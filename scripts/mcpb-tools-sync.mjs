// Đồng bộ mcpb/manifest.json.tools từ server thật (name/description/inputSchema) — Smithery cần inputSchema.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const manifestPath = resolve(root, 'mcpb', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));

const client = new Client({ name: 'mcpb-tools-sync', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [resolve(root, 'dist/index.js')], env: { ...process.env, MONACLOUD_SANDBOX: '1' } }));
const tools = [];
let cursor;
do {
  const page = await client.listTools(cursor ? { cursor } : {});
  tools.push(...page.tools);
  cursor = page.nextCursor;
} while (cursor);
await client.close();

manifest.tools = tools.map((t) => ({
  name: t.name,
  description: (t.description || '').split('\n')[0].slice(0, 500),
  inputSchema: t.inputSchema || { type: 'object', properties: {} },
}));
manifest.tools_generated = true;
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`tools: ${manifest.tools.length} → ${manifestPath}`);
