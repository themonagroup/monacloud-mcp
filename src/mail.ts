import { randomUUID } from 'node:crypto';
import { domainToASCII } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CloudClients } from './clients.js';
import type { Config } from './config.js';
import { runTool } from './errors.js';

const id = z.string().trim().min(1).max(255);
const email = z.string().max(320).regex(/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/, 'Cần địa chỉ email hợp lệ.');
const mailbox = z.union([
  email,
  z.string().max(998).regex(/^[^<>\r\n]+<[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+>$/, 'Dùng email hoặc Tên <email>.'),
]);
const recipients = z.union([mailbox, z.array(mailbox).min(1).max(50)]);
const subject = z.string().min(1).max(998).regex(/^[^\r\n]+$/, 'Subject không chứa xuống dòng.');
const domain = z.string().trim().toLowerCase().transform(domainToASCII).pipe(
  z.string().max(253).regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/, 'Cần domain hợp lệ, không kèm URL.'),
);
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === 'https:', 'Cần URL HTTPS.');
const timestamp = z.iso.datetime({ offset: true });
const dateOrTimestamp = z.union([z.iso.date(), timestamp]);
const idempotency = {
  idempotency_key: z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/, 'Idempotency key dùng ký tự ASCII, không khoảng trắng.').optional()
    .describe('Giữ cùng key khi thử lại cùng yêu cầu trong 24 giờ. / Reuse for retries.'),
};
const empty = z.object({}).strict();
const events = z.enum([
  'email.sent', 'email.delivered', 'email.deferred', 'email.bounced',
  'email.complained', 'email.suppressed', 'email.failed', 'domain.verified',
  'inbox.message',
]);
const agentId = z.string().trim().min(1).max(64).regex(/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/, 'agent_id chỉ nhận chữ thường, số, dấu chấm, gạch dưới hoặc gạch nối.');
const inboxMatch = z.string().trim().min(1).max(200).describe('otp để lấy mã, hoặc regex khớp nội dung/subject/from.');
const status = z.enum(['queued', 'sent', 'delivered', 'deferred', 'bounced', 'complained', 'suppressed', 'failed', 'sandbox']);

function idempotencyHeaders(key?: string): Record<string, string> {
  return { 'Idempotency-Key': key || `mcp-mail-${randomUUID()}` };
}

export function registerMailTools(server: McpServer, clients: CloudClients, config: Config): void {
  server.registerTool('mail_account', {
    title: 'Tài khoản MONA Mail',
    description: `Khi bắt đầu tích hợp email, đọc tài khoản, quota và bước kế tiếp. / Use first to read account and quota at ${config.monamailApi}.`,
    inputSchema: empty,
  }, () => runTool(() => clients.mail('/v1/account')));

  server.registerTool('mail_plans', {
    title: 'Gói MONA Mail',
    description: 'Khi chọn gói gửi mail, đọc giá và quota hiện hành. / Use to compare current email plans.',
    inputSchema: empty,
  }, () => runTool(() => clients.mail('/v1/plans')));

  server.registerTool('mail_plan_set', {
    title: 'Đổi gói MONA Mail',
    description: 'Khi cần đổi quota, chọn gói; gói trả phí trừ ví VND, thiếu tiền gọi cloud_topup. / Use to change the email plan.',
    inputSchema: z.object({ plan: z.enum(['free', 'khoi-nghiep', 'kinh-doanh', 'doanh-nghiep']) }).strict(),
  }, ({ plan }) => runTool(() => clients.mail('/v1/account/plan', { method: 'PUT', body: { plan } })));

  server.registerTool('mail_send', {
    title: 'Gửi email giao dịch',
    description: 'Khi gửi OTP hoặc thông báo, dùng domain đã verify; onboarding@monamail.vn chỉ gửi tới email chủ. sandbox=true thử 0đ, không gửi ra Internet. / Use to send transactional email or test in sandbox.',
    inputSchema: z.object({
      from: mailbox,
      to: recipients,
      subject: subject.optional().describe('Bắt buộc nếu không dùng template_id. / Required without a template.'),
      html: z.string().min(1).optional(),
      text: z.string().min(1).optional(),
      reply_to: recipients.optional(),
      tags: z.array(z.string().regex(/^[a-z0-9_-]+$/)).max(10).optional(),
      template_id: id.optional(),
      variables: z.record(z.string(), z.unknown()).optional(),
      unsubscribe_url: httpsUrl.optional(),
      ...idempotency,
      sandbox: z.boolean().optional().describe('Gửi X-Mona-Sandbox: 1, không tính quota hoặc trừ ví. / Test without delivery or charges.'),
    }).strict().superRefine((value, context) => {
      if (!value.template_id) {
        if (!value.subject) context.addIssue({ code: 'custom', path: ['subject'], message: 'Cần subject khi không dùng template_id.' });
        if (!value.html && !value.text) context.addIssue({ code: 'custom', path: ['html'], message: 'Cần ít nhất html hoặc text khi không dùng template_id.' });
      }
    }),
  }, ({ sandbox, idempotency_key, ...body }) => runTool(async () => {
    const result = await clients.mail<Record<string, unknown>>('/v1/emails', {
      method: 'POST',
      headers: { ...idempotencyHeaders(idempotency_key), ...(sandbox ? { 'X-Mona-Sandbox': '1' } : {}) },
      body,
    });
    return sandbox ? { ...result, sandbox: true } : result;
  }));

  server.registerTool('mail_status', {
    title: 'Trạng thái email',
    description: 'Khi cần xác nhận thư đã giao, đọc trạng thái, events và sandbox_preview. / Use to inspect an email after sending.',
    inputSchema: z.object({ email_id: id }).strict(),
  }, ({ email_id }) => runTool(() => clients.mail(`/v1/emails/${encodeURIComponent(email_id)}`)));

  server.registerTool('mail_list', {
    title: 'Danh sách email',
    description: 'Khi tra lịch sử gửi, lọc theo trạng thái, người nhận hoặc thời gian. / Use to search sent email history.',
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20),
      status: status.optional(),
      to: email.optional(),
      since: timestamp.optional(),
    }).strict(),
  }, (query) => runTool(() => clients.mail('/v1/emails', { query })));

  server.registerTool('mail_domain_add', {
    title: 'Thêm domain gửi email',
    description: 'Khi gửi bằng domain của app, thêm domain. Trả record DNS; nếu người dùng dùng Cloudflare có thể gọi mail_domain_cloudflare với token của họ (không lưu). / Use to register a sender domain and get DNS records.',
    inputSchema: z.object({
      domain: domain.refine((value) => value !== 'monamail.vn' && !value.endsWith('.monamail.vn'), 'Dùng domain của anh chị, không dùng domain MONA Mail.'),
      ...idempotency,
    }).strict(),
  }, ({ domain, idempotency_key }) => runTool(async () => ({
    ...await clients.mail<Record<string, unknown>>('/v1/domains', {
      method: 'POST', headers: idempotencyHeaders(idempotency_key), body: { domain },
    }),
    instructions: 'Thêm các records vào DNS rồi gọi mail_domain_verify. Nếu dùng Cloudflare, gọi mail_domain_cloudflare với token người dùng cung cấp; token chỉ dùng một lần, không lưu. DKIM đúng là đủ để verify; SPF/DMARC là cảnh báo. Nếu đã có SPF, thêm include:_spf.monamail.vn vào record hiện có.',
  })));

  server.registerTool('mail_domain_verify', {
    title: 'Xác minh DNS domain',
    description: 'Khi đã thêm DNS, kiểm DKIM và trạng thái domain. / Use after adding DNS records to verify the sender domain.',
    inputSchema: z.object({ domain_id: id, ...idempotency }).strict(),
  }, ({ domain_id, idempotency_key }) => runTool(() => clients.mail(`/v1/domains/${encodeURIComponent(domain_id)}/verify`, {
    method: 'POST', headers: idempotencyHeaders(idempotency_key),
  })));

  server.registerTool('mail_domain_cloudflare', {
    title: 'Thêm DNS qua Cloudflare',
    description: 'Khi người dùng cung cấp token Cloudflare, thêm DNS rồi verify domain. Token dùng một lần, không lưu, không log. / Use a user-provided Cloudflare token to configure DNS and verify.',
    inputSchema: z.object({ domain_id: id, api_token: z.string().trim().min(1).max(4096), ...idempotency }).strict(),
  }, ({ domain_id, api_token, idempotency_key }) => runTool(() => clients.mail(`/v1/domains/${encodeURIComponent(domain_id)}/cloudflare`, {
    method: 'POST', headers: idempotencyHeaders(idempotency_key), body: { api_token },
  })));

  server.registerTool('mail_domains_list', {
    title: 'Domain MONA Mail',
    description: 'Khi chọn địa chỉ gửi, xem domain và trạng thái xác minh. / Use to find verified sender domains.',
    inputSchema: empty,
  }, () => runTool(() => clients.mail('/v1/domains')));

  server.registerTool('mail_api_key_create', {
    title: 'Tạo API key MONA Mail',
    description: 'Khi tích hợp SDK vào app, tạo key live hoặc test. Key chỉ trả một lần; ghi vào .env của app dưới tên MONAMAIL_API_KEY, không cần in ra chat. / Use to create an app key; store the one-time secret in .env.',
    inputSchema: z.object({ name: id, mode: z.enum(['live', 'test']), ...idempotency }).strict(),
  }, ({ idempotency_key, ...body }) => runTool(() => clients.mail('/v1/api-keys', {
    method: 'POST', headers: idempotencyHeaders(idempotency_key), body,
  })));

  server.registerTool('mail_api_keys_list', {
    title: 'Danh sách API key',
    description: 'Khi kiểm tra key của app, đọc prefix và trạng thái; không trả secret. / Use to inspect existing API key metadata.',
    inputSchema: empty,
  }, () => runTool(() => clients.mail('/v1/api-keys')));

  server.registerTool('mail_api_key_revoke', {
    title: 'Thu hồi API key',
    description: 'Khi key không còn dùng hoặc bị lộ, thu hồi bằng key_id. / Use to revoke an unused or compromised API key.',
    inputSchema: z.object({ key_id: id }).strict(),
  }, ({ key_id }) => runTool(() => clients.mail(`/v1/api-keys/${encodeURIComponent(key_id)}`, { method: 'DELETE' })));

  server.registerTool('mail_webhook_create', {
    title: 'Tạo webhook email',
    description: 'Khi app cần nhận sự kiện gửi hoặc bounce, đăng ký HTTPS webhook; lưu secret một lần vào .env, không log. / Use to subscribe an app to email events.',
    inputSchema: z.object({ url: httpsUrl, events: z.array(events).min(1).max(8), ...idempotency }).strict(),
  }, ({ idempotency_key, ...body }) => runTool(() => clients.mail('/v1/webhooks', {
    method: 'POST', headers: idempotencyHeaders(idempotency_key), body,
  })));

  server.registerTool('mail_webhooks_list', {
    title: 'Danh sách webhook email',
    description: 'Khi kiểm tra cấu hình sự kiện của app, liệt kê webhook. / Use to inspect registered email webhooks.',
    inputSchema: empty,
  }, () => runTool(() => clients.mail('/v1/webhooks')));

  server.registerTool('mail_webhook_test', {
    title: 'Thử webhook email',
    description: 'Khi đã có endpoint, gửi mẫu email.delivered để kiểm tra HTTP response. / Use to test webhook delivery to an app.',
    inputSchema: z.object({ webhook_id: id, ...idempotency }).strict(),
  }, ({ webhook_id, idempotency_key }) => runTool(() => clients.mail(`/v1/webhooks/${encodeURIComponent(webhook_id)}/test`, {
    method: 'POST', headers: idempotencyHeaders(idempotency_key),
  })));

  server.registerTool('mail_suppressions_list', {
    title: 'Địa chỉ ngừng gửi',
    description: 'Khi thư bị suppressed, xem địa chỉ và lý do ngừng gửi. / Use to diagnose suppressed recipients.',
    inputSchema: empty,
  }, () => runTool(() => clients.mail('/v1/suppressions')));

  server.registerTool('mail_suppression_remove', {
    title: 'Gỡ suppression tài khoản',
    description: 'Khi đã xử lý nguyên nhân chặn, gỡ suppression của tài khoản; lớp toàn hệ không gỡ được. / Use to remove an account-level suppression.',
    inputSchema: z.object({ email }).strict(),
  }, ({ email }) => runTool(() => clients.mail(`/v1/suppressions/${encodeURIComponent(email)}`, { method: 'DELETE' })));

  server.registerTool('mail_template_create', {
    title: 'Tạo mẫu email',
    description: 'Khi app dùng lại nội dung mail, tạo template với biến {{ten_bien}}. / Use to create a reusable email template.',
    inputSchema: z.object({ name: id, subject, html: z.string().min(1), text: z.string().min(1).optional(), ...idempotency }).strict(),
  }, ({ idempotency_key, ...body }) => runTool(() => clients.mail('/v1/templates', {
    method: 'POST', headers: idempotencyHeaders(idempotency_key), body,
  })));

  server.registerTool('mail_stats', {
    title: 'Thống kê gửi email',
    description: 'Khi đánh giá khả năng giao thư, đọc tỷ lệ delivered và bounce theo thời gian. / Use to review email delivery statistics.',
    inputSchema: z.object({ from: dateOrTimestamp.optional(), to: dateOrTimestamp.optional() }).strict().refine(
      (value) => !value.from || !value.to || Date.parse(value.from) <= Date.parse(value.to),
      'Thời điểm from phải trước hoặc bằng to.',
    ),
  }, (query) => runTool(() => clients.mail('/v1/stats', { query })));

  // ── Hộp thư AI agent (nhận + đọc + trả lời) ─────────────────────────────
  server.registerTool('mail_inbox_create', {
    title: 'Tạo hộp thư agent',
    description: 'Khi cần một địa chỉ email cho agent trực (đọc thư, trả lời), tạo hộp. Bỏ domain để dùng miền agent.monamail.vn (nhận ngay); truyền domain đã verify để có địa chỉ brand. / Use to create an inbox an AI agent can read and reply from.',
    inputSchema: z.object({ agent_id: agentId, domain: domain.optional() }).strict(),
  }, ({ agent_id, domain }) => runTool(() => clients.mail('/v1/inboxes', {
    method: 'POST', body: domain ? { agent_id, domain } : { agent_id },
  })));

  server.registerTool('mail_inbox_list', {
    title: 'Danh sách hộp agent',
    description: 'Khi cần biết agent đang trực những hộp nào, liệt kê hộp còn hoạt động. / Use to list active agent inboxes.',
    inputSchema: empty,
  }, () => runTool(() => clients.mail('/v1/inboxes')));

  server.registerTool('mail_inbox_get', {
    title: 'Xem hộp agent',
    description: 'Khi cần địa chỉ và trạng thái của một hộp, đọc chi tiết. / Use to read one inbox.',
    inputSchema: z.object({ inbox_id: id }).strict(),
  }, ({ inbox_id }) => runTool(() => clients.mail(`/v1/inboxes/${encodeURIComponent(inbox_id)}`)));

  server.registerTool('mail_inbox_delete', {
    title: 'Xóa hộp agent',
    description: 'Khi hộp không còn dùng, xóa mềm; thư cũ còn đọc tới hết retention. / Use to soft-delete an inbox.',
    inputSchema: z.object({ inbox_id: id }).strict(),
  }, ({ inbox_id }) => runTool(() => clients.mail(`/v1/inboxes/${encodeURIComponent(inbox_id)}`, { method: 'DELETE' })));

  server.registerTool('mail_inbox_messages', {
    title: 'Thư trong hộp agent',
    description: 'Khi trực hộp, liệt kê thư nhận; lọc seen=false để lấy thư chưa xử lý, phân trang bằng cursor. / Use to list messages an agent needs to handle.',
    inputSchema: z.object({
      inbox_id: id,
      seen: z.boolean().optional().describe('false = chỉ thư chưa đọc.'),
      since: timestamp.optional(),
      limit: z.number().int().min(1).max(100).default(50),
      cursor: z.string().min(1).max(255).optional(),
    }).strict(),
  }, ({ inbox_id, seen, since, limit, cursor }) => runTool(() => clients.mail(`/v1/inboxes/${encodeURIComponent(inbox_id)}/messages`, {
    query: { limit, cursor, since, ...(seen === undefined ? {} : { seen: String(seen) }) },
  })));

  server.registerTool('mail_inbox_message', {
    title: 'Đọc thư trong hộp',
    description: 'Khi cần nội dung đầy đủ, header và đính kèm của một thư, đọc chi tiết; lần đọc đầu đánh dấu đã xem. / Use to read a full inbox message before replying.',
    inputSchema: z.object({ inbox_id: id, message_id: id }).strict(),
  }, ({ inbox_id, message_id }) => runTool(() => clients.mail(
    `/v1/inboxes/${encodeURIComponent(inbox_id)}/messages/${encodeURIComponent(message_id)}`,
  )));

  server.registerTool('mail_inbox_reply', {
    title: 'Trả lời thư trong hộp',
    description: 'Khi agent trả lời khách, gửi đúng thread (In-Reply-To, References) từ địa chỉ hộp; cần text hoặc html. Việc khó rút lại (hứa giá, chuyển tiền) thì báo người, đừng tự gửi. / Use to reply to an inbox message in-thread.',
    inputSchema: z.object({ inbox_id: id, message_id: id, text: z.string().min(1).optional(), html: z.string().min(1).optional() })
      .strict().refine((value) => value.text || value.html, 'Cần text hoặc html để trả lời.'),
  }, ({ inbox_id, message_id, ...body }) => runTool(() => clients.mail(
    `/v1/inboxes/${encodeURIComponent(inbox_id)}/messages/${encodeURIComponent(message_id)}/reply`,
    { method: 'POST', body },
  )));

  server.registerTool('mail_inbox_wait', {
    title: 'Chờ thư trong hộp',
    description: 'Khi cần chờ thư tới (ví dụ mã OTP hoặc thư khớp mẫu), chờ tối đa timeout giây; có thư khớp trả full nội dung + extracted_code, hết giờ trả 204. Gọi lại nếu cần chờ lâu hơn. / Use to wait for an OTP or a matching message.',
    inputSchema: z.object({ inbox_id: id, match: inboxMatch, timeout: z.number().int().min(0).max(300).default(120) }).strict(),
  }, ({ inbox_id, match, timeout }) => runTool(() => clients.mail(`/v1/inboxes/${encodeURIComponent(inbox_id)}/wait`, {
    query: { match, timeout },
  })));
}
