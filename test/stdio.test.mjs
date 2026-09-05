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
  assert.equal(stderr, '');
});
