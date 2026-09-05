import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { createDeflateRaw } from 'node:zlib';
import { CloudError } from './errors.js';

export const MAX_ARCHIVE_BYTES = 80 * 1024 * 1024;
const fail = (code: string, message: string): never => { throw new CloudError(code, message, 'Kiểm tra local_dir và ignore rules rồi thử lại; không cần git remote.'); };
export async function projectRoot(directory: string) {
  try {
    const root = await realpath(resolve(directory));
    if (!(await lstat(root)).isDirectory()) return fail('invalid_local_dir', 'local_dir phải là thư mục dự án.');
    return root;
  } catch (error) {
    if (error instanceof CloudError) throw error;
    return fail('invalid_local_dir', 'Không đọc được thư mục local_dir.');
  }
}

// Never follow a project symlink to credentials or files outside the chosen tree.
async function readText(root: string, name: string): Promise<string | undefined> {
  let file;
  try {
    if (!(await lstat(join(root, name))).isFile()) return undefined;
    file = await open(join(root, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile()) return undefined;
    if (info.size > 1024 * 1024) return fail('local_metadata_too_large', `${name} vượt 1 MiB; không thể đọc an toàn metadata/ignore rules.`);
    return await file.readFile('utf8');
  } catch (error) {
    if (['ENOENT', 'ELOOP'].includes(String((error as NodeJS.ErrnoException).code))) return undefined;
    throw error;
  } finally { await file?.close(); }
}

export async function detectProject(directory: string) {
  const root = await projectRoot(directory);
  const files = new Set((await readdir(root, { withFileTypes: true })).filter((f) => f.isFile()).map((f) => f.name));
  const packageText = await readText(root, 'package.json');
  let pkg: Record<string, any> = {};
  if (packageText) {
    try { pkg = JSON.parse(packageText) || {}; } catch { return fail('invalid_package_json', 'package.json không phải JSON hợp lệ.'); }
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const docker = await readText(root, 'Dockerfile');
  let stack = 'static', port = 80, start: string | null = null;
  const warnings: string[] = [];
  if (packageText) {
    stack = deps.next ? 'next' : deps.vite ? 'vite' : 'node';
    port = stack === 'vite' ? 4173 : 3000;
    start = typeof scripts.start === 'string' ? 'npm run start'
      : stack === 'vite' ? 'npm run build && npx --no-install vite preview --host 0.0.0.0'
        : files.has('server.js') ? 'node server.js' : files.has('index.js') ? 'node index.js' : null;
    if (!start) warnings.push('Chưa tìm thấy lệnh start; AI cần bổ sung scripts.start hoặc Dockerfile.');
  } else if (files.has('requirements.txt') || files.has('pyproject.toml') || files.has('manage.py') || files.has('app.py')) {
    stack = 'python'; port = 8000;
    start = files.has('manage.py') ? 'gunicorn <project>.wsgi:application --bind 0.0.0.0:8000' : files.has('app.py') ? 'gunicorn app:app --bind 0.0.0.0:8000' : null;
    warnings.push('Xác minh module Python, framework và dependency trước khi dùng lệnh start gợi ý.');
  } else if (files.has('composer.json') || files.has('index.php')) {
    stack = 'php'; port = 8080; start = `php -S 0.0.0.0:8080${files.has('artisan') ? ' -t public' : ''}`;
    warnings.push('Lệnh PHP chỉ là gợi ý kiểm thử; cấu hình web server production trong Dockerfile.');
  }
  const startScript = typeof scripts.start === 'string' ? scripts.start : '';
  const configuredPort = startScript.match(/(?:--port(?:=|\s+)|-p\s+|\bPORT=)(\d+)/)?.[1];
  const exposed = docker?.match(/^\s*EXPOSE\s+(\d+)(?:\/tcp)?\b/im)?.[1];
  const guessed = Number(exposed || configuredPort);
  if (guessed >= 1 && guessed <= 65535) port = guessed;
  const envExample = await readText(root, '.env.example');
  const envRequired = [...new Set([...envExample?.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm) || []].map((m) => m[1]))];
  return { local_dir: root, name: basename(root).toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'app',
    stack, port, start_command: start, dockerfile: docker !== undefined, build_type: docker !== undefined ? 'dockerfile' : stack === 'static' ? 'static' : 'nixpacks',
    env_required: envRequired, warnings, network: false };
}

type Rule = { regex: RegExp; negate: boolean; directoryOnly: boolean };
function glob(pattern: string) {
  let expression = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        while (pattern[i + 1] === '*') i++;
        if (pattern[i + 1] === '/') { expression += '(?:.*/)?'; i++; } else expression += '.*';
      } else expression += '[^/]*';
    } else if (c === '?') expression += '[^/]';
    else if (c === '[') {
      const end = pattern.indexOf(']', i + 1);
      if (end > i + 1) { expression += `[${pattern.slice(i + 1, end).replace(/^!/, '^')}]`; i = end; }
      else expression += '\\[';
    } else if (c === '\\' && i + 1 < pattern.length) expression += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    else expression += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return expression;
}
function parseIgnore(text: string | undefined, base = '', docker = false): Rule[] {
  return (text || '').split(/\r?\n/).flatMap((line) => {
    line = docker ? line.trim() : line.replace(/(?<!\\)\s+$/, '');
    if (!line || line.startsWith('#') || line === '.') return [];
    const negate = line.startsWith('!');
    if (negate) line = line.slice(1);
    const directoryOnly = !docker && line.endsWith('/');
    const anchored = line.startsWith('/');
    line = line.replace(/^\/+|\/+$/g, '');
    if (!line) return [];
    const prefix = base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const anywhere = !docker && !anchored && !line.includes('/');
    try { return [{ regex: new RegExp(`^${prefix}${anywhere ? '(?:.*/)?' : ''}${glob(line)}$`), negate, directoryOnly }]; }
    catch { return fail('invalid_ignore', 'Ignore pattern không hợp lệ.'); }
  });
}
function ignored(path: string, directory: boolean, rules: Rule[]) {
  let excluded = false;
  for (const rule of rules) if ((!rule.directoryOnly || directory) && rule.regex.test(path)) excluded = !rule.negate;
  return excluded;
}
const sensitive = (name: string) => name === 'node_modules' || name === '.git' || /^\.env/i.test(name) || /\.pem$/i.test(name);

const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let n = 0; n < 8; n++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

// ZIP32 with deflate, UTF-8 filenames and UNIX executable bits. No shell or package install.
// dist is retained by default: even a Dockerfile may COPY prebuilt output.
export async function archiveProject(directory: string, limit = MAX_ARCHIVE_BYTES) {
  const root = await projectRoot(directory);
  const maxBytes = Math.min(MAX_ARCHIVE_BYTES, limit);
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return fail('invalid_upload_limit', 'max_bytes không hợp lệ.');
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0, centralSize = 0, count = 0;
  const check = (size: number) => {
    if (size > maxBytes) fail('archive_too_large', `ZIP vượt giới hạn ${maxBytes} bytes (${(maxBytes / 1024 / 1024).toFixed(2)} MiB; tối đa 80 MiB). Bỏ file lớn bằng ignore rules.`);
  };
  const dockerRules = parseIgnore(await readText(root, '.dockerignore'), '', true);
  async function walk(relative: string, inheritedGit: Rule[], dockerParentIgnored = false) {
    const dir = join(root, relative);
    const gitRules = [...inheritedGit, ...parseIgnore(await readText(dir, '.gitignore'), relative)];
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (sensitive(entry.name) || entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) continue;
      const path = relative + entry.name;
      if (/[\x00-\x1f\\]/.test(path)) fail('invalid_archive_path', 'Tên file chứa ký tự không an toàn cho ZIP.');
      const directory = entry.isDirectory();
      if (ignored(path, directory, gitRules)) continue;
      // Docker allows !dir/file even under an excluded directory; Git requires re-including the parent.
      let dockerIgnored = dockerParentIgnored;
      for (const rule of dockerRules) if (rule.regex.test(path)) dockerIgnored = !rule.negate;
      if (directory) {
        if (!dockerIgnored || dockerRules.some((rule) => rule.negate)) await walk(`${path}/`, gitRules, dockerIgnored);
        continue;
      }
      if (dockerIgnored) continue;
      const absolute = await realpath(join(root, path));
      if (!absolute.startsWith(root + sep)) fail('invalid_archive_path', 'File nằm ngoài local_dir.');
      const file = await open(join(root, path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile()) continue;
        if (info.size > 0xffffffff || count >= 65535) fail('archive_too_large', 'Dự án vượt giới hạn ZIP32 (4 GiB/file hoặc 65535 file).');
        const name = Buffer.from(path);
        if (name.length > 65535) fail('invalid_archive_path', 'Tên file quá dài cho ZIP.');
        const chunks: Buffer[] = [];
        let size = 0, compressedSize = 0, crc = 0xffffffff;
        const stream = file.createReadStream({ autoClose: false });
        const deflate = createDeflateRaw();
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          for (const byte of chunk) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
        });
        stream.on('error', (error) => deflate.destroy(error));
        stream.pipe(deflate);
        try {
          for await (const chunk of deflate) {
            compressedSize += chunk.length;
            check(offset + compressedSize + centralSize + 30 + 46 + name.length * 2 + 22);
            chunks.push(chunk);
          }
        } finally { stream.destroy(); deflate.destroy(); }
        if (size !== info.size) fail('local_file_changed', 'File thay đổi trong lúc đóng ZIP; dừng tác vụ ghi file rồi thử lại.');
        const checksum = (crc ^ 0xffffffff) >>> 0;
        const header = Buffer.alloc(30);
        header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
        header.writeUInt16LE(8, 8); header.writeUInt16LE(33, 12);
        header.writeUInt32LE(checksum, 14); header.writeUInt32LE(compressedSize, 18); header.writeUInt32LE(size, 22); header.writeUInt16LE(name.length, 26);
        const index = Buffer.alloc(46);
        index.writeUInt32LE(0x02014b50); index.writeUInt16LE(0x314, 4); header.copy(index, 6, 4, 30);
        index.writeUInt32LE(((info.mode & 0xffff) * 65536) >>> 0, 38); index.writeUInt32LE(offset, 42);
        local.push(header, name, ...chunks); central.push(index, name);
        offset += header.length + name.length + compressedSize; centralSize += index.length + name.length; count++;
      } finally { await file.close(); }
    }
  }
  await walk('', []);
  if (!count) return fail('empty_archive', 'Không còn file nào sau khi áp dụng ignore rules.');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(count, 8); end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  check(offset + centralSize + end.length);
  return { bytes: Buffer.concat([...local, ...central, end]), file_count: count, build_path: '.' };
}
