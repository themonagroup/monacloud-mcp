import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';

const plans = { plans: [
  { code: 'khach-mona', cpu: 1, ram_gb: 1, disk_gb: 20, price_month_vnd: 0, price_year_vnd: 0, admin_only: true },
  { code: 'khoi-nghiep', cpu: 1, ram_gb: 1, disk_gb: 20, price_month_vnd: 399000, price_year_vnd: 3990000 },
  { code: 'kinh-doanh', cpu: 2, ram_gb: 4, disk_gb: 40, price_month_vnd: 999000, price_year_vnd: 9990000 },
] };
const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
const data = (result) => JSON.parse(result.content[0].text);
async function fixture(fn, run, extra = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-wave-ab-'));
  const calls = [];
  const env = { MONACLOUD_TOKEN: 'fake-pass', VIBECLOUD_API_TOKEN: 'fake-compute', MONACLOUD_CONFIG_DIR: directory, MONACLOUD_API: 'https://compute.test', MONACLOUD_BILLING_URL: 'https://billing.test', ...extra };
  const server = createServer({ env, fetchImpl: async (url, init) => {
    const request = { path: new URL(url).pathname + new URL(url).search, url: String(url), ...init, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(request);
    return fn(request, calls);
  } });
  const client = new Client({ name: 'wave-ab-test', version: '1.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b); await client.connect(a);
  try { await run(client, calls); } finally { await client.close(); await rm(directory, { recursive: true, force: true }); }
}
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

test('plans expose both prices, recommend by resources, and all 15 new tools have aliases', async () => {
  await fixture(() => json(plans), async (client) => {
    const result = data(await call(client, 'cloud_plan_list', { ram_gb: 4 }));
    assert.deepEqual(result.plans, plans.plans);
    assert.equal(result.recommendation.plan_code, 'kinh-doanh');
    assert.equal(data(await call(client, 'vibecloud_plan_list')).recommendation.plan_code, 'khoi-nghiep');
    const { tools } = await client.listTools();
    for (const name of ['plan_list', 'subscription_list', 'subscription_update', 'invoice_list', 'invoice_pdf', 'credit_redeem', 'app_create', 'app_list', 'app_get', 'app_deploy', 'app_env_set', 'app_domain_add', 'app_logs', 'app_delete', 'app_host_list']) {
      const current = tools.find((tool) => tool.name === `cloud_${name}`);
      const alias = tools.find((tool) => tool.name === `vibecloud_${name}`);
      assert.deepEqual(current.inputSchema, alias.inputSchema);
      assert.equal(current.inputSchema.additionalProperties, false);
      assert.match(current.description, /\/ /);
      if (name.startsWith('app_')) assert.match(current.description, /đang mở/);
    }
  });
});

test('monthly and annual spend guard uses full plan price and removes hourly sizing', async () => {
  for (const period of ['month', 'year']) {
    for (const name of ['cloud_vps_create', 'vibecloud_create_vps']) {
      const amount = period === 'month' ? 999000 : 9990000;
      await fixture((req) => req.path === '/api/plans' ? json(plans) : req.path === '/v1/balance' ? json({ balance_vnd: amount }) : json({ id: 'job1', status: 'queued' }), async (client, calls) => {
        const result = await call(client, name, { app_name: 'shop', billing_mode: 'monthly', plan_code: 'kinh-doanh', period, package_slug: 'ignore', cpu: 16, ram_gb: 64, disk_gb: 1000 });
        assert.equal(result.isError, undefined);
        assert.equal(data(result).estimate.amount_vnd, amount);
        assert.deepEqual(calls.map((r) => r.path), ['/api/plans', '/v1/balance', '/api/lxc']);
        assert.deepEqual(calls.at(-1).body, { app_name: 'shop', billing_mode: 'monthly', plan_code: 'kinh-doanh', period });
        assert.equal(calls.at(-1).headers.Authorization, 'Bearer fake-compute');
        assert.equal(calls.at(-1).headers['X-Vibecloud-Sandbox'], undefined);
      });
      await fixture((req) => req.path === '/api/plans' ? json(plans) : json({ balance_vnd: amount - 1 }), async (client, calls) => {
        const result = await call(client, name, { app_name: 'shop', billing_mode: 'monthly', plan_code: 'kinh-doanh', period });
        assert.equal(result.isError, true);
        assert.equal(data(result).code, 'insufficient_funds');
        assert.ok(!calls.some((r) => r.path === '/api/lxc'));
      });
    }
  }
});

test('free plan permits zero wallet, but unknown plans and unreadable prices/balance do not create', async () => {
  await fixture((req) => req.path === '/api/plans' ? json(plans) : req.path === '/v1/balance' ? json({ balance_vnd: 0 }) : json({ id: 'free', status: 'queued' }), async (client) => {
    const result = await call(client, 'cloud_vps_create', { app_name: 'free', billing_mode: 'monthly', plan_code: 'khach-mona' });
    assert.equal(data(result).estimate.amount_vnd, 0);
    assert.equal(result.isError, undefined);
  });
  for (const [catalog, balance, code] of [[plans, {}, 'invalid_balance'], [{ plans: [{ code: 'kinh-doanh' }] }, {}, 'invalid_plan_price'], [{ plans: [] }, {}, 'plan_not_found']]) {
    await fixture((req) => json(req.path === '/api/plans' ? catalog : balance), async (client, calls) => {
      assert.equal(data(await call(client, 'cloud_vps_create', { app_name: 'shop', billing_mode: 'monthly', plan_code: 'kinh-doanh' })).code, code);
      assert.ok(!calls.some((r) => r.path === '/api/lxc'));
    });
  }
});

test('monthly sandbox uses plan dimensions via hourly sandbox, no wallet or subscription charge', async () => {
  for (const extra of [{}, { MONACLOUD_SANDBOX: '1' }]) {
    await fixture((req) => req.path === '/api/plans' ? json(plans) : json({ id: 'sandbox1', status: 'done' }), async (client, calls) => {
      const result = data(await call(client, 'cloud_vps_create', { app_name: 'shop', billing_mode: 'monthly', plan_code: 'kinh-doanh', period: 'year', sandbox: !extra.MONACLOUD_SANDBOX }));
      assert.equal(result.estimate.amount_vnd, 9990000);
      assert.equal(result.sandbox, true);
      assert.equal(result.preview_billing_mode, 'hourly');
      assert.deepEqual(calls.map((r) => r.path), ['/api/plans', '/api/lxc']);
      assert.deepEqual(calls[1].body, { app_name: 'shop', cpu: 2, ram_gb: 4, disk_gb: 40 });
      assert.equal(calls[1].headers['X-Vibecloud-Sandbox'], '1');
    }, extra);
  }
});

test('Wave A route methods and body match local backend contract; cancellation needs no balance', async () => {
  const routes = [
    ['cloud_subscription_list', {}, 'GET', '/api/subscriptions', undefined],
    ['cloud_subscription_update', { service_id: 's/1', plan_code: 'kinh-doanh', period: 'year', auto_renew: true }, 'POST', '/api/services/s%2F1/subscription', { plan_code: 'kinh-doanh', period: 'year', auto_renew: true }],
    ['vibecloud_subscription_update', { service_id: 's/1', auto_renew: false, cancel_action: 'stop' }, 'POST', '/api/services/s%2F1/subscription', { auto_renew: false, cancel_action: 'stop' }],
    ['cloud_invoice_list', {}, 'GET', '/api/invoices', undefined],
    ['cloud_credit_redeem', { code: ' welcome ' }, 'POST', '/api/credit-codes/redeem', { code: 'WELCOME' }],
  ];
  await fixture(() => json({ ok: true }), async (client, calls) => {
    for (const [name, args, method, path, body] of routes) {
      assert.equal((await call(client, name, args)).isError, undefined);
      assert.equal(calls.at(-1).path, path); assert.equal(calls.at(-1).method, method);
      assert.deepEqual(calls.at(-1).body, body);
      assert.equal(calls.at(-1).headers.Authorization, 'Bearer fake-compute');
    }
    assert.equal(calls.length, routes.length);
  });
});

test('invoice download preserves binary bytes in private file, does not trust remote filename', async () => {
  const bytes = Buffer.from('%PDF-1.4\n\x00\xff\xfe\x80\n%%EOF', 'binary');
  await fixture(() => ({ ok: true, status: 200, headers: { get: () => '../../evil.pdf' }, arrayBuffer: async () => bytes }), async (client, calls) => {
    const result = data(await call(client, 'cloud_invoice_pdf', { invoice_id: '../a/b' }));
    try {
      assert.deepEqual(await readFile(result.path), bytes);
      assert.equal((await stat(result.path)).mode & 0o777, 0o600);
      assert.equal((await stat(dirname(result.path))).mode & 0o777, 0o700);
      assert.equal(result.size_bytes, bytes.length);
      assert.equal(calls[0].path, '/api/invoices/..%2Fa%2Fb.pdf');
      assert.equal(calls[0].headers.Accept, 'application/pdf');
      assert.equal(calls[0].headers.Authorization, 'Bearer fake-compute');
      assert.equal(calls[0].redirect, 'error');
    } finally { await rm(dirname(result.path), { recursive: true, force: true }); }
  });
  await fixture(() => ({ ok: true, arrayBuffer: async () => Buffer.from('<html>login</html>') }), async (client) => {
    assert.equal(data(await call(client, 'cloud_invoice_pdf', { invoice_id: 'i1' })).code, 'invalid_pdf');
  });
});

test('upstream auth, credit, budget and rollout errors are returned without false success', async () => {
  for (const [name, args, status, code] of [
    ['cloud_credit_redeem', { code: 'USED' }, 409, 'already_redeemed'],
    ['cloud_invoice_pdf', { invoice_id: 'missing' }, 404, 'not_found'],
    ['cloud_invoice_pdf', { invoice_id: 'other-owner' }, 403, 'forbidden'],
    ['cloud_subscription_update', { service_id: 's1', plan_code: 'kinh-doanh' }, 402, 'insufficient_funds'],
    ['cloud_app_list', {}, 404, 'not_found'],
    ['cloud_app_create', { repo_url: 'https://git.test/a/b', sandbox: true }, 503, 'rollout_pending'],
  ]) {
    await fixture(() => json({ code, message: 'API error' }, status), async (client) => {
      const result = await call(client, name, args); assert.equal(result.isError, true); assert.equal(data(result).code, code);
    });
  }
});

test('app create sends defaults and sandbox header, polls queued/running to URL, preserves estimate', async () => {
  let polls = 0;
  await fixture((req) => {
    if (req.path === '/api/apps') return json({ id: 'job/1', status: 'queued' });
    if (req.path === '/api/jobs/job%2F1') return json(++polls === 1 ? { status: 'running' } : { status: 'done', result: { url: 'https://shop-sandbox.app.monacloud.vn', application_id: 'app1', app_id: 'mona-app1', status: 'done', estimated_app_host: { hourly_rate_vnd: 123 } } });
    throw new Error(`Unexpected ${req.path}`);
  }, async (client, calls) => {
    const result = data(await call(client, 'cloud_app_create', { repo_url: 'https://git.test/shop.git', sandbox: true, interval_sec: 1 }));
    assert.equal(result.url, 'https://shop-sandbox.app.monacloud.vn');
    assert.equal(result.job_id, 'job/1'); assert.equal(result.sandbox, true);
    assert.deepEqual(result.estimate, { hourly_rate_vnd: 123 });
    assert.deepEqual(calls[0].body, { repo_url: 'https://git.test/shop.git', branch: 'main', build_type: 'dockerfile', dockerfile: 'Dockerfile', env: {}, port: 3000 });
    assert.equal(calls[0].headers['X-Vibecloud-Sandbox'], '1');
    assert.equal(calls.length, 3);
  });
});

test('live app create is guarded and forwards every app field; wait=false returns job without polling', async () => {
  const body = { repo_url: 'https://git.test/team/shop.git', branch: 'release', build_type: 'static', dockerfile: 'ops/Dockerfile', env: { SECRET: 'fake-value' }, domain: 'shop.test', app_host_id: 'host1', port: 8080 };
  await fixture((req) => req.path === '/v1/balance' ? json({ balance_vnd: 100 }) : json({ job_id: 'job1', status: 'queued' }), async (client, calls) => {
    const result = await call(client, 'cloud_app_create', { ...body, wait: false });
    assert.equal(result.isError, undefined);
    assert.deepEqual(calls.map((r) => r.path), ['/v1/balance', '/api/apps']);
    assert.deepEqual(calls[1].body, body); assert.equal(calls[1].headers['X-Vibecloud-Sandbox'], undefined);
  });
});

test('app lifecycle wire contract including env, domains, logs query, delete and aliases', async () => {
  const routes = [
    ['cloud_app_list', {}, 'GET', '/api/apps'], ['cloud_app_host_list', {}, 'GET', '/api/app-hosts'],
    ['cloud_app_get', { app_id: 'a/1' }, 'GET', '/api/apps/a%2F1'],
    ['cloud_app_deploy', { app_id: 'a/1', wait: false }, 'POST', '/api/apps/a%2F1/deploy'],
    ['cloud_app_env_set', { app_id: 'a/1', env: { NODE_ENV: 'production', SECRET: 'fake-only' } }, 'PUT', '/api/apps/a%2F1/env', { env: { NODE_ENV: 'production', SECRET: 'fake-only' } }],
    ['cloud_app_domain_add', { app_id: 'a/1', host: 'shop.test' }, 'POST', '/api/apps/a%2F1/domains', { host: 'shop.test' }],
    ['cloud_app_logs', { app_id: 'a/1', deployment: 'd/1?x' }, 'GET', '/api/apps/a%2F1/logs?deployment=d%2F1%3Fx'],
    ['cloud_app_delete', { app_id: 'a/1' }, 'DELETE', '/api/apps/a%2F1'],
  ];
  await fixture((req) => req.method === 'DELETE' ? { ok: true, status: 204, headers: { get: () => null }, text: async () => '' } : json({ ok: true }), async (client, calls) => {
    for (const [name, args, method, path, body] of routes) {
      for (const tool of [name, name.replace('cloud_', 'vibecloud_')]) {
        const result = await call(client, tool, args);
        assert.equal(result.isError, undefined);
        assert.equal(data(result).sandbox, true);
        assert.equal(calls.at(-1).path, path); assert.equal(calls.at(-1).method, method);
        assert.deepEqual(calls.at(-1).body, body);
        assert.equal(calls.at(-1).headers['X-Vibecloud-Sandbox'], '1');
      }
    }
    assert.equal(calls.length, routes.length * 2);
  }, { MONACLOUD_SANDBOX: '1' });
});

test('failed/cancelled app jobs are errors; timeout returns job ID and never submits twice', async () => {
  for (const status of ['failed', 'error', 'cancelled']) {
    await fixture((req) => json(req.path === '/api/apps' ? { id: 'job1', status: 'queued' } : { status, error: 'Dockerfile missing' }), async (client) => {
      const result = await call(client, 'cloud_app_create', { repo_url: 'https://git.test/a/b', sandbox: true });
      assert.equal(result.isError, true); assert.equal(data(result).code, 'app_deploy_failed'); assert.match(data(result).message, /job1.*Dockerfile/);
    });
  }
  await fixture(() => json({ id: 'job1', status: 'running' }), async (client, calls) => {
    const result = data(await call(client, 'cloud_app_create', { repo_url: 'https://git.test/a/b', sandbox: true, timeout_sec: 1, interval_sec: 1 }));
    assert.equal(result.polling, 'timeout'); assert.equal(result.job_id, 'job1');
    assert.equal(calls.filter((r) => r.method === 'POST').length, 1);
  });
});

test('invalid Wave A/B inputs never reach HTTP; prompts and agent stubs route deploy repo to app tools', async () => {
  await fixture(() => { throw new Error('No HTTP expected'); }, async (client, calls) => {
    for (const [name, args] of [
      ['cloud_vps_create', { app_name: 'shop', billing_mode: 'monthly' }],
      ['cloud_vps_create', { app_name: 'shop', plan_code: 'kinh-doanh', cpu: 1, ram_gb: 1, disk_gb: 20 }],
      ['cloud_subscription_update', { service_id: 's1' }], ['cloud_subscription_update', { service_id: 's1', cancel_action: 'delete' }],
      ['cloud_credit_redeem', { code: ' ' }], ['cloud_app_create', { repo_url: 'file:///etc/passwd' }], ['cloud_app_create', { repo_url: 'git@git.test:team/shop.git' }], ['cloud_app_create', { repo_url: 'https://git.test/a/b', branch: '../bad' }], ['cloud_app_create', { repo_url: 'https://git.test/a/b', env: { A: '\0' } }],
      ['cloud_app_create', { repo_url: 'https://secret@git.test/a/b' }], ['cloud_app_create', { repo_url: 'https://git.test/a/b', port: 65536 }],
      ['cloud_app_create', { repo_url: 'https://git.test/a/b', build_type: 'shell' }], ['cloud_app_create', { repo_url: 'https://git.test/a/b', env: { BAD: 1 } }],
      ['cloud_app_env_set', { app_id: 'a1', env: { 'BAD-KEY': 'x' } }], ['cloud_app_domain_add', { app_id: 'a1', host: 'https://shop.test' }],
      ['cloud_app_delete', { app_id: 'a1', force: true }],
    ]) assert.equal((await call(client, name, args)).isError, true, name);
    assert.equal(calls.length, 0);
    const resource = await client.readResource({ uri: 'monacloud://llms' });
    assert.match(resource.contents[0].text, /cloud_app_create.*đang mở/);
    const prompt = await client.getPrompt({ name: 'dung-app-ban-hang-monacloud', arguments: {} });
    assert.match(prompt.messages[0].content.text, /cloud_app_host_list.*cloud_app_create/);
    assert.match(data(await call(client, 'agent_deploy', { template: 'sales-chot-don' })).next_step, /cloud_app_create/);
  });
});
