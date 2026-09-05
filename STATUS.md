# STATUS — monacloud-mcp 0.4.0

Updated: 2026-09-05 (Asia/Ho_Chi_Minh)

## Brief deploy local — hoàn tất offline

- `cloud_app_detect(local_dir)` và alias `vibecloud_app_detect`: Node/Next/Vite/Python/PHP/static, port/start/Dockerfile/build_type, tên env từ `.env.example`; không mạng, không chạy code dự án.
- `cloud_app_create(local_dir)`: ZIP nguồn local trước HTTP, tạo `{source:"upload",name,build_type,env,port,domain?}`, nhận `{id,upload_url,max_bytes}`, multipart `archive` + `build_path`, poll job, trả URL/app_id/build/seconds. Giữ luồng git và mặc định 0.3.x.
- ZIP deflate/UTF-8/UNIX mode, tối đa 83,886,080 bytes (80 MiB); loại node_modules/.git/.env*/pem/symlink, áp dụng `.gitignore` root+nested và `.dockerignore` root. Giữ dist mặc định để không phá Dockerfile COPY output. Không cần dependency hoặc shell ZIP.
- Local create chưa có host/preview: tự sandbox, trả estimate + needs_cost_approval; agent hỏi human duyệt một lần rồi gọi thật. Preview cùng cấu hình giữ tối đa 10 phút trong MCP session. Host chưa ready và balance thiếu đều chặn tạo thật; sandbox bỏ Billing.
- Redeploy có local_dir: zip mới, xác minh source=upload, upload và chờ job trước POST deploy. Không local_dir: dùng bản đã upload. 409 upload_required, upload/build lỗi và timeout giữ hướng dẫn tiếp tục app/job hiện có.
- Upload dùng đúng endpoint cùng origin, chặn redirect, không tự set multipart Content-Type, kiểm thêm max_bytes backend; error sau create giữ app_id để không tạo trùng.
- Prompt, llms, agent guide và README theo luồng AI làm 99%; duyệt chi phí một lần, trả URL, domain+CNAME, MONA Pass/device flow và nạp ví khi hết credit 20k.
- Package/binary/MCP handshake 0.4.0; 135 tool, 2 resource, 2 prompt. Không đổi dependency, không publish, không gọi API production.

## Gate bàn giao

```text
mcp: npm test → 47 tests, 47 pass, 0 fail, 0 skip (gồm TypeScript build)
cli: npm test → 36 tests, 36 pass, 0 fail, 0 skip
```

Test gồm ZIP/CRC/binary/UTF-8/executable bits/ignore/secrets, archive vượt 80 MiB trước HTTP, mock multipart round-trip với native Request/FormData, backend max_bytes/URL không hợp lệ, sandbox/estimate, upload/build lỗi, wait=false/timeout, source mismatch/redeploy và CLI executable → MCP thật → HTTP mock. Test launcher đặt NODE_USE_SYSTEM_CA=0 riêng cho test child vì Node 22 thừa kế biến 1 bị SIGSEGV khi đọc macOS Keychain trong sandbox; runtime sản phẩm không đổi cấu hình CA.

Chi tiết hợp đồng và giới hạn: [docs/local-deploy.md](docs/local-deploy.md). Chỉ kiểm chứng offline/mock theo brief; backend upload đang được triển khai song song, chưa kiểm thử production.

CODEX DONE

---

# Lịch sử — monacloud-mcp 0.3.0

Updated: 2026-09-05 (Asia/Ho_Chi_Minh)

## 0.3.0 — Wave A/B hoàn tất (05/09/2026)

- [x] 6 tool billing: `cloud_plan_list`, `cloud_subscription_list`, `cloud_subscription_update`, `cloud_invoice_list`, `cloud_invoice_pdf`, `cloud_credit_redeem`.
- [x] `cloud_vps_create`/`vibecloud_create_vps` nhận hourly/monthly, plan_code, month/year. Monthly bỏ sizing hourly; estimate và spend guard dùng đúng toàn bộ giá kỳ từ API, gồm gói 0đ.
- [x] 9 tool app từ git: `cloud_app_create`, `cloud_app_list`, `cloud_app_get`, `cloud_app_deploy`, `cloud_app_env_set`, `cloud_app_domain_add`, `cloud_app_logs`, `cloud_app_delete`, `cloud_app_host_list`. Mô tả VI/EN ghi **đang mở**, gọi endpoint thật qua client; test HTTP mock.
- [x] 15 alias `vibecloud_` mới, dùng chung schema/handler. Tổng stdio **133 tool = 83 cũ + 20 Mail + 30 Wave A/B**, 2 resource, 2 prompt. Giữ nguyên tích hợp Mail/MONA Pay đang có.
- [x] App create/deploy poll tối đa 600 giây; trả URL/app_id/application_id, chuẩn hoá `result.estimated_app_host` thành `estimate`. Job error/failed/cancelled trả `app_deploy_failed`; timeout giữ job_id, không POST lại.
- [x] Sandbox header `X-Vibecloud-Sandbox: 1`, env `MONACLOUD_SANDBOX=1`, bỏ Billing; job poll theo ID. Monthly sandbox thử cấu hình plan qua **hourly sandbox**, báo rõ chưa tạo subscription vì Wave A từ chối monthly sandbox.
- [x] PDF giữ nguyên binary, file 0600/thư mục tạm 0700, không dùng remote filename hay follow redirect. Lỗi HTTP không tạo file giả.
- [x] Instructions/resource, prompt dựng app, agent_* và catalog hướng “deploy repo” sang cloud_app_create; đọc → ước tính → duyệt nếu cần → làm, sandbox trước khi chưa có host.
- [x] MCP và CLI cùng version **0.3.0**. README, [docs/wave-ab.md](docs/wave-ab.md), agent guide và CLI docs có bảng tool/lệnh, ví dụ, giới hạn rollout.

Ví dụ gọi:

```text
cloud_plan_list({ ram_gb: 4 })
cloud_vps_create({ app_name: "shop", billing_mode: "monthly", plan_code: "kinh-doanh", period: "month" })
cloud_subscription_update({ service_id: "<id>", auto_renew: false, cancel_action: "stop" })
cloud_invoice_pdf({ invoice_id: "<id>" })
cloud_credit_redeem({ code: "<mã đã duyệt>" })
cloud_app_create({ repo_url: "https://github.com/example/shop.git", build_type: "nixpacks", sandbox: true })
```

Gate cuối:

```text
mcp: npm test → 35 tests, 35 pass, 0 fail, 0 skip (bao gồm tsc)
cli: npm test → 31 tests, 31 pass, 0 fail, 0 skip
```

CLI có test executable → MCP thật → HTTP mock cho plans, VPS monthly, PDF, sandbox, duyệt chi phí và deploy/build lỗi. Stdio xác nhận version 0.3.0, 133 tool và không có stderr chứa secret.

Nguồn hợp đồng: snapshot `ctx/openapi.json` vẫn là **0.2.0**, thiếu Wave A/B. Đối chiếu offline schema/router Wave A và Wave B tại repo `vibecloud` trên cùng máy; giữ snapshot gốc và ghi provenance trong docs. Wave B public HTTPS repo, PUT env, query `deployment`, estimate `result.estimated_app_host`. CLI chuyển SSH remote phổ biến sang public HTTPS tương đương, không cấp quyền private repo.

Không chạy npm install, không gọi Internet/production, không publish. Toàn bộ phát triển/test trong hai workspace và thư mục tạm. Wave B live chưa kiểm vì brief yêu cầu offline.

Kiểm tra đóng gói offline: `npm pack --dry-run --json --offline --ignore-scripts` PASS (MCP 30 file), đủ source build/template/docs mới. Dùng npm CLI trực tiếp với config rỗng và `NODE_USE_SYSTEM_CA=0` để tránh lỗi Keychain/SecItemCopyMatching của Node trên runner. Không tạo tarball và không publish.

CODEX DONE

## 0.3.0 — MONA Mail

- [x] Thêm đủ 20 tool `mail_*` theo CONTRACT-MONA-MAIL-API §5 trong `src/mail.ts`, đăng ký sau nhóm compute `cloud_*`.
- [x] `MONAMAIL_API` mặc định `https://api.monamail.vn`; `CloudClients.mail()` dùng `requestJson` và `auth.accessToken()` MONA Pass, không có token cache Mail riêng.
- [x] Mọi POST có `Idempotency-Key` từ `idempotency_key` hoặc `mcp-mail-<uuid>`; `mail_send` chuyển `sandbox: true` thành `X-Mona-Sandbox: 1` và đánh dấu response.
- [x] Schema chặn email sai, trên 50 người nhận, trên 10 tags, subject trên 998 ký tự, gói/mode/event ngoài enum, webhook không dùng HTTPS và tham số lạ. Domain chuyển lowercase/IDN sang punycode.
- [x] Tool mô tả VI/EN có tình huống sử dụng; domain trả records và hướng dẫn DNS/Cloudflare. API key chỉ trả một lần để app lưu `.env` với tên `MONAMAIL_API_KEY`; không thêm log token/key, không lưu token Cloudflare.
- [x] Lỗi Mail qua `CloudError`: giữ thông tin API, gồm `403 domain_not_verified`; `402 mail_plan_set` trả `insufficient_funds` và bước tiếp theo nhắc `cloud_topup`. `src/http.ts`, `src/errors.ts` và hành vi lỗi tool cũ giữ nguyên.
- [x] Instructions/entity, `monacloud://llms` và health MONA Mail `/v1/healthz` đã cập nhật. Có prompt `gui-mail-otp-monamail` với account → onboarding → DNS → verify → key → `.env` → SDK OTP → webhook bounced.
- [x] README có bảng 20 tool, ví dụ OTP 6 bước và env Mail; `docs/ai-agent.md` có ranh giới human DNS/nạp tiền, sandbox, webhook HMAC và idempotency 24 giờ.
- [x] Version package, MCP server và CLI đồng bộ `0.3.0`. `src/index.ts` chỉ đổi version; không sửa `src/monapay.ts`.

Gate ngày 05/09/2026:

```text
$ node_modules/.bin/tsc -p tsconfig.json
exit 0, không có diagnostic

$ node --test test/*.test.mjs
tests 23, pass 23, fail 0
```

Stdio process thật xác nhận **103 tool = 83 cũ + 20 Mail**, 2 resource, 2 prompt, server version `0.3.0`. Test bao phủ auth/header/body, sandbox, records DNS, key một lần, HTTP 402/403/409/429, GET/query/DELETE 204, schema và prompt. Test cũ về compute, MONA Pay, alias và catalog đều xanh.

Lựa chọn theo contract: `subject` được bỏ khi có `template_id` vì §3 cho phép template thay nội dung; gửi trực tiếp bắt buộc subject và ít nhất html/text. Các POST ngoài `mail_send` cũng nhận `idempotency_key` tuỳ chọn để retry an toàn. Giá/quota và quyền domain vẫn do API quyết định, không hard-code giá gói.

Toàn bộ thay đổi và thư mục tạm của gate nằm trong workspace MCP; thư mục tạm đã dọn sau gate. Không chạy `npm install`, không gọi Internet hoặc production; dùng dependency có sẵn và fetch mock. Chưa kiểm gửi mail thật/DNS/SMTP production vì brief yêu cầu offline.

## Hoàn thành ở 0.2.1

- [x] Package Node 20 + TypeScript, ESM, stdio MCP; bin `monacloud-mcp`, version `0.2.1`.
- [x] OAuth device flow client `monacloud-mcp`, scope `offline_access`, token store private `0600`, refresh tự động; CLI `login`, `logout`, `whoami`.
- [x] 10 tool `cloud_*`: identity, balance, ledger, topup VietQR, usage, services aggregation, budget, token limit và console URL.
- [x] Import package `monapay-mcp` và re-export toàn bộ tool, không copy code. Dependency offline tại lần verify cuối là 0.5.5/47 tool (superset 24 tool yêu cầu); cộng `monapay_link` chuyển tiếp.
- [x] 11 tool compute tên mới `cloud_*`: link, VPS, database, job poll, list, start/stop/rebuild, prices, packages và agent-deploy stub.
- [x] 11 alias kỹ thuật `vibecloud_*` vẫn gọi được cho client cũ, không xuất hiện trong README/hướng dẫn agent.
- [x] 3 tool `agent_*`: list/get catalog local/remote/built-in và deploy qua cùng stub MONA Cloud.
- [x] Spend guard đọc billing balance trước create/start/rebuild thật; `sandbox: true` hoặc `MONACLOUD_SANDBOX=1` bỏ qua Billing, gửi header compute và đánh dấu response. Stop luôn được phép.
- [x] 2 resource đúng brief: `monacloud://llms`, `monacloud://status`.
- [x] 1 prompt `dung-app-ban-hang-monacloud`: VPS → DB → VA/QR → webhook → deploy.
- [x] Không log token; token và linked credential được lưu bằng atomic write, directory `0700`, file `0600`.
- [x] README có cài Claude Code/Codex/Cursor, device flow, env, tool, spend guard và ví dụ một lượt dựng app bán hàng.
- [x] `docs/ai-agent.md` mô tả zero-dashboard flow, OTP boundaries, idempotency, sandbox, deploy và definition of done.
- [x] Test offline: stdio process thật + `tools/list` + `cloud_whoami` token giả; spend guard; 402; MONA Pay re-export; catalog/path validation.

Tổng tool với dependency được chuẩn bị trong handoff tại lần verify cuối: **83** (gồm 11 alias tương thích).

## Gate đã chạy

```text
$ node_modules/.bin/tsc -p tsconfig.json
exit 0, không có diagnostic

$ node --test
tests 13, pass 13, fail 0
```

Không chạy `npm install`; toàn bộ build/test dùng `node_modules` có sẵn và không gọi Internet.

## Boundary chuyển tiếp đã ghi rõ

- `monapay_link` mặc định gọi `/api/v1/client/oauth/mona-id/link`; đổi bằng `MONAPAY_LINK_PATH` nếu upstream chốt path khác. Adapter cache client credential và sẽ bị bỏ khi MONA Pay nhận JWT trực tiếp.
- `cloud_link` thử Bearer MONA Pass trực tiếp trước; chỉ khi upstream trả 401/403 mới gọi adapter `/api/auth/monaid/link` (đổi bằng `VIBECLOUD_LINK_PATH`). Alias kỹ thuật cũ vẫn hoạt động.
- `cloud_agent_deploy` và `agent_deploy` là stub được brief yêu cầu tới khi runtime MONA Agent được phát hành; response không báo thành công giả.
- Compute API mặc định là `https://api.monacloud.vn`; `MONACLOUD_API` là env chính, `VIBECLOUD_API`/`VIBECLOUD_API_URL` vẫn được nhận để tương thích.
- Chưa chạy smoke production vì phiên này offline và không được cấp token/endpoint production. Unit/integration local đã phủ wire contract chính.

CODEX DONE

## Đổi tên compute VibeCloud → MONA Cloud (04/09)

- Tên người đọc và 11 tool chính đã chuyển sang MONA Cloud / `cloud_*`; VibeCloud chỉ còn trong alias và định danh kỹ thuật tương thích.
- Resource `monacloud://llms`, prompt dựng app, README và `docs/ai-agent.md` chỉ hướng dẫn tên mới.
- Package, MCP server và binary version đồng bộ `0.2.1`; build và test được ghi ở gate mới bên trên.

## QC Claude (03/09 tối) — ZERO-DASHBOARD TEST LOCAL: PASS
- Build tsc sạch · `node --test` 7/7 · stdio thật: **72 tool** (cloud 10 · monapay 48 · vibecloud 11 · agent 3), 2 resource, 1 prompt.
- E2E thật với Keycloak local (`MONACLOUD_ISSUER=http://127.0.0.1:8180/realms/mona`) + billing (`MONACLOUD_BILLING_URL=http://127.0.0.1:8191`): `monacloud-mcp login` → mã thiết bị → đăng nhập + màn "Cấp quyền" của MONA ID → `token.json` 0600 → `cloud_whoami` (userinfo thật) → `cloud_balance` 0đ (ví JIT) → `cloud_ledger` → `cloud_budget_get`. **Một token, không chạm dashboard.** *(Log 03/09 giữ tên cũ; tên hiện tại: MONA Pass.)*
- Lưu ý test tự động: trang consent Keycloak có form action TƯƠNG ĐỐI (`/realms/mona/login-actions/consent?...`) → script phải ghép host; urllib Python rớt cookie ở hop 302 → dùng curl cookie jar.
- Chưa: publish npm (`npm publish` — Claude làm khi deploy), `monapay_link`/`vibecloud_link` chờ endpoint link phía sản phẩm (gói E monapay, brief VIBECLOUD-MONAID đã có `/api/auth/monaid/link`).
- 04/09: publish npm `monacloud-mcp` 0.1.0 rồi 0.1.1 (sửa dep monapay-mcp ^0.3.0 → ^0.5.5 vì 0.5.x không khớp ^0.3).
- 04/09: sandbox bỏ spend guard (Codex) → publish 0.2.1; verify: cloud_vps_create sandbox:true với ví 0đ → job queued; không sandbox → insufficient_funds đúng.

CODEX B DONE

## QC Claude 05/09 (JOB B mail_*) — PASS local
- tsc sạch · `node --test` 23/23 · 20 tool `mail_*` + prompt `gui-mail-otp-monamail` + health `monamail` trong `monacloud://status`.
- Claude vá: `idempotencyHeaders` luôn gửi `Idempotency-Key` (mặc định `mcp-mail-<uuid>`) thay vì chỉ khi có tham số — AI retry an toàn theo contract §5.
- Chưa publish npm 0.3.0: chờ `api.monamail.vn` live (deploy theo `handoff/DEPLOY-MONA-MAIL-RUNBOOK.md`) rồi zero-dashboard test prod bằng `handoff/tests/test_mail_zero_dashboard.py`.
