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

const mailEnv = {
  MONACLOUD_TOKEN: 'fake-mail-mona-pass',
  MONAMAIL_API: 'https://mail.test/',
};
const mailBody = {
  from: 'Shop <noreply@shop.test>',
  to: ['owner@example.test', 'Khách <customer@example.test>'],
  subject: 'Mã OTP',
  html: '<b>123456</b>',
  text: '123456',
  reply_to: 'support@shop.test',
  tags: ['otp', 'transactional'],
  unsubscribe_url: 'https://shop.test/unsubscribe',
};

test('MONAMAIL_API có mặc định và bỏ dấu / cuối URL', () => {
  assert.equal(readConfig({}).monamailApi, 'https://api.monamail.vn');
  assert.equal(readConfig(mailEnv).monamailApi, 'https://mail.test');
});

test('mail_send gửi MONA Pass, idempotency, body và sandbox header qua MCP', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://mail.test/v1/emails');
    calls.push(init);
    return response({ id: 'email-1', status: 'queued', deliveries: [] }, 201);
  };
  await withClient(fetchImpl, mailEnv, async (client) => {
    const live = parsedText(await client.callTool({
      name: 'mail_send', arguments: { ...mailBody, idempotency_key: 'otp-request-1' },
    }));
    assert.equal(live.id, 'email-1');
    assert.equal(live.sandbox, undefined);
    const sandbox = parsedText(await client.callTool({
      name: 'mail_send', arguments: { ...mailBody, sandbox: true },
    }));
    assert.equal(sandbox.sandbox, true, 'MCP đánh dấu sandbox dù response API chưa có');
  });
  assert.equal(calls.length, 2, 'Mail không gọi Billing hoặc adapter token');
  for (const call of calls) {
    assert.equal(call.method, 'POST');
    assert.equal(call.headers.Authorization, 'Bearer fake-mail-mona-pass');
    assert.equal(call.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(call.body), mailBody);
  }
  assert.equal(calls[0].headers['Idempotency-Key'], 'otp-request-1');
  assert.equal(calls[0].headers['X-Mona-Sandbox'], undefined);
  assert.match(calls[1].headers['Idempotency-Key'], /^mcp-mail-[0-9a-f-]{36}$/);
  assert.equal(calls[1].headers['X-Mona-Sandbox'], '1');
});

test('mail_domain_add trả records DNS, chuẩn hoá IDN và chuyển token CF một lần', async () => {
  const records = [
    { type: 'TXT', name: 'mona1._domainkey.shop.test', value: 'v=DKIM1; k=rsa; p=public-fixture', purpose: 'dkim', required: true },
    { type: 'TXT', name: 'shop.test', value: 'v=spf1 include:_spf.monamail.vn ~all', purpose: 'spf', required: false },
    { type: 'TXT', name: '_dmarc.shop.test', value: 'v=DMARC1; p=none', purpose: 'dmarc', required: false },
  ];
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    return response(String(url).endsWith('/cloudflare')
      ? { added: records, status: 'verified' }
      : { id: 'domain/1', domain: JSON.parse(init.body).domain, status: 'pending', records }, 201);
  };
  await withClient(fetchImpl, mailEnv, async (client) => {
    const added = parsedText(await client.callTool({
      name: 'mail_domain_add', arguments: { domain: 'SHOP.test', idempotency_key: 'domain-shop-1' },
    }));
    assert.deepEqual(added.records, records);
    assert.equal(added.domain, 'shop.test');
    assert.match(added.instructions, /mail_domain_verify/);
    assert.match(added.instructions, /mail_domain_cloudflare/);
    const cf = await client.callTool({
      name: 'mail_domain_cloudflare', arguments: { domain_id: added.id, api_token: 'fake-cf-token-once' },
    });
    assert.equal(parsedText(cf).status, 'verified');
    assert.doesNotMatch(cf.content[0].text, /fake-cf-token-once/);
    const idn = parsedText(await client.callTool({ name: 'mail_domain_add', arguments: { domain: 'bücher.test' } }));
    assert.equal(idn.domain, 'xn--bcher-kva.test');
  });
  assert.equal(calls[0].url, 'https://mail.test/v1/domains');
  assert.equal(calls[0].init.headers['Idempotency-Key'], 'domain-shop-1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { domain: 'shop.test' });
  assert.equal(calls[1].url, 'https://mail.test/v1/domains/domain%2F1/cloudflare');
  assert.deepEqual(JSON.parse(calls[1].init.body), { api_token: 'fake-cf-token-once' });
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Authorization, 'Bearer fake-mail-mona-pass');
    assert.ok(init.headers['Idempotency-Key']);
  }
  assert.notEqual(calls[1].init.headers['Idempotency-Key'], calls[2].init.headers['Idempotency-Key']);
});

test('mail_api_key_create trả secret một lần để app lưu vào .env', async () => {
  const created = { id: 'key-1', name: 'shop', mode: 'test', key: `mm_test_${'0'.repeat(32)}`, prefix: 'mm_test_0000' };
  let captured;
  await withClient(async (url, init) => {
    assert.equal(String(url), 'https://mail.test/v1/api-keys');
    captured = init;
    return response(created, 201);
  }, mailEnv, async (client) => {
    const result = parsedText(await client.callTool({
      name: 'mail_api_key_create', arguments: { name: 'shop', mode: 'test', idempotency_key: 'key-shop-1' },
    }));
    assert.deepEqual(result, created);
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === 'mail_api_key_create').description;
    assert.match(description, /Key chỉ trả một lần; ghi vào \.env của app dưới tên MONAMAIL_API_KEY, không cần in ra chat/);
  });
  assert.equal(captured.method, 'POST');
  assert.equal(captured.headers.Authorization, 'Bearer fake-mail-mona-pass');
  assert.equal(captured.headers['Idempotency-Key'], 'key-shop-1');
  assert.deepEqual(JSON.parse(captured.body), { name: 'shop', mode: 'test' });
});

test('mail_plan_set 402 trả insufficient_funds và next_step nhắc cloud_topup', async () => {
  let captured;
  await withClient(async (url, init) => {
    assert.equal(String(url), 'https://mail.test/v1/account/plan');
    captured = init;
    return response({ code: 'insufficient_funds', needed_vnd: 99000, topup_hint: 'cloud_topup' }, 402, { 'X-Request-Id': 'req-mail-plan' });
  }, mailEnv, async (client) => {
    const result = await client.callTool({ name: 'mail_plan_set', arguments: { plan: 'khoi-nghiep' } });
    assert.equal(result.isError, true);
    const error = parsedText(result);
    assert.equal(error.code, 'insufficient_funds');
    assert.match(error.next_step, /cloud_topup/);
    assert.equal(error.request_id, 'req-mail-plan');
    assert.doesNotMatch(error.next_step, /\bVâng\b|—/u);
  });
  assert.equal(captured.method, 'PUT');
  assert.equal(captured.headers.Authorization, 'Bearer fake-mail-mona-pass');
  assert.deepEqual(JSON.parse(captured.body), { plan: 'khoi-nghiep' });
});

test('mail_send giữ nguyên 403 domain_not_verified cùng next_step và request_id từ API', async () => {
  const upstream = {
    code: 'domain_not_verified',
    message: 'Domain gửi chưa được xác minh.',
    next_step: 'Gọi mail_domain_add rồi mail_domain_verify, hoặc gửi onboarding@monamail.vn tới owner@example.test.',
    request_id: 'req-domain-403',
  };
  await withClient(async () => response(upstream, 403), mailEnv, async (client) => {
    const result = await client.callTool({ name: 'mail_send', arguments: mailBody });
    assert.equal(result.isError, true);
    assert.deepEqual(parsedText(result), upstream);
  });
});

test('lỗi quota, budget và idempotency của Mail giữ nguyên hướng dẫn API', async () => {
  for (const [status, code, next_step] of [
    [402, 'quota_exceeded', 'Gọi mail_plan_set để đổi gói.'],
    [402, 'budget_exceeded', 'Gọi cloud_budget_get rồi tăng ngân sách.'],
    [409, 'idempotency_conflict', 'Giữ body cũ hoặc dùng key mới cho yêu cầu mới.'],
    [429, 'rate_limited', 'Chờ 60 giây rồi thử lại cùng idempotency key.'],
  ]) {
    const upstream = { code, message: 'Yêu cầu chưa thực hiện được.', next_step, request_id: `req-${code}` };
    await withClient(async () => response(upstream, status), mailEnv, async (client) => {
      const result = await client.callTool({ name: 'mail_send', arguments: mailBody });
      assert.equal(result.isError, true);
      assert.deepEqual(parsedText(result), upstream);
    });
  }
});

test('tool Mail ánh xạ đúng GET, POST, DELETE, query và body theo contract', async () => {
  const routes = [
    ['mail_account', {}, 'GET', '/v1/account'],
    ['mail_plans', {}, 'GET', '/v1/plans'],
    ['mail_status', { email_id: 'email/1' }, 'GET', '/v1/emails/email%2F1'],
    ['mail_list', { limit: 100, status: 'bounced', to: 'user+otp@example.test', since: '2026-09-01T00:00:00+07:00' }, 'GET', '/v1/emails?limit=100&status=bounced&to=user%2Botp%40example.test&since=2026-09-01T00%3A00%3A00%2B07%3A00'],
    ['mail_domain_verify', { domain_id: 'domain/1' }, 'POST', '/v1/domains/domain%2F1/verify'],
    ['mail_domains_list', {}, 'GET', '/v1/domains'],
    ['mail_api_keys_list', {}, 'GET', '/v1/api-keys'],
    ['mail_api_key_revoke', { key_id: 'key/1' }, 'DELETE', '/v1/api-keys/key%2F1'],
    ['mail_webhook_create', { url: 'https://shop.test/mail/events', events: ['email.bounced'] }, 'POST', '/v1/webhooks', { url: 'https://shop.test/mail/events', events: ['email.bounced'] }],
    ['mail_webhooks_list', {}, 'GET', '/v1/webhooks'],
    ['mail_webhook_test', { webhook_id: 'hook/1' }, 'POST', '/v1/webhooks/hook%2F1/test'],
    ['mail_suppressions_list', {}, 'GET', '/v1/suppressions'],
    ['mail_suppression_remove', { email: 'user+otp@example.test' }, 'DELETE', '/v1/suppressions/user%2Botp%40example.test'],
    ['mail_template_create', { name: 'otp', subject: 'Mã {{otp}}', html: '<b>{{otp}}</b>', text: '{{otp}}' }, 'POST', '/v1/templates', { name: 'otp', subject: 'Mã {{otp}}', html: '<b>{{otp}}</b>', text: '{{otp}}' }],
    ['mail_stats', { from: '2026-09-01', to: '2026-09-05' }, 'GET', '/v1/stats?from=2026-09-01&to=2026-09-05'],
    ['mail_stats', {}, 'GET', '/v1/stats'],
  ];
  let expected;
  const captured = [];
  await withClient(async (url, init) => {
    const [, , method, path, body] = expected;
    assert.equal(String(url), `https://mail.test${path}`);
    assert.equal(init.method, method);
    assert.equal(init.headers.Authorization, 'Bearer fake-mail-mona-pass');
    assert.deepEqual(init.body === undefined ? undefined : JSON.parse(init.body), body);
    if (method === 'POST') {
      captured.push(init.headers['Idempotency-Key']);
      if (expected[1].idempotency_key) assert.equal(init.headers['Idempotency-Key'], expected[1].idempotency_key);
      else assert.match(init.headers['Idempotency-Key'], /^mcp-mail-[0-9a-f-]{36}$/);
    } else assert.equal(init.headers['Idempotency-Key'], undefined);
    return method === 'DELETE'
      ? { ok: true, status: 204, headers: { get: () => null }, text: async () => '' }
      : response({ ok: true });
  }, mailEnv, async (client) => {
    for (const route of routes) {
      expected = route;
      const result = await client.callTool({ name: route[0], arguments: route[1] });
      assert.equal(result.isError, undefined, route[0]);
      assert.deepEqual(parsedText(result), route[2] === 'DELETE' ? {} : { ok: true });
      if (route[2] === 'POST') {
        expected = [route[0], { ...route[1], idempotency_key: `retry-${route[0]}` }, ...route.slice(2)];
        const retry = await client.callTool({ name: expected[0], arguments: expected[1] });
        assert.equal(retry.isError, undefined, route[0]);
      }
    }
  });
  assert.equal(new Set(captured).size, captured.length);
});

test('schema Mail chặn dữ liệu sai trước fetch và nhận template hoặc 50 người nhận', async () => {
  let fetches = 0;
  await withClient(async () => { fetches += 1; return response({ id: 'valid' }, 201); }, mailEnv, async (client) => {
    const invalid = [
      ['mail_send', { ...mailBody, to: 'invalid-email' }],
      ['mail_send', { ...mailBody, from: 'Shop <bad@example.test' }],
      ['mail_send', { ...mailBody, to: [] }],
      ['mail_send', { ...mailBody, to: Array(51).fill('a@example.test') }],
      ['mail_send', { ...mailBody, tags: Array(11).fill('otp') }],
      ['mail_send', { ...mailBody, tags: ['bad tag'] }],
      ['mail_send', { ...mailBody, subject: 'a'.repeat(999) }],
      ['mail_send', { from: mailBody.from, to: mailBody.to, subject: 'Missing content' }],
      ['mail_send', { from: mailBody.from, to: mailBody.to, text: 'Missing subject' }],
      ['mail_send', { ...mailBody, idempotency_key: 'bad\nheader' }],
      ['mail_send', { ...mailBody, sandbox: 'true' }],
      ['mail_send', { ...mailBody, unknown: true }],
      ['mail_domain_add', { domain: 'https://shop.test' }],
      ['mail_domain_add', { domain: 'sub.monamail.vn' }],
      ['mail_plan_set', { plan: 'premium' }],
      ['mail_api_key_create', { name: 'shop', mode: 'sandbox' }],
      ['mail_webhook_create', { url: 'http://shop.test/hooks', events: ['email.bounced'] }],
      ['mail_webhook_create', { url: 'https://shop.test/hooks', events: ['email.opened'] }],
      ['mail_webhook_create', { url: 'https://shop.test/hooks', events: [] }],
      ['mail_list', { limit: 101 }],
      ['mail_list', { since: '2026-02-30' }],
      ['mail_stats', { from: '2026-09-05', to: '2026-09-01' }],
    ];
    for (const [name, args] of invalid) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, `${name} phải từ chối input sai`);
    }
    assert.equal(fetches, 0);
    const valid = [
      { ...mailBody, to: Array(50).fill('a@example.test'), tags: Array(10).fill('otp'), subject: 'a'.repeat(998) },
      { from: mailBody.from, to: 'a@example.test', template_id: 'tpl-1', variables: { otp: '123456' } },
      { from: mailBody.from, to: 'a@example.test', subject: 'OTP', text: '123456' },
    ];
    for (const args of valid) {
      const result = await client.callTool({ name: 'mail_send', arguments: args });
      assert.equal(result.isError, undefined);
    }
    assert.equal(fetches, valid.length);
  });
});

test('Mail xuất hiện trong instructions, llms, health và prompt OTP zero-dashboard', async () => {
  const calls = [];
  await withClient(async (url, init) => {
    calls.push(String(url));
    assert.equal(init.headers.Authorization, undefined, 'Health là public');
    return response({ status: 'ok' });
  }, mailEnv, async (client) => {
    assert.equal(client.getServerVersion().version, JSON.parse(await import('node:fs/promises').then((m) => m.readFile(new URL('../package.json', import.meta.url), 'utf8'))).version);
    assert.match(client.getInstructions(), /mail_\* để gửi email giao dịch \(MONA Mail\)/);
    const llms = await client.readResource({ uri: 'monacloud://llms' });
    assert.match(llms.contents[0].text, /- mail_\*: tài khoản, domain, API key, gửi mail, trạng thái, webhook, suppression \(MONA Mail https:\/\/monamail.vn, API https:\/\/api.monamail.vn\)/);
    const health = JSON.parse((await client.readResource({ uri: 'monacloud://status' })).contents[0].text);
    assert.equal(health.members.length, 5);
    assert.equal(health.members.find((member) => member.name === 'monamail').ok, true);
    assert.ok(calls.includes('https://mail.test/v1/healthz'));
    const listed = await client.listTools();
    const mail = listed.tools.filter((tool) => tool.name.startsWith('mail_'));
    assert.equal(mail.length, 30);
    for (const tool of mail) {
      assert.match(tool.description, /Khi .*\/ Use/i);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const prompt = await client.getPrompt({ name: 'gui-mail-otp-monamail', arguments: { app_name: 'Shop OTP', framework: 'Next.js', domain: 'shop.test' } });
    const text = prompt.messages[0].content.text;
    let previous = -1;
    for (const step of ['mail_account', 'onboarding@monamail.vn', 'mail_domain_add', 'mail_domain_cloudflare', 'mail_domain_verify', 'mail_api_key_create', 'MONAMAIL_API_KEY', "from 'monamail'", 'mail_webhook_create']) {
      const index = text.indexOf(step, previous + 1);
      assert.ok(index > previous, `${step} đúng thứ tự`);
      previous = index;
    }
    for (const term of ['Shop OTP', 'Next.js', 'shop.test', 'email.bounced', 'cloud_topup', 'thêm DNS hoặc nạp tiền']) assert.ok(text.includes(term));
    const defaults = await client.getPrompt({ name: 'gui-mail-otp-monamail', arguments: {} });
    assert.match(defaults.messages[0].content.text, /app của tôi/);
  });
});

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

test('cloud_topup ví chung: ánh xạ amount, idempotency, bỏ base64, ghi qr_file, hướng dẫn quét', async () => {
  let captured;
  const configDir = await mkdtemp(join(tmpdir(), 'monacloud-topup-'));
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_BILLING_URL: 'https://billing.test',
    MONACLOUD_CONFIG_DIR: configDir,
  };
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const fetchImpl = async (url, init) => {
    assert.equal(String(url), 'https://billing.test/v1/topups');
    captured = init;
    return response({ topup_id: 'topup-1', order_ref: 'MC1', qr_data_url: `data:image/png;base64,${png}`, status: 'pending' }, 201);
  };
  await withClient(fetchImpl, env, async (client) => {
    const result = parsedText(await client.callTool({
      name: 'cloud_topup',
      arguments: { amount: 200000, idempotency_key: 'topup-shop-1' },
    }));
    assert.equal(result.qr_data_url, undefined);
    assert.equal(result.topup_id, 'topup-1');
    assert.equal(result.wallet, 'central');
    assert.equal(result.amount_vnd, 200000);
    assert.ok(result.qr_file.startsWith(configDir));
    assert.match(result.instructions, /qr_ascii/);
    assert.match(result.instructions, /cloud_topup_status/);
  });
  assert.deepEqual(JSON.parse(captured.body), { amount_vnd: 200000 });
  assert.equal(captured.headers['Idempotency-Key'], 'topup-shop-1');
  assert.equal(captured.headers.Authorization, 'Bearer fake-token');
});

test('cloud_topup fallback compute khi billing 502 monapay_unavailable: qr_ascii in được, rồi cloud_topup_status paid', async () => {
  const calls = [];
  const configDir = await mkdtemp(join(tmpdir(), 'monacloud-topup-'));
  const env = {
    ...process.env,
    MONACLOUD_TOKEN: 'fake-token',
    MONACLOUD_BILLING_URL: 'https://billing.test',
    MONACLOUD_API: 'https://api.test',
    MONACLOUD_CONFIG_DIR: configDir,
  };
  const paymentId = '66f0a1b2c3d4e5f6a7b8c9d0';
  const fetchImpl = async (url, init) => {
    calls.push(`${init?.method || 'GET'} ${url}`);
    if (String(url) === 'https://billing.test/v1/topups') return response({ code: 'monapay_unavailable' }, 502);
    if (String(url) === 'https://api.test/api/payments/vietqr') {
      assert.deepEqual(JSON.parse(init.body), { amount: 50000 });
      assert.equal(init.headers.Authorization, 'Bearer fake-token');
      return response({
        payment_id: paymentId,
        amount: 50000,
        description: 'VIBECLOUD-964152253',
        qr_url: 'https://img.vietqr.io/image/ACB-1900636648-compact2.png?amount=50000&addInfo=VIBECLOUD-964152253&accountName=VIBECLOUD',
        qr_data_url: null,
        status: 'pending',
      });
    }
    if (String(url) === `https://api.test/api/payments/${paymentId}`) {
      return response({ payment: { id: paymentId, amount: 50000, description: 'VIBECLOUD-964152253', status: 'paid', updated_at: '2026-09-17T10:59:02Z' } });
    }
    if (String(url) === 'https://api.test/api/me') return response({ user: { credit_vnd: 50000, promo_credit_vnd: 20000, total_credit_vnd: 70000 } });
    throw new Error(`unexpected ${url}`);
  };
  await withClient(fetchImpl, env, async (client) => {
    const topup = parsedText(await client.callTool({ name: 'cloud_topup', arguments: { amount: 50000 } }));
    assert.equal(topup.wallet, 'local');
    assert.equal(topup.fallback_reason, 'monapay_unavailable');
    assert.equal(topup.topup_id, paymentId);
    assert.equal(topup.order_ref, 'VIBECLOUD-964152253');
    assert.equal(topup.transfer_content, 'VIBECLOUD964152253');
    assert.equal(topup.bank, 'ACB');
    assert.equal(topup.bank_account, '1900636648');
    assert.equal(topup.amount_vnd, 50000);
    assert.equal(topup.qr_data_url, undefined);
    assert.match(topup.qr_ascii, /^(██|  )+$/m);
    assert.match(topup.qr_ascii_light, /^(██|  )+$/m);
    assert.ok(topup.qr_payload.includes('0006970416'));
    assert.ok(topup.qr_file.endsWith('topup-VIBECLOUD-964152253.png'));
    assert.match(topup.qr_url, /^https:\/\/img\.vietqr\.io\//);

    const status = parsedText(await client.callTool({ name: 'cloud_topup_status', arguments: { topup_id: paymentId } }));
    assert.equal(status.status, 'paid');
    assert.equal(status.paid, true);
    assert.equal(status.wallet, 'local');
    assert.equal(status.balance.balance_vnd, 70000);
    assert.equal(status.balance.wallet, 'local');
  });
  assert.deepEqual(calls.slice(0, 2), ['POST https://billing.test/v1/topups', 'POST https://api.test/api/payments/vietqr']);
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
  await mkdir(join(template, 'skills', 'bao-gia'), { recursive: true });
  await writeFile(join(template, 'skills', 'bao-gia', 'SKILL.md'), '---\nname: bao-gia\ndescription: Báo giá\n---\n# Báo giá\n');
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
    assert.match(detail.files['skills/bao-gia/SKILL.md'], /name: bao-gia/);

    const invalid = await client.callTool({ name: 'agent_templates_get', arguments: { template: '../secret' } });
    assert.equal(invalid.isError, true);
  });
});
