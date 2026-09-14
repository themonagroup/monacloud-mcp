import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { CloudClients } from './clients.js';
import { CloudError, runTool } from './errors.js';
import { pollJob, TERMINAL_JOBS } from './jobs.js';
import { unwrapData } from './http.js';

type Row = Record<string, unknown>;
const object = (value: unknown): Row => value && typeof value === 'object' ? value as Row : {};
const id = z.string().trim().min(1).max(255);
const sandbox = z.boolean().optional().describe('Thử 0đ, chỉ ước tính và không tạo hạ tầng thật / Sandbox estimate only');
const baseDescription = 'Base beta = thay Supabase, chung account/ví MONA Cloud. / Beta Supabase replacement on the shared MONA Cloud account and wallet.';

function value(objects: Row[], key: string): unknown {
  for (const row of objects) if (row[key] !== undefined) return row[key];
  return undefined;
}

async function createBase(clients: CloudClients, body: Row) {
  const { sandbox: requested, ...payload } = body;
  const isSandbox = clients.sandboxEnabled(requested === true);
  const created = object(unwrapData(await clients.guardedVibecloud(
    '/api/bases', { method: 'POST', body: payload }, isSandbox,
  )));
  const jobId = typeof created.job_id === 'string' ? created.job_id
    : typeof created.id === 'string' ? created.id : undefined;
  const job = jobId && !TERMINAL_JOBS.has(String(created.status))
    ? await pollJob(clients, jobId, true, 3, 180, isSandbox)
    : created;
  const result = object(job.result);
  const base = object(result.base);
  const rows = [base, result, job, created];
  const status = String(value(rows, 'status') || 'unknown');
  if (['failed', 'error', 'cancelled'].includes(status)) {
    throw new CloudError(
      'base_provision_failed',
      `Tạo Base thất bại${jobId ? ` (job ${jobId})` : ''}: ${job.error || result.error || 'không có chi tiết'}`,
      'Kiểm tra cấu hình/giá và cloud_base_list; chỉ gọi lại cloud_base_create sau khi sửa nguyên nhân.',
    );
  }
  return {
    base_id: value(rows, 'base_id') ?? value(rows, 'id'),
    studio_url: value(rows, 'studio_url'),
    api_url: value(rows, 'api_url'),
    status,
    ...(jobId ? { job_id: jobId } : {}),
    ...(result.estimate !== undefined ? { estimate: result.estimate } : created.estimate !== undefined ? { estimate: created.estimate } : {}),
    ...(isSandbox ? {
      sandbox: true,
      next_step: 'Đây là ước tính beta, chưa tạo Base. Duyệt chi phí rồi gọi cloud_base_create với sandbox=false.',
    } : {}),
    ...(job.polling === 'timeout' ? { polling: 'timeout', next_step: job.next_step } : {}),
  };
}

export function registerBaseTools(server: McpServer, clients: CloudClients) {
  const register = (name: string, description: string, schema: z.ZodObject<any>, handler: (args: any) => unknown) => {
    for (const toolName of [name, name.replace(/^cloud_/, 'vibecloud_')]) {
      server.registerTool(toolName, {
        description: toolName === name ? `${description} ${baseDescription}` : `Alias tương thích của ${name}. / Compatibility alias. ${description} ${baseDescription}`,
        inputSchema: schema,
      }, (args) => runTool(() => handler(args)));
    }
  };

  register('cloud_base_create', 'Ước tính, kiểm ví, tạo Base và poll job tới hoàn tất; sandbox chỉ trả ước tính. / Estimate, create and wait for the Base job.',
    z.object({
      cpu: z.number().int().min(1).max(16).optional(),
      ram_gb: z.number().int().min(1).max(64).optional(),
      disk_gb: z.number().int().min(10).max(1000).optional(),
      billing_mode: z.enum(['hourly', 'monthly']).optional(),
      plan_code: z.string().trim().min(2).max(64).optional(),
      sandbox,
    }).strict(), (args) => createBase(clients, args));

  register('cloud_base_list', 'Liệt kê Base beta của tài khoản hiện tại. / List Bases.',
    z.object({}).strict(), () => clients.vibecloud('/api/bases'));
  register('cloud_base_get', 'Đọc trạng thái và URL của một Base beta. / Inspect a Base.',
    z.object({ base_id: id }).strict(), ({ base_id }) => clients.vibecloud(`/api/bases/${encodeURIComponent(base_id)}`));
  register('cloud_base_delete', 'Xoá Base beta đã được người dùng duyệt. / Delete an approved Base.',
    z.object({ base_id: id }).strict(), ({ base_id }) => clients.vibecloud(`/api/bases/${encodeURIComponent(base_id)}`, { method: 'DELETE' }));
  register('cloud_base_credentials', 'Đọc anon_key, service_key và db_url. Bí mật, không log; lưu thẳng vào secret store hoặc .env không commit. / Reveal credentials once and keep them secret.',
    z.object({ base_id: id }).strict(), async ({ base_id }) => {
      const raw = object(unwrapData(await clients.vibecloud(`/api/bases/${encodeURIComponent(base_id)}/credentials`, {
        headers: { 'X-Confirm': 'reveal' },
      })));
      return {
        anon_key: raw.anon_key,
        service_key: raw.service_key,
        db_url: raw.db_url,
        warning: 'Bí mật, không log. Lưu vào secret store hoặc .env đã bỏ khỏi git.',
      };
    });
}
