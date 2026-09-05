import type { CloudClients } from './clients.js';
import { CloudError } from './errors.js';
import { unwrapData } from './http.js';
import { finishAppJob } from './jobs.js';
import { archiveProject, detectProject, MAX_ARCHIVE_BYTES } from './local.js';

type Row = Record<string, any>;
const object = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {};
const data = (value: unknown) => object(unwrapData(value));
const ready = (host: Row) => host.status === 'active' && (!host.power_state || host.power_state === 'running') && (!host.app_host_status || host.app_host_status === 'ready');
export function localAppTools(clients: CloudClients) {
  // Preview evidence is scoped to this MCP session and exact payload, expires after ten minutes.
  // This is an estimate cache, not a substitute for the agent obtaining human cost approval.
  const previews = new Map<string, { at: number; estimate: unknown }>();
  const finish = async (response: unknown, args: Row, sandbox: boolean) => finishAppJob(clients, response, sandbox, args.wait, args.interval_sec, args.timeout_sec);
  async function upload(appId: string, archive: Awaited<ReturnType<typeof archiveProject>>, sandbox: boolean, start?: Row) {
    const path = `/api/apps/${encodeURIComponent(appId)}/upload`;
    if (start) {
      const limit = start.max_bytes;
      if (!Number.isSafeInteger(limit) || limit <= 0 || typeof start.upload_url !== 'string') throw new CloudError('invalid_upload_response', 'API thiếu upload_url/max_bytes hợp lệ.', `Đọc cloud_app_get app_id=${appId}; không tạo app mới.`);
      let valid = false;
      try {
        const url = new URL(start.upload_url, clients.config.vibecloudApi);
        const expected = new URL(`${clients.config.vibecloudApi}${path}`);
        valid = url.href === expected.href;
      } catch { /* Do not forward project files or bearer tokens to another destination. */ }
      if (!valid) throw new CloudError('invalid_upload_url', 'upload_url không khớp endpoint upload của app trên Compute API.', `Đọc cloud_app_get app_id=${appId}; không tạo app mới.`);
      if (archive.bytes.length > Math.min(limit, MAX_ARCHIVE_BYTES)) throw new CloudError('archive_too_large', `ZIP ${archive.bytes.length} bytes vượt max_bytes=${Math.min(limit, MAX_ARCHIVE_BYTES)} từ API.`, `Giảm dung lượng rồi cloud_app_deploy app_id=${appId} với local_dir; không tạo app mới.`);
    }
    const form = new FormData();
    form.set('archive', new Blob([new Uint8Array(archive.bytes)], { type: 'application/zip' }), 'project.zip');
    form.set('build_path', archive.build_path);
    return clients.vibecloud(path, { method: 'POST', body: form, timeoutMs: 120_000,
      ...(sandbox ? { headers: { 'X-Vibecloud-Sandbox': '1' } } : {}) });
  }
  async function submit(payload: Row, archive: Awaited<ReturnType<typeof archiveProject>>, args: Row, sandbox: boolean) {
    const started = Date.now();
    const created = data(await clients.guardedVibecloud('/api/apps', { method: 'POST', body: payload }, sandbox));
    // Existing sandbox implementations may return an estimate job without an upload slot.
    if (sandbox && !created.upload_url) return finish(created, args, true);
    if (typeof created.id !== 'string' || !created.id) throw new CloudError('invalid_upload_response', 'API không trả app id cho source=upload.', 'Đọc cloud_app_list trước khi thử lại; không tạo trùng app.');
    const appId = created.id;
    try {
      const result = await finish(await upload(appId, archive, sandbox, created), args, sandbox);
      return { ...result, app_id: appId, build: result.build ?? result.status, seconds: result.seconds ?? (Date.now() - started) / 1000 };
    } catch (error) {
      if (error instanceof CloudError) throw new CloudError(error.code, error.message, `${error.nextStep} App đã tạo: app_id=${appId}; sửa rồi cloud_app_deploy với local_dir, không gọi cloud_app_create lại.`, { status: error.status, requestId: error.requestId });
      throw error;
    }
  }
  return {
    async create(args: Row) {
      const detected = await detectProject(args.local_dir);
      const archive = await archiveProject(detected.local_dir); // Validate and enforce 80 MiB before any HTTP.
      const payload = { source: 'upload', name: args.name || detected.name, build_type: args.build_type || detected.build_type,
        env: args.env || {}, port: args.port || detected.port, ...(args.domain ? { domain: args.domain } : {}) };
      const key = JSON.stringify({ directory: detected.local_dir, ...payload });
      const sandbox = clients.sandboxEnabled(args.sandbox);
      let estimate;
      if (!sandbox) {
        const hostResult = unwrapData(await clients.vibecloud('/api/app-hosts'));
        const hosts = Array.isArray(hostResult) ? hostResult : object(hostResult).app_hosts ?? object(hostResult).items;
        if (!Array.isArray(hosts)) throw new CloudError('invalid_app_hosts', 'Không đọc được danh sách app host.', 'Gọi cloud_app_host_list rồi thử lại.');
        if (!hosts.some(ready)) {
          if (hosts.length) throw new CloudError('app_host_not_ready', 'App host hiện có chưa sẵn sàng.', 'Đọc cloud_app_host_list và start host trước khi deploy.');
          const cached = previews.get(key);
          if (!cached || Date.now() - cached.at > 600_000) {
            const preview = await submit(payload, archive, { ...args, wait: true }, true);
            estimate = preview.estimate;
            if (estimate && ['done', 'succeeded'].includes(String(preview.status))) previews.set(key, { at: Date.now(), estimate });
            return { ...preview, sandbox: true, needs_cost_approval: true,
              next_step: 'Báo estimate chi phí app host theo giờ/gói, hỏi human duyệt một lần; sau khi đã duyệt gọi cloud_app_create với cùng local_dir và sandbox=false. Sandbox chưa phải website thật.' };
          }
          estimate = cached.estimate;
        }
      }
      const result = await submit(payload, archive, args, sandbox);
      if (sandbox && result.estimate && ['done', 'succeeded'].includes(String(result.status))) previews.set(key, { at: Date.now(), estimate: result.estimate });
      return { ...result, ...(estimate ? { estimate } : {}) };
    },
    async deploy(args: Row) {
      const started = Date.now(), sandbox = clients.sandboxEnabled(args.sandbox);
      const archive = await archiveProject(args.local_dir);
      const path = `/api/apps/${encodeURIComponent(args.app_id)}`;
      const app = data(await clients.vibecloud(path, sandbox ? { headers: { 'X-Vibecloud-Sandbox': '1' } } : {}));
      if (app.source !== 'upload') throw new CloudError('app_source_mismatch', 'local_dir chỉ dùng để redeploy app có source=upload.', 'Tạo app local bằng cloud_app_create hoặc bỏ local_dir để redeploy repo git.');
      if (!sandbox) await clients.spendGuard();
      // The deploy endpoint must not race the upload job, even with wait=false for the final deploy.
      const uploaded = await finish(await upload(args.app_id, archive, sandbox), { ...args, wait: true }, sandbox);
      if (!['done', 'succeeded'].includes(String(uploaded.status))) return { ...uploaded, app_id: args.app_id, phase: 'upload',
        next_step: `Poll cloud_job_status job_id=${uploaded.job_id}; khi done/succeeded gọi cloud_app_deploy app_id=${args.app_id} không có local_dir.` };
      const result = await finish(await clients.guardedVibecloud(`${path}/deploy`, { method: 'POST' }, sandbox), args, sandbox);
      return { ...result, app_id: args.app_id, build: result.build ?? result.status, seconds: result.seconds ?? (Date.now() - started) / 1000 };
    },
  };
}
