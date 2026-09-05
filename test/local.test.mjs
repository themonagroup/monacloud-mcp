import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';
import { archiveProject, detectProject, MAX_ARCHIVE_BYTES } from '../dist/local.js';

const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
const unpack = (bytes) => {
  const files = new Map();
  let offset = 0;
  while (bytes.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(bytes.readUInt16LE(offset + 6), 0x800);
    const size = bytes.readUInt32LE(offset + 18), nameSize = bytes.readUInt16LE(offset + 26);
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString();
    const content = inflateRawSync(bytes.subarray(offset + 30 + nameSize, offset + 30 + nameSize + size));
    assert.equal(content.length, bytes.readUInt32LE(offset + 22));
    files.set(name, { content, crc: bytes.readUInt32LE(offset + 14) });
    offset += 30 + nameSize + size;
  }
  const centralOffset = offset;
  for (const [name, file] of files) {
    assert.equal(bytes.readUInt32LE(offset), 0x02014b50);
    const length = bytes.readUInt16LE(offset + 28);
    assert.equal(bytes.subarray(offset + 46, offset + 46 + length).toString(), name);
    file.mode = bytes.readUInt32LE(offset + 38) >>> 16;
    offset += 46 + length;
  }
  assert.equal(bytes.readUInt32LE(offset), 0x06054b50);
  assert.equal(bytes.readUInt16LE(offset + 10), files.size);
  assert.equal(bytes.readUInt32LE(offset + 16), centralOffset);
  assert.equal(offset + 22, bytes.length);
  return files;
};
async function project(files, run) {
  const root = await mkdtemp(join(tmpdir(), 'mcp-local-'));
  try {
    for (const [name, content] of Object.entries(files)) {
      await mkdir(join(root, name, '..'), { recursive: true });
      await writeFile(join(root, name), content);
    }
    await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}
const result = (value) => JSON.parse(value.content[0].text);
const call = async (client, name, args) => client.callTool({ name, arguments: args });
async function fixture(root, handler, run, extra = {}) {
  const calls = [];
  const server = createServer({ env: { MONACLOUD_CONFIG_DIR: join(root, 'unused-config'), MONACLOUD_TOKEN: 'fake-pass', VIBECLOUD_API_TOKEN: 'fake-compute', MONACLOUD_API: 'https://compute.test', MONACLOUD_BILLING_URL: 'https://billing.test', ...extra }, fetchImpl: async (url, init) => {
    const req = { path: new URL(url).pathname, ...init, body: init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : undefined };
    calls.push(req);
    return handler(req, calls);
  } });
  const client = new Client({ name: 'local-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try { await run(client, calls); } finally { await client.close(); }
}
const slot = (id = 'app1', max = MAX_ARCHIVE_BYTES) => ({ id, upload_url: `https://compute.test/api/apps/${encodeURIComponent(id)}/upload`, max_bytes: max });
const readyHost = { app_hosts: [{ id: 'h1', status: 'active' }] };

test('detect covers Node/Next/Vite/Python/PHP/static, Dockerfile port, env names only and no execution/network', async () => {
  for (const [files, expected] of [
    [{ 'package.json': JSON.stringify({ dependencies: { next: '*' }, scripts: { start: 'next start -p 3100' } }) }, ['next', 3100, 'nixpacks']],
    [{ 'package.json': JSON.stringify({ devDependencies: { vite: '*' } }) }, ['vite', 4173, 'nixpacks']],
    [{ 'package.json': '{"scripts":{"start":"node index.js"}}', Dockerfile: 'FROM node\nEXPOSE 8080/tcp\n' }, ['node', 8080, 'dockerfile']],
    [{ 'requirements.txt': 'flask' }, ['python', 8000, 'nixpacks']],
    [{ 'index.php': '<?php echo "hi";' }, ['php', 8080, 'nixpacks']],
    [{ 'index.html': 'hello' }, ['static', 80, 'static']],
  ]) await project({ ...files, '.env.example': '# not a variable\nSECRET=do-not-return\nexport PORT=bad-secret\nSECRET=duplicate' }, async (root) => {
    await fixture(root, () => { throw Error('detect must not fetch'); }, async (client, calls) => {
      const info = result(await call(client, 'cloud_app_detect', { local_dir: root }));
      assert.deepEqual([info.stack, info.port, info.build_type], expected);
      assert.deepEqual(info.env_required, ['SECRET', 'PORT']);
      assert.doesNotMatch(JSON.stringify(info), /do-not-return|bad-secret/);
      assert.equal(info.network, false); assert.equal(calls.length, 0);
      assert.deepEqual(result(await call(client, 'vibecloud_app_detect', { local_dir: root })), info);
    });
  });
});

test('ZIP interoperable records retain binary/UTF-8/executable bits/dist and exclude secrets, symlinks and ignored paths', async () => {
  await project({ 'index.html': '123456789', 'ảnh.bin': Buffer.from([0, 255, 128]), 'start.sh': '#!/bin/sh\n', 'dist/site.js': 'built', Dockerfile: 'FROM nginx\nCOPY dist /www',
    '.env': 'secret', '.env.example': 'SECRET=example', 'nested/.env.prod': 'secret', 'nested/key.pem': 'private', '.git/config': 'token', 'node_modules/a/x': 'dependency',
    '.gitignore': '*.log\n!keep.log\n/root-only\ncache/\n', 'a.log': 'ignored', 'keep.log': 'keep', 'root-only': 'ignored', 'nested/root-only': 'keep',
    'cache/x': 'ignore', 'nested/.gitignore': '*.tmp\n!keep.tmp', 'nested/x.tmp': 'ignore', 'nested/keep.tmp': 'keep',
    '.dockerignore': '**/*.map\noutput\n!output/keep.txt\n', 'nested/x.map': 'ignore', 'output/drop.txt': 'ignore', 'output/keep.txt': 'keep',
  }, async (root) => {
    await chmod(join(root, 'start.sh'), 0o755);
    await symlink('/etc/passwd', join(root, 'outside'));
    await symlink('index.html', join(root, 'inside'));
    const zip = await archiveProject(root), files = unpack(zip.bytes);
    assert.equal(zip.build_path, '.'); assert.equal(zip.file_count, files.size);
    assert.equal(files.get('index.html').crc, 0xcbf43926);
    assert.deepEqual(files.get('ảnh.bin').content, Buffer.from([0, 255, 128]));
    assert.equal(files.get('start.sh').mode & 0o777, 0o755);
    for (const path of ['dist/site.js', 'keep.log', 'nested/root-only', 'nested/keep.tmp', 'output/keep.txt']) assert.ok(files.has(path), path);
    for (const path of ['.env', '.env.example', 'nested/.env.prod', 'nested/key.pem', '.git/config', 'node_modules/a/x', 'outside', 'inside', 'a.log', 'root-only', 'cache/x', 'nested/x.tmp', 'nested/x.map', 'output/drop.txt']) assert.ok(!files.has(path), path);
  });
});

test('ZIP enforces exact byte limit, invalid directories, empty archives and malformed project metadata', async () => {
  await project({ 'index.html': 'hello' }, async (root) => {
    const zip = await archiveProject(root);
    assert.equal((await archiveProject(root, zip.bytes.length)).bytes.length, zip.bytes.length);
    await assert.rejects(archiveProject(root, zip.bytes.length - 1), { code: 'archive_too_large' });
    await assert.rejects(detectProject(join(root, 'missing')), { code: 'invalid_local_dir' });
    await assert.rejects(detectProject(join(root, 'index.html')), { code: 'invalid_local_dir' });
  });
  await project({ '.env': 'only-secret' }, async (root) => assert.rejects(archiveProject(root), { code: 'empty_archive' }));
  await project({ 'package.json': '{invalid' }, async (root) => assert.rejects(detectProject(root), { code: 'invalid_package_json' }));
});

test('oversized ZIP fails clearly before any network request', async () => {
  await project({ 'random.bin': randomBytes(MAX_ARCHIVE_BYTES + 64 * 1024) }, async (root) => {
    await fixture(root, () => { throw Error('must not fetch'); }, async (client, calls) => {
      const response = await call(client, 'cloud_app_create', { local_dir: root });
      assert.equal(response.isError, true); assert.equal(result(response).code, 'archive_too_large');
      assert.match(result(response).message, /80 MiB/); assert.equal(calls.length, 0);
    });
  });
});

test('local create sends exact upload contract, native multipart bytes/auth, polls and flattens URL/build/seconds', async () => {
  await project({ 'index.html': 'hello', '.env': 'never-upload' }, async (root) => fixture(root, async (req) => {
    if (req.path === '/api/app-hosts') return json(readyHost);
    if (req.path === '/v1/balance') return json({ balance_vnd: 20000 });
    if (req.path === '/api/apps') {
      assert.deepEqual(req.body, { source: 'upload', name: 'demo', build_type: 'static', env: { PUBLIC: 'value' }, port: 80, domain: 'shop.test' });
      return json(slot('a/1'));
    }
    if (req.path === '/api/apps/a%2F1/upload') {
      assert.ok(req.body instanceof FormData); assert.deepEqual([...req.body.keys()], ['archive', 'build_path']);
      assert.equal(req.body.get('build_path'), '.'); assert.equal(req.body.get('archive').type, 'application/zip');
      assert.deepEqual([...unpack(Buffer.from(await req.body.get('archive').arrayBuffer())).keys()], ['index.html']);
      assert.equal(req.headers['Content-Type'], undefined); assert.equal(req.redirect, 'error');
      assert.equal(req.headers.Authorization, 'Bearer fake-compute');
      const wire = new Request('https://compute.test', { method: 'POST', body: req.body });
      assert.match(wire.headers.get('content-type'), /multipart\/form-data; boundary=/);
      assert.equal((await wire.formData()).get('archive').name, 'project.zip');
      return json({ job_id: 'j1', status: 'queued' });
    }
    assert.equal(req.path, '/api/jobs/j1'); return json({ status: 'succeeded', result: { url: 'https://app.test', build: 'b1', seconds: 12 } });
  }, async (client, calls) => {
    const response = await call(client, 'cloud_app_create', { local_dir: root, name: 'demo', env: { PUBLIC: 'value' }, domain: 'shop.test' });
    assert.equal(response.isError, undefined);
    const out = result(response); assert.equal(out.app_id, 'a/1'); assert.equal(out.url, 'https://app.test'); assert.equal(out.build, 'b1'); assert.equal(out.seconds, 12);
    assert.equal(calls.filter((r) => r.method === 'POST').length, 2);
  }));
});

test('missing host triggers sandbox estimate only, then matching approved create can proceed live', async () => {
  await project({ 'index.html': 'hello' }, async (root) => fixture(root, (req) => {
    if (req.path === '/api/app-hosts') return json({ app_hosts: [] });
    if (req.path === '/v1/balance') return json({ balance_vnd: 20000 });
    const sandbox = req.headers['X-Vibecloud-Sandbox'] === '1';
    if (req.path === '/api/apps') return json(sandbox ? { job_id: 'preview' } : slot());
    if (req.path.endsWith('/upload')) return json({ job_id: 'build' });
    return json({ status: 'done', result: { url: req.path.endsWith('preview') ? 'https://sandbox.test' : 'https://real.test', estimated_app_host: { hourly_rate_vnd: 100, plan_code: 'starter', price_month_vnd: 72000 } } });
  }, async (client, calls) => {
    const args = { local_dir: root };
    const preview = result(await call(client, 'cloud_app_create', args));
    assert.equal(preview.needs_cost_approval, true); assert.equal(preview.sandbox, true); assert.equal(preview.estimate.hourly_rate_vnd, 100);
    assert.ok(!calls.some((r) => r.path === '/v1/balance' || r.path.endsWith('/upload')));
    const live = result(await call(client, 'cloud_app_create', args));
    assert.equal(live.url, 'https://real.test'); assert.equal(live.sandbox, undefined);
    assert.equal(calls.filter((r) => r.path === '/api/apps' && !r.headers['X-Vibecloud-Sandbox']).length, 1);
  }));
});

test('sandbox upload carries header, skips billing and wait=false returns job without polling', async () => {
  for (const extra of [{}, { MONACLOUD_SANDBOX: '1' }]) await project({ 'index.html': 'hello' }, async (root) => fixture(root, (req) => {
    assert.equal(req.headers['X-Vibecloud-Sandbox'], '1');
    return json(req.path === '/api/apps' ? slot() : { job_id: 'upload1', status: 'queued' });
  }, async (client, calls) => {
    const out = result(await call(client, 'cloud_app_create', { local_dir: root, sandbox: !extra.MONACLOUD_SANDBOX, wait: false }));
    assert.equal(out.job_id, 'upload1'); assert.equal(out.app_id, 'app1'); assert.equal(out.sandbox, true);
    assert.deepEqual(calls.map((r) => r.path), ['/api/apps', '/api/apps/app1/upload']);
  }, extra));
});

test('upload rejects lower server cap, malformed slot and foreign destinations; preserves recovery app id', async () => {
  for (const [created, code] of [[slot('app1', 10), 'archive_too_large'], [{ ...slot(), upload_url: 'https://evil.test/upload' }, 'invalid_upload_url'], [{ ...slot(), max_bytes: -1 }, 'invalid_upload_response']]) {
    await project({ 'index.html': 'hello' }, async (root) => fixture(root, () => json(created), async (client, calls) => {
      const response = await call(client, 'cloud_app_create', { local_dir: root, sandbox: true });
      assert.equal(response.isError, true); assert.equal(result(response).code, code); assert.match(result(response).next_step, /app_id=app1/); assert.equal(calls.length, 1);
    }));
  }
});

test('upload failures and failed builds do not report success or resubmit creation', async () => {
  for (const mode of ['http', 'build']) await project({ 'index.html': 'hello' }, async (root) => fixture(root, (req) => {
    if (req.path === '/api/apps') return json(slot());
    if (req.path.endsWith('/upload')) return mode === 'http' ? json({ code: 'archive_invalid', message: 'bad zip' }, 400) : json({ job_id: 'j1' });
    return json({ status: 'failed', error: 'Build failed' });
  }, async (client, calls) => {
    const response = await call(client, 'cloud_app_create', { local_dir: root, sandbox: true });
    assert.equal(response.isError, true); assert.equal(result(response).code, mode === 'http' ? 'archive_invalid' : 'app_deploy_failed');
    assert.match(result(response).next_step, /app_id=app1/); assert.equal(calls.filter((r) => r.path === '/api/apps').length, 1);
  }));
});

test('redeploy rezips changed files, waits for upload then deploys; missing local_dir reuses old archive', async () => {
  await project({ 'index.html': 'version1' }, async (root) => {
    await archiveProject(root); await writeFile(join(root, 'index.html'), 'version2');
    await fixture(root, async (req) => {
      if (req.path === '/api/apps/app1') return json({ source: 'upload' });
      if (req.path.endsWith('/upload')) {
        assert.equal(unpack(Buffer.from(await req.body.get('archive').arrayBuffer())).get('index.html').content.toString(), 'version2');
        return json({ job_id: 'upload1' });
      }
      if (req.path === '/api/jobs/upload1') return json({ status: 'done' });
      assert.equal(req.path, '/api/apps/app1/deploy'); return json({ job_id: 'deploy1', status: 'queued' });
    }, async (client, calls) => {
      const out = result(await call(client, 'cloud_app_deploy', { app_id: 'app1', local_dir: root, sandbox: true, wait: false }));
      assert.equal(out.job_id, 'deploy1');
      assert.deepEqual(calls.map((r) => r.path), ['/api/apps/app1', '/api/apps/app1/upload', '/api/jobs/upload1', '/api/apps/app1/deploy']);
      calls.length = 0;
      await call(client, 'cloud_app_deploy', { app_id: 'app1', sandbox: true, wait: false });
      assert.deepEqual(calls.map((r) => r.path), ['/api/apps/app1/deploy']);
    });
  });
});

test('redeploy rejects git source, preserves upload_required and never deploys an unfinished upload', async () => {
  for (const mode of ['git', 'timeout', 'failed', 'required']) await project({ 'index.html': 'hello' }, async (root) => fixture(root, (req) => {
    if (req.path === '/api/apps/app1') return json({ source: mode === 'git' ? 'git' : 'upload' });
    if (req.path.endsWith('/upload')) return json({ job_id: 'upload1' });
    if (req.path.endsWith('/deploy')) return json({ detail: 'upload_required' }, 409);
    return json({ status: mode === 'timeout' ? 'running' : 'failed' });
  }, async (client, calls) => {
    const response = await call(client, 'cloud_app_deploy', { app_id: 'app1', ...(mode !== 'required' ? { local_dir: root } : {}), sandbox: true, interval_sec: 1, timeout_sec: 1 });
    const out = result(response);
    if (mode === 'timeout') { assert.equal(out.phase, 'upload'); assert.equal(out.polling, 'timeout'); }
    else { assert.equal(response.isError, true); assert.equal(out.code, mode === 'git' ? 'app_source_mismatch' : mode === 'required' ? 'upload_required' : 'app_deploy_failed'); }
    if (mode !== 'required') assert.ok(!calls.some((r) => r.path.endsWith('/deploy')));
    else assert.match(out.next_step, /local_dir/);
  }));
});

test('ambiguous local/git inputs and malformed local options are rejected before HTTP', async () => {
  await project({ 'index.html': 'hello' }, async (root) => fixture(root, () => { throw Error('must not fetch'); }, async (client, calls) => {
    for (const args of [{}, { local_dir: root, repo_url: 'https://git.test/a/b' }, { local_dir: root, branch: 'main' }, { local_dir: '\0' }]) {
      assert.equal((await call(client, 'cloud_app_create', args)).isError, true);
    }
    assert.equal(calls.length, 0);
    const llms = (await client.readResource({ uri: 'monacloud://llms' })).contents[0].text;
    const prompt = (await client.getPrompt({ name: 'dung-app-ban-hang-monacloud', arguments: {} })).messages[0].content.text;
    for (const text of [llms, prompt]) {
      assert.match(text, /AI làm 99%/); assert.match(text, /cloud_app_detect/);
      assert.match(text, /cloud_app_create\(local_dir/); assert.match(text, /một lần/);
      assert.match(text, /cloud_app_domain_add.*CNAME/); assert.match(text, /credit 20k/);
    }
  }));
});
