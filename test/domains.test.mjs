import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';

const json = (body, status = 200) => ({
  ok: status < 400, status, headers: { get: () => null },
  text: async () => JSON.stringify(body),
});
const data = (result) => JSON.parse(result.content[0].text);
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });

async function fixture(fetcher, run) {
  const directory = await mkdtemp(join(tmpdir(), 'mcp-domains-'));
  const calls = [];
  const env = {
    MONACLOUD_TOKEN: 'fake-pass',
    VIBECLOUD_API_TOKEN: 'fake-compute',
    MONACLOUD_CONFIG_DIR: directory,
    MONACLOUD_API: 'https://compute.test',
    MONACLOUD_BILLING_URL: 'https://billing.test',
  };
  const server = createServer({
    env,
    fetchImpl: async (url, init) => {
      const request = {
        path: new URL(url).pathname,
        query: Object.fromEntries(new URL(url).searchParams),
        method: init.method || 'GET',
        headers: init.headers || {},
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      };
      calls.push(request);
      return fetcher(request, calls);
    },
  });
  const client = new Client({ name: 'domain-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    await run(client, calls);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('Domain tools are registered and have strict schemas', async () => {
  await fixture(() => json([]), async (client) => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [
      'cloud_domain_search', 'cloud_domain_registrant_get', 'cloud_domain_registrant_set',
      'cloud_domain_buy', 'cloud_domain_list', 'cloud_domain_verify_start',
      'cloud_domain_verify_status', 'cloud_domain_health', 'cloud_domain_wait',
      'cloud_domain_webhook_set', 'cloud_domain_attach',
    ]) {
      assert.ok(names.includes(name), `Missing tool: ${name}`);
      const tool = tools.find((t) => t.name === name);
      assert.equal(tool.inputSchema.additionalProperties, false, `${name} must have additionalProperties:false`);
    }
  });
});

test('cloud_domain_search passes q, tlds, years as query params', async () => {
  await fixture((req) => {
    assert.equal(req.path, '/api/domains/search');
    assert.equal(req.query.q, 'myapp');
    assert.equal(req.query.tlds, 'vn,com');
    assert.equal(req.query.years, '2');
    return json([{ domain: 'myapp.vn', available: true, price_vnd: 756000, is_vn: true }]);
  }, async (client, calls) => {
    const result = data(await call(client, 'cloud_domain_search', { q: 'myapp', tlds: 'vn,com', years: 2 }));
    assert.ok(Array.isArray(result));
    assert.equal(calls.length, 1);
  });
});

test('cloud_domain_search — query only with q', async () => {
  await fixture((req) => {
    assert.equal(req.path, '/api/domains/search');
    assert.equal(req.query.q, 'example.vn');
    assert.equal(req.query.tlds, undefined);
    return json([{ domain: 'example.vn', available: false, price_vnd: null, is_vn: true }]);
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_search', { q: 'example.vn' }));
    assert.ok(Array.isArray(result));
  });
});

test('cloud_domain_registrant_get hits GET /api/domains/registrant', async () => {
  const reg = { id: 'abc123', fullname: 'Nguyễn A', owner_type: 'individual' };
  await fixture((req) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/api/domains/registrant');
    return json(reg);
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_registrant_get'));
    assert.equal(result.fullname, 'Nguyễn A');
  });
});

test('cloud_domain_registrant_set hits PUT /api/domains/registrant with body', async () => {
  const payload = {
    owner_type: 'individual',
    fullname: 'Nguyễn A',
    email: 'a@example.test',
    phone: '0900000000',
    address: 'Hà Nội',
    cccd: '012345678901',
    dob: '01/01/1990',
    gender: 'male',
  };
  await fixture((req) => {
    assert.equal(req.method, 'PUT');
    assert.equal(req.path, '/api/domains/registrant');
    assert.equal(req.body.fullname, 'Nguyễn A');
    assert.equal(req.body.cccd, '012345678901');
    return json({ id: 'reg-1', fullname: 'Nguyễn A' });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_registrant_set', payload));
    assert.equal(result.id, 'reg-1');
  });
});

test('cloud_domain_buy posts with spelling_confirmed and sandbox header', async () => {
  await fixture((req) => {
    if (req.path === '/v1/balance') return json({ balance_vnd: 2000000 });
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/api/domains');
    assert.equal(req.body.name, 'example.com');
    assert.equal(req.body.spelling_confirmed, true);
    assert.equal(req.headers['X-Vibecloud-Sandbox'], undefined);
    return json({ id: 'order-1', domain: 'example.com', status: 'active', charged_vnd: 432000 });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_buy', {
      name: 'example.com', years: 1, spelling_confirmed: true,
    }));
    assert.equal(result.id, 'order-1');
  });
});

test('cloud_domain_buy with sandbox=true skips wallet and sends sandbox header', async () => {
  await fixture((req) => {
    assert.equal(req.path, '/api/domains');
    assert.equal(req.headers['X-Vibecloud-Sandbox'], '1');
    return json({ id: 'sandbox-1', domain: 'example.vn', status: 'pending_verification', charged_vnd: 0, sandbox: true });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_buy', {
      name: 'example.vn', spelling_confirmed: true, sandbox: true,
    }));
    assert.equal(result.sandbox, true);
    assert.equal(result.charged_vnd, 0);
  });
});

test('cloud_domain_buy with spelling_confirmed=false is rejected by server', async () => {
  await fixture((req) => {
    assert.equal(req.body.spelling_confirmed, false);
    return json({ code: 'spelling_unconfirmed' }, 422);
  }, async (client) => {
    // Tool passes spelling_confirmed=false — server returns 422, runTool surfaces error
    const result = data(await call(client, 'cloud_domain_buy', {
      name: 'example.vn', spelling_confirmed: false,
    }));
    assert.ok(result.error || result.code || result.message || JSON.stringify(result).includes('spelling'));
  });
});

test('cloud_domain_list hits GET /api/domains', async () => {
  await fixture((req) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/api/domains');
    assert.equal(req.headers['X-Vibecloud-Sandbox'], undefined);
    return json([{ id: 'dom-1', name: 'example.com', status: 'active' }]);
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_list'));
    assert.ok(Array.isArray(result));
  });
});

test('cloud_domain_list with sandbox=true sends sandbox header', async () => {
  await fixture((req) => {
    assert.equal(req.headers['X-Vibecloud-Sandbox'], '1');
    return json([]);
  }, async (client) => {
    await call(client, 'cloud_domain_list', { sandbox: true });
  });
});

test('cloud_domain_verify_start posts to /{id}/verify', async () => {
  const orderId = 'a1b2c3d4e5f6a1b2c3d4e5f6';
  await fixture((req) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.path, `/api/domains/${orderId}/verify`);
    return json({ id: orderId, upload_url: 'https://api.test/upload/tok', instructions: 'Upload here' });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_verify_start', { id: orderId }));
    assert.ok(result.upload_url);
  });
});

test('cloud_domain_verify_status hits GET /{id}/verify', async () => {
  const orderId = 'a1b2c3d4e5f6a1b2c3d4e5f6';
  await fixture((req) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.path, `/api/domains/${orderId}/verify`);
    return json({ id: orderId, status: 'pending_verification', profile_status: null });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_verify_status', { id: orderId }));
    assert.equal(result.status, 'pending_verification');
  });
});

test('cloud_domain_health hits GET /{id}/health', async () => {
  const orderId = 'a1b2c3d4e5f6a1b2c3d4e5f6';
  await fixture((req) => {
    assert.equal(req.path, `/api/domains/${orderId}/health`);
    return json({ id: orderId, domain: 'example.vn', status: 'active', alerts: [] });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_health', { id: orderId }));
    assert.equal(result.domain, 'example.vn');
  });
});

test('cloud_domain_wait hits GET /{id}/wait with timeout param', async () => {
  const orderId = 'a1b2c3d4e5f6a1b2c3d4e5f6';
  await fixture((req) => {
    assert.equal(req.path, `/api/domains/${orderId}/wait`);
    assert.equal(req.query.timeout, '30');
    return json({ id: orderId, domain: 'example.com', status: 'active' });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_wait', { id: orderId, timeout: 30 }));
    assert.equal(result.status, 'active');
  });
});

test('cloud_domain_webhook_set hits PUT /api/domains/webhook', async () => {
  await fixture((req) => {
    assert.equal(req.method, 'PUT');
    assert.equal(req.path, '/api/domains/webhook');
    assert.equal(req.body.url, 'https://myapp.test/webhook');
    assert.equal(req.body.secret, 'supersecret123');
    return json({ registered: true, url: 'https://myapp.test/webhook' });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_webhook_set', {
      url: 'https://myapp.test/webhook',
      secret: 'supersecret123',
    }));
    assert.equal(result.registered, true);
  });
});

test('cloud_domain_attach hits POST /{id}/attach', async () => {
  const domainId = 'a1b2c3d4e5f6a1b2c3d4e5f6';
  const appId = 'b2c3d4e5f6a1b2c3d4e5f6a1';
  await fixture((req) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.path, `/api/domains/${domainId}/attach`);
    assert.equal(req.body.app_id, appId);
    return json({ ssl: 'pending', record: { type: 'A' }, app_id: appId });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_attach', { domain_id: domainId, app_id: appId }));
    assert.equal(result.ssl, 'pending');
  });
});

test('cloud_domain_attach — .vn pending_verification returns pending=true', async () => {
  const domainId = 'a1b2c3d4e5f6a1b2c3d4e5f6';
  const appId = 'b2c3d4e5f6a1b2c3d4e5f6a1';
  await fixture((req) => {
    return json({ pending: true, domain: 'example.vn', message: 'Đặt trước thành công.' });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_attach', { domain_id: domainId, app_id: appId }));
    assert.equal(result.pending, true);
  });
});

// --- Guest → reserve → claim (spec monadomain §12) ------------------------------------------

async function guestFixture(fetcher, run) {
  // Không MONACLOUD_TOKEN, không VIBECLOUD_API_TOKEN, config dir rỗng → auth.accessToken ném login_required
  const directory = await mkdtemp(join(tmpdir(), 'mcp-domains-guest-'));
  const calls = [];
  const server = createServer({
    env: {
      MONACLOUD_CONFIG_DIR: directory,
      MONACLOUD_API: 'https://compute.test',
      MONACLOUD_BILLING_URL: 'https://billing.test',
    },
    fetchImpl: async (url, init) => {
      const request = {
        path: new URL(url).pathname,
        query: Object.fromEntries(new URL(url).searchParams),
        method: init.method || 'GET',
        headers: init.headers || {},
        body: init.body === undefined ? undefined : JSON.parse(init.body),
      };
      calls.push(request);
      return fetcher(request, calls);
    },
  });
  const client = new Client({ name: 'domain-guest-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  await client.connect(a);
  try {
    await run(client, calls);
  } finally {
    await client.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test('reserve/claim tools registered with strict schemas', async () => {
  await fixture(() => json([]), async (client) => {
    const { tools } = await client.listTools();
    for (const name of ['cloud_domain_reserve', 'cloud_domain_reserve_status', 'cloud_domain_claim', 'cloud_domain_reserve_release']) {
      const tool = tools.find((t) => t.name === name);
      assert.ok(tool, `Missing tool: ${name}`);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
  });
});

test('guest: cloud_domain_search works WITHOUT any token (no Authorization header)', async () => {
  await guestFixture((req) => {
    assert.equal(req.path, '/api/domains/search');
    assert.equal(req.headers.Authorization, undefined);
    return json([{ domain: 'myapp.vn', available: true, price_vnd: 756000 }]);
  }, async (client, calls) => {
    const result = data(await call(client, 'cloud_domain_search', { q: 'myapp' }));
    assert.equal(result[0].price_vnd, 756000);
    assert.equal(calls.length, 1);
  });
});

test('guest: cloud_domain_reserve posts email/phone/consent anonymously and returns claim_url + QR', async () => {
  const reservation = {
    id: 'aaaaaaaaaaaaaaaaaaaaaaaa', domain: 'myapp.vn', status: 'reserved', price_vnd: 756000,
    claim_token: 'rsv_abcdefghijklmnopqrstuvwxyz', guest_token: 'vc_guest_zyxwvutsrqponmlkjihgfedcba',
    claim_url: 'https://monadomain.vn/claim/aaaaaaaaaaaaaaaaaaaaaaaa?t=rsv_abcdefghijklmnopqrstuvwxyz',
    payment: { qr_url: 'https://img.vietqr.io/x.png', amount: 756000, description: 'MONACLOUD123456789' },
  };
  await guestFixture((req) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/api/domains/reserve');
    assert.equal(req.headers.Authorization, undefined);
    assert.deepEqual(req.body, {
      name: 'myapp.vn', email: 'a@b.test', phone: '0909000111', spelling_confirmed: true, marketing_consent: true,
      context: 'Cursor dựng shop',
    });
    return json(reservation, 201);
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_reserve', {
      name: 'MyApp.VN', email: 'a@b.test', phone: '0909000111', spelling_confirmed: true, marketing_consent: true,
      context: 'Cursor dựng shop',
    }));
    assert.equal(result.claim_url, reservation.claim_url);
    assert.equal(result.payment.qr_url, reservation.payment.qr_url);
  });
});

test('guest: cloud_domain_reserve_status sends claim_token both as ?t= and bearer', async () => {
  await guestFixture((req) => {
    assert.equal(req.method, 'GET');
    assert.equal(req.path, '/api/domains/reserve/aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(req.query.t, 'rsv_abcdefghijklmnopqrstuvwxyz');
    assert.equal(req.headers.Authorization, 'Bearer rsv_abcdefghijklmnopqrstuvwxyz');
    return json({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: 'paid', paid_vnd: 756000, next_step: 'mở claim_url' });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_reserve_status', {
      reservation_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', claim_token: 'rsv_abcdefghijklmnopqrstuvwxyz',
    }));
    assert.equal(result.status, 'paid');
  });
});

test('guest: cloud_domain_claim requires login (login_required, no HTTP call)', async () => {
  await guestFixture(() => { throw new Error('must not call backend'); }, async (client, calls) => {
    const result = await call(client, 'cloud_domain_claim', {
      reservation_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', claim_token: 'rsv_abcdefghijklmnopqrstuvwxyz',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /login_required/);
    assert.equal(calls.length, 0);
  });
});

test('logged in: cloud_domain_claim posts token + consent with Authorization', async () => {
  await fixture((req) => {
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/api/domains/reserve/aaaaaaaaaaaaaaaaaaaaaaaa/claim');
    assert.equal(req.headers.Authorization, 'Bearer fake-compute');
    assert.deepEqual(req.body, { claim_token: 'rsv_abcdefghijklmnopqrstuvwxyz', marketing_consent: true });
    return json({ id: 'bbbbbbbbbbbbbbbbbbbbbbbb', domain: 'myapp.vn', status: 'pending_verification', charged_vnd: 756000, claimed: true });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_claim', {
      reservation_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', claim_token: 'rsv_abcdefghijklmnopqrstuvwxyz', marketing_consent: true,
    }));
    assert.equal(result.claimed, true);
  });
});

test('logged in: cloud_domain_reserve still sends Authorization so backend binds owner', async () => {
  await fixture((req) => {
    assert.equal(req.path, '/api/domains/reserve');
    assert.equal(req.headers.Authorization, 'Bearer fake-compute');
    return json({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: 'reserved', guest_token: null }, 201);
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_reserve', {
      name: 'myapp.vn', email: 'a@b.test', phone: '0909000111', spelling_confirmed: true,
    }));
    assert.equal(result.guest_token, null);
  });
});

test('guest: cloud_domain_reserve_release DELETEs with ?t=', async () => {
  await guestFixture((req) => {
    assert.equal(req.method, 'DELETE');
    assert.equal(req.path, '/api/domains/reserve/aaaaaaaaaaaaaaaaaaaaaaaa');
    assert.equal(req.query.t, 'rsv_abcdefghijklmnopqrstuvwxyz');
    return json({ id: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: 'released' });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_reserve_release', {
      reservation_id: 'aaaaaaaaaaaaaaaaaaaaaaaa', claim_token: 'rsv_abcdefghijklmnopqrstuvwxyz',
    }));
    assert.equal(result.status, 'released');
  });
});

test('cloud_domain_renew defaults to dry_run=true and posts billing_cycle', async () => {
  await fixture((req) => {
    if (req.path === '/v1/balance' || req.path === '/api/me') return json({ balance_vnd: 5_000_000, credit_vnd: 5_000_000 });
    assert.equal(req.method, 'POST');
    assert.equal(req.path, '/api/domains/aaaaaaaaaaaaaaaaaaaaaaaa/renew');
    assert.deepEqual(req.body, { billing_cycle: 12, dry_run: true });
    return json({ total_amount: 756000, price_vnd: 756000, dry_run: true });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_renew', { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', billing_cycle: 12 }));
    assert.equal(result.price_vnd, 756000);
  });
});

test('cloud_domain_renew dry_run=false charges', async () => {
  await fixture((req) => {
    if (req.path === '/v1/balance' || req.path === '/api/me') return json({ balance_vnd: 5_000_000, credit_vnd: 5_000_000 });
    assert.deepEqual(req.body, { billing_cycle: 24, dry_run: false });
    return json({ charged_vnd: 1512000, status: 'renewed', renewal_id: 'bbbbbbbbbbbbbbbbbbbbbbbb' });
  }, async (client) => {
    const result = data(await call(client, 'cloud_domain_renew', { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', billing_cycle: 24, dry_run: false }));
    assert.equal(result.status, 'renewed');
  });
});
