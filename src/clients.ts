import { randomUUID } from 'node:crypto';
import type { Config } from './config.js';
import { AuthManager, readLinks, writeLinks } from './auth.js';
import { CloudError } from './errors.js';
import { requestJson, unwrapData } from './http.js';

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject => (
  value && typeof value === 'object' ? value as JsonObject : {}
);

function pickString(objects: JsonObject[], keys: string[]): string | undefined {
  for (const object of objects) {
    for (const key of keys) {
      const value = object[key];
      if (typeof value === 'string' && value) return value;
    }
  }
  return undefined;
}

export class CloudClients {
  constructor(
    readonly config: Config,
    readonly auth: AuthManager,
    readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async billing<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown; query?: Record<string, string | number | undefined>; headers?: Record<string, string> } = {},
  ): Promise<T> {
    return requestJson<T>(`${this.config.billingUrl}${path}`, {
      ...options,
      token: await this.auth.accessToken(),
      fetchImpl: this.fetchImpl,
    });
  }

  balance() {
    return this.billing('/v1/balance');
  }

  ledger(cursor?: string, limit = 50) {
    return this.billing('/v1/ledger', { query: { cursor, limit } });
  }

  usage(period: string, product?: string) {
    return this.billing('/v1/usage', { query: { period, product } });
  }

  topup(amount: number, idempotencyKey?: string) {
    return this.billing('/v1/topups', {
      method: 'POST',
      headers: { 'Idempotency-Key': idempotencyKey || `mcp-topup-${randomUUID()}` },
      body: { amount_vnd: amount },
    });
  }

  budgetSet(body: { scope: string; scope_id: string; limit_vnd: number; period: string }) {
    return this.billing('/v1/budgets', { method: 'POST', body });
  }

  budgetGet() {
    return this.billing('/v1/budgets');
  }

  async tokenLimit(spendLimitVnd: number, period: string, tokenId?: string) {
    const token = await this.auth.accessToken();
    const id = tokenId || this.auth.tokenId(token);
    return requestJson(`${this.config.billingUrl}/v1/tokens/${encodeURIComponent(id)}/limit`, {
      method: 'PUT',
      token,
      body: { spend_limit_vnd: spendLimitVnd, period },
      fetchImpl: this.fetchImpl,
    });
  }

  async spendGuard(): Promise<JsonObject> {
    const current = asObject(await this.balance());
    const balance = current.balance_vnd;
    if (typeof balance === 'number' && balance <= 0) {
      throw new CloudError(
        'insufficient_funds',
        'Ví thiếu tiền: số dư hiện tại là 0 đ.',
        `Nạp ví tại ${this.config.consoleUrl} rồi gọi lại tool.`,
      );
    }
    return current;
  }

  sandboxEnabled(requested = false): boolean {
    return requested || this.auth.env.MONACLOUD_SANDBOX === '1';
  }

  private async vibecloudToken(): Promise<string> {
    if (this.auth.env.VIBECLOUD_API_TOKEN) return this.auth.env.VIBECLOUD_API_TOKEN;
    const links = await readLinks(this.config);
    if (links.vibecloud?.token
      && (!links.vibecloud.expires_at || links.vibecloud.expires_at > Date.now() + 30_000)) {
      return links.vibecloud.token;
    }
    return this.auth.accessToken();
  }

  async vibecloud<T = unknown>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    return requestJson<T>(`${this.config.vibecloudApi}${path}`, {
      ...options,
      token: await this.vibecloudToken(),
      fetchImpl: this.fetchImpl,
    });
  }

  async guardedVibecloud(
    path: string,
    options: { method?: string; body?: unknown } = {},
    requestedSandbox = false,
  ): Promise<unknown> {
    const sandbox = this.sandboxEnabled(requestedSandbox);
    if (!sandbox) await this.spendGuard();
    const result = await this.vibecloud(path, {
      ...options,
      ...(sandbox ? { headers: { 'X-Vibecloud-Sandbox': '1' } } : {}),
    });
    return sandbox ? { ...asObject(result), sandbox: true } : result;
  }

  async vibecloudLink(): Promise<JsonObject> {
    if (this.auth.env.VIBECLOUD_API_TOKEN) {
      return { linked: true, product: 'vibecloud', mode: 'legacy_env', next_step: 'Dùng các tool cloud_*.' };
    }
    const monaIdToken = await this.auth.accessToken();
    try {
      await requestJson(`${this.config.vibecloudApi}/api/services`, {
        token: monaIdToken,
        fetchImpl: this.fetchImpl,
      });
      return {
        linked: true,
        product: 'vibecloud',
        mode: 'direct_mona_id',
        next_step: 'MONA Cloud đã nhận MONA Pass trực tiếp; không cần cache vc_live token.',
      };
    } catch (error) {
      if (!(error instanceof CloudError) || ![401, 403].includes(error.status || 0)) throw error;
    }
    const value = await requestJson(`${this.config.vibecloudApi}${this.config.vibecloudLinkPath}`, {
      method: 'POST',
      token: monaIdToken,
      body: { source: 'monacloud-mcp' },
      fetchImpl: this.fetchImpl,
    });
    const root = asObject(value);
    const data = asObject(unwrapData(value));
    const token = pickString([data, root], ['api_token', 'access_token', 'token', 'vibecloud_token']);
    if (!token) {
      throw new CloudError(
        'invalid_link_response',
        'MONA Cloud không trả automation token sau khi liên kết.',
        'Kiểm tra endpoint chuyển tiếp MONA Pass của MONA Cloud rồi gọi lại cloud_link.',
      );
    }
    const expiresIn = Number(data.expires_in ?? root.expires_in);
    const links = await readLinks(this.config);
    links.vibecloud = {
      token,
      ...(Number.isFinite(expiresIn) ? { expires_at: Date.now() + expiresIn * 1000 } : {}),
      linked_at: new Date().toISOString(),
    };
    await writeLinks(this.config, links);
    return { linked: true, product: 'vibecloud', next_step: 'Dùng các tool cloud_* bằng cùng MONA Pass.' };
  }

  async monapayLink(): Promise<JsonObject> {
    const value = await requestJson(`${this.config.monapayApi}${this.config.monapayLinkPath}`, {
      method: 'POST',
      token: await this.auth.accessToken(),
      body: { source: 'monacloud-mcp' },
      fetchImpl: this.fetchImpl,
    });
    const root = asObject(value);
    const data = asObject(unwrapData(value));
    const clientId = pickString([data, root], ['client_id', 'clientId']);
    const clientSecret = pickString([data, root], ['client_secret', 'clientSecret']);
    if (!clientId || !clientSecret) {
      throw new CloudError(
        'invalid_link_response',
        'MONA Pay chưa trả đủ client_id/client_secret sau khi liên kết.',
        'Nếu tài khoản cũ cần OTP liên kết, hoàn tất OTP theo hướng dẫn MONA Pay rồi gọi lại monapay_link.',
      );
    }
    const links = await readLinks(this.config);
    links.monapay = { client_id: clientId, client_secret: clientSecret, linked_at: new Date().toISOString() };
    await writeLinks(this.config, links);
    return { linked: true, product: 'monapay', next_step: 'Dùng các tool monapay_* bằng cùng MONA Pass.' };
  }

  prices() {
    return requestJson(`${this.config.vibecloudApi}/api/prices`, { fetchImpl: this.fetchImpl });
  }

  packages() {
    return requestJson(`${this.config.vibecloudApi}/api/packages`, { fetchImpl: this.fetchImpl });
  }
}
