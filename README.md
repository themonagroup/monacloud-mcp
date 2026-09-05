# monacloud-mcp

`monacloud-mcp` là MCP hợp nhất của MONA Cloud: cài một lần, đăng nhập một MONA Pass và dùng chung ví VND để quản lý tài khoản, chạy app/VPS, tích hợp MONA Pay và đọc catalog MONA Agent ngay trong Claude Code, Codex hoặc Cursor.

Human chỉ cần đăng ký, nạp tiền và cung cấp OTP/KYC khi bắt buộc. Các bước tạo tài nguyên, đọc trạng thái, cấu hình webhook, test và deploy được thiết kế để AI agent làm qua MCP.

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
| `cloud_topup(amount)` | Tạo yêu cầu nạp, trả `qr_data_url` và hướng dẫn VietQR |
| `cloud_usage(period)` | Usage theo tháng, có thể lọc sản phẩm |
| `cloud_services` | Gom VPS/database, VA và webhook MONA Pay |
| `cloud_budget_set` / `cloud_budget_get` | Đặt và đọc budget theo product/project/token |
| `cloud_token_limit` | Đặt spend limit cho PAT/token |
| `cloud_open_console` | Trả URL console chung |

### MONA Pay

`monacloud-mcp` import `monapay-mcp` và re-export toàn bộ tool của package, không copy implementation. Dependency range là `^0.3.0`; bộ dependency offline tại lần verify này là 0.5.5 với 47 tool MONA Pay, gồm các nhóm:

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
| `cloud_vps_create` | Tạo LXC theo `package_slug` hoặc CPU/RAM/đĩa |
| `cloud_db_create` | Tạo MongoDB, PostgreSQL hoặc MySQL |
| `cloud_job_status` | Poll job tới trạng thái cuối, có timeout |
| `cloud_services_list` | Liệt kê VPS/database |
| `cloud_service_start` / `cloud_service_stop` / `cloud_service_rebuild` | Quản lý vòng đời service |
| `cloud_prices` / `cloud_packages` | Đơn giá và gói cấu hình |
| `cloud_agent_deploy` | Stub có cấu trúc cho runtime MONA Agent wave sau |

`cloud_service_stop` không bị chặn bởi số dư để người dùng luôn có thể hạn chế chi phí. Những lệnh tạo/start/rebuild thật đọc `GET /v1/balance` trước khi gọi compute MONA Cloud.

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
- `monacloud://status`: health tổng hợp MONA Pass, Billing, compute MONA Cloud và MONA Pay.
- Prompt `dung-app-ban-hang-monacloud`: chuỗi VPS → database → VA/QR → webhook → deploy, chỉ dừng để hỏi nạp tiền hoặc OTP bắt buộc.

## Spend guard và lỗi cho AI

Trước lệnh compute MONA Cloud thật có thể phát sinh tiền, MCP đọc ví chung. Sandbox bỏ qua bước này vì chi phí 0đ. HTTP `402 insufficient_funds` và `402 budget_exceeded` được chuẩn hoá thành text JSON:

```json
{
  "code": "budget_exceeded",
  "message": "Ví thiếu 20.000 đ hoặc đã chạm giới hạn chi tiêu.",
  "next_step": "Nạp ví hoặc tăng ngân sách tại https://monacloud.vn/console rồi gọi lại tool.",
  "request_id": "req_..."
}
```

Token và linked secret không nằm trong payload lỗi hoặc log. `request_id` được giữ khi API upstream trả về để agent tự đối chiếu.

## Ví dụ một lượt: dựng app bán hàng

Người dùng nói:

> Dựng app bán hàng Node.js, có PostgreSQL và thu tiền VietQR, deploy lên MONA Cloud.

Agent thực hiện:

1. `cloud_whoami` → `cloud_balance` → `cloud_packages`.
2. Nếu ví thiếu: `cloud_topup(200000)`, đưa QR cho người dùng và chờ xác nhận.
3. `cloud_vps_create` + `cloud_db_create`, sau đó `cloud_job_status` cho từng job.
4. `monapay_link` nếu adapter chuyển tiếp chưa có credential; `monapay_whoami` để kiểm tra VA.
5. Nếu chưa có VA: bắt đầu nối ACB, hỏi người dùng OTP đúng hai điểm bắt buộc, không tự đoán.
6. Agent viết endpoint webhook HMAC/idempotent, gọi `monapay_create_webhook`, `monapay_test_webhook`, `monapay_webhook_logs`.
7. Agent cắm `monapay_create_checkout` hoặc `monapay_create_qr`, deploy code lên VPS và báo URL cuối.

Chi tiết dành riêng cho agent: [`docs/ai-agent.md`](docs/ai-agent.md).

## Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MONACLOUD_ISSUER` | `https://pass.monacloud.vn/realms/mona` | OIDC issuer |
| `MONACLOUD_BILLING_URL` | `https://billing.monacloud.vn` | Billing/ví API |
| `MONAPAY_API` | `https://api.monapay.vn` | MONA Pay API |
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
