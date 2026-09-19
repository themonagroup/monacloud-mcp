import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../dist/server.js';

const destructivePattern = /(?:^|_)(?:delete|remove|cancel|release|rotate|stop|destroy|reset|revoke|suspend)(?:_|$)/;

test('mọi tool công bố title và đủ bốn annotations', async () => {
  const env = {
    MONACLOUD_CONFIG_DIR: '/tmp/monacloud-annotations-test',
    MONACLOUD_TOKEN: 'fake-annotations-token',
    MONAPAY_CLIENT_ID: 'fake-client',
    MONAPAY_CLIENT_SECRET: 'fake-secret',
  };
  const server = createServer({ env, fetchImpl: async () => { throw new Error('tools/list không được gọi mạng'); } });
  const client = new Client({ name: 'annotations-test', version: '1' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.ok(tools.length > 0);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));
    for (const tool of tools) {
      assert.equal(typeof tool.title, 'string', `${tool.name}: thiếu title`);
      assert.ok(tool.title.trim(), `${tool.name}: title rỗng`);
      assert.equal(typeof tool.annotations, 'object', `${tool.name}: thiếu annotations`);
      for (const key of ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']) {
        assert.equal(typeof tool.annotations?.[key], 'boolean', `${tool.name}: ${key} không phải boolean`);
      }
      assert.ok(!(tool.annotations.readOnlyHint && tool.annotations.destructiveHint), `${tool.name}: vừa read-only vừa destructive`);
      if (destructivePattern.test(tool.name)) {
        assert.equal(tool.annotations.destructiveHint, true, `${tool.name}: phải destructive`);
      }
      if (/(?:^|_)(?:list|get|status|search)(?:_|$)/.test(tool.name)
        || tool.name === 'cloud_balance' || tool.name === 'cloud_whoami') {
        assert.equal(tool.annotations.readOnlyHint, true, `${tool.name}: phải read-only`);
      }
    }
    assert.equal(byName.get('cloud_app_detect').annotations.openWorldHint, false);
    assert.equal(byName.get('vibecloud_app_detect').annotations.openWorldHint, false);
    assert.equal(tools.filter((tool) => !tool.annotations.openWorldHint).length, 2);

    const aliasExceptions = {
      vibecloud_create_vps: 'cloud_vps_create',
      vibecloud_create_database: 'cloud_db_create',
      vibecloud_list_services: 'cloud_services_list',
      vibecloud_start: 'cloud_service_start',
      vibecloud_stop: 'cloud_service_stop',
      vibecloud_rebuild: 'cloud_service_rebuild',
    };
    for (const alias of tools.filter((tool) => tool.name.startsWith('vibecloud_'))) {
      const originalName = aliasExceptions[alias.name] || alias.name.replace(/^vibecloud_/, 'cloud_');
      assert.deepEqual(alias.annotations, byName.get(originalName)?.annotations, `${alias.name}: annotations phải khớp ${originalName}`);
    }
  } finally {
    await client.close();
  }
});
