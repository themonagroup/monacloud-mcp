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
import { registerMailTools } from './mail.js';
import { APP_FLOW, createVps, registerComputeTools } from './compute.js';
import { pollJob } from './jobs.js';

export type ServerDependencies = {
  config?: Config;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

type JsonObject = Record<string, unknown>;

const ENTITY = 'MONA Cloud là hệ công cụ cho vibecoder Việt Nam: một MONA Pass, một ví VND và một MCP để chạy app/VPS, thu tiền MONA Pay và dùng các sản phẩm MONA. Dùng mail_* để gửi email giao dịch (MONA Mail). MONA Mail là dịch vụ gửi email giao dịch cho phần mềm và AI agent của người Việt: một API, trả VND, không cần thẻ, thuộc nhóm MONA Cloud của The MONA Group.';
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

const vpsSchema = z.object({
  ...sizingSchema,
  billing_mode: z.enum(['hourly', 'monthly']).optional(),
  plan_code: z.string().trim().min(2).max(64).optional(),
  period: z.enum(['month', 'year']).optional(),
}).strict().superRefine((value, context) => {
  if (value.billing_mode === 'monthly') {
    if (!value.plan_code) context.addIssue({ code: 'custom', message: 'Monthly cần plan_code.' });
    return;
  }
  if (value.plan_code || value.period) context.addIssue({ code: 'custom', message: 'plan_code/period chỉ dùng với billing_mode=monthly.' });
  const checked = provisionSchema.safeParse(value);
  if (!checked.success) for (const issue of checked.error.issues) context.addIssue({ code: 'custom', message: issue.message, path: issue.path });
});

function agentRuntimeStub(template: string, sandbox = false) {
  return {
    status: 'not_available',
    code: 'agent_runtime_pending',
    template,
    message: 'Runtime MONA Agent trên MONA Cloud chưa được phát hành; tool này là slot wave kế tiếp theo brief.',
    next_step: `Dùng agent_templates_get để đọc template. ${APP_FLOW}`,
    ...(sandbox ? { sandbox: true } : {}),
  };
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
    { name: 'monacloud-mcp', version: '0.4.0' },
    { instructions: `${ENTITY}\nDùng cloud_* cho tài khoản, ví và hạ tầng; monapay_* cho thu tiền; mail_* để gửi email giao dịch (MONA Mail); agent_* cho catalog. Không bao giờ yêu cầu mật khẩu sản phẩm. Đọc → ước tính → hỏi duyệt nếu chưa được duyệt → làm. Dừng khi cần DNS, nạp tiền, duyệt chi phí, OTP hoặc KYC. ${APP_FLOW}` },
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
    description: `Đọc cloud_plan_list (monthly) hoặc cloud_prices/cloud_packages (hourly), ước tính rồi hỏi duyệt trước tạo. Monthly bỏ CPU/RAM/đĩa, lấy từ plan_code; period=month|year. Kiểm ví đủ giá gói, trả estimate và job_id. / Estimate, approve, create VPS. ${SANDBOX_DESCRIPTION}.`,
    inputSchema: vpsSchema,
  }, (body) => runTool(() => createVps(clients, body)));

  server.registerTool('vibecloud_create_vps', {
    title: 'Alias cũ của cloud_vps_create',
    description: `Alias tương thích; dùng cloud_vps_create cho tích hợp mới. ${SANDBOX_DESCRIPTION}.`,
    inputSchema: vpsSchema,
  }, (body) => runTool(() => createVps(clients, body)));

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

  registerComputeTools(server, clients);
  registerMailTools(server, clients, config);

  server.registerTool('agent_templates_list', {
    title: 'Catalog MONA Agent',
    description: 'Đọc template từ thư mục local, URL catalog hoặc catalog wave 1 tích hợp. Deploy dự án: cloud_app_detect rồi cloud_app_create(local_dir), sandbox trước nếu chưa có host.',
  }, () => runTool(() => catalog.list()));

  server.registerTool('agent_templates_get', {
    title: 'Chi tiết MONA Agent template',
    description: 'Đọc README, AGENTS.md, tools, deploy, checklist và skills của một template.',
    inputSchema: { template: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/) },
  }, ({ template }) => runTool(() => catalog.get(template)));

  server.registerTool('agent_deploy', {
    title: 'Dùng ngay MONA Agent template',
    description: 'Gọi cùng runtime với cloud_agent_deploy. Deploy thư mục: cloud_app_detect → cloud_app_create(local_dir); git dùng repo_url (đã live), sandbox trước nếu chưa có host.',
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
    text: `${ENTITY}\n\n${APP_FLOW}\n\nHuman đăng ký MONA Pass, duyệt chi phí, thêm DNS khi cần, nạp tiền và cung cấp OTP/KYC bắt buộc. AI dùng MCP làm phần còn lại.\n\n- cloud_*: tài khoản, ví, ledger, usage, budget, VPS, database, job, vòng đời service, plans, subscriptions, invoices/PDF, credit và apps từ git hoặc thư mục local (source=upload); cloud_app_detect hoàn toàn offline.\n- monapay_*: nối ngân hàng, checkout/QR, giao dịch, webhook và email.\n- mail_*: tài khoản, domain, API key, gửi mail, trạng thái, webhook, suppression (MONA Mail https://monamail.vn, API https://api.monamail.vn)\n- agent_*: catalog và deploy template.\n\nMONA Cloud: https://monacloud.vn\nCompute API: https://api.monacloud.vn\nMONA Pay: https://monapay.vn\n`,
  }] }));

  server.registerResource('monacloud-status', 'monacloud://status', {
    title: 'Trạng thái hệ MONA Cloud',
    description: 'Health tổng hợp của MONA Pass, billing, compute MONA Cloud, MONA Pay và MONA Mail.',
    mimeType: 'application/json',
  }, async (uri) => {
    const members = await Promise.all([
      providerHealth('mona-id', `${config.issuer}/.well-known/openid-configuration`, fetchImpl),
      providerHealth('billing', `${config.billingUrl}/v1/healthz`, fetchImpl),
      providerHealth('monacloud-compute', `${config.vibecloudApi}/api/prices`, fetchImpl),
      providerHealth('monapay', `${config.monapayApi}/health`, fetchImpl),
      providerHealth('monamail', `${config.monamailApi}/v1/healthz`, fetchImpl),
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
      text: `Dựng app bán hàng ${app_name || 'của tôi'} bằng ${framework || 'stack phù hợp'} trên MONA Cloud. ${APP_FLOW}\nTheo đúng thứ tự:\n1. Gọi cloud_whoami, cloud_balance, cloud_plan_list, cloud_packages và cloud_prices. Báo ước tính và hỏi duyệt chi phí nếu chưa được duyệt. Nếu thiếu tiền, gọi cloud_topup rồi dừng để người dùng quét VietQR.\n2. Nếu dùng VPS gọi cloud_vps_create và cloud_db_create; nếu deploy dự án dùng cloud_app_detect(local_dir), cloud_app_host_list rồi cloud_app_create(local_dir), sandbox trước nếu chưa có host. Poll từng job bằng cloud_job_status tới done/succeeded.\n3. Gọi monapay_link nếu MONA Pay còn ở lớp chuyển tiếp. Gọi monapay_whoami; nếu chưa có VA, nối ngân hàng bằng chuỗi monapay_link_bank_start → HỎI OTP → verify → notification_register → HỎI OTP lần 2 → verify. Không tự đoán OTP.\n4. Viết endpoint webhook có HMAC và idempotency theo transaction_code; đăng ký bằng monapay_create_webhook, bắn monapay_test_webhook và đọc monapay_webhook_logs.\n5. Tích hợp monapay_create_checkout hoặc monapay_create_qr vào app, chỉ giao hàng sau CHECKOUT_PAID.\n6. Với dự án local, dùng cloud_app_create(local_dir) sau khi duyệt ước tính; git dùng repo_url; kiểm cloud_app_get/cloud_app_logs và health rồi báo URL. Chỉ dùng VPS thủ công khi người dùng chọn. Không yêu cầu người dùng mở dashboard ngoài bước nạp tiền/OTP bắt buộc.`,
    },
  }] }));

  server.registerPrompt('gui-mail-otp-monamail', {
    title: 'Gửi mail OTP bằng MONA Mail',
    description: 'Tích hợp OTP zero-dashboard: account → onboarding → DNS → verify → API key → SDK → webhook bounced.',
    argsSchema: {
      app_name: z.string().optional(),
      framework: z.string().optional(),
      domain: z.string().optional(),
    },
  }, ({ app_name, framework, domain }) => ({ messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `Tích hợp gửi mail OTP cho ${app_name || 'app của tôi'} bằng ${framework || 'stack hiện có của app'}, domain ${domain || 'lấy từ cấu hình app'}, dùng MONA Mail theo thứ tự:
1. Gọi mail_account để lấy email chủ, quota, domain và next_step. MCP dùng MONA Pass sẵn có, tài khoản Mail được tạo tự động ở request đầu.
2. Nếu chưa có domain verified, gửi thử mail_send từ onboarding@monamail.vn tới đúng email chủ vừa lấy, subject "Thử OTP MONA Mail", text là nội dung thử và idempotency_key riêng cho lượt thử. Gọi mail_status theo id; chỉ báo đã giao khi status=delivered. Nếu yêu cầu sandbox, dùng sandbox: true rồi kiểm sandbox_preview, không báo đã gửi thư thật.
3. Gọi mail_domain_add cho domain của app. Trả nguyên records để người dùng thêm DNS; đây là điểm được dừng hỏi. Nếu đã có token Cloudflare của người dùng, gọi mail_domain_cloudflare để thêm DNS và verify; token chỉ dùng một lần, không lưu hoặc log. Nếu cần token, xin ngay tại bước DNS.
4. Gọi mail_domain_verify, đọc checks và chờ status=verified; DKIM đúng là đủ, SPF/DMARC là cảnh báo. Khi đã có SPF, gộp include:_spf.monamail.vn vào record hiện có.
5. Gọi mail_api_key_create với name theo app và mode live; khi thử sandbox chọn mode test (mm_test_). Key chỉ trả một lần: ghi trực tiếp vào .env của app dưới tên MONAMAIL_API_KEY, bỏ .env khỏi git, không in key ra chat hoặc log. Chỉ báo prefix nếu cần nhận diện.
6. Viết code gửi OTP ở server bằng SDK npm monamail: import { MonaMail } from 'monamail'; const monamail = new MonaMail(process.env.MONAMAIL_API_KEY); const { id } = await monamail.emails.send({ from: 'Tên app <noreply@DOMAIN_DA_VERIFY>', to: emailNguoiNhan, subject: 'Mã OTP', text: 'Mã OTP: ' + otp, tags: ['otp'], idempotency_key: requestId }); Thay placeholder bằng domain đã verify, sinh OTP ngẫu nhiên có hạn dùng và giới hạn số lần thử. Giữ cùng idempotency_key khi retry cùng yêu cầu trong 24 giờ. Gọi mail_status để kiểm kết quả.
7. Viết HTTPS endpoint nhận email.bounced; xác minh HMAC trên timestamp và raw body bằng MonaMail.verifyWebhook, chống replay và xử lý idempotent theo event id. Gọi mail_webhook_create với events: ['email.bounced'], lưu secret riêng trong .env, rồi mail_webhook_test (payload thử là email.delivered). Kiểm suppression bằng mail_suppressions_list khi có bounce.
Chỉ dừng hỏi người dùng ở bước thêm DNS hoặc nạp tiền. Nếu mail_plan_set trả insufficient_funds, gọi cloud_topup rồi chờ người dùng nạp và cloud_balance cập nhật. Dùng mail_plans để đọc giá hiện hành, không hard-code giá. Không yêu cầu mở dashboard để lấy API key.`,
    },
  }] }));

  return server;
}
