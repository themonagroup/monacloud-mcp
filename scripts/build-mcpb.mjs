import { cpSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const buildDir = resolve(root, 'build');
const stageDir = resolve(buildDir, 'mcpb');
const outputFile = resolve(buildDir, 'monacloud-mcp.mcpb');
const npmCacheDir = resolve(buildDir, '.npm-cache');
const commandEnv = { ...process.env, npm_config_cache: npmCacheDir };

rmSync(stageDir, { recursive: true, force: true });
rmSync(outputFile, { force: true });
mkdirSync(stageDir, { recursive: true });

for (const source of ['dist', 'docs']) {
  cpSync(resolve(root, source), resolve(stageDir, source), { recursive: true });
}
for (const source of ['package.json', 'package-lock.json', 'README.md', 'LICENSE']) {
  cpSync(resolve(root, source), resolve(stageDir, source));
}
cpSync(resolve(root, 'mcpb', 'manifest.json'), resolve(stageDir, 'manifest.json'));

execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts'], {
  cwd: stageDir,
  env: commandEnv,
  stdio: 'inherit',
});
execFileSync('npx', ['--yes', '@anthropic-ai/mcpb', 'pack', stageDir, outputFile], {
  cwd: root,
  env: commandEnv,
  stdio: 'inherit',
});

const size = statSync(outputFile).size;
console.log(`MCPB: ${outputFile}`);
console.log(`Size: ${size} bytes (${(size / 1024 / 1024).toFixed(2)} MiB)`);
