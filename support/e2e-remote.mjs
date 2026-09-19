// E2E remote MCP local: DCR → authorize URL (in ra) → chờ code ở 127.0.0.1:9997/cb → token → /mcp initialize + tools/list + cloud_whoami
import http from 'node:http'; import crypto from 'node:crypto'; import fs from 'node:fs';
// E2E remote MCP thật: node support/e2e-remote.mjs → mở AUTH_URL trong trình duyệt, đăng nhập tài khoản test (~/.config/mona/monapass-e2e.env) → script tự lấy token, gọi /mcp.
const BASE = process.env.MCP_REMOTE_BASE || 'https://mcp.monacloud.vn';
const reg = await (await fetch(BASE + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'e2e-local', redirect_uris: ['http://127.0.0.1:9997/cb'], grant_types: ['authorization_code','refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) })).json();
if (!reg.client_id) { console.error('DCR fail', reg); process.exit(1); }
const verifier = crypto.randomBytes(32).toString('base64url'); const challenge = crypto.createHash('sha256').update(verifier).digest('base64url'); const state = crypto.randomBytes(8).toString('hex');
const authUrl = `${BASE}/authorize?response_type=code&client_id=${encodeURIComponent(reg.client_id)}&redirect_uri=${encodeURIComponent('http://127.0.0.1:9997/cb')}&code_challenge=${challenge}&code_challenge_method=S256&scope=${encodeURIComponent('openid profile email offline_access vibecloud-api billing-api')}&state=${state}`;
fs.writeFileSync('e2e-auth-url.txt', authUrl); console.log('AUTH_URL', authUrl);
const code = await new Promise((resolve) => { const srv = http.createServer((req, res) => { const u = new URL(req.url, 'http://127.0.0.1:9997'); res.end('ok, dong tab'); if (u.pathname === '/cb') { srv.close(); resolve(u.searchParams.get('code')); } }); srv.listen(9997); });
console.log('CODE', code?.slice(0, 12));
const tok = await (await fetch(BASE + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: 'http://127.0.0.1:9997/cb', client_id: reg.client_id, code_verifier: verifier }) })).json();
console.log('TOKEN', Object.keys(tok), tok.error || '', 'scope=', tok.scope); fs.writeFileSync('e2e-tokens.json', JSON.stringify(tok)); const claims = JSON.parse(Buffer.from(tok.access_token.split('.')[1],'base64url').toString()); console.log('CLAIMS', JSON.stringify({aud: claims.aud, azp: claims.azp, scope: claims.scope, exp: claims.exp, roles: claims.realm_access?.roles}));
const h = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + tok.access_token };
const init = await fetch(BASE + '/mcp', { method: 'POST', headers: h, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '1' } } }) });
const sid = init.headers.get('mcp-session-id'); console.log('INIT', init.status, 'sid', sid?.slice(0, 8));
const parse = async (r) => { const t = await r.text(); const line = t.split('\n').find(l => l.startsWith('data:')); return JSON.parse(line ? line.slice(5) : t); };
await fetch(BASE + '/mcp', { method: 'POST', headers: { ...h, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) });
const tools = await parse(await fetch(BASE + '/mcp', { method: 'POST', headers: { ...h, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) }));
console.log('TOOLS', tools.result?.tools?.length);
const who = await parse(await fetch(BASE + '/mcp', { method: 'POST', headers: { ...h, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'cloud_whoami', arguments: {} } }) }));
console.log('WHOAMI', JSON.stringify(who.result?.content?.[0]?.text || who).slice(0, 300));
const bal = await parse(await fetch(BASE + '/mcp', { method: 'POST', headers: { ...h, 'mcp-session-id': sid }, body: JSON.stringify({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'cloud_balance', arguments: {} } }) }));
console.log('BALANCE', JSON.stringify(bal.result?.content?.[0]?.text || bal).slice(0, 200));
process.exit(0);
