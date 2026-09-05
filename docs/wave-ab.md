# Wave A/B — gói tháng, hoá đơn và app từ git (0.3.0)

Luồng mặc định: **đọc → ước tính VND → hỏi duyệt nếu chưa được duyệt → làm → kiểm kết quả**. Các tool dưới đây đều có alias `vibecloud_` cùng hậu tố, schema và hành vi; riêng alias VPS cũ vẫn là `vibecloud_create_vps`.

## Bảng tool

| Tool | HTTP compute | Dùng khi |
|---|---|---|
| `cloud_plan_list` | GET `/api/plans` | Xem giá tháng/năm, cấu hình, included_db/backup; gợi ý gói rẻ nhất đủ CPU/RAM/đĩa yêu cầu, không tự chọn admin_only |
| `cloud_vps_create` | POST `/api/lxc` | Hourly như cũ; monthly nhận `plan_code`, `period: month|year`, trả `estimate` và job |
| `cloud_subscription_list` | GET `/api/subscriptions` | Đọc gói, kỳ gia hạn, auto-renew |
| `cloud_subscription_update` | POST `/api/services/{service_id}/subscription` | `plan_code`, `period`, `auto_renew`, `cancel_action: hourly|stop`; ít nhất một thay đổi |
| `cloud_invoice_list` | GET `/api/invoices` | Đọc hoá đơn tài khoản |
| `cloud_invoice_pdf` | GET `/api/invoices/{invoice_id}.pdf` | Lưu nguyên bytes vào file tạm 0600 trong thư mục riêng 0700, trả `path` |
| `cloud_credit_redeem` | POST `/api/credit-codes/redeem` | Body `{code}`, trim/uppercase; không tự đoán mã |
| `cloud_app_create` | POST `/api/apps` → GET `/api/jobs/{id}` | Deploy public repo HTTPS, tự poll và trả URL; **đang mở** |
| `cloud_app_list` | GET `/api/apps` | Tránh tạo trùng app; **đang mở** |
| `cloud_app_get` | GET `/api/apps/{app_id}` | Status, URL, last_deploy, app host; **đang mở** |
| `cloud_app_deploy` | POST `/api/apps/{app_id}/deploy` → job | Deploy lại sau sửa code/env; **đang mở** |
| `cloud_app_env_set` | PUT `/api/apps/{app_id}/env` | Body `{env: {KEY: "value"}}`, thay toàn bộ env; deploy lại để áp dụng; **đang mở** |
| `cloud_app_domain_add` | POST `/api/apps/{app_id}/domains` | Body `{host}`, trả hướng dẫn CNAME; **đang mở** |
| `cloud_app_logs` | GET `/api/apps/{app_id}/logs?deployment=...` | Tối đa 500 dòng, giữ log có secret riêng tư; **đang mở** |
| `cloud_app_delete` | DELETE `/api/apps/{app_id}` | Xoá app/domain/A record sau khi được duyệt; host vẫn có thể tính phí; **đang mở** |
| `cloud_app_host_list` | GET `/api/app-hosts` | Đọc host, tài nguyên và phí; **đang mở** |

## Gói tháng/năm

```text
cloud_plan_list({ ram_gb: 4 })
cloud_balance()
# Báo đúng price_month_vnd hoặc price_year_vnd, hỏi duyệt nếu chưa có.
cloud_vps_create({ app_name: "shop", billing_mode: "monthly", plan_code: "kinh-doanh", period: "month" })
cloud_job_status({ job_id: "<id trả về>" })
cloud_subscription_list()
cloud_subscription_update({ service_id: "<service_id>", auto_renew: false, cancel_action: "stop" })
cloud_invoice_list()
cloud_invoice_pdf({ invoice_id: "<invoice_id>" })
cloud_credit_redeem({ code: "<mã người dùng cung cấp>" })
```

Monthly bỏ `package_slug`, CPU/RAM/đĩa trong payload trước khi gửi, lấy cấu hình từ plan. Spend guard so sánh số dư với **toàn bộ giá kỳ đã chọn**, không chỉ số dư dương. Plan giá 0 được phép với ví 0; API vẫn kiểm quyền gói admin. Giá đọc từ API, không hard-code. Nâng gói tính prorate và hạ gói kỳ sau do backend quyết định; MCP không tự tính khoản prorate hoặc chặn huỷ khi ví hết tiền.

Wave A hiện từ chối monthly trong sandbox. `cloud_vps_create` monthly + sandbox lấy CPU/RAM/đĩa từ plan, gửi request **hourly sandbox** với `X-Vibecloud-Sandbox: 1`; trả `estimate` là giá gói thật, `requested_billing_mode: monthly`, `preview_billing_mode: hourly`. Không tạo subscription và không trừ tiền. Được duyệt rồi mới gọi monthly thật, tắt cả tham số sandbox và `MONACLOUD_SANDBOX` nếu env đang bật.

PDF là file tạm trên máy chạy MCP, không phải máy từ xa của người chat. Sao chép file nếu cần giữ lâu; hệ điều hành có thể dọn thư mục tạm. Không dùng filename từ server làm đường dẫn local, không follow redirect có bearer token, không chuyển PDF qua text/JSON.

## Deploy repo: 3 bước

1. Đọc repo/nhánh/build/domain, `cloud_app_list`, `cloud_app_host_list`, `cloud_prices`, `cloud_packages`. Nếu chưa có host, gọi `cloud_app_create` sandbox trước để lấy `result.estimated_app_host` (MCP cũng trả thành `estimate`) và URL thử. Đọc `cloud_balance` trước tạo thật.
2. Báo chi phí host, repo, nhánh và domain, hỏi duyệt nếu chưa được duyệt. Gói tháng cần giá đúng kỳ; app dùng host hiện có vẫn tiếp tục phí host. Sandbox không cần ví, không cần duyệt chi phí.
3. `cloud_app_create` thật, chờ terminal job, đọc `cloud_app_get`/`cloud_app_logs`, kiểm HTTPS/health rồi báo URL. Khi có host, truyền `app_host_id` để dùng lại. Custom domain dùng `cloud_app_domain_add`, làm theo CNAME và chờ SSL.

```text
cloud_app_create({ repo_url: "https://github.com/example/shop.git", branch: "main", build_type: "nixpacks", port: 3000, env: {}, sandbox: true })
# Đọc estimate, duyệt, rồi:
cloud_app_create({ repo_url: "https://github.com/example/shop.git", branch: "main", build_type: "nixpacks", port: 3000, env: {}, sandbox: false })
cloud_app_env_set({ app_id: "<app_id>", env: { NODE_ENV: "production" } })
cloud_app_deploy({ app_id: "<app_id>" })
cloud_app_domain_add({ app_id: "<app_id>", host: "shop.example.vn" })
cloud_app_logs({ app_id: "<app_id>", deployment: "<deployment_id>" })
```

`cloud_app_create` mặc định branch=`main`, build_type=`dockerfile`, dockerfile=`Dockerfile`, env=`{}`, port=`3000`, wait=`true`, interval_sec=`3`, timeout_sec=`600`. Build có `dockerfile|nixpacks|static`. `wait: false` trả job để client tự poll; nên dùng nếu MCP host giới hạn mỗi tool dưới 10 phút. `done`/`succeeded` là hoàn tất; `failed`/`error`/`cancelled` trả lỗi `app_deploy_failed`. Timeout giữ job_id và next_step để poll tiếp; không tự gửi lại POST.

Wave B hiện nhận **public HTTPS repo** không credential/query/fragment. CLI đổi remote `git@host:owner/repo.git` hoặc `ssh://git@host/owner/repo.git` sang HTTPS; điều đó không cấp quyền repo private. Không đưa token vào URL. Env là map string, tối đa 200 key/64 KiB; không in secret hoặc log build ra công khai.

Sandbox app dùng `X-Vibecloud-Sandbox: 1` cho các endpoint app. Job được tìm theo ID; không cần header khi poll. `MONACLOUD_SANDBOX=1` cũng bật sandbox và không thể bị `sandbox:false` ghi đè. Lỗi 404/503 khi endpoint chưa mở được trả nguyên theo API, không có thành công giả.

Prompt mẫu: “Deploy repo hiện tại lên MONA Cloud. Kiểm host và giá, sandbox trước nếu chưa có host, báo chi phí để tôi duyệt rồi deploy thật và kiểm URL.”

## Nguồn hợp đồng offline

Snapshot `ctx/openapi.json` được giao vẫn ghi API `0.2.0`, chưa có Wave A/B. Đã đối chiếu **file local** `vibecloud/app/schemas.py`, `app/routers/api.py` cho Wave A; Wave B theo `ctx/BRIEF-CODEX-WAVE-B-APPS.md` §2–4 và đối chiếu thêm `vibecloud/app/routers/apps.py`, `app/sandbox.py`. Vì brief cũ trong `SPEC-WAVE-B-APP-TU-GIT.md` ghi POST env và `?deploy=`, implementation dùng hợp đồng mới hơn: **PUT env, `?deployment=`**. Không sửa snapshot cũ để tránh gán nhầm provenance; không gọi endpoint production.
