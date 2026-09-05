# MONA Cloud MCP — hướng dẫn cho AI agent

Tài liệu này dành cho Claude, Codex, Cursor và agent dùng Model Context Protocol. Mục tiêu là hoàn thành tích hợp end-to-end mà không yêu cầu người dùng mở dashboard, trừ ba việc hợp lệ: đăng ký MONA Pass, nạp tiền và OTP/KYC bắt buộc.

## Quy tắc vận hành

1. Bắt đầu bằng `cloud_whoami`. Nếu nhận `login_required`, yêu cầu người dùng chạy `monacloud-mcp login`; không hỏi username hoặc password trong chat.
2. Trước khi provision thật, đọc `cloud_balance`, `cloud_packages` và `cloud_prices`. Với `sandbox: true`, không cần đọc hoặc nạp ví.
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

Deploy source lên VPS từ credential của job, đưa database connection string qua secret environment, chạy migration, bật HTTPS và gọi health endpoint. Sau đó:

- tạo checkout sandbox;
- tạo transaction sandbox;
- xác nhận webhook chỉ xử lý một lần khi event bị gửi lại;
- xác nhận đơn chuyển `paid` sau webhook;
- đọc `cloud_services` để báo lại toàn bộ service/VA/webhook;
- không echo credential nhạy cảm trong báo cáo.

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

## Tiêu chí hoàn tất

Một lượt được coi là xong khi app và database chạy, webhook HMAC test pass, sandbox checkout chuyển `paid`, credential nằm trong secret store, và agent báo lại URL cùng trạng thái dịch vụ. Không coi việc “đã tạo job” là hoàn tất; phải poll tới terminal state và kiểm health thực tế.
