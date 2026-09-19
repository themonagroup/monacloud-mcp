# BRIEF — đóng gói MCPB (.mcpb) cho monacloud-mcp để nộp Smithery (Local/MCPB)

Repo: thư mục hiện tại (~/monacloud/mcp). Chỉ ghi các file nêu dưới, KHÔNG thăm dò/sửa file khác, KHÔNG publish npm, KHÔNG push git.

## Việc
1. Tạo `mcpb/manifest.json` theo MCPB spec (https://github.com/modelcontextprotocol/mcpb, manifest_version "0.2"):
   - name `monacloud-mcp`, display_name `MONA Cloud (monadomain)`, version lấy từ package.json (0.10.9)
   - description ≤ 200 ký tự tiếng Anh: "Buy .vn/intl domains in VND, deploy apps, Postgres, email, VietQR pay — Vietnam MCP for AI agents. Domain search & reserve work without login."
   - author {name: "The MONA Group", url: "https://monadomain.vn"}, homepage https://monadomain.vn, documentation https://monadomain.vn/AGENTS.md, repository https://github.com/themonagroup/monacloud-mcp, license MIT
   - server: type "node", entry_point "dist/index.js", mcp_config {command: "node", args: ["${__dirname}/dist/index.js"], env: {MONACLOUD_TOKEN: "${user_config.monacloud_token}"}}
   - user_config: monacloud_token {type string, title "MONA Pass token", description "Optional. Not needed for domain search/reserve; run `npx monacloud-mcp login` to buy, deploy and pay.", sensitive true, required false}
   - keywords: mcp, domain, vn, vietnam, monadomain, monacloud, deploy, vietqr
   - compatibility: {claude_desktop: ">=0.10.0", platforms: ["darwin","win32","linux"], runtimes: {node: ">=18"}}
   - tools: liệt kê TÊN + description ngắn của các tool thật — lấy bằng cách grep `registerTool(` / `server.tool(` trong src/*.ts (không bịa tên tool).
2. Tạo `scripts/build-mcpb.mjs` (Node, không dependency mới): 
   - mkdir sạch `build/mcpb/`, copy `manifest.json`, `dist/`, `package.json`, `README.md`, `LICENSE`, `docs/` vào đó
   - chạy `npm ci --omit=dev --ignore-scripts` trong `build/mcpb/` (dùng package-lock.json copy kèm) để có node_modules production
   - gọi `npx --yes @anthropic-ai/mcpb pack build/mcpb build/monacloud-mcp.mcpb`
   - in đường dẫn + kích thước file.
3. Thêm script vào package.json: `"mcpb": "node scripts/build-mcpb.mjs"` (chỉ thêm 1 dòng, không đổi gì khác).
4. Chạy `npm run build && npm run mcpb`, rồi `npx --yes @anthropic-ai/mcpb validate build/mcpb/manifest.json` phải PASS. Sửa cho tới khi pass.
5. Đảm bảo `.gitignore` có `build/`.

## Output
- Ghi kết quả (đường dẫn .mcpb, size, output validate, danh sách tool đã khai) vào `handoff/out/MCPB-KET-QUA.md` (đường dẫn tuyệt đối: /Users/themon/monacloud/mcp/handoff/out/MCPB-KET-QUA.md).
