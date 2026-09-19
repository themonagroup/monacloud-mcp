# Kết quả đóng gói MCPB — monacloud-mcp

## Trạng thái

- `npm run build`: **PASS**
- Kiểm tra manifest theo schema MCPB 0.2 chính thức: **PASS**
- Đối chiếu tool trong manifest với registry runtime: **PASS** — 177 tool, không thiếu và không trùng.
- Smoke test server từ staging: **PASS** — nạp được 177 tool.
- Kiểm tra ZIP bằng `unzip -tq`: **PASS**
- `npm run mcpb`: **BLOCKED bởi môi trường mạng** tại bước `npm ci --omit=dev --ignore-scripts`.
- `npx --yes @anthropic-ai/mcpb validate build/mcpb/manifest.json`: **BLOCKED bởi môi trường mạng**, chưa thể ghi nhận PASS từ CLI chính thức.

## Artifact

- Đường dẫn: `/Users/themon/monacloud/mcp/build/monacloud-mcp.mcpb`
- Kích thước: **5,559,529 bytes** (xấp xỉ **5.30 MiB**)
- Artifact hiện tại được tạo từ staging cùng production dependencies đã cài sẵn; cấu trúc là ZIP MCPB hợp lệ và kiểm tra nén không có lỗi.

## Output validate

Kiểm tra cục bộ theo schema MCPB 0.2 chính thức:

```text
MCPB 0.2 schema checks PASS
Description: 142 chars
Tools: 177 exact runtime matches
```

Output của lệnh validate chính thức:

```text
npm error code ENOTFOUND
npm error syscall getaddrinfo
npm error network request to https://registry.npmjs.org/@anthropic-ai%2fmcpb failed,
reason: getaddrinfo ENOTFOUND registry.npmjs.org
```

Khi môi trường có quyền truy cập npm registry, chạy lại:

```sh
npm run build && npm run mcpb
npx --yes @anthropic-ai/mcpb validate build/mcpb/manifest.json
```

## Danh sách tool đã khai (177)

```text
cloud_whoami
cloud_balance
cloud_ledger
cloud_topup
cloud_topup_status
cloud_usage
cloud_services
cloud_budget_set
cloud_budget_get
cloud_token_limit
cloud_open_console
monapay_link
cloud_link
vibecloud_link
cloud_vps_create
vibecloud_create_vps
cloud_db_create
vibecloud_create_database
cloud_job_status
vibecloud_job_status
cloud_services_list
vibecloud_list_services
cloud_service_start
vibecloud_start
cloud_service_stop
vibecloud_stop
cloud_service_rebuild
vibecloud_rebuild
cloud_prices
vibecloud_prices
cloud_packages
vibecloud_packages
cloud_agent_deploy
vibecloud_agent_deploy
cloud_plan_list
vibecloud_plan_list
cloud_subscription_list
vibecloud_subscription_list
cloud_subscription_update
vibecloud_subscription_update
cloud_invoice_list
vibecloud_invoice_list
cloud_invoice_pdf
vibecloud_invoice_pdf
cloud_credit_redeem
vibecloud_credit_redeem
cloud_app_detect
vibecloud_app_detect
cloud_app_create
vibecloud_app_create
cloud_app_list
vibecloud_app_list
cloud_app_host_list
vibecloud_app_host_list
cloud_app_get
vibecloud_app_get
cloud_app_deploy
vibecloud_app_deploy
cloud_app_env_set
vibecloud_app_env_set
cloud_app_domain_add
vibecloud_app_domain_add
cloud_app_logs
vibecloud_app_logs
cloud_app_delete
vibecloud_app_delete
cloud_base_create
vibecloud_base_create
cloud_base_list
vibecloud_base_list
cloud_base_get
vibecloud_base_get
cloud_base_delete
vibecloud_base_delete
cloud_base_credentials
vibecloud_base_credentials
mail_account
mail_plans
mail_plan_set
mail_send
mail_status
mail_list
mail_domain_add
mail_domain_verify
mail_domain_cloudflare
mail_domains_list
mail_api_key_create
mail_api_keys_list
mail_api_key_revoke
mail_webhook_create
mail_webhooks_list
mail_webhook_test
mail_suppressions_list
mail_suppression_remove
mail_template_create
mail_stats
mail_inbox_create
mail_inbox_list
mail_inbox_get
mail_inbox_delete
mail_inbox_messages
mail_inbox_message
mail_inbox_reply
mail_inbox_wait
mail_inbox_update
mail_inbox_batch
cloud_domain_search
cloud_domain_registrant_get
cloud_domain_registrant_set
cloud_domain_buy
cloud_domain_reserve
cloud_domain_reserve_status
cloud_domain_claim
cloud_domain_reserve_release
cloud_domain_list
cloud_domain_verify_start
cloud_domain_verify_status
cloud_domain_health
cloud_domain_renew
cloud_domain_wait
cloud_domain_webhook_set
cloud_domain_attach
cloud_domain_dns_list
cloud_domain_dns_add
cloud_domain_dns_update
cloud_domain_dns_delete
cloud_domain_ns_set
agent_templates_list
agent_templates_get
agent_deploy
monapay_me
monapay_whoami
monapay_list_bank_accounts
monapay_list_virtual_accounts
monapay_link_bank_start
monapay_link_bank_verify_otp
monapay_notification_register
monapay_notification_verify_otp
monapay_get_payment_profile
monapay_set_payment_profile
monapay_create_checkout
monapay_get_checkout
monapay_list_checkouts
monapay_cancel_checkout
monapay_create_qr
monapay_cancel_qr
monapay_list_transactions
monapay_sandbox_transaction
monapay_list_webhooks
monapay_create_webhook
monapay_update_webhook
monapay_delete_webhook
monapay_test_webhook
monapay_webhook_logs
monapay_webhook_stats
monapay_list_email_configs
monapay_create_email_config
monapay_update_email_config
monapay_delete_email_config
monapay_verify_email
monapay_resend_email_verification
monapay_test_email
monapay_email_logs
monapay_email_stats
monapay_list_email_suppressions
monapay_remove_email_suppression
monapay_list_zalo_groups
monapay_create_zalo_group
monapay_update_zalo_group
monapay_delete_zalo_group
monapay_test_zalo_group
monapay_zalo_group_logs
monapay_retry_transaction
monapay_generate_key
monapay_rotate_key
monapay_verify_signature
monapay_generate_webhook_snippet
```
