import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
const plan = { code: 'kinh-doanh', cpu: 2, ram_gb: 4, disk_gb: 40, price_month_vnd: 999000, price_year_vnd: 9990000 };
const json = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname;
  const body = init.body instanceof FormData ? init.body : init.body ? JSON.parse(init.body) : undefined;
  const sandbox = init.headers['X-Vibecloud-Sandbox'] === '1';
  if (process.env.WAVE_AB_TRACE) appendFileSync(process.env.WAVE_AB_TRACE, JSON.stringify({ path, method: init.method || 'GET', sandbox }) + '\n');
  if (path === '/api/plans') return json({ plans: [plan] });
  assert.equal(init.headers.Authorization, path === '/v1/balance' ? 'Bearer fake-pass-only' : 'Bearer fake-compute-only');
  if (path === '/v1/balance') return json({ balance_vnd: 9990000 });
  if (path === '/api/invoices') return json({ invoices: [{ id: 'inv1', total_vnd: 999000 }] });
  if (path === '/api/invoices/inv1.pdf') return { ok: true, status: 200, headers: { get: () => 'application/pdf' }, arrayBuffer: async () => Buffer.from('%PDF-1.4\n% mock binary \x00\xff\n%%EOF', 'binary') };
  if (path === '/api/lxc') {
    assert.deepEqual(body, { app_name: 'shop', billing_mode: 'monthly', plan_code: 'kinh-doanh', period: 'month' });
    return json({ id: 'vps1', status: 'queued' });
  }
  if (path === '/api/app-hosts') return json({ app_hosts: [] });
  if (path === '/api/apps') {
    if (body.source === 'upload') {
      assert.deepEqual(body, { source: 'upload', name: 'demo', build_type: 'nixpacks', env: {}, port: 3000 });
      const id = sandbox ? 'local-preview' : 'local-app';
      return json({ id, upload_url: `/api/apps/${id}/upload`, max_bytes: 80 * 1024 * 1024 });
    }
    assert.deepEqual(body, { repo_url: 'https://git.test/team/shop.git', branch: 'release', build_type: 'nixpacks', dockerfile: 'Dockerfile', env: {}, domain: 'shop.test', port: 3000 });
    return json({ id: sandbox ? 'preview1' : 'app1', status: 'queued' });
  }
  if (/^\/api\/apps\/local-(preview|app)\/upload$/.test(path)) {
    assert.ok(body instanceof FormData);
    assert.deepEqual([...body.keys()], ['archive', 'build_path']);
    assert.equal(body.get('build_path'), '.');
    assert.equal(init.headers['Content-Type'], undefined);
    assert.equal(init.redirect, 'error');
    const wire = new Request('https://compute.test', { method: 'POST', body });
    assert.match(wire.headers.get('Content-Type'), /multipart\/form-data; boundary=/);
    const archive = Buffer.from(await (await wire.formData()).get('archive').arrayBuffer());
    const names = [];
    let offset = 0;
    while (archive.readUInt32LE(offset) === 0x04034b50) {
      const size = archive.readUInt32LE(offset + 18), length = archive.readUInt16LE(offset + 26);
      names.push(archive.subarray(offset + 30, offset + 30 + length).toString());
      offset += 30 + length + size;
    }
    assert.ok(names.includes('package.json')); assert.ok(names.includes('index.js'));
    assert.ok(!names.some((name) => /\.env|node_modules|\.pem|\.git\//.test(name)));
    return json({ job_id: sandbox ? 'preview1' : 'app1', status: 'queued' });
  }
  if (path.startsWith('/api/jobs/')) {
    if (path.endsWith('/app1') && process.env.WAVE_AB_FAILURE === '1') return json({ status: 'failed', error: 'Build failed' });
    return json({ id: path.split('/').at(-1), status: 'done', result: { url: path.endsWith('/preview1') ? 'https://sandbox.test' : 'https://deployed.test', application_id: 'a1', app_id: 'app1', estimated_app_host: { hourly_rate_vnd: 100, estimated_30_days_vnd: 72000 } } });
  }
  throw new Error(`Unexpected mock request: ${path}`);
};
