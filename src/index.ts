#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AuthManager } from './auth.js';
import { readConfig } from './config.js';
import { toAgentError } from './errors.js';
import { createServer } from './server.js';

const command = process.argv[2];
const config = readConfig();
const auth = new AuthManager(config);

async function main(): Promise<void> {
  if (command === 'login') {
    await auth.login();
    return;
  }
  if (command === 'logout') {
    const removed = await auth.logout();
    console.log(removed ? 'Đã đăng xuất MONA Cloud.' : 'Máy chưa có token MONA Cloud.');
    return;
  }
  if (command === 'whoami') {
    console.log(JSON.stringify(await auth.userinfo(), null, 2));
    return;
  }
  if (command === '--version' || command === '-v') {
    console.log('0.5.0');
    return;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    console.log('Usage: monacloud-mcp [login|logout|whoami|--version]\nKhông có command: chạy MCP server qua stdio.');
    return;
  }
  if (command) {
    throw new Error(`Command không hỗ trợ: ${command}`);
  }
  await createServer().connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(JSON.stringify(toAgentError(error)));
  process.exitCode = 1;
});
