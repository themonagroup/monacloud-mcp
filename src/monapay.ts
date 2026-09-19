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

export type ToolAnnotations = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

// cloud_subscription_update có thể huỷ gia hạn / dừng máy (cancel_action=stop) → xếp destructive để agent hỏi lại trước khi gọi.
const DESTRUCTIVE = /(?:^|_)(?:delete|remove|cancel|release|rotate|stop|destroy|reset|revoke|suspend)(?:_|$)|^cloud_subscription_update$/;
const READ_ONLY = /(?:^|_)(?:list|get|status|search|balance|ledger|health|whoami|usage|services|quote|detect|wait|logs|stats|templates|tlds|prices|packages)(?:_|$)/;
const IDEMPOTENT_WRITE = /(?:^|_)(?:set|update|attach)(?:_|$)/;

/** Mechanical metadata shared by native tools and tools imported from monapay-mcp. */
export function toolAnnotationsForName(name: string): ToolAnnotations {
  const canonical = name.replace(/^vibecloud_/, 'cloud_');
  const destructiveHint = DESTRUCTIVE.test(canonical);
  const readOnlyHint = !destructiveHint && (
    READ_ONLY.test(canonical)
    || canonical === 'cloud_open_console'
    || canonical === 'mail_account'
    || canonical === 'mail_plans'
    || canonical === 'cloud_invoice_pdf'
    || canonical === 'cloud_base_credentials'
    || canonical === 'mail_inbox_message'
    || canonical === 'mail_inbox_messages'
    || canonical === 'monapay_me'
    || canonical === 'monapay_verify_signature'
    || canonical === 'monapay_generate_webhook_snippet'
    || canonical === 'monapay_quickstart'
  );
  const idempotentHint = readOnlyHint
    || (destructiveHint && !/(?:^|_)(?:rotate|reset)(?:_|$)/.test(canonical))
    || (!destructiveHint && IDEMPOTENT_WRITE.test(canonical));
  return {
    readOnlyHint,
    destructiveHint,
    idempotentHint,
    openWorldHint: canonical !== 'cloud_app_detect',
  };
}

export function completeToolMetadata(
  name: string,
  title: unknown,
  annotations: unknown,
): { title: string; annotations: ToolAnnotations } {
  const existing = annotations && typeof annotations === 'object'
    ? annotations as Partial<ToolAnnotations>
    : {};
  return {
    title: typeof title === 'string' && title.trim()
      ? title
      : `Công cụ MONA ${name.replace(/^(?:cloud|vibecloud|monapay|mail|agent)_/, '').replaceAll('_', ' ')}`,
    annotations: { ...toolAnnotationsForName(name), ...existing },
  };
}

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
