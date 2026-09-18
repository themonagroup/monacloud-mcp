import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from './config.js';
import { AuthManager, readLinks, writeLinks } from './auth.js';
import { CloudError } from './errors.js';
import { apiError, requestJson, unwrapData } from './http.js';

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

  async mail<T = unknown>(
    path: string,
    options: { method?: string; body?: unknown; query?: Record<string, string | number | undefined>; headers?: Record<string, string> } = {},
  ): Promise<T> {
    try {
      return await requestJson<T>(`${this.config.monamailApi}${path}`, {
        ...options,
        headers: {
          ...(options.method === 'POST' ? { 'Idempotency-Key': `mcp-mail-${randomUUID()}` } : {}),
          ...options.headers,
        },
        token: await this.auth.accessToken(),
        fetchImpl: this.fetchImpl,
      });
    } catch (error) {
      if (!(error instanceof CloudError) || !error.status) throw error;
      // Mail keeps the API's error contract without changing legacy HTTP errors.
      const root = asObject(error.details);
      const objects = [root, asObject(root.detail)];
      const code = path === '/v1/account/plan' && error.status === 402
        ? 'insufficient_funds'
        : pickString(objects, ['code']) || error.code;
      const fallback = code === 'insufficient_funds'
        ? 'Gọi cloud_topup để lấy QR nạp ví (in qr_ascii cho người dùng quét), chờ cloud_topup_status paid hoặc cloud_balance cập nhật rồi thử lại.'
        : code === 'quota_exceeded'
          ? 'Gọi mail_plans rồi mail_plan_set để đổi gói trước khi gửi tiếp.'
          : code === 'budget_exceeded'
            ? 'Gọi cloud_budget_get và điều chỉnh ngân sách trước khi thử lại.'
            : error.nextStep;
      const nextStep = pickString(objects, ['next_step']) || fallback;
      throw new CloudError(
        code,
        pickString(objects, ['message']) || error.message,
        code === 'insufficient_funds' && !nextStep.includes('cloud_topup')
          ? `${nextStep} Gọi cloud_topup để nạp ví.`
          : nextStep,
        { status: error.status, details: error.details, requestId: error.requestId },
      );
    }
  }

  async balance(): Promise<unknown> {
    try {
      return await this.billing('/v1/balance');
    } catch (error) {
      // Ví local (token vc_live_* hoặc tài khoản chưa chuyển ví chung): billing trả 401/403/404 → đọc số dư qua compute /api/me.
      const status = error instanceof CloudError ? error.status ?? 0 : 0;
      if (!(error instanceof CloudError) || ![401, 403, 404, 502, 503].includes(status)) throw error;
      const root = asObject(unwrapData(await this.vibecloud('/api/me')));
      const me = asObject(root.user ?? root); // compute trả {user:{credit_vnd, promo_credit_vnd, total_credit_vnd}}
      const balanceVnd = me.total_credit_vnd !== undefined
        ? Number(me.total_credit_vnd)
        : Number(me.credit_vnd ?? me.balance_vnd ?? 0) + Number(me.promo_credit_vnd ?? 0);
      return {
        balance_vnd: Number.isFinite(balanceVnd) ? balanceVnd : 0,
        currency: 'VND',
        wallet: 'local',
        source: '/api/me',
        note: 'Số dư ví local MONA Cloud compute (billing.monacloud.vn không nhận token này). Thiếu tiền thì gọi cloud_topup: QR VietQR in ngay trong terminal, người dùng quét bằng app ngân hàng, không cần mở console. / Local compute wallet balance; top up with cloud_topup.',
      };
    }
  }

  /** Số dư ví local compute (nơi yêu cầu nạp qua /api/payments/vietqr được cộng), đọc từ /api/me. */
  async localBalance(): Promise<JsonObject> {
    const root = asObject(unwrapData(await this.vibecloud('/api/me')));
    const me = asObject(root.user ?? root);
    const credit = Number(me.credit_vnd ?? 0);
    const promo = Number(me.promo_credit_vnd ?? 0);
    const total = me.total_credit_vnd !== undefined ? Number(me.total_credit_vnd) : credit + promo;
    return {
      balance_vnd: Number.isFinite(total) ? total : 0,
      credit_vnd: Number.isFinite(credit) ? credit : 0,
      promo_credit_vnd: Number.isFinite(promo) ? promo : 0,
      currency: 'VND',
      wallet: 'local',
      source: '/api/me',
    };
  }

  ledger(cursor?: string, limit = 50) {
    return this.billing('/v1/ledger', { query: { cursor, limit } });
  }

  usage(period: string, product?: string) {
    return this.billing('/v1/usage', { query: { period, product } });
  }

  /**
   * Tạo yêu cầu nạp ví. Ưu tiên ví chung (billing /v1/topups → MONA Pay); khi billing chưa nhận token
   * hoặc merchant MONA Pay chưa cấu hình (401/403/404/502/503) thì tạo qua compute /api/payments/vietqr
   * (ví local, prefix VIBECLOUD, báo có tự cộng). Người dùng chỉ quét QR; không cần console.
   */
  async topup(amount: number, idempotencyKey?: string): Promise<JsonObject> {
    const key = idempotencyKey || `mcp-topup-${randomUUID()}`;
    try {
      const central = asObject(unwrapData(await this.billing('/v1/topups', {
        method: 'POST',
        headers: { 'Idempotency-Key': key },
        body: { amount_vnd: amount },
      })));
      return { amount_vnd: amount, ...central, wallet: 'central', source: '/v1/topups' };
    } catch (error) {
      const status = error instanceof CloudError ? error.status ?? 0 : 0;
      if (!(error instanceof CloudError) || ![401, 403, 404, 502, 503].includes(status)) throw error;
      const local = asObject(unwrapData(await this.vibecloud('/api/payments/vietqr', {
        method: 'POST',
        body: { amount },
      })));
      return {
        topup_id: local.payment_id,
        order_ref: local.description,
        amount_vnd: typeof local.amount === 'number' ? local.amount : amount,
        status: local.status ?? 'pending',
        qr_url: local.qr_url,
        qr_data_url: local.qr_data_url,
        wallet: 'local',
        source: '/api/payments/vietqr',
        fallback_reason: error.code,
      };
    }
  }

  /** Trạng thái một yêu cầu nạp (pending/paid) kèm số dư hiện tại, để AI chờ tiền vào rồi làm tiếp. */
  async topupStatus(topupId: string): Promise<JsonObject> {
    if (/^[0-9a-f]{24}$/i.test(topupId)) {
      const root = asObject(unwrapData(await this.vibecloud(`/api/payments/${encodeURIComponent(topupId)}`)));
      const payment = asObject(root.payment ?? root);
      const status = typeof payment.status === 'string' ? payment.status : 'pending';
      return {
        topup_id: topupId,
        status,
        paid: status === 'paid',
        amount_vnd: payment.amount,
        order_ref: payment.description,
        updated_at: payment.updated_at ?? payment.paid_at,
        wallet: 'local',
        balance: await this.localBalance(),
      };
    }
    const ledger = await this.ledger(undefined, 100).catch(() => undefined);
    const paid = ledger !== undefined && JSON.stringify(ledger).includes(topupId);
    return {
      topup_id: topupId,
      status: paid ? 'paid' : 'pending',
      paid,
      wallet: 'central',
      balance: await this.balance(),
    };
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

  async spendGuard(requiredVnd?: number): Promise<JsonObject> {
    const current = asObject(unwrapData(await this.balance()));
    const balance = current.balance_vnd;
    if (requiredVnd !== undefined && (typeof balance !== 'number' || !Number.isFinite(balance))) {
      throw new CloudError('invalid_balance', 'Không đọc được số dư để duyệt giá gói.', 'Gọi cloud_balance rồi thử lại.');
    }
    if (typeof balance === 'number' && (requiredVnd === undefined ? balance <= 0 : balance < requiredVnd)) {
      throw new CloudError(
        'insufficient_funds',
        `Ví thiếu tiền: có ${balance} đ${requiredVnd === undefined ? '' : `, cần ${requiredVnd} đ`}.`,
        'Gọi cloud_topup để lấy QR nạp ví in ngay trong terminal; người dùng quét xong thì gọi lại tool.',
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
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    return requestJson<T>(`${this.config.vibecloudApi}${path}`, {
      timeoutMs: 30_000,
      ...options,
      token: await this.vibecloudToken(),
      fetchImpl: this.fetchImpl,
    });
  }

  /**
   * Gọi endpoint MONA Cloud mở cho guest (spec monadomain §12: search/reserve/status không cần Pass).
   * Có token trên máy thì vẫn gửi (để backend ghi lead + gắn chủ); chưa login thì đi ẩn danh
   * hoặc dùng guest_token của reservation — KHÔNG ném login_required.
   */
  /** true khi máy chưa có token nào (env, links, MONA Pass) — agent đang ở tư cách guest. */
  async isGuest(): Promise<boolean> {
    try {
      await this.vibecloudToken();
      return false;
    } catch (error) {
      if (error instanceof CloudError && error.code === 'login_required') return true;
      throw error;
    }
  }

  async vibecloudGuestOk<T = unknown>(
    path: string,
    options: {
      method?: string;
      body?: unknown;
      query?: Record<string, string | number | undefined>;
      headers?: Record<string, string>;
      guestToken?: string;
    } = {},
  ): Promise<T> {
    const { guestToken, ...rest } = options;
    let token: string | undefined;
    try {
      token = await this.vibecloudToken();
    } catch (error) {
      if (!(error instanceof CloudError) || error.code !== 'login_required') throw error;
      token = guestToken;
    }
    return requestJson<T>(`${this.config.vibecloudApi}${path}`, {
      timeoutMs: 30_000,
      ...rest,
      token,
      fetchImpl: this.fetchImpl,
    });
  }

  async guardedVibecloud(
    path: string,
    options: { method?: string; body?: unknown } = {},
    requestedSandbox = false,
    requiredVnd?: number,
  ): Promise<unknown> {
    const sandbox = this.sandboxEnabled(requestedSandbox);
    if (!sandbox) await this.spendGuard(requiredVnd);
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

  plans() {
    return requestJson(`${this.config.vibecloudApi}/api/plans`, { fetchImpl: this.fetchImpl });
  }

  async invoicePdf(invoiceId: string) {
    const token = await this.vibecloudToken();
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.config.vibecloudApi}/api/invoices/${encodeURIComponent(invoiceId)}.pdf`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/pdf' },
        signal: AbortSignal.timeout(30_000),
        redirect: 'error',
      });
    } catch {
      throw new CloudError('network_error', 'Không tải được PDF hoá đơn.', 'Gọi lại cloud_invoice_pdf với cùng invoice_id.');
    }
    if (!response.ok) {
      const body = await response.text();
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { parsed = { message: body.slice(0, 1000) }; }
      throw apiError(response, parsed);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new CloudError('invalid_pdf', 'API không trả nội dung PDF hợp lệ.', 'Kiểm tra invoice_id rồi thử lại.');
    }
    const directory = await mkdtemp(join(tmpdir(), 'monacloud-invoice-'));
    const path = join(directory, 'invoice.pdf');
    try {
      await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
    return { invoice_id: invoiceId, path, mime_type: 'application/pdf', size_bytes: bytes.length };
  }
}
