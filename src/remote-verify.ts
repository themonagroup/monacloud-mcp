import { createPublicKey, verify as verifySignature } from "node:crypto";

export interface VerifiedAccessToken {
  token: string;
  clientId: string;
  scopes: string[];
  expiresAt: number;
  extra: { sub: string };
}

interface JwtHeader {
  alg?: string;
  kid?: string;
}

interface JwtClaims {
  iss?: string;
  sub?: string;
  exp?: number;
  aud?: string | string[];
  azp?: string;
  scope?: string;
}

interface JwksDocument {
  keys?: Array<Record<string, unknown> & { kid?: string; alg?: string; use?: string }>;
}

export interface JwtVerifierOptions {
  issuer: string;
  fetch?: typeof globalThis.fetch;
  jwksTtlMs?: number;
  isRegisteredClient?: (clientId: string) => boolean | Promise<boolean>;
  now?: () => number;
}

function decodeJson<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function includesAccount(aud: JwtClaims["aud"]): boolean {
  return typeof aud === "string" ? aud === "account" : Array.isArray(aud) && aud.includes("account");
}

export function createAccessTokenVerifier(options: JwtVerifierOptions) {
  const issuer = options.issuer.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const ttl = options.jwksTtlMs ?? 10 * 60_000;
  const now = options.now ?? Date.now;
  let cached: { expires: number; document: JwksDocument } | undefined;

  async function getJwks(): Promise<JwksDocument> {
    if (cached && cached.expires > now()) return cached.document;
    const response = await fetchImpl(`${issuer}/protocol/openid-connect/certs`);
    if (!response.ok) throw new Error(`JWKS request failed: ${response.status}`);
    const document = await response.json() as JwksDocument;
    if (!Array.isArray(document.keys)) throw new Error("JWKS response has no keys");
    cached = { expires: now() + ttl, document };
    return document;
  }

  return async function verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Malformed JWT");
    const header = decodeJson<JwtHeader>(parts[0]);
    const claims = decodeJson<JwtClaims>(parts[1]);
    if (header.alg !== "RS256" || !header.kid) throw new Error("Unsupported JWT algorithm");

    const jwks = await getJwks();
    const jwk = jwks.keys?.find((key) => key.kid === header.kid && (!key.alg || key.alg === "RS256"));
    if (!jwk) throw new Error("JWT signing key not found");
    const publicKey = createPublicKey({ key: jwk as never, format: "jwk" });
    const valid = verifySignature(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      Buffer.from(parts[2], "base64url"),
    );
    if (!valid) throw new Error("Invalid JWT signature");

    const currentSeconds = Math.floor(now() / 1000);
    if (claims.iss !== issuer) throw new Error("Invalid token issuer");
    if (!claims.exp || claims.exp <= currentSeconds) throw new Error("Expired access token");
    if (!claims.sub || !claims.azp) throw new Error("Missing token subject or authorized party");
    const registered = options.isRegisteredClient
      ? await options.isRegisteredClient(claims.azp)
      : false;
    if (!includesAccount(claims.aud) && !registered) throw new Error("Invalid token audience");

    return {
      token,
      clientId: claims.azp,
      scopes: claims.scope?.split(/\s+/).filter(Boolean) ?? [],
      expiresAt: claims.exp,
      extra: { sub: claims.sub },
    };
  };
}
