import { setTimeout as delay } from 'node:timers/promises';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { readConfig } from './config.js';
import { AuthManager } from './auth.js';
import { CloudClients } from './clients.js';
import { errorResult, runTool, textResult, toAgentError } from './errors.js';
import { requestJson, unwrapData } from './http.js';
import { createMonaPayClient, importedMonaPayTools, normalizeImportedResult } from './monapay.js';
import { TemplateCatalog } from './templates.js';

export type ServerDependencies = {
  config?: Config;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

type JsonObject = Record<string, unknown>;

const ENTITY = 'MONA Cloud là hệ công cụ cho vibecoder Việt Nam: một MONA Pass, một ví VND và một MCP để chạy app/VPS, thu tiền MONA Pay và dùng các sản phẩm MONA.';
const TERMINAL_JOBS = new Set(['done', 'succeeded', 'failed', 'cancelled']);
const SANDBOX_DESCRIPTION = 'sandbox=true: thử 0đ, không cần ví';
const sandboxSchema = z.boolean().optional().describe(SANDBOX_DESCRIPTION);

const asObject = (value: unknown): JsonObject => (
  value && typeof value === 'object' ? value as JsonObject : {}
);

function collection(value: unknown): JsonObject[] {
  const data = unwrapData<unknown>(value);
  if (Array.isArray(data)) return data.filter((item) => item && typeof item === 'object') as JsonObject[];
  const object = asObject(data);
  for (const key of ['items', 'data', 'results', 'bank_accounts', 'virtual_accounts', 'webhooks']) {
    const nested = object[key];
    if (Array.isArray(nested)) return nested.filter((item) => item && typeof item === 'object') as JsonObject[];
  }
  return [];
}

const sizingSchema = {
  app_name: z.string().min(2).max(80),
  package_slug: z.string().min(1).max(64).optional(),
  cpu: z.number().int().min(1).max(16).optional(),
  ram_gb: z.number().int().min(1).max(64).optional(),
  disk_gb: z.number().int().min(10).max(1000).optional(),
  sandbox: sandboxSchema,
};

const provisionSchema = z.object(sizingSchema).superRefine((value, context) => {
  const dimensions = [value.cpu, value.ram_gb, value.disk_gb];
  const hasAny = dimensions.some((item) => item !== undefined);
  const hasAll = dimensions.every((item) => item !== undefined);
  if (value.package_slug && hasAny) {
    context.addIssue({ code: 'custom', message: 'Dùng package_slug hoặc bộ cpu/ram_gb/disk_gb, không dùng cả hai.' });
  }
  if (!value.package_slug && !hasAll) {
    context.addIssue({ code: 'custom', message: 'Cần package_slug hoặc đủ cpu, ram_gb và disk_gb.' });
  }
});

function agentRuntimeStub(template: string, sandbox = false) {
  return {
    status: 'not_available',
    code: 'agent_runtime_pending',
    template,
    message: 'Runtime MONA Agent trên MONA Cloud chưa được phát hành; tool này là slot wave kế tiếp theo brief.',
    next_step: 'Dùng agent_templates_get để lấy nội dung template và triển khai thủ công, hoặc thử lại khi MONA Cloud bật runtime agent.',
    ...(sandbox ? { sandbox: true } : {}),
  };
}

async function pollJob(
  clients: CloudClients,
  jobId: string,
  wait: boolean,
  intervalSeconds: number,
  timeoutSeconds: number,
  sandbox: boolean,
): Promise<unknown> {
  let result = await clients.vibecloud(`/api/jobs/${encodeURIComponent(jobId)}`);
  if (!wait) return sandbox ? { ...asObject(result), sandbox: true } : result;
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (!TERMINAL_JOBS.has(String(asObject(result).status || '')) && Date.now() < deadline) {
    await delay(intervalSeconds * 1000);
    result = await clients.vibecloud(`/api/jobs/${encodeURIComponent(jobId)}`);
  }
  if (!TERMINAL_JOBS.has(String(asObject(result).status || ''))) {
    return {
      ...asObject(result),
      ...(sandbox ? { sandbox: true } : {}),
      polling: 'timeout',
      next_step: `Gọi lại cloud_job_status với job_id=${jobId}.`,
    };
  }
  return sandbox ? { ...asObject(result), sandbox: true } : result;
}

async function providerHealth(name: string, url: string, fetchImpl: typeof fetch) {
  const started = Date.now();
  try {
    const data = await requestJson(url, { fetchImpl, timeoutMs: 5_000 });
    return { name, ok: true, latency_ms: Date.now() - started, data };
  } catch (error) {
    return { name, ok: false, latency_ms: Date.now() - started, error: toAgentError(error) };
  }
}

export function createServer(dependencies: ServerDependencies = {}): McpServer {
  const env = dependencies.env || process.env;
  const config = dependencies.config || readConfig(env);
  const fetchImpl = dependencies.fetchImpl || fetch;
  const auth = new AuthManager(config, env, fetchImpl);
  const clients = new CloudClients(config, auth, fetchImpl);
  const catalog = new TemplateCatalog(config, fetchImpl);
  const server = new McpServer(
    { name: 'monacloud-mcp', version: '0.2.1' },
    { instructions: `${ENTITY}\nDùng cloud_* cho tài khoản, ví và hạ tầng; monapay_* cho thu tiền; agent_* cho catalog. Không bao giờ yêu cầu mật khẩu sản phẩm. Chỉ dừng hỏi người dùng khi cần nạp tiền, OTP ngân hàng hoặc KYC bắt buộc.` },
  );

  server.registerTool('cloud_whoami', {
    title: 'Tài khoản MONA Cloud',
    description: 'Xác minh MONA Pass hiện tại. / Return the current MONA Pass profile.',
  }, () => runTool(async () => ({ ...(await auth.userinfo()), console_url: config.consoleUrl })));

  server.registerTool('cloud_balance', {
    title: 'Số dư ví MONA Cloud',
    description: 'Đọc số dư ví VND chung trước khi tạo tài nguyên có phí.',
  }, () => runTool(() => clients.balance()));

  server.registerTool('cloud_ledger', {
    title: 'Sổ cái ví MONA Cloud',
    description: 'Đọc các dòng nạp, trừ và hoàn tiền trong ledger.',
    inputSchema: {
      cursor: z.string().max(2048).optional(),
      limit: z.number().int().min(1).max(100).default(50),
    },
  }, ({ cursor, limit }) => runTool(() => clients.ledger(cursor, limit)));

  server.registerTool('cloud_topup', {
    title: 'Nạp ví bằng VietQR',
    description: 'Tạo yêu cầu nạp ví và trả VietQR; đây là bước con người thanh toán hợp lệ.',
    inputSchema: {
      amount: z.number().int().min(1_000).max(1_000_000_000).describe('Số tiền nguyên VND'),
      idempotency_key: z.string().min(1).max(255).optional(),
    },
  }, ({ amount, idempotency_key }) => runTool(async () => ({
    ...asObject(await clients.topup(amount, idempotency_key)),
    instructions: 'Mở app ngân hàng, quét qr_data_url và chuyển đúng số tiền/nội dung. Sau khi tiền vào, gọi cloud_balance.',
  })));

  server.registerTool('cloud_usage', {
    title: 'Chi phí MONA Cloud theo kỳ',
    description: 'Đọc usage và tổng tiền theo tháng, có thể lọc sản phẩm.',
    inputSchema: {
      period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Dùng YYYY-MM'),
      product: z.string().min(1).max(100).optional(),
    },
  }, ({ period, product }) => runTool(() => clients.usage(period, product)));

  server.registerTool('cloud_services', {
    title: 'Mọi dịch vụ đang chạy',
    description: 'Gom VPS/database MONA Cloud cùng tài khoản ảo và webhook MONA Pay.',
  }, () => runTool(async () => {
    const [vibecloud, monapay] = await Promise.all([
      clients.vibecloud('/api/services')
        .then((services) => ({ ok: true, services }))
        .catch((error) => ({ ok: false, error: toAgentError(error) })),
      (async () => {
        try {
          const client = createMonaPayClient(config, env, fetchImpl);
          const [bankResponse, webhookResponse] = await Promise.all([
            client.listBankAccounts({ page: 1, limit: 100 }),
            client.listWebhooks(),
          ]);
          const banks = collection(bankResponse);
          const virtualAccounts = (await Promise.all(banks.map(async (bank) => {
            const id = typeof bank.id === 'string' ? bank.id : undefined;
            return id ? collection(await client.listVirtualAccounts(id, { page: 1, limit: 100 })) : [];
          }))).flat();
          return { ok: true, bank_accounts: banks, virtual_accounts: virtualAccounts, webhooks: collection(webhookResponse) };
        } catch (error) {
          return { ok: false, error: toAgentError(error) };
        }
      })(),
    ]);
    return { vibecloud, monapay };
  }));

  server.registerTool('cloud_budget_set', {
    title: 'Đặt ngân sách MONA Cloud',
    description: 'Đặt giới hạn chi tiêu theo product, project hoặc token.',
    inputSchema: {
      scope: z.enum(['product', 'project', 'token']),
      scope_id: z.string().min(1).max(255),
      limit_vnd: z.number().int().min(0),
      period: z.enum(['day', 'month']),
    },
  }, (body) => runTool(() => clients.budgetSet(body)));

  server.registerTool('cloud_budget_get', {
    title: 'Đọc ngân sách MONA Cloud',
    description: 'Liệt kê giới hạn và mức đã dùng theo kỳ.',
  }, () => runTool(() => clients.budgetGet()));

  server.registerTool('cloud_token_limit', {
    title: 'Giới hạn chi tiêu của token',
    description: 'Đặt spend guard riêng cho token hiện tại hoặc token_id chỉ định.',
    inputSchema: {
      spend_limit_vnd: z.number().int().min(0),
      period: z.enum(['day', 'month']),
      token_id: z.string().min(1).max(255).optional(),
    },
  }, ({ spend_limit_vnd, period, token_id }) => runTool(() => clients.tokenLimit(spend_limit_vnd, period, token_id)));

  server.registerTool('cloud_open_console', {
    title: 'Mở MONA Cloud Console',
    description: 'Trả URL console chung để nạp ví, đổi budget hoặc quản lý tài khoản.',
  }, () => textResult({ url: config.consoleUrl, next_step: `Mở ${config.consoleUrl} trong trình duyệt.` }));

  server.registerTool('monapay_link', {
    title: 'Liên kết MONA Pay chuyển tiếp',
    description: 'Tạm đổi MONA Pass thành client credential MONA Pay và cache cục bộ; bỏ khi MONA Pay nhận JWT trực tiếp.',
  }, () => runTool(() => clients.monapayLink()));

  server.registerTool('cloud_link', {
    title: 'Liên kết MONA Cloud chuyển tiếp',
    description: 'Xác nhận compute MONA Cloud nhận MONA Pass trực tiếp; chỉ đổi thành vc_live token khi upstream còn ở chế độ cũ.',
  }, () => runTool(() => clients.vibecloudLink()));

  server.registerTool('vibecloud_link', {
    title: 'Alias cũ của cloud_link',
    description: 'Alias tương thích; dùng cloud_link cho tích hợp mới.',
  }, () => runTool(() => clients.vibecloudLink()));

  server.registerTool('cloud_vps_create', {
    title: 'Tạo VPS MONA Cloud',
    description: `Kiểm tra ví chung rồi tạo LXC VPS; trả job_id để poll. ${SANDBOX_DESCRIPTION}.`,
    inputSchema: provisionSchema,
  }, (body) => runTool(async () => {
    const { sandbox, ...payload } = body;
    return clients.guardedVibecloud('/api/lxc', { method: 'POST', body: payload }, sandbox);
  }));

  server.registerTool('vibecloud_create_vps', {
    title: 'Alias cũ của cloud_vps_create',
    description: `Alias tương thích; dùng cloud_vps_create cho tích hợp mới. ${SANDBOX_DESCRIPTION}.`,
    inputSchema: provisionSchema,
  }, (body) => runTool(async () => {
    const { sandbox, ...payload } = body;
    return clients.guardedVibecloud('/api/lxc', { method: 'POST', body: payload }, sandbox);
  }));

  const databaseSchema = provisionSchema.extend({ engine: z.enum(['mongodb', 'postgresql', 'mysql']).default('mongodb') });

  server.registerTool('cloud_db_create', {
    title: 'Tạo database MONA Cloud',
    description: `Kiểm tra ví chung rồi tạo MongoDB/PostgreSQL/MySQL; trả job_id để poll. ${SANDBOX_DESCRIPTION}.`,
    inputSchema: databaseSchema,
  }, (body) => runTool(async () => {
    const { sandbox, ...payload } = body;
    return clients.guardedVibecloud('/api/databases', { method: 'POST', body: payload }, sandbox);
  }));

  server.registerTool('vibecloud_create_database', {
    title: 'Alias cũ của cloud_db_create',
    description: `Alias tương thích; dùng cloud_db_create cho tích hợp mới. ${SANDBOX_DESCRIPTION}.`,
    inputSchema: databaseSchema,
  }, (body) => runTool(async () => {
    const { sandbox, ...payload } = body;
    return clients.guardedVibecloud('/api/databases', { method: 'POST', body: payload }, sandbox);
  }));

  const jobStatusSchema = {
    job_id: z.string().min(1),
    wait: z.boolean().default(true),
    interval_sec: z.number().int().min(1).max(30).default(3),
    timeout_sec: z.number().int().min(1).max(600).default(180),
    sandbox: sandboxSchema,
  };

  server.registerTool('cloud_job_status', {
    title: 'Theo dõi job MONA Cloud',
    description: 'Đọc job thật hoặc sandbox theo ID; API tự nhận diện sandbox nên không cần header.',
    inputSchema: jobStatusSchema,
  }, ({ job_id, wait, interval_sec, timeout_sec, sandbox }) => runTool(
    () => pollJob(clients, job_id, wait, interval_sec, timeout_sec, clients.sandboxEnabled(sandbox)),
  ));

  server.registerTool('vibecloud_job_status', {
    title: 'Alias cũ của cloud_job_status',
    description: 'Alias tương thích; dùng cloud_job_status cho tích hợp mới. Job sandbox được tự nhận diện, không cần header.',
    inputSchema: jobStatusSchema,
  }, ({ job_id, wait, interval_sec, timeout_sec, sandbox }) => runTool(
    () => pollJob(clients, job_id, wait, interval_sec, timeout_sec, clients.sandboxEnabled(sandbox)),
  ));

  server.registerTool('cloud_services_list', {
    title: 'Danh sách service MONA Cloud',
    description: 'Liệt kê VPS/database; sandbox=true gộp cả service thử 0đ bằng API, không cần header.',
    inputSchema: { sandbox: sandboxSchema },
  }, ({ sandbox }) => runTool(() => clients.vibecloud('/api/services', {
    query: clients.sandboxEnabled(sandbox) ? { include_sandbox: 1 } : undefined,
  })));

  server.registerTool('vibecloud_list_services', {
    title: 'Alias cũ của cloud_services_list',
    description: 'Alias tương thích; dùng cloud_services_list cho tích hợp mới. sandbox=true gộp service thử 0đ, không cần header.',
    inputSchema: { sandbox: sandboxSchema },
  }, ({ sandbox }) => runTool(() => clients.vibecloud('/api/services', {
    query: clients.sandboxEnabled(sandbox) ? { include_sandbox: 1 } : undefined,
  })));

  for (const action of ['start', 'stop', 'rebuild'] as const) {
    const name = `cloud_service_${action}`;
    server.registerTool(name, {
      title: `${action} service MONA Cloud`,
      description: action === 'stop'
        ? 'Dừng VPS/database MONA Cloud; luôn cho phép dừng để người dùng hạn chế chi phí.'
        : `${action} VPS/database MONA Cloud. Lệnh có thể phát sinh chi phí và kiểm tra ví trước. ${SANDBOX_DESCRIPTION}.`,
      inputSchema: { service_id: z.string().min(1), sandbox: sandboxSchema },
    }, ({ service_id, sandbox }) => runTool(async () => {
      const path = `/api/services/${encodeURIComponent(service_id)}/${action}`;
      if (action !== 'stop') return clients.guardedVibecloud(path, { method: 'POST' }, sandbox);
      return clients.vibecloud(path, { method: 'POST' });
    }));
    server.registerTool(`vibecloud_${action}`, {
      title: `Alias cũ của ${name}`,
      description: `Alias tương thích; dùng ${name} cho tích hợp mới.${action === 'stop' ? '' : ` ${SANDBOX_DESCRIPTION}.`}`,
      inputSchema: { service_id: z.string().min(1), sandbox: sandboxSchema },
    }, ({ service_id, sandbox }) => runTool(async () => {
      const path = `/api/services/${encodeURIComponent(service_id)}/${action}`;
      if (action !== 'stop') return clients.guardedVibecloud(path, { method: 'POST' }, sandbox);
      return clients.vibecloud(path, { method: 'POST' });
    }));
  }

  server.registerTool('cloud_prices', {
    title: 'Bảng giá MONA Cloud',
    description: 'Đọc đơn giá giờ hiện hành.',
  }, () => runTool(() => clients.prices()));

  server.registerTool('vibecloud_prices', {
    title: 'Alias cũ của cloud_prices',
    description: 'Alias tương thích; dùng cloud_prices cho tích hợp mới.',
  }, () => runTool(() => clients.prices()));

  server.registerTool('cloud_packages', {
    title: 'Gói cấu hình MONA Cloud',
    description: 'Liệt kê package_slug và cấu hình CPU/RAM/đĩa.',
  }, () => runTool(() => clients.packages()));

  server.registerTool('vibecloud_packages', {
    title: 'Alias cũ của cloud_packages',
    description: 'Alias tương thích; dùng cloud_packages cho tích hợp mới.',
  }, () => runTool(() => clients.packages()));

  server.registerTool('cloud_agent_deploy', {
    title: 'Deploy MONA Agent trên MONA Cloud',
    description: `Slot runtime agent wave kế tiếp; hiện trả trạng thái stub rõ ràng. ${SANDBOX_DESCRIPTION}.`,
    inputSchema: { template: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), sandbox: sandboxSchema },
  }, ({ template, sandbox }) => runTool(() => agentRuntimeStub(template, clients.sandboxEnabled(sandbox))));

  server.registerTool('vibecloud_agent_deploy', {
    title: 'Alias cũ của cloud_agent_deploy',
    description: `Alias tương thích; dùng cloud_agent_deploy cho tích hợp mới. ${SANDBOX_DESCRIPTION}.`,
    inputSchema: { template: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/), sandbox: sandboxSchema },
  }, ({ template, sandbox }) => runTool(() => agentRuntimeStub(template, clients.sandboxEnabled(sandbox))));

  server.registerTool('agent_templates_list', {
    title: 'Catalog MONA Agent',
    description: 'Đọc template từ thư mục local, URL catalog hoặc catalog wave 1 tích hợp.',
  }, () => runTool(() => catalog.list()));

  server.registerTool('agent_templates_get', {
    title: 'Chi tiết MONA Agent template',
    description: 'Đọc README, AGENTS.md, tools, deploy, checklist và skills của một template.',
    inputSchema: { template: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/) },
  }, ({ template }) => runTool(() => catalog.get(template)));

  server.registerTool('agent_deploy', {
    title: 'Dùng ngay MONA Agent template',
    description: 'Gọi cùng runtime với cloud_agent_deploy.',
    inputSchema: { template: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/) },
  }, ({ template }) => runTool(() => agentRuntimeStub(template)));

  const imported = importedMonaPayTools(config, env, fetchImpl);
  for (const [name, tool] of Object.entries(imported)) {
    if (!tool.enabled) continue;
    const register = server.registerTool.bind(server) as (
      name: string,
      config: Record<string, unknown>,
      callback: (...args: unknown[]) => unknown,
    ) => unknown;
    register(name, {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      _meta: tool._meta,
    }, async (...args) => {
      try {
        return await normalizeImportedResult(tool.handler(...args));
      } catch (error) {
        return errorResult(error);
      }
    });
  }

  server.registerResource('monacloud-llms', 'monacloud://llms', {
    title: 'MONA Cloud llms.txt tổng',
    description: 'Bản máy đọc mô tả stack và luồng AI-first của MONA Cloud.',
    mimeType: 'text/plain',
  }, async (uri) => ({ contents: [{
    uri: uri.href,
    mimeType: 'text/plain',
    text: `${ENTITY}\n\nHuman chỉ đăng ký MONA Pass, nạp tiền và cung cấp OTP/KYC bắt buộc. AI dùng MCP làm phần còn lại.\n\n- cloud_*: tài khoản, ví, ledger, usage, budget, VPS, database, job, vòng đời service và giá/gói.\n- monapay_*: nối ngân hàng, checkout/QR, giao dịch, webhook và email.\n- agent_*: catalog và deploy template.\n\nMONA Cloud: https://monacloud.vn\nCompute API: https://api.monacloud.vn\nMONA Pay: https://monapay.vn\n`,
  }] }));

  server.registerResource('monacloud-status', 'monacloud://status', {
    title: 'Trạng thái hệ MONA Cloud',
    description: 'Health tổng hợp của MONA Pass, billing, compute MONA Cloud và MONA Pay.',
    mimeType: 'application/json',
  }, async (uri) => {
    const members = await Promise.all([
      providerHealth('mona-id', `${config.issuer}/.well-known/openid-configuration`, fetchImpl),
      providerHealth('billing', `${config.billingUrl}/v1/healthz`, fetchImpl),
      providerHealth('monacloud-compute', `${config.vibecloudApi}/api/prices`, fetchImpl),
      providerHealth('monapay', `${config.monapayApi}/health`, fetchImpl),
    ]);
    return { contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify({ checked_at: new Date().toISOString(), members }, null, 2) }] };
  });

  server.registerPrompt('dung-app-ban-hang-monacloud', {
    title: 'Dựng app bán hàng có thu tiền trên MONA Cloud',
    description: 'Chuỗi zero-dashboard: VPS → DB → VA/QR → webhook → deploy.',
    argsSchema: {
      app_name: z.string().optional(),
      framework: z.string().optional(),
    },
  }, ({ app_name, framework }) => ({ messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `Dựng app bán hàng ${app_name || 'của tôi'} bằng ${framework || 'stack phù hợp'} trên MONA Cloud theo đúng thứ tự:\n1. Gọi cloud_whoami, cloud_balance, cloud_packages và cloud_prices. Nếu thiếu tiền, gọi cloud_topup rồi dừng để người dùng quét VietQR.\n2. Gọi cloud_vps_create và cloud_db_create; poll từng job bằng cloud_job_status tới succeeded.\n3. Gọi monapay_link nếu MONA Pay còn ở lớp chuyển tiếp. Gọi monapay_whoami; nếu chưa có VA, nối ngân hàng bằng chuỗi monapay_link_bank_start → HỎI OTP → verify → notification_register → HỎI OTP lần 2 → verify. Không tự đoán OTP.\n4. Viết endpoint webhook có HMAC và idempotency theo transaction_code; đăng ký bằng monapay_create_webhook, bắn monapay_test_webhook và đọc monapay_webhook_logs.\n5. Tích hợp monapay_create_checkout hoặc monapay_create_qr vào app, chỉ giao hàng sau CHECKOUT_PAID.\n6. Deploy code lên VPS vừa tạo, kiểm tra health và báo URL/credential cần lưu. Không yêu cầu người dùng mở dashboard ngoài bước nạp tiền/OTP bắt buộc.`,
    },
  }] }));

  return server;
}
