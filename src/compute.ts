import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CloudClients } from './clients.js';
import { CloudError, runTool } from './errors.js';
import { unwrapData } from './http.js';
import { finishAppJob } from './jobs.js';
import { detectProject } from './local.js';
import { localAppTools } from './local-app.js';

type Row = Record<string, unknown>;
export const APP_FLOW = 'AI làm 99%: cloud_app_detect(local_dir) offline → cloud_app_host_list, cloud_prices/cloud_packages/cloud_plan_list và cloud_balance → cloud_app_create(local_dir, sandbox=true) nếu chưa có app host để ước tính chi phí giờ/gói → hỏi human một lần duyệt chi phí nếu chưa được duyệt → cloud_app_create(local_dir, sandbox=false) → poll tới done/succeeded → kiểm và trả URL. Cần DB/Supabase? cloud_base_create (beta) — chung account/ví MONA Cloud, khớp app deploy. Nếu human có domain: cloud_app_domain_add và hướng dẫn CNAME từ API. Human đăng ký MONA Pass bằng device flow một lần; hết credit 20k thì AI gọi cloud_topup và in QR (qr_ascii) ngay trong terminal, human chỉ quét bằng app ngân hàng, không mở console; AI làm các bước còn lại. App git cloud_app_create(repo_url) đã live; không gọi agent_deploy cho deploy dự án. / Detect locally, estimate, obtain cost approval once, upload and deploy, create an optional Base, return URL, then attach an optional domain.';
const sandbox = z.boolean().optional().describe('Thử 0đ, không tạo hạ tầng thật / Sandbox, no charge');
const id = z.string().trim().min(1).max(255);
const planCode = z.string().trim().min(2).max(64);
const period = z.enum(['month', 'year']);
const object = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {};
export function rows(value: unknown, key: string): Row[] {
  const data = unwrapData(value);
  const list = Array.isArray(data) ? data : object(data)[key];
  return Array.isArray(list) ? list.filter((row) => row && typeof row === 'object') : [];
}

export async function planEstimate(clients: CloudClients, code: string, cycle = 'month') {
  const plan = rows(await clients.plans(), 'plans').find((row) => row.code === code && row.active !== false);
  if (!plan) throw new CloudError('plan_not_found', `Không có gói đang mở: ${code}.`, 'Gọi cloud_plan_list để chọn plan_code.');
  const amount = plan[cycle === 'year' ? 'price_year_vnd' : 'price_month_vnd'];
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) {
    throw new CloudError('invalid_plan_price', 'Không đọc được giá gói.', 'Gọi cloud_plan_list rồi thử lại; không tự đoán giá.');
  }
  return { plan, estimate: { billing_mode: 'monthly', plan_code: code, period: cycle, amount_vnd: amount, currency: 'VND' } };
}

export async function createVps(clients: CloudClients, body: Row) {
  const { sandbox: requested, ...payload } = body;
  if (payload.billing_mode !== 'monthly') return clients.guardedVibecloud('/api/lxc', { method: 'POST', body: payload }, requested === true);
  const { plan, estimate } = await planEstimate(clients, String(payload.plan_code), String(payload.period || 'month'));
  // Wave A rejects mixed sizing. Strip all hourly sizing before the real request.
  delete payload.cpu; delete payload.ram_gb; delete payload.disk_gb; delete payload.package_slug;
  const isSandbox = clients.sandboxEnabled(requested === true);
  const outgoing = isSandbox
    ? { app_name: payload.app_name, cpu: plan.cpu, ram_gb: plan.ram_gb, disk_gb: plan.disk_gb }
    : payload;
  const result = await clients.guardedVibecloud('/api/lxc', { method: 'POST', body: outgoing }, isSandbox, estimate.amount_vnd);
  return { ...object(result), estimate, ...(isSandbox ? {
    preview_billing_mode: 'hourly', requested_billing_mode: 'monthly',
    next_step: 'Sandbox chỉ thử cấu hình gói qua hourly (0đ); chưa tạo subscription. Duyệt giá estimate rồi gọi cloud_vps_create billing_mode=monthly, sandbox=false.',
  } : {}) };
}

export function registerComputeTools(server: McpServer, clients: CloudClients) {
  // Every new compute tool keeps a mechanical legacy alias, using the same schema and handler.
  const register = (name: string, description: string, schema: z.ZodObject<any>, handler: (args: any) => unknown) => {
    for (const toolName of [name, name.replace(/^cloud_/, 'vibecloud_')]) {
      server.registerTool(toolName, {
        description: toolName === name ? description : `Alias tương thích của ${name}. / Compatibility alias. ${description}`,
        inputSchema: schema,
      }, (args) => runTool(() => handler(args)));
    }
  };
  register('cloud_plan_list', 'Bảng gói cùng giá tháng/năm; gợi ý gói rẻ nhất đủ CPU/RAM/đĩa yêu cầu, admin_only không tự chọn. Đọc trước khi duyệt chi phí. / List plans, prices and sizing recommendation.',
    z.object({ cpu: z.number().int().positive().optional(), ram_gb: z.number().positive().optional(), disk_gb: z.number().positive().optional() }).strict(), async (needs) => {
      const plans = rows(await clients.plans(), 'plans');
      const eligible = plans.filter((plan) => plan.active !== false && !plan.admin_only
        && ['cpu', 'ram_gb', 'disk_gb'].every((key) => typeof plan[key] === 'number' && Number(plan[key]) >= (needs[key] || 0))
        && typeof plan.price_month_vnd === 'number').sort((a, b) => Number(a.price_month_vnd) - Number(b.price_month_vnd));
      return { plans, recommendation: eligible[0] ? { plan_code: eligible[0].code, reason: 'Gói giá tháng thấp nhất đáp ứng cấu hình yêu cầu; kiểm tra tải thực tế, backup và included_db.' } : null,
        next_step: 'Chọn plan_code và month/year, báo giá tương ứng rồi hỏi duyệt trước cloud_vps_create.' };
    });
  register('cloud_subscription_list', 'Đọc các gói đang dùng, kỳ gia hạn và auto-renew. / List subscriptions.', z.object({}).strict(), () => clients.vibecloud('/api/subscriptions'));
  register('cloud_subscription_update', 'Đổi gói/chu kỳ/gia hạn sau khi đọc subscription và giá, ước tính rồi được duyệt. Upgrade tính prorate, downgrade kỳ sau. Huỷ: auto_renew=false, cancel_action=hourly|stop. / Update or cancel renewal.',
    z.object({ service_id: id, plan_code: planCode.optional(), period: period.optional(), auto_renew: z.boolean().optional(), cancel_action: z.enum(['hourly', 'stop']).optional() }).strict()
      .refine((args) => [args.plan_code, args.period, args.auto_renew, args.cancel_action].some((value) => value !== undefined), 'Cần ít nhất một thay đổi subscription.'),
    async ({ service_id, ...body }) => {
      // Cancellation must remain possible with an empty wallet. Proration is authoritative at the API.
      return clients.vibecloud(`/api/services/${encodeURIComponent(service_id)}/subscription`, { method: 'POST', body });
    });
  register('cloud_invoice_list', 'Đọc hoá đơn hàng tháng của tài khoản. / List monthly invoices.', z.object({}).strict(), () => clients.vibecloud('/api/invoices'));
  register('cloud_invoice_pdf', 'Tải PDF hoá đơn vào file tạm riêng tư, trả path; sao chép ra nơi cần giữ trước khi hệ điều hành dọn. / Download invoice PDF to a private temporary file.', z.object({ invoice_id: id }).strict(), ({ invoice_id }) => clients.invoicePdf(invoice_id));
  register('cloud_credit_redeem', 'Dùng mã credit người dùng cung cấp sau khi họ đồng ý; không thử đoán mã. / Redeem an approved promotional credit code.', z.object({ code: z.string().trim().min(2).max(64) }).strict(), ({ code }) => clients.vibecloud('/api/credit-codes/redeem', { method: 'POST', body: { code: code.toUpperCase() } }));

  const appNotice = 'App từ git đã live: app host đầu tiên ~2–3 phút, deploy sau đó 10–20 giây. / Git apps are live. ';
  const poll = { wait: z.boolean().default(true), interval_sec: z.number().int().min(1).max(30).default(3), timeout_sec: z.number().int().min(1).max(600).default(600) };
  const env = z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().refine((value) => !value.includes('\0'), 'Env không chứa NUL.')).refine((value) => Object.keys(value).length <= 200 && Object.entries(value).reduce((sum, [key, val]) => sum + key.length + val.length, 0) <= 65536, 'Env tối đa 200 key / 64 KiB.');
  const domain = z.string().trim().min(3).max(253).regex(/^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,63}$/, 'Chỉ hostname, không URL/path.');
  const appId = z.object({ app_id: id, sandbox }).strict();
  const gitPath = z.string().trim().min(1).max(255).refine((value) => !/[\x00-\x1f]/.test(value) && !value.startsWith('-') && !value.startsWith('/') && !value.split('/').includes('..'), 'Nhánh/path git không hợp lệ.');
  const repo = z.string().trim().min(1).max(2048).refine((value) => {
    try { const u = new URL(value); return u.protocol === 'https:' && !u.port && !u.password && !u.username && !u.search && !u.hash && u.pathname.length > 1; } catch { return false; }
  }, 'Dùng public HTTPS git URL không chứa token/mật khẩu; private repo chưa được hỗ trợ.');
  const compute = async (path: string, options: { method?: string; body?: unknown; query?: Record<string, string | undefined> }, requested?: boolean) => {
    const isSandbox = clients.sandboxEnabled(requested);
    const result = await clients.vibecloud(path, { ...options, ...(isSandbox ? { headers: { 'X-Vibecloud-Sandbox': '1' } } : {}) });
    return isSandbox ? { ...(Array.isArray(result) ? { items: result } : object(result)), sandbox: true } : result;
  };
  const localDir = z.string().min(1).max(4096).refine((value) => value.trim().length > 0 && !/[\x00-\x1f]/.test(value), 'local_dir không hợp lệ.');
  const local = localAppTools(clients);
  register('cloud_app_detect', 'Nhận diện Node/Next/Vite/Python/PHP/static, port, start, Dockerfile, build_type và tên biến .env.example; hoàn toàn offline, không thực thi code dự án. / Detect a local app without network.',
    z.object({ local_dir: localDir }).strict(), ({ local_dir }) => detectProject(local_dir));
  register('cloud_app_create', appNotice + APP_FLOW,
    z.object({ local_dir: localDir.optional(), name: z.string().trim().min(1).max(80).optional(), repo_url: repo.optional(), branch: gitPath.optional(), build_type: z.enum(['dockerfile', 'nixpacks', 'static']).optional(), dockerfile: gitPath.optional(), env: env.default({}), domain: domain.optional(), app_host_id: id.optional(), port: z.number().int().min(1).max(65535).optional(), sandbox, ...poll }).strict()
      .refine((args) => Boolean(args.local_dir) !== Boolean(args.repo_url), 'Chọn đúng một local_dir hoặc repo_url.')
      .refine((args) => !args.local_dir || (!args.branch && (!args.dockerfile || args.dockerfile === 'Dockerfile')), 'Upload local dùng Dockerfile ở root (hoặc Nixpacks tự nhận); branch/app_host_id chỉ dùng cho git.'),
    async (args) => {
      if (args.local_dir) return local.create(args);
      const { sandbox: requested, wait, interval_sec, timeout_sec, local_dir, name, ...fields } = args;
      const body = { ...fields, branch: fields.branch || 'main', build_type: fields.build_type || 'dockerfile', dockerfile: fields.dockerfile || 'Dockerfile', port: fields.port || 3000 };
      return finishAppJob(clients, await clients.guardedVibecloud('/api/apps', { method: 'POST', body }, requested), clients.sandboxEnabled(requested), wait, interval_sec, timeout_sec);
    });
  register('cloud_app_list', appNotice + 'Liệt kê app trước khi tạo để tránh trùng. / List apps.', z.object({ sandbox }).strict(), ({ sandbox }) => compute('/api/apps', {}, sandbox));
  register('cloud_app_host_list', appNotice + 'Đọc app host; chưa có host thì sandbox cloud_app_create trước để ước tính. / List app hosts.', z.object({ sandbox }).strict(), ({ sandbox }) => compute('/api/app-hosts', {}, sandbox));
  register('cloud_app_get', appNotice + 'Đọc status, URL, lần deploy và app host. / Inspect app.', appId, ({ app_id, sandbox }) => compute(`/api/apps/${encodeURIComponent(app_id)}`, {}, sandbox));
  register('cloud_app_deploy', appNotice + 'App upload: local_dir đóng ZIP mới → upload → chờ job → deploy; bỏ local_dir để redeploy bản đã upload. / Redeploy uploaded source or a git app and poll.', appId.extend({ local_dir: localDir.optional(), ...poll }),
    async (args) => args.local_dir ? local.deploy(args) : finishAppJob(clients,
      await clients.guardedVibecloud(`/api/apps/${encodeURIComponent(args.app_id)}/deploy`, { method: 'POST' }, args.sandbox), clients.sandboxEnabled(args.sandbox), args.wait, args.interval_sec, args.timeout_sec));
  register('cloud_app_env_set', appNotice + 'Thay toàn bộ env sau khi được duyệt, gửi đầy đủ map cần giữ; không log secret. Gọi cloud_app_deploy sau đó để áp dụng. / Set app environment.', appId.extend({ env }), ({ app_id, env, sandbox }) => compute(`/api/apps/${encodeURIComponent(app_id)}/env`, { method: 'PUT', body: { env } }, sandbox));
  register('cloud_app_domain_add', appNotice + 'Thêm domain đã được duyệt, trả hướng dẫn CNAME từ API; chờ DNS trước kiểm HTTPS. / Attach custom domain.', appId.extend({ host: domain }), ({ app_id, host, sandbox }) => compute(`/api/apps/${encodeURIComponent(app_id)}/domains`, { method: 'POST', body: { host } }, sandbox));
  register('cloud_app_logs', appNotice + 'Đọc tối đa 500 dòng log; có thể chứa secret, không đưa nguyên log ra công khai. / Read deployment logs.', appId.extend({ deployment: id.optional() }), ({ app_id, deployment, sandbox }) => compute(`/api/apps/${encodeURIComponent(app_id)}/logs`, { query: { deployment } }, sandbox));
  register('cloud_app_delete', appNotice + 'Sau khi user duyệt xoá: xoá app/domain/A record; app host vẫn có thể tính phí. / Delete an approved app.', appId, ({ app_id, sandbox }) => compute(`/api/apps/${encodeURIComponent(app_id)}`, { method: 'DELETE' }, sandbox));
}
