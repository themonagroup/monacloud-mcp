# monacloud-mcp

`monacloud-mcp` là MCP hợp nhất của MONA Cloud: cài một lần, đăng nhập một MONA Pass và dùng chung ví VND để quản lý tài khoản, chạy app/VPS, tạo Base beta thay Supabase, tích hợp MONA Pay, gửi email giao dịch bằng MONA Mail và đọc catalog MONA Agent ngay trong Claude Code, Codex hoặc Cursor.

Human đăng ký MONA Pass một lần, duyệt chi phí, thêm DNS khi cần, quét QR nạp ví do AI tạo và cung cấp OTP/KYC khi bắt buộc. Các bước tạo yêu cầu nạp, tạo tài nguyên, đọc trạng thái, cấu hình webhook, test và deploy được thiết kế để AI agent làm qua MCP.

## 0.8.1 — luật nạp ví đứng đầu instructions

Codex chỉ chắc chắn đọc 512 ký tự đầu của `instructions` MCP, nên luật "ví thiếu → AI tự gọi `cloud_topup`, in QR, không bảo mở console" được đưa lên đầu; mô tả hệ và APP_FLOW đặt sau. Kiểm thử 17/09: Claude Code (sonnet) và Gemini (Antigravity CLI) tự gọi `cloud_topup` và in QR khi người dùng nói "ví hết tiền, nạp 50k"; Codex `exec` cần cho phép gọi MCP (mặc định chặn approval) rồi cũng làm được.

## 0.8.0 — Nạp ví ngay trong terminal

Ví thiếu tiền thì AI gọi `cloud_topup(amount)`; MCP trả **`qr_ascii`** (QR VietQR chuẩn EMVCo/NAPAS in bằng khối đầy `██`, Claude Code/Codex/Gemini CLI hiện được ngay; terminal nền sáng dùng `qr_ascii_light`, bản gọn `qr_ascii_small`; đã giải mã được bằng ZBar và OpenCV ở cả hai nền), `qr_file` (PNG tại `~/.config/monacloud/`), `qr_url` (ảnh VietQR) cùng ngân hàng, số tài khoản, số tiền, nội dung chuyển khoản. Người dùng mở app ngân hàng quét màn hình, tiền vào tự cộng ví; AI gọi `cloud_topup_status(topup_id)` tới khi `paid` rồi làm tiếp. Không còn bảo người dùng mở console để nạp; base64 không còn nằm trong text (tiết kiệm 15–25k token mỗi lần). Khi ví chung (`billing`) chưa nhận token hoặc merchant MONA Pay chưa cấu hình, `cloud_topup` tự chuyển sang đường compute `/api/payments/vietqr` (ví local, prefix VIBECLOUD, báo có tự cộng).

## 0.5.0 — MONA Base beta

Thêm `cloud_base_create/list/get/delete/credentials` cùng alias `vibecloud_base_*`. Base thay Supabase, chung MONA Pass/ví MONA Cloud và khớp app deploy. Sandbox chỉ ước tính, không provision; chờ Base provision-live trước khi publish package.

## 0.4.0 — Đưa thư mục hiện tại lên web

Prompt Claude Code: **“Đưa dự án này lên MONA Cloud, dùng thư mục hiện tại”**.

AI làm 99%: `cloud_app_detect(local_dir)` offline → đọc host và giá → sandbox nếu cần host mới → hỏi duyệt chi phí một lần → `cloud_app_create(local_dir)` → kiểm và trả URL. Có domain riêng thì `cloud_app_domain_add` và hướng dẫn CNAME. Human đăng ký MONA Pass qua device flow; hết credit 20k thì AI gọi `cloud_topup` và in QR, human chỉ quét.

| Tool | Đầu vào / hành vi 0.4.0 |
|---|---|
| `cloud_app_detect` | `local_dir`: stack, port, start, Dockerfile, build_type, tên env từ `.env.example`; không mạng |
| `cloud_app_create` | `local_dir`, `name?`, `build_type?`, `env?`, `port?`, `domain?`: ZIP → tạo source=upload → multipart → poll → `{url, app_id, build, seconds}` |
| `cloud_app_deploy` | `app_id`, `local_dir?`: có thư mục thì ZIP mới, upload, chờ rồi deploy; bỏ thư mục để dùng bản cũ |
| `cloud_app_domain_add` | `app_id`, `host`: gắn domain và nhận hướng dẫn CNAME |

```text
cloud_app_detect({ local_dir: "/absolute/path/to/project" })
cloud_app_create({ local_dir: "/absolute/path/to/project", name: "shop", sandbox: true })
// Sau khi đã duyệt chi phí
cloud_app_create({ local_dir: "/absolute/path/to/project", name: "shop" })
cloud_app_deploy({ app_id: "<app_id>", local_dir: "/absolute/path/to/project" })
```

ZIP tối đa 80 MiB, loại `.env*`, `*.pem`, `.git`, `node_modules` và symlink; áp dụng `.gitignore`/`.dockerignore`. `dist` được giữ mặc định. Git vẫn dùng `repo_url` như trước. [Hợp đồng upload, giới hạn và cách tiếp tục job](docs/local-deploy.md).

## Yêu cầu

- Node.js 20 trở lên.
- Một MONA Pass có quyền dùng client `monacloud-mcp`.
- MONA Pass, Billing, compute MONA Cloud và MONA Pay đã được cấu hình theo môi trường triển khai.

## Cài và đăng nhập

Đăng nhập lần đầu bằng OAuth Device Authorization Grant:

```bash
npx -y monacloud-mcp login
```

Lệnh in URL tại `pass.monacloud.vn` và mã thiết bị. Sau khi xác nhận, offline refresh token được lưu tại `~/.config/monacloud/token.json`; thư mục có mode `0700`, file có mode `0600`. Server tự refresh access token và không in token ra log.

Kiểm tra hoặc đăng xuất:

```bash
npx -y monacloud-mcp whoami
npx -y monacloud-mcp logout
```

### Claude Code

```bash
claude mcp add monacloud -- npx -y monacloud-mcp
```

### Codex (`~/.codex/config.toml`)

```toml
[mcp_servers.monacloud]
command = "npx"
args = ["-y", "monacloud-mcp"]
```

### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "monacloud": {
      "command": "npx",
      "args": ["-y", "monacloud-mcp"]
    }
  }
}
```

MCP client không cần giữ username/password sản phẩm. Có thể truyền PAT trực tiếp bằng `MONACLOUD_TOKEN` trong CI hoặc môi trường không dùng token store; không commit giá trị này.

## Tool

Tên tool dùng `snake_case` để giữ tương thích với prompt MONA Pay cũ.

### MONA Cloud

| Tool | Công dụng |
|---|---|
| `cloud_whoami` | Hồ sơ MONA Pass hiện tại |
| `cloud_balance` | Số dư ví VND chung |
| `cloud_ledger` | Ledger nạp/trừ/hoàn tiền có cursor |
| `cloud_topup(amount)` | Tạo yêu cầu nạp, trả `qr_ascii` (in trong terminal), `qr_file`, `qr_url`, ngân hàng/số TK/số tiền/nội dung; tự fallback compute khi ví chung chưa sẵn sàng |
| `cloud_topup_status(topup_id)` | Trạng thái yêu cầu nạp (pending/paid) kèm số dư, để chờ tiền vào rồi làm tiếp |
| `cloud_usage(period)` | Usage theo tháng, có thể lọc sản phẩm |
| `cloud_services` | Gom VPS/database, VA và webhook MONA Pay |
| `cloud_budget_set` / `cloud_budget_get` | Đặt và đọc budget theo product/project/token |
| `cloud_token_limit` | Đặt spend limit cho PAT/token |
| `cloud_open_console` | Trả URL console chung |

### MONA Pay

`monacloud-mcp` import `monapay-mcp` và re-export toàn bộ tool của package, không copy implementation. Dependency range là `^0.5.5`; bộ dependency offline tại lần verify này là 0.5.5 với 47 tool MONA Pay, gồm các nhóm:

- hồ sơ và nối ACB/VA bằng hai lần OTP;
- payment profile, checkout, VietQR, sandbox transaction và đối soát;
- webhook, log, thống kê và retry;
- email notification, verification, suppression và log;
- xoay key, kiểm chữ ký HMAC và sinh code mẫu webhook.

Các tên cũ như `monapay_create_qr`, `monapay_link_bank_start`, `monapay_create_webhook` được giữ nguyên. `monapay_link` là adapter chuyển tiếp: đổi MONA Pass thành `client_id/client_secret` rồi cache kín ở `~/.config/monacloud/links.json`. Adapter này sẽ được bỏ khi MONA Pay nhận JWT MONA Pass trực tiếp.

### Compute MONA Cloud

| Tool | Công dụng |
|---|---|
| `cloud_link` | Xác nhận direct MONA Pass; chỉ đổi sang `vc_live_*` nếu upstream còn ở chế độ cũ |
| `cloud_vps_create` | Hourly theo cấu hình; monthly theo `plan_code`, `period: month/year`, kiểm ví đủ giá kỳ |
| `cloud_db_create` | Tạo MongoDB, PostgreSQL hoặc MySQL |
| `cloud_job_status` | Poll job tới trạng thái cuối, có timeout |
| `cloud_services_list` | Liệt kê VPS/database |
| `cloud_service_start` / `cloud_service_stop` / `cloud_service_rebuild` | Quản lý vòng đời service |
| `cloud_prices` / `cloud_packages` | Đơn giá và gói cấu hình |
| `cloud_agent_deploy` | Stub có cấu trúc cho runtime MONA Agent wave sau |

### MONA Base (beta)

Base thay Supabase, dùng chung MONA Pass và ví MONA Cloud, đồng thời khớp với app deploy. Sandbox chỉ trả URL thử và ước tính, không tạo hạ tầng thật.

| Tool | Công dụng |
|---|---|
| `cloud_base_create` | Tạo Base, tự poll job và trả `base_id`, `studio_url`, `api_url`, `status` |
| `cloud_base_list` / `cloud_base_get` | Liệt kê hoặc đọc trạng thái Base |
| `cloud_base_credentials` | Đọc `anon_key`, `service_key`, `db_url`; bí mật, không log |
| `cloud_base_delete` | Xoá Base đã được duyệt |

Mỗi tool có alias `vibecloud_base_*` cùng schema và handler. Cần DB/Supabase cho app thì gọi `cloud_base_create`; Base dùng cùng account và khớp app deploy.

`cloud_service_stop` không bị chặn bởi số dư để người dùng luôn có thể hạn chế chi phí. Những lệnh tạo/start/rebuild thật đọc `GET /v1/balance` trước khi gọi compute MONA Cloud.

### MONA Mail

MONA Mail là dịch vụ gửi email giao dịch cho phần mềm và AI agent của người Việt: một API, trả VND, không cần thẻ, thuộc nhóm MONA Cloud của The MONA Group.

20 tool `mail_*` dùng MONA Pass sẵn có; tài khoản Mail được tạo tự động ở request đầu. Site: https://monamail.vn, API: https://api.monamail.vn.

| Tên | Việc |
|---|---|
| `mail_account` | Đọc tài khoản, email chủ, quota và bước kế tiếp |
| `mail_plans` | Đọc giá và quota hiện hành của các gói |
| `mail_plan_set` | Đổi gói, trừ ví VND khi chọn gói trả phí |
| `mail_send` | Gửi OTP/thông báo hoặc thử bằng `sandbox: true` |
| `mail_status` | Đọc trạng thái, events và nội dung sandbox |
| `mail_list` | Lọc lịch sử theo trạng thái, người nhận và thời gian |
| `mail_domain_add` | Thêm domain, trả records DNS và hướng dẫn |
| `mail_domain_verify` | Kiểm DKIM và xác minh domain |
| `mail_domain_cloudflare` | Thêm DNS bằng token Cloudflare của người dùng, dùng một lần, không lưu/log |
| `mail_domains_list` | Liệt kê domain cùng trạng thái |
| `mail_api_key_create` | Tạo key live/test, secret chỉ trả một lần |
| `mail_api_keys_list` | Xem prefix và trạng thái key |
| `mail_api_key_revoke` | Thu hồi key của app |
| `mail_webhook_create` | Đăng ký HTTPS endpoint và các sự kiện email |
| `mail_webhooks_list` | Liệt kê webhook |
| `mail_webhook_test` | Gửi payload `email.delivered` mẫu |
| `mail_suppressions_list` | Xem địa chỉ ngừng gửi và lý do |
| `mail_suppression_remove` | Gỡ suppression của tài khoản; không gỡ lớp toàn hệ |
| `mail_template_create` | Tạo mẫu với biến `{{ten_bien}}` |
| `mail_stats` | Đọc thống kê giao thư và bounce theo thời gian |

`mail_send` nhận 1 đến 50 người nhận, tối đa 10 tags, `subject` tối đa 998 ký tự và ít nhất một trong `html`/`text`. Khi dùng `template_id`, template thay cho `subject`/`html`/`text`. Sender `onboarding@monamail.vn` chỉ gửi tới email chủ từ `mail_account`; domain riêng cần verified trước khi gửi.

Key chỉ trả một lần; ghi vào `.env` của app dưới tên `MONAMAIL_API_KEY`, không cần in ra chat. MCP tiếp tục dùng MONA Pass; app dùng SDK `monamail` với key `mm_live_` hoặc `mm_test_`. Sandbox bằng `mail_send({ ..., sandbox: true })` gửi header `X-Mona-Sandbox: 1` và trả `sandbox: true`; sandbox không gửi ra Internet, không tính quota hoặc trừ ví. Dùng `mail_status` để xem `sandbox_preview`.

Mọi POST gửi `Idempotency-Key` từ `idempotency_key` hoặc tự tạo `mcp-mail-<uuid>`. Truyền key ổn định khi cần retry: trong 24 giờ, cùng key và body trả response cũ; khác body trả `idempotency_conflict`. MCP đưa key vào header, không đưa `sandbox` vào body API. Giá gói lấy bằng `mail_plans`; lỗi thiếu ví từ `mail_plan_set` hướng dẫn gọi `cloud_topup`.

## Thử 0đ bằng sandbox

Truyền `sandbox: true` cho `cloud_vps_create`, `cloud_db_create`, `cloud_service_start`, `cloud_service_rebuild` hoặc `cloud_agent_deploy` để thử luồng mà không cần số dư ví. Có thể bật mặc định cho cả MCP process bằng `MONACLOUD_SANDBOX=1`; các alias `vibecloud_*` có cùng hành vi.

Ở chế độ này MCP bỏ qua `GET /v1/balance`, tự gửi `X-Vibecloud-Sandbox: 1` đến compute API và bảo đảm response có `sandbox: true`. Ví dụ:

```text
cloud_vps_create({ app_name: "shop-demo", package_slug: "standard-2", sandbox: true })
cloud_job_status({ job_id: "...", sandbox: true })
cloud_services_list({ sandbox: true })
```

`cloud_job_status` tự tìm job sandbox theo ID mà không cần header. `cloud_services_list({ sandbox: true })` dùng khả năng `include_sandbox` của API để gộp service thật và sandbox. Sandbox không tạo hạ tầng thật, không trừ tiền và có thể bị dọn theo TTL của compute API. `cloud_agent_deploy` vẫn là stub cho đến khi runtime MONA Agent được phát hành, nhưng response sandbox được đánh dấu nhất quán.

### MONA Agent

- `agent_templates_list`: ưu tiên catalog local tại `~/monacloud/templates`, sau đó URL cấu hình, cuối cùng catalog wave 1 tích hợp.
- `agent_templates_get(template)`: trả các file `README.md`, `AGENTS.md`, `tools.json`, `deploy.md`, `CHECKLIST.md` và skill text.
- `agent_deploy(template)`: dùng cùng slot runtime với `cloud_agent_deploy`; hiện trả `agent_runtime_pending` theo yêu cầu stub của wave này.

## Resource và prompt

- `monacloud://llms`: mô tả máy đọc của toàn stack MONA Cloud.
- `monacloud://status`: health tổng hợp MONA Pass, Billing, compute MONA Cloud, MONA Pay và MONA Mail (`/v1/healthz`).
- Prompt `dung-app-ban-hang-monacloud`: chuỗi VPS → database → VA/QR → webhook → deploy, đọc giá, duyệt chi phí rồi tạo; dự án local dùng `cloud_app_detect` rồi `cloud_app_create(local_dir)`; git dùng `repo_url`.
- Prompt `gui-mail-otp-monamail(app_name?, framework?, domain?)`: account → thử onboarding → domain/DNS → verify → API key → `.env` → SDK OTP → webhook bounced; chỉ dừng ở bước thêm DNS hoặc nạp tiền.

## Spend guard và lỗi cho AI

Trước lệnh compute MONA Cloud thật có thể phát sinh tiền, MCP đọc ví chung. Sandbox bỏ qua bước này vì chi phí 0đ. HTTP `402 insufficient_funds` và `402 budget_exceeded` được chuẩn hoá thành text JSON:

```json
{
  "code": "budget_exceeded",
  "message": "Ví thiếu 20.000 đ hoặc đã chạm giới hạn chi tiêu.",
  "next_step": "Gọi cloud_topup để lấy QR nạp ví hoặc cloud_budget_set để tăng ngân sách rồi gọi lại tool.",
  "request_id": "req_..."
}
```

Token và linked secret không nằm trong payload lỗi hoặc log. `request_id` được giữ khi API upstream trả về để agent tự đối chiếu.

## Ví dụ một lượt: dựng app bán hàng

Người dùng nói:

> Dựng app bán hàng Node.js, có PostgreSQL và thu tiền VietQR, deploy lên MONA Cloud.

Agent thực hiện:

1. `cloud_whoami` → `cloud_balance` → `cloud_packages`.
2. Nếu ví thiếu: `cloud_topup(200000)`, in nguyên khối `qr_ascii` cho người dùng quét bằng app ngân hàng, rồi `cloud_topup_status` tới khi `paid`.
3. `cloud_vps_create` + `cloud_db_create`, sau đó `cloud_job_status` cho từng job.
4. `monapay_link` nếu adapter chuyển tiếp chưa có credential; `monapay_whoami` để kiểm tra VA.
5. Nếu chưa có VA: bắt đầu nối ACB, hỏi người dùng OTP đúng hai điểm bắt buộc, không tự đoán.
6. Agent viết endpoint webhook HMAC/idempotent, gọi `monapay_create_webhook`, `monapay_test_webhook`, `monapay_webhook_logs`.
7. Agent cắm `monapay_create_checkout` hoặc `monapay_create_qr`, deploy code lên VPS và báo URL cuối.

Chi tiết dành riêng cho agent: [`docs/ai-agent.md`](docs/ai-agent.md).

## Ví dụ một lượt: gửi mail OTP

Người dùng nói: “Tích hợp gửi mail OTP cho app shop bằng MONA Mail, domain shop.vn.”

1. `mail_account`: lấy email chủ, quota và domain đã xác minh.
2. Nếu chưa có domain, `mail_send` từ `onboarding@monamail.vn` tới email chủ, dùng idempotency key riêng; `mail_status` kiểm kết quả.
3. `mail_domain_add({ domain: "shop.vn" })`: đưa records để user thêm DNS, hoặc gọi `mail_domain_cloudflare` bằng token của họ; sau đó `mail_domain_verify`.
4. `mail_api_key_create({ name: "shop-otp", mode: "live" })`: ghi key trực tiếp vào `.env` dưới tên `MONAMAIL_API_KEY`.
5. Viết server dùng `new MonaMail(process.env.MONAMAIL_API_KEY)` và `monamail.emails.send(...)` với `tags: ["otp"]`; kiểm thư bằng `mail_status`.
6. Viết endpoint HMAC, `mail_webhook_create` với `events: ["email.bounced"]`, lưu secret rồi `mail_webhook_test`; khi thiếu ví gọi `cloud_topup` và chờ user nạp.

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MONACLOUD_ISSUER` | `https://pass.monacloud.vn/realms/mona` | OIDC issuer |
| `MONACLOUD_BILLING_URL` | `https://billing.monacloud.vn` | Billing/ví API |
| `MONAPAY_API` | `https://api.monapay.vn` | MONA Pay API |
| `MONAMAIL_API` | `https://api.monamail.vn` | MONA Mail API, dùng Bearer MONA Pass của MCP |
| `MONACLOUD_API` | `https://api.monacloud.vn` | Compute API của MONA Cloud |
| `MONACLOUD_CONSOLE_URL` | `https://monacloud.vn/console` | URL trả cho bước human |
| `MONACLOUD_TOKEN` | — | PAT/access token ưu tiên token store |
| `MONACLOUD_SANDBOX` | — | Đặt `1` để mọi lệnh compute hỗ trợ sandbox chạy thử 0đ, không cần ví |
| `MONACLOUD_CONFIG_DIR` | `~/.config/monacloud` | Token và link cache |
| `MONACLOUD_TEMPLATES_DIR` | `~/monacloud/templates` | Catalog agent local |
| `MONACLOUD_TEMPLATES_URL` | — | Catalog JSON từ xa, chỉ dùng khi local không có |
| `MONAPAY_LINK_PATH` | `/api/v1/client/oauth/mona-id/link` | Endpoint adapter chuyển tiếp |
| `VIBECLOUD_LINK_PATH` | `/api/auth/monaid/link` | Endpoint adapter cũ, chỉ gọi khi direct MONA Pass bị từ chối |

`VIBECLOUD_API`/`VIBECLOUD_API_URL`, `MONAPAY_CLIENT_ID` + `MONAPAY_CLIENT_SECRET` và `VIBECLOUD_API_TOKEN` chỉ là đường tương thích trong giai đoạn migrate. `logout` xoá cả token store lẫn linked credential cache; luồng đích là một MONA Pass.

## Phát triển offline

Không chạy `npm install` trong workspace handoff; `node_modules` đã được chuẩn bị sẵn.

```bash
node_modules/.bin/tsc -p tsconfig.json
node --test
```

Test dùng Node built-in, MCP transport thật qua stdio, process con và mock HTTP local. Trong sandbox cấm bind socket, test tự dùng fetch fixture tương đương. Bộ test không gọi Internet.

## Mới ở 0.3.0: gói tháng, hoá đơn và app từ git

| Tool mới | Công dụng |
|---|---|
| `cloud_plan_list` | Bảng gói và giá tháng/năm, gợi ý theo CPU/RAM/đĩa |
| `cloud_subscription_list` / `cloud_subscription_update` | Đọc gói, đổi chu kỳ, auto-renew; huỷ với `cancel_action: hourly/stop` |
| `cloud_invoice_list` / `cloud_invoice_pdf` | Xem hoá đơn và tải PDF về file tạm riêng tư |
| `cloud_credit_redeem` | Dùng mã credit được người dùng cung cấp |
| `cloud_app_create` / `cloud_app_list` / `cloud_app_get` | Deploy public repo HTTPS, poll job và đọc URL; **đang mở** |
| `cloud_app_deploy` / `cloud_app_env_set` | Deploy lại, thay env; **đang mở** |
| `cloud_app_domain_add` / `cloud_app_logs` / `cloud_app_delete` | CNAME domain, log build, xoá app; **đang mở** |
| `cloud_app_host_list` | Xem host và tài nguyên/chi phí; **đang mở** |

15 tool mới có 15 alias `vibecloud_` tương ứng. Tổng với MONA Pay 0.5.5 đang có: **135 tool** ở 0.4.0, gồm 20 Mail và 27 alias compute (thêm cloud_app_detect/vibecloud_app_detect). Package/MCP binary version: **0.4.0**.

```text
cloud_plan_list({ ram_gb: 4 })
# Đọc ví, báo giá, chờ duyệt rồi tạo:
cloud_vps_create({ app_name: "shop", billing_mode: "monthly", plan_code: "kinh-doanh", period: "month" })
cloud_invoice_pdf({ invoice_id: "<id>" })
cloud_app_host_list()
cloud_app_create({ repo_url: "https://github.com/example/shop.git", branch: "main", build_type: "nixpacks", sandbox: true })
```

Monthly bỏ qua CPU/RAM/đĩa và package_slug, đọc cấu hình/giá từ plan và guard toàn bộ giá tháng/năm. Backend chưa nhận monthly sandbox: MCP thử cấu hình plan qua hourly sandbox 0đ, trả giá thật trong `estimate`, không tạo subscription. Khi tạo thật phải tắt `MONACLOUD_SANDBOX` nếu đã bật env.

Khi user nói “deploy repo”, đọc host; chưa có host thì sandbox `cloud_app_create` để ước tính, hỏi duyệt rồi tạo thật và kiểm URL. Tool chờ job tối đa 600 giây; dùng `wait:false` và `cloud_job_status` nếu host MCP có timeout ngắn. Endpoint Wave B đang mở, lỗi API được báo thật.

Hợp đồng HTTP, đầy đủ tham số, ví dụ billing/deploy, PDF và giới hạn rollout: [docs/wave-ab.md](docs/wave-ab.md).
