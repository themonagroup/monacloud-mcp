import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('stdio JSON-RPC tools/list và cloud_whoami chạy bằng token giả', async () => {
  // Run the stdio integration check in a clean child. Node 22 on restricted
  // macOS runners can segfault when NODE_USE_SYSTEM_CA=1 reaches Undici.
  const { stdout, stderr } = await execFileAsync(
    process.execPath,
    [join(projectRoot, 'support', 'stdio-check.mjs')],
    {
      cwd: projectRoot,
      env: { ...process.env, NODE_USE_SYSTEM_CA: '0' },
      timeout: 15_000,
    },
  );
  assert.match(stdout, /STDIO PASS/);
  const summary = JSON.parse(stdout.trim().slice('STDIO PASS '.length));
  assert.equal(summary.tools_count, 83 + 20 + 32 + 10, '0.5.0 thêm Base và alias');
  assert.equal(summary.version, '0.5.0');
  assert.deepEqual(summary.mail_tools, [
    'mail_account', 'mail_plans', 'mail_plan_set', 'mail_send', 'mail_status', 'mail_list',
    'mail_domain_add', 'mail_domain_verify', 'mail_domain_cloudflare', 'mail_domains_list',
    'mail_api_key_create', 'mail_api_keys_list', 'mail_api_key_revoke',
    'mail_webhook_create', 'mail_webhooks_list', 'mail_webhook_test',
    'mail_suppressions_list', 'mail_suppression_remove', 'mail_template_create', 'mail_stats',
  ].sort());
  assert.deepEqual(summary.prompts, ['dung-app-ban-hang-monacloud', 'gui-mail-otp-monamail']);
  assert.equal(stderr, '');
});
