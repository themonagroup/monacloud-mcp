import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import cors from "cors";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ProxyOAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/providers/proxyProvider.js";
import { mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { createServer as createMcpServer } from "./server.js";
import { createAccessTokenVerifier, type VerifiedAccessToken } from "./remote-verify.js";

const SCOPES = ["openid", "profile", "email", "offline_access", "vibecloud-api", "billing-api"];
// Keycloak DCR chỉ nhận tên client scope thật (openid/profile/email là mặc định, gửi kèm sẽ bị policy "Allowed Client Scopes" từ chối).
const DCR_SCOPES = ["profile", "email", "roles", "basic", "offline_access", "vibecloud-api", "billing-api"];
const IDLE_TTL_MS = 30 * 60_000;
const MAX_SESSIONS = 2_000;

interface OAuthDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint?: string;
}

interface HttpRequest {
  method: string;
  path: string;
  ip?: string;
  body?: Record<string, unknown>;
  get(name: string): string | undefined;
}

interface HttpResponse {
  statusCode: number;
  locals: Record<string, unknown>;
  on(event: "finish", listener: () => void): void;
  set(name: string, value: string): HttpResponse;
  status(code: number): HttpResponse;
  json(body: unknown): HttpResponse;
  end(): HttpResponse;
}

interface ClientInfo extends Record<string, unknown> {
  client_id: string;
  redirect_uris: string[];
}

interface Session {
  server: { close(): Promise<void> };
  transport: StreamableHTTPServerTransport;
  // env của phiên: AuthManager đọc env.MONACLOUD_TOKEN mỗi lần gọi → cập nhật khi client gửi token mới (refresh).
  env: NodeJS.ProcessEnv;
  sub: string;
  exp: number;
  touchedAt: number;
}

export interface RemoteServerOptions {
  publicUrl: string;
  issuer: string;
  initialAccessToken: string;
  /** Thư mục lưu client DCR (clients.json) để sống qua restart; bỏ trống = chỉ giữ trong RAM (test). */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  verifyAccessToken?: (token: string) => Promise<VerifiedAccessToken>;
  createServer?: typeof createMcpServer;
  now?: () => number;
}

export interface RemoteServer {
  app: ReturnType<typeof express>;
  close(): Promise<void>;
  sessionCount(): number;
}

function bearer(req: HttpRequest): string | undefined {
  const value = req.get("authorization");
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1];
}

function authChallenge(publicUrl: string): string {
  return `Bearer resource_metadata="${publicUrl}/.well-known/oauth-protected-resource"`;
}

export async function createRemoteServer(options: RemoteServerOptions): Promise<RemoteServer> {
  const publicUrl = options.publicUrl.replace(/\/$/, "");
  const issuer = options.issuer.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const createServer = options.createServer ?? createMcpServer;
  const registeredClients = new Map<string, ClientInfo>();
  const sessions = new Map<string, Session>();
  const clientsFile = options.dataDir ? join(options.dataDir, "clients.json") : undefined;
  if (clientsFile) {
    mkdirSync(options.dataDir!, { recursive: true });
    try {
      const stored = JSON.parse(readFileSync(clientsFile, "utf8")) as ClientInfo[];
      for (const client of stored) registeredClients.set(client.client_id, client);
    } catch {
      // chưa có file hoặc hỏng → bắt đầu rỗng
    }
  }
  function persistClients(): void {
    if (!clientsFile) return;
    const tmp = `${clientsFile}.tmp`;
    writeFileSync(tmp, JSON.stringify([...registeredClients.values()], null, 2));
    renameSync(tmp, clientsFile);
  }

  const discoveryResponse = await fetchImpl(`${issuer}/.well-known/openid-configuration`);
  if (!discoveryResponse.ok) throw new Error(`OIDC discovery failed: ${discoveryResponse.status}`);
  const discovery = await discoveryResponse.json() as OAuthDiscovery;
  if (!discovery.authorization_endpoint || !discovery.token_endpoint) {
    throw new Error("OIDC discovery is missing required endpoints");
  }

  const verifyAccessToken = options.verifyAccessToken ?? createAccessTokenVerifier({
    issuer,
    fetch: fetchImpl,
    isRegisteredClient: (clientId) => registeredClients.has(clientId),
    now,
  });

  const registrationUrl = `${issuer}/clients-registrations/openid-connect`;

  // DCR: SDK router lo validate + rate-limit (express-rate-limit 1h/IP); registerClient đẩy sang Keycloak
  // kèm Initial Access Token (Keycloak không mở đăng ký ẩn danh) và ép public client + PKCE.
  async function registerClient(client: Record<string, unknown>): Promise<ClientInfo> {
    const upstream = await fetchImpl(registrationUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.initialAccessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        ...client,
        client_id: undefined,
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        token_endpoint_auth_method: "none",
        scope: DCR_SCOPES.join(" "),
      }),
    });
    const body = await upstream.json() as Record<string, unknown>;
    if (!upstream.ok || typeof body.client_id !== "string" || !Array.isArray(body.redirect_uris)) {
      throw new Error(`Client registration failed: ${upstream.status} ${JSON.stringify(body).slice(0, 200)}`);
    }
    // Không lưu registration_access_token (không cần cho luồng public client + PKCE).
    const { registration_access_token: _rat, ...info } = body;
    registeredClients.set(body.client_id, info as ClientInfo);
    persistClients();
    return info as ClientInfo;
  }

  class MonaPassProxyProvider extends ProxyOAuthServerProvider {
    override get clientsStore() {
      return {
        getClient: async (clientId: string) => registeredClients.get(clientId),
        registerClient,
      };
    }

    // Luôn xin đủ scope API (vibecloud-api → aud vibecloud, billing-api → aud billing, offline_access → refresh)
    // dù client chỉ gửi "openid": thiếu là cloud_balance/cloud_topup bị 401 dù đã đăng nhập.
    override async authorize(
      client: Parameters<ProxyOAuthServerProvider["authorize"]>[0],
      params: Parameters<ProxyOAuthServerProvider["authorize"]>[1],
      res: Parameters<ProxyOAuthServerProvider["authorize"]>[2],
    ): Promise<void> {
      const scopes = new Set([...(params.scopes ?? []), ...SCOPES]);
      return super.authorize(client, { ...params, scopes: [...scopes] }, res);
    }
  }

  const provider = new MonaPassProxyProvider({
    endpoints: {
      authorizationUrl: discovery.authorization_endpoint,
      tokenUrl: discovery.token_endpoint,
      revocationUrl: discovery.revocation_endpoint,
      registrationUrl,
    },
    verifyAccessToken,
    getClient: async (clientId: string) => registeredClients.get(clientId),
  });

  const app = express();
  app.set("trust proxy", "loopback"); // sau nginx: req.ip = IP thật của khách
  app.use(cors({
    origin: true,
    allowedHeaders: ["Authorization", "Mcp-Session-Id", "Content-Type"],
    exposedHeaders: ["Mcp-Session-Id"],
  }));
  // Chỉ parse JSON cho /mcp; các route OAuth của SDK (/register, /token…) tự parse body của chúng.
  app.use("/mcp", express.json({ limit: "4mb" }));

  app.use((req: HttpRequest, res: HttpResponse, next: () => void) => {
    const started = now();
    res.on("finish", () => {
      const subject = (res.locals.auth as VerifiedAccessToken | undefined)?.extra.sub;
      console.log(JSON.stringify({
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Math.max(0, now() - started),
        ...(subject ? { sub: `${subject.slice(0, 8)}…` } : {}),
      }));
    });
    next();
  });

  app.get("/healthz", (_req: HttpRequest, res: HttpResponse) => {
    res.json({ ok: true, version: process.env.npm_package_version ?? "0.10.10", sessions: sessions.size });
  });

  // RFC 9728 cho phép metadata theo path của resource (/.well-known/oauth-protected-resource/mcp) — Smithery/Claude thử URL này trước.
  app.get(["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"], (_req: HttpRequest, res: HttpResponse) => {
    res.json({
      resource: `${publicUrl}/mcp`,
      authorization_servers: [publicUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: SCOPES,
    });
  });

  // Cùng lý do: một số client hỏi /.well-known/oauth-authorization-server/mcp.
  app.get("/.well-known/oauth-authorization-server/mcp", (_req: HttpRequest, res: HttpResponse) => {
    res.set("Location", `${publicUrl}/.well-known/oauth-authorization-server`).status(302).end();
  });

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: new URL(publicUrl),
    baseUrl: new URL(publicUrl),
    scopesSupported: SCOPES,
    resourceName: "MONA Cloud MCP",
    clientRegistrationOptions: { clientIdGeneration: false },
  }));

  async function closeSession(sessionId: string): Promise<void> {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    await session.transport.close().catch(() => undefined);
    await session.server.close().catch(() => undefined);
  }

  async function sweep(): Promise<void> {
    const current = now();
    const expired = [...sessions.entries()]
      .filter(([, session]) => session.exp * 1000 <= current || current - session.touchedAt > IDLE_TTL_MS)
      .map(([id]) => closeSession(id));
    await Promise.all(expired);
  }
  const sweepTimer = setInterval(() => void sweep(), 60_000);
  sweepTimer.unref();

  async function authenticate(req: HttpRequest, res: HttpResponse): Promise<VerifiedAccessToken | undefined> {
    const token = bearer(req);
    if (!token) {
      res.set("WWW-Authenticate", authChallenge(publicUrl)).status(401).json({ error: "invalid_token" });
      return undefined;
    }
    try {
      const auth = await verifyAccessToken(token);
      res.locals.auth = auth;
      return auth;
    } catch {
      res.set("WWW-Authenticate", authChallenge(publicUrl)).status(401).json({ error: "invalid_token" });
      return undefined;
    }
  }

  app.all("/mcp", async (req: HttpRequest, res: HttpResponse) => {
    const auth = await authenticate(req, res);
    if (!auth) return;
    await sweep();
    const sessionId = req.get("mcp-session-id");

    if (req.method === "DELETE") {
      if (!sessionId || !sessions.has(sessionId)) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }
      await closeSession(sessionId);
      res.status(204).end();
      return;
    }

    if (sessionId) {
      const session = sessions.get(sessionId);
      if (!session || session.sub !== auth.extra.sub) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }
      session.touchedAt = now();
      session.env.MONACLOUD_TOKEN = auth.token;
      session.exp = auth.expiresAt;
      await session.transport.handleRequest(req as never, res as never, req.body);
      return;
    }

    if (req.method !== "POST") {
      res.status(400).json({ error: "missing_session_id" });
      return;
    }
    if (sessions.size >= MAX_SESSIONS) {
      res.status(503).json({ error: "session_limit_reached" });
      return;
    }

    let pendingSessionId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (id) => { pendingSessionId = id; },
    });
    const env: NodeJS.ProcessEnv = { ...process.env, ...options.env, MONACLOUD_TOKEN: auth.token };
    const server = createServer({ env });
    await server.connect(transport);
    await transport.handleRequest(req as never, res as never, req.body);
    if (pendingSessionId) {
      sessions.set(pendingSessionId, {
        server,
        transport,
        env,
        sub: auth.extra.sub,
        exp: auth.expiresAt,
        touchedAt: now(),
      });
    } else {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });

  return {
    app,
    sessionCount: () => sessions.size,
    async close() {
      clearInterval(sweepTimer);
      await Promise.all([...sessions.keys()].map(closeSession));
    },
  };
}
