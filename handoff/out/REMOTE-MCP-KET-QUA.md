# Kết quả Remote MCP

## Đã làm

Đã triển khai Remote MCP theo brief với Streamable HTTP, OAuth proxy MONA Pass,
DCR có Initial Access Token, JWT RS256/JWKS, session theo người dùng, giới hạn
2.000 session, dọn token hết hạn/idle 30 phút, CORS, health check và JSON request
log không chứa token.

### File đã tạo

- `src/remote.ts`
- `src/remote-verify.ts`
- `src/remote-cli.ts`
- `Dockerfile.remote`
- `deploy/remote/docker-compose.yml`
- `deploy/remote/nginx.mcp.monacloud.vn.conf`
- `deploy/remote/README.md`
- `test/remote.test.mjs`
- `docs/remote.md`
- `handoff/out/REMOTE-MCP-KET-QUA.md`

### File đã sửa

- `package.json`

Không sửa source tool hiện hữu, không publish npm, không push git và không deploy.

## Kiểm thử

Chạy:

```sh
npm run build
node --test test/remote.test.mjs
node support/test.mjs
```

Kết quả:

```text
npm run build
> tsc -p tsconfig.json
exit 0

node --test test/remote.test.mjs
tests 5; pass 5; fail 0; cancelled 0; skipped 0

node support/test.mjs
tests 91; pass 91; fail 0; cancelled 0; skipped 0
```

Test Remote dùng Express và cả Streamable HTTP client/server của MCP SDK hoàn toàn
in-process, không mở socket và không gọi mạng thật. Case `tools/list` chạy trên
server thật của repo và xác nhận có ít nhất 100 tool.

## Điểm chưa chắc

- Chưa kiểm thử tích hợp với Keycloak MONA Pass thật, nginx/Certbot thật hoặc các
  connector Claude.ai, ChatGPT và Cursor; toàn bộ upstream trong test được mock.
- Brief không cho phép sửa `package-lock.json`, nên file này được giữ nguyên dù
  `package.json` có dependency mới. Trước khi build Docker bằng `npm ci`, phía
  deploy cần xác nhận lockfile hiện tại đã đồng bộ; nếu chưa, cần cập nhật lockfile
  trong một thay đổi được cho phép riêng.
