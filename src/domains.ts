import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CloudClients } from './clients.js';
import { runTool } from './errors.js';

const domainName = z.string().trim().toLowerCase()
  .min(3).max(253)
  .describe('Tên miền đầy đủ (vd: example.vn) hoặc chỉ tên chưa có đuôi (vd: example).');

const objectId = z.string().regex(/^[a-f0-9]{24}$/i, 'Cần ID 24 ký tự hex.');

const registrantSchema = z.object({
  owner_type: z.enum(['individual', 'organization']).optional()
    .describe('individual = cá nhân (mặc định), organization = tổ chức/doanh nghiệp.'),
  fullname: z.string().min(2).max(200).describe('Họ và tên đầy đủ (hoặc tên doanh nghiệp nếu organization).'),
  email: z.string().email().describe('Email liên hệ.'),
  phone: z.string().min(8).max(20).describe('Số điện thoại.'),
  address: z.string().min(5).max(500).describe('Địa chỉ liên hệ.'),
  province: z.string().max(100).optional().describe('Tỉnh/thành phố.'),
  ward: z.string().max(100).optional().describe('Phường/xã.'),
  country: z.string().max(10).optional().describe('Mã quốc gia, mặc định VN.'),
  cccd: z.string().min(12).max(12).optional()
    .describe('Số CCCD (12 số) — bắt buộc khi đăng ký tên miền .vn cá nhân.'),
  dob: z.string().max(20).optional().describe('Ngày sinh định dạng DD/MM/YYYY — cá nhân .vn.'),
  gender: z.enum(['male', 'female', '']).optional().describe('Giới tính — cá nhân .vn.'),
  org_name: z.string().max(300).optional().describe('Tên tổ chức/doanh nghiệp — bắt buộc khi organization.'),
  tax_code: z.string().max(20).optional().describe('Mã số thuế — bắt buộc khi organization.'),
  representative: z.string().max(200).optional().describe('Họ tên người đại diện — bắt buộc khi organization.'),
}).strict();

export function registerDomainTools(server: McpServer, clients: CloudClients): void {

  server.registerTool('cloud_domain_search', {
    title: 'Tìm kiếm + báo giá tên miền',
    description: 'Kiểm tra tên miền còn trống và xem giá mua. Dùng trước khi mua để AI biết available/price.',
    inputSchema: z.object({
      q: z.string().min(1).max(253).describe('Tên miền hoặc từ khoá (vd: "myapp" hoặc "myapp.vn").'),
      tlds: z.string().max(200).optional().describe('Đuôi muốn tìm, phân cách phẩy (vd: "vn,com"). Mặc định: vn,com.'),
      years: z.number().int().min(1).max(10).optional().describe('Số năm đăng ký. Mặc định 1.'),
    }).strict(),
  }, ({ q, tlds, years }) => runTool(async () => {
    const params = new URLSearchParams({ q });
    if (tlds) params.set('tlds', tlds);
    if (years) params.set('years', String(years));
    return clients.vibecloud(`/api/domains/search?${params}`);
  }));

  server.registerTool('cloud_domain_registrant_get', {
    title: 'Xem thông tin chủ thể đăng ký tên miền',
    description: 'Lấy thông tin chủ thể (registrant) đã lưu. Cần dữ liệu này để mua tên miền.',
    inputSchema: z.object({}).strict(),
  }, () => runTool(() => clients.vibecloud('/api/domains/registrant')));

  server.registerTool('cloud_domain_registrant_set', {
    title: 'Cập nhật thông tin chủ thể đăng ký tên miền',
    description: 'Lưu hoặc cập nhật thông tin chủ thể. Tên miền .vn cá nhân cần CCCD 12 số, ngày sinh, giới tính.',
    inputSchema: registrantSchema,
  }, (args) => runTool(() => clients.vibecloud('/api/domains/registrant', {
    method: 'PUT',
    body: args,
  })));

  server.registerTool('cloud_domain_buy', {
    title: 'Mua tên miền',
    description: [
      'Mua tên miền và trừ ví VND. Trước khi gọi:',
      '1. Dùng cloud_domain_search để xem giá.',
      '2. Hỏi người dùng xác nhận chính tả tên miền (vd: "Bạn có muốn đăng ký example.vn không?") — đây là lý do spelling_confirmed=true/false.',
      '3. Hỏi người dùng duyệt chi phí (giá lấy từ cloud_domain_search).',
      '4. Tên miền .vn cần registrant có CCCD — dùng cloud_domain_registrant_set trước.',
      'sandbox=true: giả lập 0đ, không mua thật.',
    ].join(' '),
    inputSchema: z.object({
      name: domainName,
      years: z.number().int().min(1).max(10).optional().describe('Số năm đăng ký. Mặc định 1.'),
      spelling_confirmed: z.boolean()
        .describe('true = người dùng đã xác nhận chính tả tên miền; false = chặn, không mua.'),
      registrant_id: objectId.optional().describe('ID registrant (lấy từ cloud_domain_registrant_get). Để trống → dùng registrant mặc định.'),
      sandbox: z.boolean().optional().describe('sandbox=true: mô phỏng 0đ, không gọi MONA Host.'),
    }).strict(),
  }, ({ name, years, spelling_confirmed, registrant_id, sandbox }) => runTool(async () => {
    const body: Record<string, unknown> = { name, spelling_confirmed };
    if (years) body.years = years;
    if (registrant_id) body.registrant_id = registrant_id;
    return clients.guardedVibecloud('/api/domains', { method: 'POST', body }, sandbox === true);
  }));

  server.registerTool('cloud_domain_list', {
    title: 'Danh sách tên miền đã import/mua',
    description: 'Liệt kê tên miền đã đưa vào MONA Cloud (import + mua). sandbox=true → xem domain sandbox.',
    inputSchema: z.object({
      sandbox: z.boolean().optional().describe('true → hiện domain sandbox.'),
    }).strict(),
  }, ({ sandbox }) => runTool(async () => {
    const headers = sandbox ? { 'X-Vibecloud-Sandbox': '1' } : undefined;
    return clients.vibecloud('/api/domains', { headers });
  }));

  server.registerTool('cloud_domain_verify_start', {
    title: 'Bắt đầu nộp hồ sơ .vn',
    description: 'Sinh bản khai đã điền sẵn và link upload hồ sơ .vn. Dùng sau khi mua tên miền .vn (status=pending_verification).',
    inputSchema: z.object({
      id: objectId.describe('Order ID trả về khi cloud_domain_buy.'),
    }).strict(),
  }, ({ id }) => runTool(() => clients.vibecloud(`/api/domains/${encodeURIComponent(id)}/verify`, {
    method: 'POST',
  })));

  server.registerTool('cloud_domain_verify_status', {
    title: 'Trạng thái hồ sơ .vn',
    description: 'Kiểm tra trạng thái duyệt hồ sơ đăng ký .vn (profile_status từ MONA Host).',
    inputSchema: z.object({
      id: objectId.describe('Order ID của tên miền .vn.'),
    }).strict(),
  }, ({ id }) => runTool(() => clients.vibecloud(`/api/domains/${encodeURIComponent(id)}/verify`)));

  server.registerTool('cloud_domain_health', {
    title: 'Kiểm tra sức khoẻ tên miền',
    description: 'Kiểm tra hạn đăng ký, trạng thái hồ sơ, NS, SSL và cảnh báo tên miền đã mua.',
    inputSchema: z.object({
      id: objectId.describe('Order ID tên miền cần kiểm tra.'),
    }).strict(),
  }, ({ id }) => runTool(() => clients.vibecloud(`/api/domains/${encodeURIComponent(id)}/health`)));

  server.registerTool('cloud_domain_wait', {
    title: 'Chờ tên miền active',
    description: 'Long-poll cho đến khi tên miền chuyển sang active/failed (mặc định timeout=60s). Dùng sau cloud_domain_buy để chờ MONA Host xử lý.',
    inputSchema: z.object({
      id: objectId.describe('Order ID cần chờ.'),
      timeout: z.number().int().min(5).max(300).optional().describe('Timeout giây. Mặc định 60.'),
    }).strict(),
  }, ({ id, timeout }) => runTool(async () => {
    const params = timeout ? `?timeout=${timeout}` : '';
    return clients.vibecloud(`/api/domains/${encodeURIComponent(id)}/wait${params}`);
  }));

  server.registerTool('cloud_domain_webhook_set', {
    title: 'Đăng ký webhook tên miền',
    description: 'Đăng ký URL nhận sự kiện domain.status_changed (ký HMAC). Mỗi user 1 webhook; gọi lại để cập nhật.',
    inputSchema: z.object({
      url: z.string().url().refine((v) => v.startsWith('https://'), 'Cần URL HTTPS.'),
      secret: z.string().min(8).max(256).describe('Chuỗi bí mật để xác minh chữ ký HMAC.'),
    }).strict(),
  }, ({ url, secret }) => runTool(() => clients.vibecloud('/api/domains/webhook', {
    method: 'PUT',
    body: { url, secret },
  })));

  server.registerTool('cloud_domain_attach', {
    title: 'Gắn tên miền vào ứng dụng',
    description: [
      'Gắn tên miền vào app đã deploy. Tên miền .vn chưa active vẫn gọi được — attach đặt trước, server tự hoàn tất sau khi hồ sơ được duyệt và gửi webhook domain.status_changed.',
      'Dùng cloud_app_list để lấy app_id; domain_id là ID của domain row (từ cloud_domain_list).',
    ].join(' '),
    inputSchema: z.object({
      domain_id: objectId.describe('Domain ID (từ cloud_domain_list).'),
      app_id: objectId.describe('App ID cần gắn vào.'),
      sandbox: z.boolean().optional(),
    }).strict(),
  }, ({ domain_id, app_id, sandbox }) => runTool(async () => {
    const headers = sandbox ? { 'X-Vibecloud-Sandbox': '1' } : undefined;
    return clients.vibecloud(`/api/domains/${encodeURIComponent(domain_id)}/attach`, {
      method: 'POST',
      body: { app_id },
      headers,
    });
  }));
}
