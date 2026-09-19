# BRIEF — Gắn `title` + `annotations` (readOnlyHint/destructiveHint/idempotentHint/openWorldHint) cho MỌI tool của monacloud-mcp

Lý do: Claude Connectors Directory từ chối server có tool thiếu `title` hoặc thiếu `readOnlyHint`/`destructiveHint` phù hợp. Đây là việc cơ học trên toàn bộ file đăng ký tool.

## Phạm vi (chỉ sửa các file này)
`src/server.ts`, `src/domains.ts`, `src/mail.ts`, `src/compute.ts`, `src/base.ts`, `src/monapay.ts` (chỗ bọc tool của monapay-mcp), và thêm test `test/annotations.test.mjs`.
KHÔNG đổi tên tool, mô tả, inputSchema, handler, thứ tự đăng ký. KHÔNG publish, KHÔNG push.

## Luật gắn
- Mọi `server.registerTool(name, { ... })` phải có `title` (tiếng Việt ngắn 3–7 chữ, có sẵn thì giữ) và `annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }`.
- `readOnlyHint: true` khi tool chỉ đọc/tra/ước tính: tên chứa hoặc mang nghĩa `list|get|status|search|balance|ledger|health|whoami|usage|services|quote|detect|wait|logs|stats|templates|plan_list|tlds|registrant_get|verify_status|webhook_logs|email_logs|zalo_group_logs|generate_webhook_snippet|verify_signature|open_console|quickstart|me`. Với read-only: `destructiveHint: false`, `idempotentHint: true`.
- `destructiveHint: true` khi tool xoá/huỷ/thu hồi/dừng/đổi khoá không đảo ngược được: `delete|remove|cancel|release|rotate|stop|destroy|reset|revoke|suspend` (kể cả `cloud_domain_reserve_release`, `monapay_cancel_qr`, `monapay_rotate_key`, `cloud_domain_dns_delete`, `*_webhook delete`, `remove_email_suppression`). Với destructive: `readOnlyHint: false`, `idempotentHint: true` nếu gọi lại không gây thêm hại (xoá thứ đã xoá), ngược lại `false`.
- Tool tạo/mua/nạp/gửi/deploy/đổi cấu hình (`create|buy|topup|deploy|attach|set|update|add|renew|claim|reserve|register|send|test_webhook|test_email|link_bank_start|verify_otp|budget_set|token_limit|credit_redeem|retry|generate_key`): `readOnlyHint: false`, `destructiveHint: false`, `idempotentHint: false` (trừ `*_set`/`*_update`/`attach`/`ns_set`/`registrant_set`/`budget_set`/`webhook_set` = `true` vì đặt lại cùng giá trị không đổi kết quả).
- `openWorldHint: true` cho mọi tool (đều gọi API MONA Cloud ngoài máy), trừ `cloud_app_detect` (đọc thư mục local) = `false`.
- Alias `vibecloud_*` (compute.ts/base.ts) lấy đúng annotations của tool gốc.
- monapay.ts: tool bọc từ gói `monapay-mcp` — nếu gói con đã có `annotations` thì giữ; thiếu thì suy theo luật trên từ tên tool (`monapay_list_*`, `monapay_get_*`, `monapay_*_logs`, `monapay_*_stats`, `monapay_me`, `monapay_whoami`, `monapay_verify_signature`, `monapay_generate_webhook_snippet`, `monapay_quickstart` = read-only; `monapay_cancel_*`, `monapay_delete_*`, `monapay_rotate_key`, `monapay_remove_email_suppression` = destructive; còn lại = ghi).

## Test bắt buộc (`test/annotations.test.mjs`, node --test)
- Khởi động server in-process (như `support/test.mjs` làm) hoặc import `createServer` với env giả, gọi `tools/list` qua client SDK in-memory transport.
- Assert: 100% tool có `title` không rỗng; 100% tool có `annotations` với 4 khoá boolean; không tool nào vừa `readOnlyHint: true` vừa `destructiveHint: true`; các tool trong danh sách destructive ở trên phải `destructiveHint: true`; các tool `*_list|*_get|*_status|*_search|cloud_balance|cloud_whoami` phải `readOnlyHint: true`.
- `npm run build` xanh; `node support/test.mjs` không tăng fail; `node --test test/annotations.test.mjs` pass.

## Kết quả
Ghi `handoff/out/ANNOTATIONS-KET-QUA.md` (đường dẫn tuyệt đối /Users/themon/monacloud/mcp/handoff/out/ANNOTATIONS-KET-QUA.md): số tool, bảng đếm read-only/destructive/ghi, tool nào phân loại "không chắc" để Claude soát.
