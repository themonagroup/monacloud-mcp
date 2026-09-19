import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { Duplex } from "node:stream";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createRemoteServer } from "../dist/remote.js";

const PUBLIC_URL = "https://mcp.monacloud.vn";
const ISSUER = "https://pass.monacloud.vn/realms/mona";
let remote;
const upstreamRequests = [];

async function appFetch(input, init = {}) {
  const request = input instanceof Request ? input : new Request(String(input), init);
  const url = new URL(request.url);
  const body = request.body ? Buffer.from(await request.arrayBuffer()) : Buffer.alloc(0);
  const socket = new Duplex({ read() {}, write(_chunk, _encoding, callback) { callback(); } });
  const req = new IncomingMessage(socket);
  req.method = request.method;
  req.url = `${url.pathname}${url.search}`;
  req.headers = Object.fromEntries(request.headers);
  req.headers.host = url.host;
  req.rawHeaders = Object.entries(req.headers).flatMap(([name, value]) => [name, value]);
  if (body.length && !req.headers["content-length"]) req.headers["content-length"] = String(body.length);
  if (body.length && req.headers["content-type"]?.includes("application/json")) {
    req.body = JSON.parse(body.toString("utf8"));
  }
  req.push(body.length ? body : null);
  if (body.length) req.push(null);

  const res = new ServerResponse(req);
  const chunks = [];
  return await new Promise((resolve, reject) => {
    res.write = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
      if (typeof encoding === "function") encoding();
      else if (callback) callback();
      return true;
    };
    res.end = (chunk, encoding, callback) => {
      if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof encoding === "string" ? encoding : undefined));
      if (typeof encoding === "function") encoding();
      else if (callback) callback();
      res.emit("finish");
      const responseBody = Buffer.concat(chunks);
      resolve(new Response(responseBody, {
        status: res.statusCode,
        statusText: res.statusCode >= 400 ? responseBody.toString("utf8").slice(0, 200) : undefined,
        headers: Object.entries(res.getHeaders()).map(([name, value]) => [name, Array.isArray(value) ? value.join(", ") : String(value)]),
      }));
      return res;
    };
    remote.app(req, res, reject);
  });
}

function mockFetch(input, init = {}) {
  const url = String(input);
  if (url.endsWith("/.well-known/openid-configuration")) {
    return Promise.resolve(new Response(JSON.stringify({
      authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
      token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
      revocation_endpoint: `${ISSUER}/protocol/openid-connect/revoke`,
    }), { status: 200, headers: { "content-type": "application/json" } }));
  }
  if (url.endsWith("/clients-registrations/openid-connect")) {
    upstreamRequests.push({ url, init });
    const request = JSON.parse(init.body);
    return Promise.resolve(new Response(JSON.stringify({
      ...request,
      client_id: "registered-client",
      client_id_issued_at: 1_700_000_000,
    }), { status: 201, headers: { "content-type": "application/json" } }));
  }
  throw new Error(`Unexpected network request: ${url}`);
}

before(async () => {
  remote = await createRemoteServer({
    publicUrl: PUBLIC_URL,
    issuer: ISSUER,
    initialAccessToken: "initial-secret",
    fetch: mockFetch,
    verifyAccessToken: async (token) => {
      if (token !== "valid-token") throw new Error("invalid token");
      return {
        token,
        clientId: "test-client",
        scopes: ["vibecloud-api"],
        expiresAt: Math.floor(Date.now() / 1000) + 3600,
        extra: { sub: "test-subject" },
      };
    },
  });
});

after(async () => {
  await remote.close();
});

test("protected-resource metadata has the required shape", async () => {
  const response = await appFetch(`${PUBLIC_URL}/.well-known/oauth-protected-resource`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    resource: `${PUBLIC_URL}/mcp`,
    authorization_servers: [PUBLIC_URL],
    bearer_methods_supported: ["header"],
    scopes_supported: ["openid", "profile", "email", "offline_access", "vibecloud-api", "billing-api"],
  });
});

test("MCP without a bearer token returns an OAuth challenge", async () => {
  const response = await appFetch(`${PUBLIC_URL}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("www-authenticate"), `Bearer resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`);
});

test("MCP rejects an invalid bearer token", async () => {
  const response = await appFetch(`${PUBLIC_URL}/mcp`, { method: "POST", headers: { authorization: "Bearer fake-token", "content-type": "application/json" }, body: "{}" });
  assert.equal(response.status, 401);
});

test("Streamable HTTP initializes and lists at least 100 tools", async () => {
  const client = new Client({ name: "remote-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${PUBLIC_URL}/mcp`), {
    requestInit: { headers: { authorization: "Bearer valid-token" } },
    fetch: appFetch,
  });
  await client.connect(transport);
  const result = await client.listTools();
  assert.ok(result.tools.length >= 100, `expected at least 100 tools, got ${result.tools.length}`);
  await client.close();
});

test("dynamic registration adds the Keycloak initial access token", async () => {
  const redirectUris = ["https://client.example/callback"];
  const response = await appFetch(`${PUBLIC_URL}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: redirectUris, client_name: "Test client" }),
  });
  assert.equal(response.status, 201);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].init.headers.authorization, "Bearer initial-secret");
  const forwarded = JSON.parse(upstreamRequests[0].init.body);
  assert.deepEqual(forwarded.redirect_uris, redirectUris);
  assert.deepEqual(forwarded.grant_types, ["authorization_code", "refresh_token"]);
  assert.equal(forwarded.token_endpoint_auth_method, "none");
  assert.equal(forwarded.scope, "profile email roles basic offline_access vibecloud-api billing-api");
});
