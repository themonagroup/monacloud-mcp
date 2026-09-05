import { readFileSync } from 'node:fs';
import { createServer as createMonaPayServer } from 'monapay-mcp';
import { MonaPayClient } from 'monapay-mcp/dist/client.js';
import type { Config } from './config.js';
import { CloudError, errorResult } from './errors.js';

type ImportedTool = {
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
  _meta?: Record<string, unknown>;
  handler: (...args: unknown[]) => unknown;
  enabled: boolean;
};

type McpInternals = {
  _registeredTools: Record<string, ImportedTool>;
};

function linkedCredentials(config: Config): { client_id: string; client_secret: string } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(config.linksFile, 'utf8')) as {
      monapay?: { client_id?: string; client_secret?: string };
    };
    if (parsed.monapay?.client_id && parsed.monapay.client_secret) {
      return { client_id: parsed.monapay.client_id, client_secret: parsed.monapay.client_secret };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CloudError(
        'invalid_link_store',
        'Không đọc được credential MONA Pay đã liên kết.',
        'Xoá links.json trong thư mục cấu hình rồi gọi monapay_link lại.',
      );
    }
  }
  return undefined;
}

export function createMonaPayClient(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): MonaPayClient {
  const clientId = env.MONAPAY_CLIENT_ID;
  const clientSecret = env.MONAPAY_CLIENT_SECRET;
  if (clientId && clientSecret) {
    return new MonaPayClient({ clientId, clientSecret, baseUrl: config.monapayApi, fetchImpl });
  }
  const linked = linkedCredentials(config);
  if (linked) {
    return new MonaPayClient({
      clientId: linked.client_id,
      clientSecret: linked.client_secret,
      baseUrl: config.monapayApi,
      fetchImpl,
    });
  }
  throw new CloudError(
    'monapay_link_required',
    'MONA Pay đang ở giai đoạn chuyển tiếp và chưa được liên kết với MONA Pass này.',
    'Gọi monapay_link một lần; nếu hệ thống yêu cầu OTP thì hoàn tất OTP rồi thử lại.',
  );
}

export function importedMonaPayTools(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Record<string, ImportedTool> {
  const imported = createMonaPayServer(() => createMonaPayClient(config, env, fetchImpl));
  return (imported as unknown as McpInternals)._registeredTools;
}

export async function normalizeImportedResult(result: unknown) {
  const value = await result;
  if (!value || typeof value !== 'object') return value;
  const response = value as { isError?: boolean; content?: Array<{ type: string; text?: string }> };
  if (!response.isError) return response;
  const message = response.content?.find((item) => item.type === 'text')?.text || 'MONA Pay trả lỗi.';
  return errorResult(new CloudError(
    'monapay_error',
    message,
    'Kiểm tra tham số và trạng thái liên kết MONA Pay; gọi monapay_link nếu credential chuyển tiếp đã hết hiệu lực.',
  ));
}
