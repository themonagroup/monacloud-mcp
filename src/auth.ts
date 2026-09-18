import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { CloudError } from './errors.js';
import { requestJson } from './http.js';

export type StoredToken = {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  token_type?: string;
  scope?: string;
  expires_in?: number;
  expires_at: number;
};

type DeviceAuthorization = {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
};

type Discovery = {
  device_authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
};

const sleep = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const asObject = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' ? value as Record<string, unknown> : {}
);

async function readJsonFile<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new CloudError(
      'invalid_token_store',
      `Không đọc được token store: ${error instanceof Error ? error.message : String(error)}`,
      'Chạy `monacloud-mcp logout`, sau đó đăng nhập lại.',
    );
  }
}

async function writePrivateJson(path: string, directory: string, value: unknown): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporaryPath, 0o600);
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

function tokenFromResponse(value: unknown, previousRefreshToken?: string): StoredToken {
  const body = asObject(value);
  if (typeof body.access_token !== 'string' || !body.access_token) {
    throw new CloudError(
      'invalid_token_response',
      'MONA Pass không trả access_token.',
      'Kiểm tra cấu hình client `monacloud-mcp` trên MONA Pass rồi đăng nhập lại.',
    );
  }
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : 300;
  return {
    access_token: body.access_token,
    ...(typeof body.refresh_token === 'string'
      ? { refresh_token: body.refresh_token }
      : previousRefreshToken ? { refresh_token: previousRefreshToken } : {}),
    ...(typeof body.id_token === 'string' ? { id_token: body.id_token } : {}),
    ...(typeof body.token_type === 'string' ? { token_type: body.token_type } : {}),
    ...(typeof body.scope === 'string' ? { scope: body.scope } : {}),
    expires_in: expiresIn,
    expires_at: Date.now() + Math.max(0, expiresIn) * 1000,
  };
}

async function postForm(
  url: string,
  form: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(form),
    });
  } catch (error) {
    throw new CloudError(
      'network_error',
      `Không kết nối được MONA Pass: ${error instanceof Error ? error.message : String(error)}`,
      'Kiểm tra MONACLOUD_ISSUER và kết nối mạng rồi thử lại.',
    );
  }
  const body = asObject(await response.json().catch(() => ({})));
  return { response, body };
}

export class AuthManager {
  constructor(
    readonly config: Config,
    readonly env: NodeJS.ProcessEnv = process.env,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async discovery(): Promise<Discovery> {
    try {
      return await requestJson<Discovery>(`${this.config.issuer}/.well-known/openid-configuration`, {
        fetchImpl: this.fetchImpl,
      });
    } catch {
      return {};
    }
  }

  async loadToken(): Promise<StoredToken | undefined> {
    return readJsonFile<StoredToken>(this.config.tokenFile);
  }

  async saveToken(token: StoredToken): Promise<void> {
    await writePrivateJson(this.config.tokenFile, this.config.configDir, token);
  }

  async logout(): Promise<boolean> {
    let removed = false;
    for (const path of [this.config.tokenFile, this.config.linksFile]) {
      try {
        await rm(path);
        removed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return removed;
  }

  async refresh(token: StoredToken): Promise<StoredToken> {
    if (!token.refresh_token) {
      throw new CloudError(
        'login_required',
        'Token đã hết hạn và không có offline refresh token.',
        'Chạy `monacloud-mcp login` để đăng nhập lại.',
      );
    }
    const discovery = await this.discovery();
    const endpoint = discovery.token_endpoint
      || `${this.config.issuer}/protocol/openid-connect/token`;
    const { response, body } = await postForm(endpoint, {
      grant_type: 'refresh_token',
      client_id: this.config.clientId,
      refresh_token: token.refresh_token,
    }, this.fetchImpl);
    if (!response.ok) {
      throw new CloudError(
        'refresh_failed',
        typeof body.error_description === 'string' ? body.error_description : 'Không refresh được token MONA Pass.',
        'Chạy `monacloud-mcp login` để đăng nhập lại.',
        { status: response.status },
      );
    }
    const refreshed = tokenFromResponse(body, token.refresh_token);
    await this.saveToken(refreshed);
    return refreshed;
  }

  async accessToken(): Promise<string> {
    if (this.env.MONACLOUD_TOKEN) return this.env.MONACLOUD_TOKEN;
    const stored = await this.loadToken();
    if (!stored) {
      throw new CloudError(
        'login_required',
        'Chưa có token MONA Pass trên máy.',
        'Người dùng muốn MUA TÊN MIỀN mà chưa có tài khoản → KHÔNG bảo họ đi đăng ký: gọi cloud_domain_reserve (không cần đăng nhập; hỏi email + số điện thoại) → đưa QR trong payment + claim_url, họ bấm đăng nhập 1 bước là hệ tự tạo ví + mua. Với việc khác cần tài khoản: chạy `monacloud-mcp login`, hoàn tất mã thiết bị rồi gọi lại tool.',
      );
    }
    if (stored.expires_at > Date.now() + 30_000) return stored.access_token;
    return (await this.refresh(stored)).access_token;
  }

  async userinfo(): Promise<Record<string, unknown>> {
    const discovery = await this.discovery();
    const endpoint = discovery.userinfo_endpoint
      || `${this.config.issuer}/protocol/openid-connect/userinfo`;
    return requestJson<Record<string, unknown>>(endpoint, {
      token: await this.accessToken(),
      fetchImpl: this.fetchImpl,
    });
  }

  async login(output: (line: string) => void = console.log): Promise<Record<string, unknown>> {
    const discovery = await this.discovery();
    const deviceEndpoint = discovery.device_authorization_endpoint
      || `${this.config.issuer}/protocol/openid-connect/auth/device`;
    const tokenEndpoint = discovery.token_endpoint
      || `${this.config.issuer}/protocol/openid-connect/token`;
    const started = await postForm(deviceEndpoint, {
      client_id: this.config.clientId,
      scope: this.config.scope,
    }, this.fetchImpl);
    if (!started.response.ok) {
      throw new CloudError(
        'device_flow_unavailable',
        typeof started.body.error_description === 'string'
          ? started.body.error_description
          : 'MONA Pass không khởi tạo được device flow.',
        'Kiểm tra client `monacloud-mcp` đã bật OAuth 2.0 Device Authorization Grant.',
        { status: started.response.status },
      );
    }
    const device = started.body as DeviceAuthorization;
    if (!device.device_code || !device.user_code || !device.verification_uri) {
      throw new CloudError(
        'invalid_device_response',
        'MONA Pass trả device-flow response không hợp lệ.',
        'Kiểm tra cấu hình MONA Pass rồi thử lại.',
      );
    }

    output('Đăng nhập MONA Cloud');
    output(`Mở: ${device.verification_uri_complete || device.verification_uri}`);
    output(`Mã: ${device.user_code}`);
    output('Đang chờ xác nhận…');

    let intervalSeconds = Math.max(1, device.interval || 5);
    const deadline = Date.now() + Math.max(1, device.expires_in) * 1000;
    while (Date.now() < deadline) {
      await sleep(intervalSeconds * 1000);
      const polled = await postForm(tokenEndpoint, {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: device.device_code,
        client_id: this.config.clientId,
      }, this.fetchImpl);
      if (polled.response.ok) {
        const token = tokenFromResponse(polled.body);
        await this.saveToken(token);
        const identity: Record<string, unknown> = await this.userinfo().catch(() => ({}));
        output(`Đăng nhập xong${identity.email ? `: ${String(identity.email)}` : '.'}`);
        return identity;
      }
      const error = polled.body.error;
      if (error === 'authorization_pending') continue;
      if (error === 'slow_down') {
        intervalSeconds += 5;
        continue;
      }
      if (error === 'access_denied') {
        throw new CloudError('access_denied', 'Người dùng đã từ chối đăng nhập.', 'Chạy lại `monacloud-mcp login` khi sẵn sàng.');
      }
      if (error === 'expired_token') break;
      throw new CloudError(
        typeof error === 'string' ? error : 'login_failed',
        typeof polled.body.error_description === 'string' ? polled.body.error_description : 'Đăng nhập thất bại.',
        'Chạy lại `monacloud-mcp login`.',
        { status: polled.response.status },
      );
    }
    throw new CloudError('device_code_expired', 'Mã đăng nhập đã hết hạn.', 'Chạy lại `monacloud-mcp login` để lấy mã mới.');
  }

  tokenId(token: string): string {
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1] || '', 'base64url').toString('utf8')) as Record<string, unknown>;
      if (typeof payload.jti === 'string' && payload.jti) return payload.jti;
      if (typeof payload.sub === 'string' && payload.sub) return payload.sub;
    } catch {
      // Opaque PATs intentionally fall through to the stable client identifier.
    }
    return this.config.clientId;
  }
}

export type LinkedCredentials = {
  monapay?: { client_id: string; client_secret: string; linked_at: string };
  vibecloud?: { token: string; expires_at?: number; linked_at: string };
};

export async function readLinks(config: Config): Promise<LinkedCredentials> {
  return (await readJsonFile<LinkedCredentials>(config.linksFile)) || {};
}

export async function writeLinks(config: Config, links: LinkedCredentials): Promise<void> {
  await writePrivateJson(config.linksFile, config.configDir, links);
}
