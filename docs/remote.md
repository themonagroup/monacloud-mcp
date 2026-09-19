# Kết nối MONA Cloud MCP từ xa

Endpoint dùng chung: `https://mcp.monacloud.vn/mcp`. Ứng dụng sẽ mở MONA Pass
để đăng nhập và cấp quyền lần đầu.

## Claude.ai

Vào **Settings → Connectors → Add custom connector**, nhập URL
`https://mcp.monacloud.vn/mcp`, sau đó hoàn tất đăng nhập MONA Pass.

## Cursor

Thêm vào `mcp.json`:

```json
{
  "mcpServers": {
    "monacloud": {
      "url": "https://mcp.monacloud.vn/mcp"
    }
  }
}
```

## Codex

Thêm vào cấu hình Codex:

```toml
[mcp_servers.monacloud]
url = "https://mcp.monacloud.vn/mcp"
```

## ChatGPT

Bật **Developer mode**, thêm connector tùy chỉnh với URL
`https://mcp.monacloud.vn/mcp`, rồi đăng nhập MONA Pass khi được yêu cầu.
