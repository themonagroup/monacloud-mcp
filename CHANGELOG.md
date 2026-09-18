# Changelog

## 0.10.2 (2026-09-18)

### Changed — dẫn agent chưa login sang guest flow (rút từ test 3 AI thật 18/09)
- `login_required` (auth) nay nói rõ: muốn mua tên miền mà chưa có tài khoản → `cloud_domain_reserve`, không bảo người dùng đi đăng ký.
- Server `instructions` mở đầu bằng luật guest cho tên miền (Codex chỉ đọc chắc 512 ký tự đầu).
- `cloud_domain_search` khi chưa login trả `{results, guest: true, next_step}` dẫn sang reserve; đã login trả mảng như cũ.
- `cloud_domain_buy` mô tả: login_required → dùng reserve thay.


## 0.10.1 (2026-09-18)

### Added
- `cloud_domain_renew` — gia hạn tên miền: dry_run báo `price_vnd` → hỏi duyệt → trừ ví VND + gia hạn thật (backend giờ THU tiền khách khi gia hạn; trước đó gọi thẳng registrar).


## 0.10.0 (2026-09-18)

### Added — mua tên miền TRƯỚC khi có tài khoản (guest → reserve → claim, spec monadomain §12)
- `cloud_domain_search` **không cần đăng nhập** nữa: chưa có MONA Pass vẫn tra tên + giá (backend rate-limit theo IP).
- `cloud_domain_reserve` — giữ chỗ 30 phút, không trừ tiền, không đăng ký thật; hỏi email + sđt (+ 1 câu opt-in ưu đãi → `marketing_consent`); trả QR VietQR đúng giá + `claim_url` + `claim_token` + `guest_token`. Người dùng quét QR trước, đăng nhập Pass sau; tiền vào trước khi có tài khoản được giữ trên reservation.
- `cloud_domain_reserve_status` — theo dõi reserved/paid/claimed/expired (guest dùng claim_token).
- `cloud_domain_claim` — gắn reservation vào MONA Pass đang đăng nhập, kéo tiền về ví, mua ngay (idempotent; 402 → nạp, 422 → set registrant rồi claim lại).
- `cloud_domain_reserve_release` — nhả chỗ khi chưa nhận tiền.
- Prompt `mua-ten-mien-monacloud` có nhánh "chưa có tài khoản → reserve + QR + claim_url", không bảo người dùng đi đăng ký trước.
- Backend ghi lead (email/sđt/consent) từ bước reserve/registrant/mua vào kho `leads` chung MONA Cloud (spec §12b).


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

## 0.9.2 (2026-09-18)
- domain: quản lý DNS + NS hoàn toàn bằng AI — cloud_domain_dns_list/add/update/delete (A/AAAA/CNAME/MX/TXT/SRV/NS) + cloud_domain_ns_set (đổi nameserver ≥2). Backend /api/domains/{id}/records + /ns qua MONA Host.
