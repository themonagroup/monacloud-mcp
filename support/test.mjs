import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Offline mocks do not need OS certificates. Node can crash while loading macOS
// Keychain in the restricted workspace when NODE_USE_SYSTEM_CA is inherited.
const cwd = fileURLToPath(new URL('..', import.meta.url));
const tests = readdirSync(new URL('../test/', import.meta.url)).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `test/${name}`);
const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...tests], { cwd, stdio: 'inherit', env: { ...process.env, NODE_USE_SYSTEM_CA: '0' } });
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
