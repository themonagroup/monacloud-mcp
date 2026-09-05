import { setTimeout as delay } from 'node:timers/promises';
import type { CloudClients } from './clients.js';
import { CloudError } from './errors.js';
import { unwrapData } from './http.js';

export const TERMINAL_JOBS = new Set(['done', 'succeeded', 'failed', 'cancelled', 'error']);
const object = (value: unknown) => (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;

export async function pollJob(
  clients: CloudClients, jobId: string, wait: boolean, intervalSeconds: number,
  timeoutSeconds: number, sandbox: boolean,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const read = async () => object(unwrapData(await clients.vibecloud(`/api/jobs/${encodeURIComponent(jobId)}`, {
    timeoutMs: wait ? Math.max(1, Math.min(30_000, deadline - Date.now())) : 30_000,
  })));
  let result = await read();
  while (wait && !TERMINAL_JOBS.has(String(result.status)) && Date.now() < deadline) {
    await delay(Math.min(intervalSeconds * 1000, Math.max(0, deadline - Date.now())));
    if (Date.now() >= deadline) break;
    result = await read();
  }
  return {
    ...result,
    ...(sandbox ? { sandbox: true } : {}),
    ...(wait && !TERMINAL_JOBS.has(String(result.status)) ? {
      polling: 'timeout', job_id: jobId,
      next_step: `Gọi lại cloud_job_status với job_id=${jobId}; không tạo lại app.`,
    } : {}),
  };
}

export async function finishAppJob(clients: CloudClients, created: unknown, sandbox: boolean,
  wait: boolean, interval: number, timeout: number) {
  const start = object(unwrapData(created));
  const jobId = typeof start.job_id === 'string' ? start.job_id
    : !start.url && typeof start.id === 'string' ? start.id : undefined;
  const job = jobId && wait ? await pollJob(clients, jobId, true, interval, timeout, sandbox) : start;
  const result = object(job.result);
  if (['failed', 'error', 'cancelled'].includes(String(job.status)) || result.status === 'error') {
    throw new CloudError('app_deploy_failed',
      `Deploy thất bại${jobId ? ` (job ${jobId})` : ''}: ${job.error || result.errorMessage || result.error || 'kiểm tra log build'}`,
      'Gọi cloud_app_logs và cloud_app_get để sửa lỗi; chỉ cloud_app_deploy lại sau khi sửa.');
  }
  return { ...start, ...job, ...(jobId ? { job_id: jobId } : {}),
    ...(result.estimated_app_host ? { estimate: result.estimated_app_host } : {}),
    ...(typeof result.app_id === 'string' ? { app_id: result.app_id } : {}),
    ...(typeof result.url === 'string' ? { url: result.url } : {}),
    ...(typeof result.application_id === 'string' ? { application_id: result.application_id } : {}),
    ...(sandbox ? { sandbox: true } : {}) };
}
