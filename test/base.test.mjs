import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';

const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const data = (result) => JSON.parse(result.content[0].text);
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

async function fixture(fetcher, run, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-base-'));
  const calls = [];
  const env = { MONACLOUD_TOKEN: 'fake-pass', VIBECLOUD_API_TOKEN: 'fake-compute', MONACLOUD_CONFIG_DIR: directory, MONACLOUD_API: 'https://compute.test', MONACLOUD_BILLING_URL: 'https://billing.test', ...extra };
  const server = createServer({ env, fetchImpl: async (url, init) => {
    const request = { path: new URL(url).pathname, method: init.method || 'GET', headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(request);
    return fetcher(request, calls);
  } });
  const client = new Client({ name: 'base-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try { await run(client, calls); } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
}

test('Base tools and aliases expose strict beta Supabase descriptions', async () => {
  await fixture(() => json([]), async (client) => {
    const { tools } = await client.listTools();
    for (const suffix of ['create', 'list', 'get', 'delete', 'credentials']) {
      const tool = tools.find((entry) => entry.name === `cloud_base_${suffix}`);
      const alias = tools.find((entry) => entry.name === `vibecloud_base_${suffix}`);
      assert.deepEqual(alias.inputSchema, tool.inputSchema);
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.match(tool.description, /Base beta = thay Supabase, chung account\/ví MONA Cloud/);
      assert.match(tool.description, /\/ .*Base|\/ Beta/);
    }
    assert.match(client.getInstructions(), /cloud_base_create.*chung account\/ví MONA Cloud/);
    const llms = await client.readResource({ uri: 'monacloud://llms' });
    assert.match(llms.contents[0].text, /cần DB\/Supabase thì dùng cloud_base_create/);
    const prompt = await client.getPrompt({ name: 'dung-app-ban-hang-monacloud', arguments: {} });
    assert.match(prompt.messages[0].content.text, /Cần DB\/Supabase.*cloud_base_create \(beta\)/);
  });
});

test('Base create checks wallet, posts payload and polls to normalized URLs', async () => {
  let polls = 0;
  await fixture((req) => {
    if (req.path === '/v1/balance') return json({ balance_vnd: 100000 });
    if (req.path === '/api/bases') return json({ id: 'job/1', status: 'queued' });
    if (req.path === '/api/jobs/job%2F1') return json(++polls === 1 ? { status: 'running' } : { status: 'done', result: { base_id: 'base/1', studio_url: 'https://studio.test', api_url: 'https://api.test' } });
    throw new Error(`Unexpected ${req.path}`);
  }, async (client, calls) => {
    const result = data(await call(client, 'cloud_base_create', { cpu: 2, ram_gb: 4, disk_gb: 40, billing_mode: 'hourly' }));
    assert.deepEqual({ base_id: result.base_id, studio_url: result.studio_url, api_url: result.api_url, status: result.status }, { base_id: 'base/1', studio_url: 'https://studio.test', api_url: 'https://api.test', status: 'done' });
    assert.deepEqual(calls.map((item) => item.path), ['/v1/balance', '/api/bases', '/api/jobs/job%2F1', '/api/jobs/job%2F1']);
    assert.deepEqual(calls[1].body, { cpu: 2, ram_gb: 4, disk_gb: 40, billing_mode: 'hourly' });
  });
});

test('Base sandbox skips wallet, sends header and returns estimate without a live Base', async () => {
  await fixture((req) => {
    assert.equal(req.path, '/api/bases');
    return json({ id: 'preview-1', status: 'done', result: { estimate: { hourly_rate_vnd: 900 }, studio_url: 'https://sandbox-studio.test', api_url: 'https://sandbox-api.test' } });
  }, async (client, calls) => {
    const result = data(await call(client, 'vibecloud_base_create', { billing_mode: 'monthly', plan_code: 'base-small', sandbox: true }));
    assert.equal(result.sandbox, true);
    assert.deepEqual(result.estimate, { hourly_rate_vnd: 900 });
    assert.equal(result.base_id, 'preview-1');
    assert.match(result.next_step, /chưa tạo Base/);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].headers['X-Vibecloud-Sandbox'], '1');
    assert.deepEqual(calls[0].body, { billing_mode: 'monthly', plan_code: 'base-small' });
  });
});

test('Base list/get/delete/credentials match HTTP contract and hide extra credential fields', async () => {
  await fixture((req) => req.path.endsWith('/credentials')
    ? json({ anon_key: 'anon', service_key: 'service', db_url: 'postgres://secret', internal: 'omit' })
    : req.method === 'DELETE' ? { ok: true, status: 204, headers: { get: () => null }, text: async () => '' } : json({ ok: true }), async (client, calls) => {
    for (const [name, args, method, path] of [
      ['cloud_base_list', {}, 'GET', '/api/bases'],
      ['cloud_base_get', { base_id: 'base/1' }, 'GET', '/api/bases/base%2F1'],
      ['vibecloud_base_delete', { base_id: 'base/1' }, 'DELETE', '/api/bases/base%2F1'],
    ]) {
      assert.equal((await call(client, name, args)).isError, undefined);
      assert.equal(calls.at(-1).method, method); assert.equal(calls.at(-1).path, path);
    }
    const credentials = data(await call(client, 'cloud_base_credentials', { base_id: 'base/1' }));
    assert.deepEqual(credentials, { anon_key: 'anon', service_key: 'service', db_url: 'postgres://secret', warning: 'Bí mật, không log. Lưu vào secret store hoặc .env đã bỏ khỏi git.' });
    assert.equal(calls.at(-1).headers['X-Confirm'], 'reveal');
  });
});

test('Base errors keep code/next_step and invalid input never reaches HTTP', async () => {
  await fixture((req) => req.path === '/v1/balance' ? json({ balance_vnd: 0 }) : json({}), async (client, calls) => {
    const insufficient = await call(client, 'cloud_base_create', {});
    assert.equal(insufficient.isError, true);
    assert.equal(data(insufficient).code, 'insufficient_funds');
    assert.ok(data(insufficient).next_step);
    assert.equal((await call(client, 'cloud_base_get', { base_id: '' })).isError, true);
    assert.equal((await call(client, 'cloud_base_create', { cpu: 0 })).isError, true);
    assert.equal(calls.length, 1);
  });
});
