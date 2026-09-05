# MONA Cloud MCP — hướng dẫn cho AI agent

Tài liệu này dành cho Claude, Codex, Cursor và agent dùng Model Context Protocol. Mục tiêu là hoàn thành tích hợp end-to-end mà không yêu cầu người dùng mở dashboard; các bước human gồm đăng ký MONA Pass, duyệt chi phí, thêm DNS khi cần, nạp tiền và OTP/KYC bắt buộc.

## Quy tắc vận hành

1. Bắt đầu bằng `cloud_whoami`. Nếu nhận `login_required`, yêu cầu người dùng chạy `monacloud-mcp login`; không hỏi username hoặc password trong chat.
2. Trước khi provision thật, đọc `cloud_balance`, `cloud_plan_list` hoặc `cloud_packages`/`cloud_prices`; báo ước tính và hỏi duyệt chi phí nếu chưa được duyệt. Với `sandbox: true`, không cần đọc hoặc nạp ví.
3. Khi cần nạp, gọi `cloud_topup`; đưa nguyên `qr_data_url`, số tiền, nội dung và hạn thanh toán cho người dùng. Chỉ tiếp tục sau khi `cloud_balance` phản ánh tiền vào.
4. Với OTP ngân hàng, dừng đúng sau `monapay_link_bank_start` và `monapay_notification_register`. Hỏi người dùng mã vừa nhận; không suy đoán, brute-force hoặc ghi OTP vào source/log.
5. Mọi endpoint webhook phải xác minh HMAC, chống replay theo timestamp và idempotent theo `transaction_code`.
6. Không giao hàng chỉ dựa vào browser redirect. Chỉ xác nhận đơn sau webhook `CHECKOUT_PAID` hoặc đối soát server-side.
7. Nếu tool trả `isError`, parse text content thành `{code,message,next_step,request_id?}` và làm theo `next_step`. Không retry vô hạn lệnh ghi.

## Xác thực

MCP dùng OAuth 2.0 Device Authorization Grant với public client `monacloud-mcp`, scope:

```text
openid profile email product billing-api offline_access
```

Token store mặc định là `~/.config/monacloud/token.json`, mode `0600`. Access token tự refresh bằng offline refresh token. Trong CI, `MONACLOUD_TOKEN` có thể cung cấp PAT trực tiếp.

Không in hoặc copy token vào source, issue, log, output tool hay nội dung webhook. Sản phẩm đích xác minh JWT MONA Pass và audience tương ứng.

### Adapter chuyển tiếp

MONA Pay và compute MONA Cloud có thể chưa nhận JWT MONA Pass trực tiếp tại thời điểm wave 1:

- gọi `monapay_link` một lần để nhận/cache `client_id/client_secret` MONA Pay;
- gọi `cloud_link` để xác nhận direct MONA Pass; tool chỉ nhận/cache `vc_live_*` khi upstream từ chối JWT và còn bật adapter cũ;
- linked credential nằm ở `~/.config/monacloud/links.json`, mode `0600`;
- không gọi link lại ở mỗi request;
- khi upstream nhận JWT trực tiếp, bỏ adapter mà không đổi tên tool nghiệp vụ.

Nếu tài khoản MONA Pay cũ cần OTP email để link, trả quyền điều khiển cho người dùng ở đúng bước OTP rồi tiếp tục `monapay_link`.

## Luồng dựng app bán hàng

### 1. Kiểm tra account, ví và cấu hình hạ tầng

```text
cloud_whoami
cloud_balance
cloud_packages
cloud_prices
```

Chọn `package_slug` nếu có thể. Chỉ dùng custom sizing khi cần; không gửi đồng thời `package_slug` và `cpu/ram_gb/disk_gb`.

Nếu ví thiếu:

```text
cloud_topup({ amount: 200000, idempotency_key: "topup:<project>:<stable-id>" })
```

Giữ cùng idempotency key khi retry cùng một yêu cầu nạp.

### 2. Tạo compute và database

```text
cloud_vps_create({ app_name: "shop-demo", package_slug: "standard-2" })
cloud_db_create({ app_name: "shop-demo", engine: "postgresql", package_slug: "standard-2" })
```

Mỗi response là job. Dùng:

```text
cloud_job_status({ job_id: "...", wait: true, interval_sec: 3, timeout_sec: 180 })
```

Chỉ dùng `result`/credential khi trạng thái `succeeded`. Với `failed`, đọc `error`; sửa nguyên nhân rồi mới retry. Không đưa database password vào commit hoặc response công khai.

### 3. Chuẩn bị MONA Pay

```text
monapay_link
monapay_whoami
```

Nếu chưa có tài khoản ngân hàng/VA:

```text
monapay_link_bank_start
→ DỪNG, hỏi OTP ACB
monapay_link_bank_verify_otp
monapay_notification_register
→ DỪNG, hỏi OTP ACB lần hai
monapay_notification_verify_otp
```

Đây là hai điểm human-in-the-loop bắt buộc. Không yêu cầu người dùng đưa username/password ACB hoặc MONA Pay.

### 4. Viết và test webhook

1. Lấy code mẫu bằng `monapay_generate_webhook_snippet`.
2. Tạo HTTPS endpoint trong app.
3. Xác minh `X-Mona-Signature = sha256=HMAC-SHA256(secret, "<timestamp>.<raw_body>")`.
4. Từ chối timestamp lệch quá 300 giây.
5. Dùng `transaction_code` làm unique idempotency key.
6. Đăng ký bằng `monapay_create_webhook` với `HMAC_SHA256` và secret ngẫu nhiên ít nhất 32 ký tự.
7. Gọi `monapay_test_webhook`; đọc `monapay_webhook_logs` và `monapay_webhook_stats`.

### 5. Thu tiền

Ưu tiên hosted checkout khi app cần link thanh toán:

```text
monapay_create_checkout({
  amount: 250000,
  order_code: "DH_10234",
  return_url: "https://shop.example/checkout/return",
  idempotency_key: "checkout:DH_10234"
})
```

Dùng `monapay_create_qr` khi đã có đủ thông tin ACB/VA và cần render QR trực tiếp. Sandbox dùng `monapay_sandbox_transaction`; không test bằng tiền thật.

### 6. Deploy và xác minh

Với repo git, ưu tiên `cloud_app_create` (đang mở): đọc `cloud_app_host_list`, sandbox trước nếu chưa có host, báo ước tính và duyệt rồi deploy thật. Dùng secret env, chạy migration và kiểm HTTPS/health. Chỉ triển khai VPS thủ công nếu người dùng chọn. Sau đó:

- tạo checkout sandbox;
- tạo transaction sandbox;
- xác nhận webhook chỉ xử lý một lần khi event bị gửi lại;
- xác nhận đơn chuyển `paid` sau webhook;
- đọc `cloud_services` để báo lại toàn bộ service/VA/webhook;
- không echo credential nhạy cảm trong báo cáo.

## MONA Mail

MONA Mail là dịch vụ gửi email giao dịch cho phần mềm và AI agent của người Việt: một API, trả VND, không cần thẻ, thuộc nhóm MONA Cloud của The MONA Group.

20 tool `mail_*` gọi `MONAMAIL_API` (mặc định `https://api.monamail.vn`) bằng access token MONA Pass hiện tại. JWT cần audience `monamail` hoặc `mona-products`; scope `product` đã có trong MCP. Tài khoản Mail được tạo tự động từ `sub` và `email` ở request đầu, không cần link hoặc đăng ký sản phẩm riêng.

Dùng prompt `gui-mail-otp-monamail` với `app_name?`, `framework?`, `domain?` và thực hiện:

1. `mail_account` lấy email chủ, quota, domain và `next_step`. `mail_plans` đọc gói và giá hiện hành khi cần đổi quota.
2. Nếu chưa có domain verified, `mail_send` từ `onboarding@monamail.vn` tới đúng email chủ. Gọi `mail_status` theo `id`; `queued` hoặc `sent` chưa có nghĩa thư đã tới hộp nhận.
3. `mail_domain_add` trả records DKIM/SPF/DMARC. Dừng ở bước DNS để user thêm records hoặc cung cấp token Cloudflare. Nếu đã có token, gọi `mail_domain_cloudflare` ngay; token dùng một lần, không ghi file, cache, log hoặc chat. Nếu có SPF sẵn, gộp `include:_spf.monamail.vn` vào record hiện có.
4. `mail_domain_verify` đọc `checks`; chỉ gửi bằng domain riêng khi `status=verified`. DKIM đúng là đủ để verify, SPF/DMARC là cảnh báo.
5. `mail_api_key_create` với `name` của app và `mode: "live"` hoặc `"test"`. Key chỉ trả một lần; ghi thẳng vào `.env` dưới tên `MONAMAIL_API_KEY`, bảo đảm `.env` không vào git. Chỉ dùng prefix để nhận diện key trong báo cáo. MCP vẫn dùng MONA Pass, app dùng key của SDK.
6. Tích hợp SDK `monamail` tại server; sinh OTP ngẫu nhiên, có hạn dùng và giới hạn số lần thử. Gửi bằng `monamail.emails.send`, sau đó kiểm trạng thái qua `mail_status`.
7. Viết HTTPS endpoint cho `email.bounced`, đăng ký `mail_webhook_create`, lưu secret riêng trong `.env`, gọi `mail_webhook_test`. Payload test là `email.delivered`, endpoint cần tiếp nhận mẫu này để kiểm đường truyền. Xem `mail_suppressions_list` khi địa chỉ bị ngừng gửi; `mail_suppression_remove` chỉ gỡ lớp account, API có thể trả `global_suppression` cho lớp toàn hệ.

Ví dụ code Node.js trong app sau khi có key và domain verified:

```ts
import { MonaMail } from 'monamail';

const monamail = new MonaMail(process.env.MONAMAIL_API_KEY);
const { id } = await monamail.emails.send({
  from: 'Shop <noreply@shop.vn>',
  to: emailNguoiNhan,
  subject: 'Mã OTP',
  text: `Mã OTP: ${otp}`,
  tags: ['otp'],
  idempotency_key: requestId,
});
```

`emailNguoiNhan`, `otp` và `requestId` lấy từ luồng xác thực của app. Dùng `MonaMail.verifyWebhook({ secret, timestamp, body, signature })` kiểm `X-Mona-Signature` trên `"<X-Mona-Timestamp>.<raw_body>"`. Chống replay theo timestamp, xử lý event một lần theo payload `id`/`X-Mona-Event-Id`.

Ranh giới human của luồng Mail sau đăng nhập là **thêm DNS và nạp tiền**. Khi `mail_plan_set` trả `insufficient_funds`, gọi `cloud_topup`, đưa VietQR cho user và chờ `cloud_balance` cập nhật trước khi thử lại. Không yêu cầu user mở dashboard lấy API key. Lỗi Mail giữ `code`, `message`, `next_step`, `request_id` từ API, gồm `domain_not_verified`, `quota_exceeded`, `budget_exceeded` và `idempotency_conflict`.

### Sandbox và idempotency Mail

- MCP: `mail_send({ ..., sandbox: true })` gửi `X-Mona-Sandbox: 1`, kết quả có `sandbox: true`.
- App: key `mm_test_` bật sandbox qua SDK; key `mm_live_` dùng để gửi thật. `MONACLOUD_SANDBOX` dành cho compute, không tự bật sandbox Mail.
- Sandbox đi qua pipeline nhưng không gửi ra Internet, không tính quota hoặc trừ ví. Dùng `mail_status` để đọc trạng thái `sandbox` và `sandbox_preview`; không báo thư sandbox đã được giao thật.
- Mọi POST Mail có header `Idempotency-Key`: dùng tham số `idempotency_key` hoặc MCP tự tạo `mcp-mail-<uuid>`. Khi retry phải truyền cùng key và giữ nguyên body trong TTL 24 giờ. Cùng key/body trả response cũ, khác body trả 409 `idempotency_conflict`. Nếu bỏ key, mỗi lần gọi MCP là yêu cầu mới.

## Spend guard

`cloud_vps_create`, `cloud_db_create`, `cloud_service_start` và `cloud_service_rebuild` đọc `GET /v1/balance` trước khi gọi sản phẩm thật. Upstream vẫn là nguồn quyết định cuối và có thể trả:

```json
{
  "code": "insufficient_funds",
  "message": "Ví thiếu tiền...",
  "next_step": "Nạp ví tại https://monacloud.vn/console rồi gọi lại tool."
}
```

hoặc `budget_exceeded`. Khi gặp hai code này, không retry. Gọi `cloud_topup`, `cloud_budget_get` hoặc yêu cầu user tăng budget. `cloud_service_stop` luôn được phép vì chặn stop có thể làm tăng rủi ro chi phí.

## Thử 0đ bằng sandbox

Thêm `sandbox: true` khi gọi `cloud_vps_create`, `cloud_db_create`, `cloud_service_start`, `cloud_service_rebuild` hoặc `cloud_agent_deploy`. Có thể đặt `MONACLOUD_SANDBOX=1` để bật cho toàn bộ MCP process. Alias `vibecloud_*` tương ứng hoạt động giống hệt.

```text
cloud_vps_create({ app_name: "shop-demo", package_slug: "standard-2", sandbox: true })
cloud_db_create({ app_name: "shop-demo", engine: "postgresql", package_slug: "standard-2", sandbox: true })
cloud_job_status({ job_id: "...", sandbox: true })
cloud_services_list({ sandbox: true })
```

Với lệnh tạo/start/rebuild sandbox, MCP không gọi Billing, tự gửi `X-Vibecloud-Sandbox: 1`, và response có `sandbox: true`. `cloud_job_status` tra job theo ID mà không cần header; trạng thái `done` là terminal hợp lệ của sandbox. `cloud_services_list({ sandbox: true })` dùng `include_sandbox=1`, cũng không cần header, để gộp service thật và sandbox.

Sandbox không gọi Proxmox, không cấp IP thật, không trừ tiền và có TTL do compute API quản lý. Chỉ chuyển sang lệnh thật khi người dùng yêu cầu rõ ràng. `cloud_agent_deploy` hiện vẫn trả `agent_runtime_pending`; sandbox chỉ đánh dấu response nhất quán, không giả vờ đã deploy.

## Catalog MONA Agent

`agent_templates_list` trả nguồn catalog và danh sách slug. `agent_templates_get` trả toàn bộ file text cần để agent build local. Không tự nối path từ input ngoài; chỉ dùng slug đã trả.

`agent_deploy` và `cloud_agent_deploy` hiện là stub có chủ đích, trả `agent_runtime_pending`; không giả vờ đã provision. Khi nhận code này, có thể đọc template và triển khai thủ công hoặc báo rõ runtime hosted chưa được bật.

## Resource hữu ích

- Đọc `monacloud://llms` khi cần bối cảnh toàn hệ sinh thái.
- Đọc `monacloud://status` trước khi kết luận lỗi là do credential hoặc request.
- Dùng prompt `dung-app-ban-hang-monacloud` để lấy chuỗi tác vụ chuẩn.
- Dùng prompt `gui-mail-otp-monamail` để tích hợp OTP, DNS, API key và webhook Mail.

## Tiêu chí hoàn tất

Một lượt được coi là xong khi app và database chạy, webhook HMAC test pass, sandbox checkout chuyển `paid`, credential nằm trong secret store, và agent báo lại URL cùng trạng thái dịch vụ. Không coi việc “đã tạo job” là hoàn tất; phải poll tới terminal state và kiểm health thực tế.

## Wave A/B (0.3.0)

Xem [bảng tool và hợp đồng HTTP](wave-ab.md) cho 15 tool mới, VPS monthly, subscriptions, invoices/PDF, credit và app từ git. Khi user nói “deploy repo”, dùng `cloud_app_create`; `agent_deploy` vẫn là stub cho runtime template. Đọc → ước tính → hỏi duyệt nếu chưa được duyệt → làm. Chưa có app host thì sandbox trước, sau khi hoàn tất kiểm URL thật.
