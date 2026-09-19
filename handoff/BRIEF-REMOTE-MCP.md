# BRIEF — Remote MCP (Streamable HTTP + OAuth) cho monacloud-mcp → `https://mcp.monacloud.vn/mcp`

Mục tiêu: người dùng Claude.ai / ChatGPT / Cursor "Add connector" bằng URL, đăng nhập MONA Pass 1 lần, dùng đủ 177 tool như bản stdio. Lọt Claude connectors directory + Smithery "Hosted endpoint".
Repo: thư mục hiện tại (~/monacloud/mcp). KHÔNG sửa hành vi tool hiện có, KHÔNG publish npm, KHÔNG push git, KHÔNG deploy (Claude làm).

## Kiến trúc (đã chốt, không đổi)
- Transport: `StreamableHTTPServerTransport` của `@modelcontextprotocol/sdk` (đã có trong node_modules, ^1.30), Express (thêm dependency `express` + `cors`; không thêm gì khác).
- Mỗi phiên = 1 `createServer({ env: { ...process.env, MONACLOUD_TOKEN: <access_token của request> } })` (xem `src/server.ts` `createServer(dependencies)`, `src/auth.ts` `accessToken()` ưu tiên `env.MONACLOUD_TOKEN`). Session id do transport sinh; map sessionId → { server, transport, sub, exp }; dọn phiên hết hạn token hoặc idle > 30' ; giới hạn 2.000 phiên; `DELETE /mcp` đóng phiên.
- OAuth 2.1 resource server theo MCP spec 2025-06-18:
  - `GET /.well-known/oauth-protected-resource` (RFC 9728): `{ resource: "https://mcp.monacloud.vn/mcp", authorization_servers: ["https://mcp.monacloud.vn"], bearer_methods_supported: ["header"], scopes_supported: ["openid","profile","email","offline_access","vibecloud-api","billing-api"] }`.
  - Authorization server = CHÍNH server này làm proxy trước Keycloak MONA Pass (issuer `https://pass.monacloud.vn/realms/mona`, PKCE S256, DCR endpoint `.../clients-registrations/openid-connect`): dùng `ProxyOAuthServerProvider` + `mcpAuthRouter` của SDK (`node_modules/@modelcontextprotocol/sdk/dist/esm/server/auth/providers/proxyProvider.js`, `router.js`). Endpoints upstream: authorize/token/revocation lấy từ discovery `.well-known/openid-configuration` của issuer (đọc 1 lần lúc boot, cache).
  - `/register` (DCR): proxy tới Keycloak nhưng **server tự gắn `Authorization: Bearer ${MONA_PASS_INITIAL_ACCESS_TOKEN}`** (env; Claude cấp) vì Keycloak không mở đăng ký ẩn danh. Ép các trường khi đăng ký: `redirect_uris` giữ nguyên từ client, `grant_types: ["authorization_code","refresh_token"]`, `token_endpoint_auth_method: "none"` (public client + PKCE), thêm `default scopes`. Trả về đúng JSON RFC 7591 (client_id, client_id_issued_at, redirect_uris…).
  - `verifyAccessToken(token)`: xác minh JWT RS256 bằng JWKS của issuer (`/protocol/openid-connect/certs`, cache 10', dùng `jose`? KHÔNG — chỉ được thêm express+cors; tự viết verify bằng `crypto.verify` + JWK→KeyObject `crypto.createPublicKey({key: jwk, format:'jwk'})`), kiểm `iss`, `exp`, `azp/aud` (chấp nhận aud chứa `account` hoặc azp là client đã đăng ký), trả `{ token, clientId: azp, scopes, expiresAt, extra: { sub } }`.
  - Request tới `/mcp` không có bearer hợp lệ → 401 + `WWW-Authenticate: Bearer resource_metadata="https://mcp.monacloud.vn/.well-known/oauth-protected-resource"`.
- `GET /healthz` → `{ ok: true, version, sessions }` (không auth).
- CORS: cho phép origin bất kỳ với header `Authorization, Mcp-Session-Id, Content-Type`, expose `Mcp-Session-Id`.
- Bind `127.0.0.1:8765` mặc định (env `MCP_REMOTE_BIND`, `MCP_REMOTE_PORT`), nginx ở ngoài lo TLS. Env: `MCP_REMOTE_PUBLIC_URL=https://mcp.monacloud.vn`, `MONACLOUD_ISSUER`, `MONA_PASS_INITIAL_ACCESS_TOKEN`.
- Log 1 dòng/request JSON (method, path, status, ms, sub rút gọn), không log token.

## File được tạo/sửa (chỉ những file này)
- `src/remote.ts` (server Express + auth + session map), `src/remote-verify.ts` (JWKS verify, thuần Node crypto), `src/remote-cli.ts` (bin entry: parse env, start, SIGTERM đóng phiên).
- `package.json`: thêm bin `"monacloud-mcp-remote": "dist/remote-cli.js"`, deps `express`, `cors` (+ `@types/express`, `@types/cors` devDeps), script `"start:remote": "node dist/remote-cli.js"`.
- `Dockerfile.remote` (node:22-alpine, user non-root `mcp`, `npm ci --omit=dev`, `CMD node dist/remote-cli.js`, EXPOSE 8765) và `deploy/remote/docker-compose.yml` (service `monacloud-mcp-remote`, `ports: "127.0.0.1:8765:8765"`, env_file `.env.remote`, restart unless-stopped) + `deploy/remote/nginx.mcp.monacloud.vn.conf` (proxy_pass 127.0.0.1:8765, `proxy_buffering off`, `proxy_read_timeout 3600`, HTTP/1.1, header Mcp-Session-Id pass-through, chỉ 80 → 443 sau certbot) + `deploy/remote/README.md` (lệnh deploy 5 dòng, cách tạo Initial Access Token trong Keycloak: Realm → Clients → Initial access token, count 10000, expiration 0).
- `test/remote.test.mjs` (node --test): (1) `/.well-known/oauth-protected-resource` đúng shape; (2) `/mcp` không token → 401 + WWW-Authenticate; (3) token giả → 401; (4) với `verifyAccessToken` được mock (inject qua dependencies) → initialize + tools/list qua StreamableHTTP client của SDK trả ≥ 100 tool; (5) `/register` proxy gắn bearer initial token (mock fetch, kiểm header). Test không gọi mạng thật.
- `docs/remote.md`: cách add connector ở Claude.ai (Settings → Connectors → Add custom connector → URL `https://mcp.monacloud.vn/mcp`), Cursor (`"url"` trong mcp.json), Codex (`[mcp_servers.monacloud] url = ...`), ChatGPT (Developer mode). Tiếng Việt, ngắn, KHÔNG dùng các cụm: "không cần mở web/console/dashboard", "bỏ qua xác minh", "thẻ quốc tế", "không cần thẻ".

## Ràng buộc
- Không thăm dò ngoài danh sách file trên. TypeScript strict như repo (tsconfig hiện có; thêm `"types": ["node"]` nếu cần).
- `npm run build` phải xanh, `node --test test/remote.test.mjs` pass, `node support/test.mjs` không tăng fail (đã có 1 fail #stdio token giả từ trước — không tính).
- Kết quả ghi `handoff/out/REMOTE-MCP-KET-QUA.md` (đường dẫn tuyệt đối /Users/themon/monacloud/mcp/handoff/out/REMOTE-MCP-KET-QUA.md): file đã tạo, lệnh test + output, điểm chưa chắc.
