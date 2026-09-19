import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function json(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

function parsedText(result) {
  const item = result.content?.find((entry) => entry.type === 'text');
  assert.ok(item, 'tool phải trả text content');
  return JSON.parse(item.text);
}

const requests = [];
const mock = createHttpServer((request, response) => {
  requests.push({ url: request.url, authorization: request.headers.authorization });
  if (request.url === '/realms/mona/.well-known/openid-configuration') {
    const address = mock.address();
    const base = `http://127.0.0.1:${address.port}/realms/mona`;
    json(response, 200, { issuer: base, userinfo_endpoint: `${base}/protocol/openid-connect/userinfo` });
    return;
  }
  if (request.url === '/realms/mona/protocol/openid-connect/userinfo') {
    json(response, 200, { sub: 'user-123', email: 'mon@example.test', name: 'Mon' });
    return;
  }
  json(response, 404, { code: 'not_found' });
});

const listenResult = await new Promise((resolve, reject) => {
  mock.once('error', (error) => {
    if (error.code === 'EPERM' || error.code === 'EACCES') resolve(null);
    else reject(error);
  });
  mock.listen(0, '127.0.0.1', () => resolve(mock.address()));
});
const issuer = listenResult
  ? `http://127.0.0.1:${listenResult.port}/realms/mona`
  : 'https://id.test/realms/mona';
const childArgs = listenResult
  ? [join(projectRoot, 'dist', 'index.js')]
  : ['--import', join(projectRoot, 'support', 'mock-fetch.mjs'), join(projectRoot, 'dist', 'index.js')];

const transport = new StdioClientTransport({
  command: process.execPath,
  args: childArgs,
  cwd: projectRoot,
  stderr: 'pipe',
  env: {
    NODE_USE_SYSTEM_CA: '0',
    MONACLOUD_TOKEN: 'fake-token-for-test',
    MONACLOUD_ISSUER: issuer,
    MONACLOUD_BILLING_URL: listenResult ? `http://127.0.0.1:${listenResult.port}` : 'https://billing.test',
    MONAPAY_API: listenResult ? `http://127.0.0.1:${listenResult.port}` : 'https://pay.test',
    MONAMAIL_API: listenResult ? `http://127.0.0.1:${listenResult.port}` : 'https://mail.test',
    MONACLOUD_API: listenResult ? `http://127.0.0.1:${listenResult.port}` : 'https://cloud.test',
  },
});
const client = new Client({ name: 'stdio-test', version: '1.0.0' });
let summary;
let serverStderr = '';
transport.stderr?.on('data', (chunk) => { serverStderr += chunk.toString(); });
try {
  await client.connect(transport);
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name);
  assert.equal(names.length, 177); // 19/09: 0.10.x thêm cloud_app_*, cloud_base_*, domain reserve/claim, mail inbox
  for (const name of [
    'cloud_whoami', 'cloud_balance', 'cloud_topup', 'cloud_services',
    'monapay_create_qr', 'monapay_create_webhook',
    'cloud_vps_create', 'cloud_db_create', 'cloud_job_status',
    'cloud_services_list', 'cloud_service_start', 'cloud_service_stop', 'cloud_service_rebuild',
    'cloud_prices', 'cloud_packages', 'cloud_agent_deploy', 'cloud_link',
    'cloud_base_create', 'cloud_base_list', 'cloud_base_get', 'cloud_base_delete', 'cloud_base_credentials',
    'vibecloud_base_create', 'vibecloud_base_list', 'vibecloud_base_get', 'vibecloud_base_delete', 'vibecloud_base_credentials',
    'agent_templates_list', 'agent_deploy',
  ]) assert.ok(names.includes(name), `${name} phải có trong tools/list`);

  const whoami = parsedText(await client.callTool({ name: 'cloud_whoami', arguments: {} }));
  assert.equal(whoami.sub, 'user-123');
  assert.equal(whoami.email, 'mon@example.test');
  assert.equal(whoami.console_url, 'https://monacloud.vn/console');
  if (listenResult) assert.equal(requests.at(-1).authorization, 'Bearer fake-token-for-test');

  const resources = await client.listResources();
  assert.deepEqual(resources.resources.map((resource) => resource.uri).sort(), [
    'monacloud://llms', 'monacloud://status',
  ]);
  const prompts = await client.listPrompts();
  const promptNames = prompts.prompts.map((prompt) => prompt.name);
  assert.deepEqual(promptNames, ['mua-ten-mien-monacloud', 'dung-app-ban-hang-monacloud', 'gui-mail-otp-monamail']);
  summary = {
    tools_count: names.length,
    mail_tools: names.filter((name) => name.startsWith('mail_')).sort(),
    prompts: promptNames,
    version: client.getServerVersion().version,
  };
} finally {
  await client.close();
  if (listenResult) {
    mock.close();
    await once(mock, 'close');
  }
}

assert.equal(serverStderr, '', 'MCP server không ghi token hoặc API key ra stderr');
console.log(`STDIO PASS ${JSON.stringify(summary)}`);
