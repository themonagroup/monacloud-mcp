# Changelog

## 0.9.0 (2026-09-18)

### Added
- **`cloud_domain_*` tools** — luồng search → quote → buy → verify (.vn) → attach → health cho AI agent:
  - `cloud_domain_search` — tìm domain trống + báo giá theo TLD
  - `cloud_domain_registrant_get` / `cloud_domain_registrant_set` — quản lý thông tin chủ thể đăng ký
  - `cloud_domain_buy` — mua tên miền, trừ ví VND, sandbox=true chạy 0đ
  - `cloud_domain_list` — liệt kê domain đã import/mua
  - `cloud_domain_verify_start` / `cloud_domain_verify_status` — nộp + theo dõi hồ sơ .vn
  - `cloud_domain_health` — kiểm tra hạn đăng ký, NS, SSL, profile_status
  - `cloud_domain_wait` — long-poll chờ domain active (timeout tối đa 300s)
  - `cloud_domain_webhook_set` — đăng ký webhook `domain.status_changed` ký HMAC
  - `cloud_domain_attach` — gắn domain vào app; .vn chưa active → đặt trước, server tự hoàn tất

## 0.8.1

Previous release.

## 0.9.1 (2026-09-18)
- domain: prompt `mua-ten-mien-monacloud` (làm trọn trong phiên: suggest → hỏi info chủ thể → QR nạp ví → mua → xác thực .vn → gắn app); cloud_domain_buy dẫn 402→cloud_topup QR + suggested_next deploy; registrant_set hỏi info trong phiên.
