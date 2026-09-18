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
    description: 'Lưu thông tin chủ thể để đăng ký tên miền. HỎI NGƯỜI DÙNG cung cấp NGAY TRONG PHIÊN: họ tên, email, điện thoại, địa chỉ. Tên miền .vn cá nhân cần thêm CCCD 12 số + ngày sinh (DD/MM/YYYY) + giới tính; .vn tổ chức cần org_name + tax_code (MST) + representative. Lưu 1 lần, tái dùng cho các domain sau. Không tự bịa dữ liệu — thiếu trường nào thì hỏi đúng trường đó.',
    inputSchema: registrantSchema,
  }, (args) => runTool(() => clients.vibecloud('/api/domains/registrant', {
    method: 'PUT',
    body: args,
  })));

  server.registerTool('cloud_domain_buy', {
    title: 'Mua tên miền',
    description: [
      'Mua tên miền và trừ ví VND — làm trọn trong phiên, không bảo người dùng mở web. Trước khi gọi:',
      '1. cloud_domain_search để xem giá + còn trống.',
      '2. Hỏi người dùng xác nhận chính tả tên miền (vd: "Đăng ký example.vn nhé?") → spelling_confirmed. WHOIS không sửa được sau khi mua.',
      '3. Hỏi duyệt chi phí (giá từ search).',
      '4. cloud_domain_registrant_set để lưu thông tin chủ thể (hỏi người dùng ngay trong phiên); .vn cần CCCD/MST.',
      'Khi gọi mà trả 402 insufficient_balance → gọi cloud_topup, IN NGUYÊN KHỐI qr_ascii (QR VietQR) cho người dùng quét bằng app ngân hàng NGAY trong terminal, chờ cloud_topup_status=paid rồi gọi lại cloud_domain_buy. Không bảo người dùng mở console để nạp.',
      'Kết quả có suggested_next → gợi ý người dùng deploy app lên MONA Cloud (cloud_app_create) và gắn domain (cloud_domain_attach).',
      '.vn sau khi mua ở trạng thái pending_verification → dùng cloud_domain_verify_start (link eKYC/bản khai) rồi cloud_domain_wait.',
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

  const recordSchema = {
    type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS']).describe('Loại bản ghi.'),
    name: z.string().min(1).max(253).describe('Tên bản ghi ("@" cho gốc, "www", "api"...).'),
    data: z.string().min(1).max(2048).describe('Giá trị (IP cho A, hostname cho CNAME, nội dung cho TXT...).'),
    ttl: z.number().int().min(60).max(86400).optional().describe('TTL giây (mặc định để trống).'),
    priority: z.number().int().min(0).max(65535).optional().describe('Ưu tiên (MX/SRV).'),
  };

  server.registerTool('cloud_domain_dns_list', {
    title: 'Xem bản ghi DNS của tên miền',
    description: 'Liệt kê bản ghi DNS (A/CNAME/MX/TXT...) của tên miền đăng ký tại MONA Cloud. domain_id lấy từ cloud_domain_list.',
    inputSchema: z.object({ domain_id: objectId }).strict(),
  }, ({ domain_id }) => runTool(() => clients.vibecloud(`/api/domains/${encodeURIComponent(domain_id)}/records`)));

  server.registerTool('cloud_domain_dns_add', {
    title: 'Thêm bản ghi DNS',
    description: 'Thêm 1 bản ghi DNS. Vd trỏ web: type=A, name=@, data=<IP>. Trỏ www: type=CNAME, name=www, data=<domain>. AI làm trọn, không cần mở dashboard.',
    inputSchema: z.object({ domain_id: objectId, ...recordSchema }).strict(),
  }, ({ domain_id, ...record }) => runTool(() =>
    clients.vibecloud(`/api/domains/${encodeURIComponent(domain_id)}/records`, { method: 'POST', body: record })));

  server.registerTool('cloud_domain_dns_update', {
    title: 'Sửa bản ghi DNS',
    description: 'Sửa 1 bản ghi DNS theo record_id (lấy từ cloud_domain_dns_list).',
    inputSchema: z.object({ domain_id: objectId, record_id: z.string().min(1).max(128), ...recordSchema }).strict(),
  }, ({ domain_id, record_id, ...record }) => runTool(() =>
    clients.vibecloud(`/api/domains/${encodeURIComponent(domain_id)}/records/${encodeURIComponent(record_id)}`, { method: 'PUT', body: record })));

  server.registerTool('cloud_domain_dns_delete', {
    title: 'Xoá bản ghi DNS',
    description: 'Xoá 1 bản ghi DNS theo record_id.',
    inputSchema: z.object({ domain_id: objectId, record_id: z.string().min(1).max(128) }).strict(),
  }, ({ domain_id, record_id }) => runTool(() =>
    clients.vibecloud(`/api/domains/${encodeURIComponent(domain_id)}/records/${encodeURIComponent(record_id)}`, { method: 'DELETE' })));

  server.registerTool('cloud_domain_ns_set', {
    title: 'Đổi nameserver (NS) của tên miền',
    description: 'Đổi NS cho tên miền (≥2). Vd giữ DNS ở MONA: ns1.mona.host, ns2.mona.host. Hoặc chuyển sang Cloudflare/nhà khác. AI làm hoàn toàn.',
    inputSchema: z.object({
      domain_id: objectId,
      ns_list: z.array(z.string().min(3).max(253)).min(2).max(6).describe('Danh sách hostname NS, tối thiểu 2.'),
    }).strict(),
  }, ({ domain_id, ns_list }) => runTool(() =>
    clients.vibecloud(`/api/domains/${encodeURIComponent(domain_id)}/ns`, { method: 'PATCH', body: { ns_list } })));

  server.registerPrompt('mua-ten-mien-monacloud', {
    title: 'Mua tên miền cho app — làm trọn trong phiên (gợi ý, hỏi info, bắn QR, mua)',
    description: 'AI tự tra + báo giá + hỏi thông tin chủ thể + nạp ví bằng QR trong terminal + mua + xác thực .vn, không bảo người dùng mở web.',
    argsSchema: {
      keyword: z.string().optional(),
      app_id: z.string().optional(),
    },
  }, ({ keyword, app_id }) => ({ messages: [{
    role: 'user',
    content: {
      type: 'text',
      text: `Mua giúp tôi tên miền${keyword ? ` quanh "${keyword}"` : ''} bằng MONA Cloud, làm trọn ngay trong phiên này, đừng bảo tôi mở web:
1. cloud_domain_search để tìm tên còn trống + báo giá VND (ưu tiên .vn và .com; nói rõ giá đã gồm VAT).
2. Hỏi tôi chọn tên nào và XÁC NHẬN CHÍNH TẢ (WHOIS không sửa được sau khi mua).
3. cloud_domain_registrant_set: HỎI TÔI thông tin chủ thể ngay trong phiên — họ tên, email, điện thoại, địa chỉ; nếu là .vn cá nhân hỏi thêm CCCD 12 số + ngày sinh + giới tính (tổ chức: tên công ty + MST + người đại diện). Đừng tự bịa.
4. Kiểm ví bằng cloud_balance. Nếu thiếu tiền, gọi cloud_topup rồi IN NGUYÊN KHỐI qr_ascii (QR VietQR) cho tôi quét bằng app ngân hàng ngay trong terminal; chờ cloud_topup_status=paid.
5. cloud_domain_buy (spelling_confirmed=true) — trừ ví, mua thật.
6. Nếu là .vn: cloud_domain_verify_start đưa tôi link eKYC/bản khai (chụp CCCD + chân dung / ký), rồi cloud_domain_wait tới khi active.
7. ${app_id ? `Gắn vào app ${app_id} bằng cloud_domain_attach` : 'Gợi ý tôi deploy app lên MONA Cloud (cloud_app_create) rồi gắn domain bằng cloud_domain_attach'} — trỏ DNS + SSL tự động.
Trả VND, không cần thẻ quốc tế, không mở dashboard.`,
    },
  }] }));
}
