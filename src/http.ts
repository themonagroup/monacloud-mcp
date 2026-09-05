import { CloudError } from './errors.js';

export type HttpOptions = {
  method?: string;
  token?: string;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' ? value as Record<string, unknown> : {}
);

const nestedString = (body: Record<string, unknown>, key: string): string | undefined => {
  const value = body[key];
  if (typeof value === 'string' && value) return value;
  const detail = asRecord(body.detail);
  const nested = detail[key];
  return typeof nested === 'string' && nested ? nested : undefined;
};

export function apiError(response: Response, body: unknown): CloudError {
  const parsed = asRecord(body);
  const requestId = response.headers.get('x-request-id')
    || nestedString(parsed, 'request_id');
  const detail = parsed.detail;
  const code = nestedString(parsed, 'code')
    || (typeof detail === 'string' && /^[a-z0-9_]+$/i.test(detail) ? detail : undefined)
    || (response.status === 401 ? 'auth_required' : `http_${response.status}`);
  const rawMessage = nestedString(parsed, 'message')
    || (typeof detail === 'string' ? detail : undefined)
    || `HTTP ${response.status}`;

  if (response.status === 402 || code === 'budget_exceeded' || code === 'insufficient_funds') {
    const shortage = parsed.shortage_vnd ?? parsed.missing_vnd ?? asRecord(detail).shortage_vnd;
    const missing = typeof shortage === 'number' ? `${shortage.toLocaleString('vi-VN')} đ` : 'tiền';
    return new CloudError(
      code === 'budget_exceeded' ? 'budget_exceeded' : 'insufficient_funds',
      `Ví thiếu ${missing} hoặc đã chạm giới hạn chi tiêu. ${rawMessage}`,
      'Nạp ví hoặc tăng ngân sách tại https://monacloud.vn/console rồi gọi lại tool.',
      { status: response.status, details: body, requestId },
    );
  }

  if (response.status === 401 || response.status === 403) {
    return new CloudError(
      code,
      `Token không có quyền hoặc đã hết hạn. ${rawMessage}`,
      'Chạy `monacloud-mcp login` rồi thử lại; kiểm tra audience/scope nếu lỗi vẫn còn.',
      { status: response.status, details: body, requestId },
    );
  }

  return new CloudError(
    code,
    rawMessage,
    code === 'upload_required'
      ? 'Gọi cloud_app_deploy với app_id hiện có và local_dir để upload source; không tạo app mới.'
      : response.status >= 500
      ? 'Kiểm tra monacloud://status rồi thử lại.'
      : 'Kiểm tra tham số theo mô tả tool rồi gọi lại.',
    { status: response.status, details: body, requestId },
  );
}

export async function requestJson<T = unknown>(url: string, options: HttpOptions = {}): Promise<T> {
  const parsedUrl = new URL(url);
  for (const [key, value] of Object.entries(options.query || {})) {
    if (value !== undefined && value !== '') parsedUrl.searchParams.set(key, String(value));
  }
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...options.headers,
  };
  const multipart = options.body instanceof FormData;
  if (options.body !== undefined && !multipart) headers['Content-Type'] = 'application/json';
  let response: Response;
  try {
    response = await (options.fetchImpl || fetch)(parsedUrl, {
      method: options.method || 'GET',
      headers,
      body: multipart ? options.body as FormData : options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(multipart ? { redirect: 'error' as const } : {}),
      ...(options.timeoutMs ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    });
  } catch (error) {
    throw new CloudError(
      'network_error',
      `Không kết nối được ${parsedUrl.origin}: ${error instanceof Error ? error.message : String(error)}`,
      'Kiểm tra mạng, URL cấu hình và monacloud://status rồi thử lại.',
    );
  }
  const text = await response.text();
  let body: unknown = {};
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { message: text.slice(0, 1000) };
    }
  }
  if (!response.ok) throw apiError(response, body);
  return body as T;
}

export function unwrapData<T = unknown>(value: unknown): T {
  const body = asRecord(value);
  return (body.data === undefined ? value : body.data) as T;
}
