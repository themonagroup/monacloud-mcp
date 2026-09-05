# STATUS — monacloud-mcp 0.2.1

Updated: 2026-09-04 (Asia/Ho_Chi_Minh)

## Hoàn thành

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
