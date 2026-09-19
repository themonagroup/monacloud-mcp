# Deploy Remote MCP

```sh
cp deploy/remote/.env.remote.example deploy/remote/.env.remote
docker compose -f deploy/remote/docker-compose.yml build
docker compose -f deploy/remote/docker-compose.yml up -d
sudo cp deploy/remote/nginx.mcp.monacloud.vn.conf /etc/nginx/sites-enabled/mcp.monacloud.vn.conf
sudo nginx -t && sudo systemctl reload nginx
```

File `.env.remote` cần có `MCP_REMOTE_PUBLIC_URL`, `MONACLOUD_ISSUER` và
`MONA_PASS_INITIAL_ACCESS_TOKEN`. Container lắng nghe `0.0.0.0:8765`, nhưng
Compose chỉ publish cổng này trên `127.0.0.1` của máy chủ.

Để tạo Initial Access Token trong Keycloak MONA Pass, vào **Realm → Clients →
Initial access token**, đặt **count = 10000**, **expiration = 0**, rồi sao chép
token vào `MONA_PASS_INITIAL_ACCESS_TOKEN`. Chỉ lưu token trong file môi trường
trên máy chủ và không commit file đó.

Chạy Certbot cho `mcp.monacloud.vn` trước khi bật cấu hình HTTPS. Sau khi có
chứng chỉ, server cổng 80 chỉ chuyển hướng sang 443.
