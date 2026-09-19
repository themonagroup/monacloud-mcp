# Nộp Claude Connectors Directory — bản điền sẵn (Mon dán vào portal)

Portal: https://claude.ai/admin-settings/directory/submissions/new — **cần tài khoản Claude Team/Enterprise, vai Owner**. Cá nhân không có mục này. Tài liệu: https://claude.com/docs/connectors/building/submission

Điều kiện kỹ thuật đã đạt (19/09/2026): server HTTPS `https://mcp.monacloud.vn/mcp` (Streamable HTTP) · OAuth 2.0 + PKCE + Dynamic Client Registration (`/.well-known/oauth-authorization-server`, `/register`) · 177 tool đều có `title` + `readOnlyHint`/`destructiveHint` (monacloud-mcp ≥ 0.10.11) · chính sách quyền riêng tư https://monacloud.vn/chinh-sach-quyen-rieng-tu (EN: https://monacloud.vn/en/privacy) · Smithery đã quét thành công (177 tool, 3 prompt, 2 resource).

## 2. Connection
- Server URL: `https://mcp.monacloud.vn/mcp` · Transport: Streamable HTTP · Universal URL (một URL cho mọi người dùng).

## 4. Listing
- Name (≤100): `MONA Cloud`
- Tagline (≤55): `Domains .vn, deploy, Postgres, VietQR pay for Vietnam`
- Description (≤2000, tiếng Anh):
  MONA Cloud gives Claude the tools Vietnamese builders need to ship a product end to end. Search and buy .vn and 370+ international domains priced in VND with VAT, reserve a name for 30 minutes and pay by VietQR from any Vietnamese banking app, then point DNS and SSL at your app. Deploy the app you are working on to MONA Cloud (a Vercel-style host billed in VND), create Postgres, Auth and Storage bases (a Supabase-style backend), send transactional email with MONA Mail, and accept bank-transfer payments with MONA Pay, all from one MONA Pass account and one VND wallet. When the wallet runs low, Claude shows a VietQR code; you scan it and continue. MONA Cloud is operated by The MONA Group (Vietnam, since 2016, 14,000+ projects). Domain search and quotes work before you sign in; buying, deploying and paying use your MONA Pass login.
- Categories: Developer Tools · Cloud & Infrastructure · Domains/Hosting · Payments (chọn 1–5 theo danh mục portal)
- Documentation URL: https://monacloud.vn/docs/mcp-va-sdk (thêm: https://monadomain.vn/docs, https://github.com/themonagroup/monacloud-mcp/blob/main/docs/remote.md)
- Privacy policy URL: https://monacloud.vn/en/privacy
- Support contact: info@themona.global · hotline 1900 636 648
- Icon: `~/mona-hub/brand/mona/monacloud/fav-monacloud.svg` (PNG 512: https://monadomain.vn/icon-512.png)
- Slug: `mona-cloud`

## 5. Use cases
- Primary use cases: (1) buy and configure a .vn or international domain for the app being built, in VND; (2) deploy the current project and databases to MONA Cloud and manage them; (3) accept VietQR bank-transfer payments and send transactional email from the app.
- Prerequisites: a free MONA Pass account (created on first login, Google/GitHub/email). Paid actions need VND in the wallet; Claude shows a VietQR to top up. .vn domains require the registrant's identity per Vietnamese law (Claude fills the form, the user verifies once).
- Reads and writes data: both.

## Example prompts (≥3, mỗi prompt đụng tool khác nhau)
1. "Buy a domain for this app, prefer .vn, budget 800,000 VND." → cloud_domain_search → cloud_domain_reserve → cloud_domain_claim/cloud_domain_buy
2. "Deploy this folder to MONA Cloud and give me the URL." → cloud_app_detect → cloud_app_create → cloud_app_status
3. "Create a Postgres base for this project and put the connection string in .env." → cloud_base_create → cloud_base_credentials
4. "Point mydomain.vn at the deployed app with SSL." → cloud_domain_attach → cloud_domain_dns_list
5. "Check my wallet balance and top up 200,000 VND." → cloud_balance → cloud_topup → cloud_topup_status

## 6. Company
- The MONA Group (Công ty TNHH MONA MEDIA), https://mona.media — contact: Vy Nguyễn Khánh Hùng, mon@themona.global

## 7. Authentication
- OAuth 2.0 with **dynamic client registration** (RFC 7591) at `https://mcp.monacloud.vn/register`; authorization server metadata at `https://mcp.monacloud.vn/.well-known/oauth-authorization-server`; PKCE S256; refresh tokens (offline_access). Identity provider: MONA Pass (Keycloak) at pass.monacloud.vn.

## 8. Data handling
- Underlying API is our own (api.monacloud.vn, billing.monacloud.vn, MONA Pass). No personal health data. No sponsored content. Domain registration data is passed to the registrar/VNNIC as required by law (see privacy policy).

## 9. Test & launch
- Test account: tài khoản MONA Pass riêng cho reviewer — lấy trong `~/.config/mona/monapass-e2e.env` (user `mon+mcp-e2e@themona.global`). Trước khi nộp: nạp ví test ~200.000đ để reviewer chạy được tool có phí ở sandbox (`MONACLOUD_SANDBOX` không áp cho remote → nêu rõ tool nào tính tiền).
- Steps for reviewer: Add custom connector → URL above → sign in with the test account → run `cloud_whoami`, `cloud_balance`, `cloud_domain_search` (q="monatest", tlds="vn,com"), `cloud_domain_reserve` (creates a 30-minute hold, no charge), `cloud_app_detect` on any folder.
- Confirm: every tool exercised via `support/e2e-remote.mjs` + MCP Inspector (19/09/2026).

## 10. Compliance — 7 xác nhận (đọc và tick trong portal).
