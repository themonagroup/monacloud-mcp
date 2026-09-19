# Kết quả gắn tool annotations

Đã kiểm tra qua `tools/list` bằng MCP SDK và in-memory transport.

| Phân loại | Số tool |
|---|---:|
| Tổng cộng | 177 |
| Chỉ đọc (`readOnlyHint: true`) | 83 |
| Phá huỷ (`destructiveHint: true`) | 18 |
| Ghi, không phá huỷ | 76 |

Tất cả 177 tool có `title` không rỗng và đủ bốn khóa boolean: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. Không có tool đồng thời vừa read-only vừa destructive. `cloud_app_detect` và alias `vibecloud_app_detect` có `openWorldHint: false`; các tool còn lại là `true`.

## Các trường hợp cần Claude soát

| Tool | Phân loại hiện tại | Lý do chưa chắc |
|---|---|---|
| `cloud_subscription_update` + alias | Ghi, idempotent | Có thể đặt `cancel_action=stop`, nhưng tên tool là `update` và brief quy định `*_update` idempotent, không destructive. |
| `mail_inbox_message` | Chỉ đọc | GET nội dung nhưng lần đọc đầu có tác dụng phụ đánh dấu đã xem. |
| `cloud_domain_renew` | Ghi, không idempotent | Mặc định chỉ báo giá (`dry_run=true`), nhưng `dry_run=false` gia hạn và trừ tiền. |
| `mail_domain_verify` | Ghi, không idempotent | Dùng POST để kích hoạt kiểm tra DNS; không thuộc nhóm `verify_status` read-only trong brief. |
| `agent_deploy` và `cloud_agent_deploy` + alias | Ghi, không idempotent | Hiện là stub không tạo tài nguyên, nhưng ngữ nghĩa công khai là deploy. |
| `cloud_link`, `vibecloud_link`, `monapay_link` | Ghi, không idempotent | Có thể tạo/cache credential chuyển tiếp dù một số upstream hiện chỉ xác nhận kết nối. |

## Kiểm tra

- `npm run build`: đạt.
- `node --test test/annotations.test.mjs`: đạt.
- `node support/test.mjs`: 92/92 test đạt, không tăng fail.
