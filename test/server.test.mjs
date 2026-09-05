import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readConfig } from '../dist/config.js';
import { createServer } from '../dist/server.js';

function response(value, status = 200, headers = {}) {
  const normalizedHeaders = Object.fromEntries(
    Object.entries({ 'content-type': 'application/json', ...headers }).map(([key, item]) => [key.toLowerCase(), item]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => normalizedHeaders[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(value),
    json: async () => value,
  };
}

function parsedText(result) {
  const item = result.content?.find((entry) => entry.type === 'text');
  assert.ok(item);
  return JSON.parse(item.text);
}

async function withClient(fetchImpl, env, callback) {
  const server = createServer({ config: readConfig(env), env, fetchImpl });
  const client = new Client({ name: 'unit-test', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    return await callback(client);
  } finally {
    await client.close();
  }
}

test('MONA Cloud provision luôn đọc ví trước rồi mới tạo VPS', async () => {
  const calls = [];
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_BILLING_URL: 'https://billing.test',
    MONACLOUD_API: 'https://cloud.test',
    MONAPAY_API: 'https://pay.test',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url) === 'https://billing.test/v1/balance') return response({ balance_vnd: 150000, currency: 'VND' });
    if (String(url) === 'https://cloud.test/api/lxc') return response({ id: 'job-1', status: 'pending', type: 'create_lxc' });
    throw new Error(`Unexpected URL ${url}`);
  };
  await withClient(fetchImpl, env, async (client) => {
    const result = parsedText(await client.callTool({
      name: 'cloud_vps_create',
      arguments: { app_name: 'shop-test', package_slug: 'standard-2' },
    }));
    assert.equal(result.id, 'job-1');
  });
  assert.deepEqual(calls.map((call) => call.url), [
    'https://billing.test/v1/balance',
    'https://cloud.test/api/lxc',
  ]);
  assert.equal(calls[1].init.headers.Authorization, 'Bearer fake-token');
});

test('sandbox create bỏ qua billing, gửi header và đánh dấu response', async () => {
  const calls = [];
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_SANDBOX: '0',
    MONACLOUD_BILLING_URL: 'https://billing.test',
    MONACLOUD_API: 'https://cloud.test',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(String(url), 'https://cloud.test/api/lxc');
    return response({ id: 'sandbox-job-1', status: 'queued' }, 202);
  };
  await withClient(fetchImpl, env, async (client) => {
    const result = parsedText(await client.callTool({
      name: 'cloud_vps_create',
      arguments: { app_name: 'sandbox-shop', package_slug: 'standard-2', sandbox: true },
    }));
    assert.equal(result.id, 'sandbox-job-1');
    assert.equal(result.sandbox, true);
  });
  assert.equal(calls.length, 1, 'sandbox không được gọi Billing');
  assert.equal(calls[0].init.headers['X-Vibecloud-Sandbox'], '1');
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    app_name: 'sandbox-shop',
    package_slug: 'standard-2',
  });
});

test('MONACLOUD_SANDBOX=1 áp dụng cho alias và bỏ qua billing', async () => {
  const calls = [];
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_SANDBOX: '1',
    MONACLOUD_BILLING_URL: 'https://billing.test',
    MONACLOUD_API: 'https://cloud.test',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(String(url), 'https://cloud.test/api/databases');
    return response({ id: 'sandbox-db-job', status: 'queued' }, 202);
  };
  await withClient(fetchImpl, env, async (client) => {
    const result = parsedText(await client.callTool({
      name: 'vibecloud_create_database',
      arguments: { app_name: 'sandbox-db', package_slug: 'standard-2', engine: 'postgresql' },
    }));
    assert.equal(result.sandbox, true);
  });
  assert.equal(calls.length, 1, 'env sandbox không được gọi Billing');
  assert.equal(calls[0].init.headers['X-Vibecloud-Sandbox'], '1');
});

test('non-sandbox vẫn bị spend guard chặn khi ví bằng 0', async () => {
  const calls = [];
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_SANDBOX: '0',
    MONACLOUD_BILLING_URL: 'https://billing.test',
    MONACLOUD_API: 'https://cloud.test',
  };
  const fetchImpl = async (url) => {
    calls.push(String(url));
    assert.equal(String(url), 'https://billing.test/v1/balance');
    return response({ balance_vnd: 0, currency: 'VND' });
  };
  await withClient(fetchImpl, env, async (client) => {
    const raw = await client.callTool({
      name: 'cloud_vps_create',
      arguments: { app_name: 'real-shop', package_slug: 'standard-2' },
    });
    assert.equal(raw.isError, true);
    assert.equal(parsedText(raw).code, 'insufficient_funds');
  });
  assert.deepEqual(calls, ['https://billing.test/v1/balance']);
});

test('poll và list hiểu sandbox mà không gửi sandbox header', async () => {
  const calls = [];
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_SANDBOX: '0',
    MONACLOUD_API: 'https://cloud.test',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    assert.equal(init.headers['X-Vibecloud-Sandbox'], undefined);
    if (String(url) === 'https://cloud.test/api/jobs/sandbox-job-1') {
      return response({ id: 'sandbox-job-1', status: 'done', sandbox: true });
    }
    if (String(url) === 'https://cloud.test/api/services?include_sandbox=1') {
      return response([{ id: 'sandbox-service-1', sandbox: true }]);
    }
    throw new Error(`Unexpected URL ${url}`);
  };
  await withClient(fetchImpl, env, async (client) => {
    const job = parsedText(await client.callTool({
      name: 'cloud_job_status',
      arguments: { job_id: 'sandbox-job-1', sandbox: true },
    }));
    assert.equal(job.status, 'done');
    assert.equal(job.sandbox, true);
    const services = parsedText(await client.callTool({
      name: 'cloud_services_list',
      arguments: { sandbox: true },
    }));
    assert.equal(services[0].sandbox, true);
  });
  assert.equal(calls.length, 2);
});

test('402 budget_exceeded trả lỗi JSON cho AI với next_step nạp ví', async () => {
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_BILLING_URL: 'https://billing.test',
    MONACLOUD_API: 'https://cloud.test',
    MONAPAY_API: 'https://pay.test',
  };
  const fetchImpl = async () => response(
    { code: 'budget_exceeded', message: 'Monthly project budget exceeded', shortage_vnd: 20000 },
    402,
    { 'x-request-id': 'req-budget-1' },
  );
  await withClient(fetchImpl, env, async (client) => {
    const result = await client.callTool({ name: 'cloud_service_start', arguments: { service_id: 'service-1' } });
    assert.equal(result.isError, true);
    const error = parsedText(result);
    assert.equal(error.code, 'budget_exceeded');
    assert.match(error.message, /20\.000 đ/);
    assert.match(error.next_step, /monacloud\.vn\/console/);
    assert.equal(error.request_id, 'req-budget-1');
  });
});

test('cloud_topup ánh xạ amount, idempotency và trả hướng dẫn VietQR', async () => {
  let captured;
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_BILLING_URL: 'https://billing.test',
  };
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://billing.test/v1/topups');
    captured = init;
    return response({ topup_id: 'topup-1', qr_data_url: 'data:image/png;base64,QR', status: 'pending' }, 201);
  };
  await withClient(fetchImpl, env, async (client) => {
    const result = parsedText(await client.callTool({
      name: 'cloud_topup',
      arguments: { amount: 200000, idempotency_key: 'topup-shop-1' },
    }));
    assert.equal(result.qr_data_url, 'data:image/png;base64,QR');
    assert.match(result.instructions, /quét qr_data_url/);
  });
  assert.deepEqual(JSON.parse(captured.body), { amount_vnd: 200000 });
  assert.equal(captured.headers['Idempotency-Key'], 'topup-shop-1');
  assert.equal(captured.headers.Authorization, 'Bearer fake-token');
});

test('cloud_link ưu tiên Bearer MONA Pass trực tiếp, không tạo credential phụ', async () => {
  const calls = [];
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'one-mona-id-token',
    MONACLOUD_API: 'https://cloud.test',
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return response([]);
  };
  await withClient(fetchImpl, env, async (client) => {
    const result = parsedText(await client.callTool({ name: 'cloud_link', arguments: {} }));
    assert.equal(result.mode, 'direct_mona_id');
  });
  assert.deepEqual(calls.map((call) => call.url), ['https://cloud.test/api/services']);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer one-mona-id-token');
});

test('API compute mặc định dùng monacloud.vn và env VIBECLOUD_API cũ vẫn nhận', async () => {
  assert.equal(readConfig({}).vibecloudApi, 'https://api.monacloud.vn');
  assert.equal(readConfig({ VIBECLOUD_API: 'https://legacy.test/' }).vibecloudApi, 'https://legacy.test');
  assert.equal(readConfig({
    MONACLOUD_API: 'https://new.test/',
    VIBECLOUD_API: 'https://legacy.test/',
  }).vibecloudApi, 'https://new.test');
});

test('alias vibecloud_* cũ vẫn gọi được', async () => {
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    VIBECLOUD_API: 'https://legacy.test',
  };
  const fetchImpl = async (url) => {
    assert.equal(String(url), 'https://legacy.test/api/prices');
    return response({ cpu_hour_vnd: 250 });
  };
  await withClient(fetchImpl, env, async (client) => {
    const listed = await client.listTools();
    const compatibilityPairs = [
      ['cloud_vps_create', 'vibecloud_create_vps'],
      ['cloud_db_create', 'vibecloud_create_database'],
      ['cloud_job_status', 'vibecloud_job_status'],
      ['cloud_services_list', 'vibecloud_list_services'],
      ['cloud_service_start', 'vibecloud_start'],
      ['cloud_service_stop', 'vibecloud_stop'],
      ['cloud_service_rebuild', 'vibecloud_rebuild'],
      ['cloud_prices', 'vibecloud_prices'],
      ['cloud_packages', 'vibecloud_packages'],
      ['cloud_agent_deploy', 'vibecloud_agent_deploy'],
      ['cloud_link', 'vibecloud_link'],
    ];
    for (const name of compatibilityPairs.flat()) {
      assert.ok(listed.tools.some((tool) => tool.name === name));
    }
    const sandboxMutations = [
      'cloud_vps_create',
      'vibecloud_create_vps',
      'cloud_db_create',
      'vibecloud_create_database',
      'cloud_service_start',
      'vibecloud_start',
      'cloud_service_rebuild',
      'vibecloud_rebuild',
      'cloud_agent_deploy',
      'vibecloud_agent_deploy',
    ];
    for (const name of sandboxMutations) {
      const tool = listed.tools.find((entry) => entry.name === name);
      assert.match(tool.description, /sandbox=true: thử 0đ, không cần ví/);
      assert.ok(tool.inputSchema.properties.sandbox);
    }
    for (const name of ['cloud_job_status', 'vibecloud_job_status', 'cloud_services_list', 'vibecloud_list_services']) {
      const tool = listed.tools.find((entry) => entry.name === name);
      assert.ok(tool.inputSchema.properties.sandbox);
    }
    const result = parsedText(await client.callTool({ name: 'vibecloud_prices', arguments: {} }));
    assert.equal(result.cpu_hour_vnd, 250);
  });
});

test('re-export dependency MONA Pay giữ tool cũ và chuẩn hoá lỗi JSON', async () => {
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_CONFIG_DIR: join(tmpdir(), `monacloud-no-link-${process.pid}`),
  };
  await withClient(async () => { throw new Error('không được gọi mạng'); }, env, async (client) => {
    const listed = await client.listTools();
    const monapay = listed.tools.filter((tool) => tool.name.startsWith('monapay_'));
    assert.ok(monapay.length >= 25, '24 tool gốc + monapay_link');
    for (const name of ['monapay_create_qr', 'monapay_link_bank_start', 'monapay_create_webhook']) {
      assert.ok(monapay.some((tool) => tool.name === name));
    }
    const result = await client.callTool({ name: 'monapay_whoami', arguments: {} });
    assert.equal(result.isError, true);
    const error = parsedText(result);
    assert.equal(error.code, 'monapay_error');
    assert.match(error.next_step, /monapay_link/);
    assert.doesNotMatch(result.content[0].text, /fake-token/);
  });
});

test('agent catalog đọc template local và chặn slug traversal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'monacloud-templates-'));
  const template = join(root, 'sales-chot-don');
  await mkdir(join(template, 'skills'), { recursive: true });
  await writeFile(join(template, 'README.md'), '# Sales chốt đơn\n\nTạo QR và xác nhận tiền.\n');
  await writeFile(join(template, 'AGENTS.md'), '# Agent instructions\n');
  await writeFile(join(template, 'skills', 'payment.md'), '# Payment skill\n');
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_TEMPLATES_DIR: root,
  };
  await withClient(async () => response({}), env, async (client) => {
    const listed = parsedText(await client.callTool({ name: 'agent_templates_list', arguments: {} }));
    assert.equal(listed.templates[0].slug, 'sales-chot-don');
    const detail = parsedText(await client.callTool({
      name: 'agent_templates_get', arguments: { template: 'sales-chot-don' },
    }));
    assert.match(detail.files['AGENTS.md'], /Agent instructions/);
    assert.match(detail.files['skills/payment.md'], /Payment skill/);

    const invalid = await client.callTool({ name: 'agent_templates_get', arguments: { template: '../secret' } });
    assert.equal(invalid.isError, true);
  });
});
