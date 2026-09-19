#!/usr/bin/env node
import { createServer as createHttpServer } from "node:http";
import { createRemoteServer } from "./remote.js";

const bind = process.env.MCP_REMOTE_BIND ?? "127.0.0.1";
const port = Number.parseInt(process.env.MCP_REMOTE_PORT ?? "8765", 10);
const publicUrl = process.env.MCP_REMOTE_PUBLIC_URL ?? "https://mcp.monacloud.vn";
const issuer = process.env.MONACLOUD_ISSUER ?? "https://pass.monacloud.vn/realms/mona";
const initialAccessToken = process.env.MONA_PASS_INITIAL_ACCESS_TOKEN;

if (!initialAccessToken) throw new Error("MONA_PASS_INITIAL_ACCESS_TOKEN is required");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("MCP_REMOTE_PORT is invalid");

const dataDir = process.env.MCP_REMOTE_DATA_DIR ?? "./data";
const remote = await createRemoteServer({ publicUrl, issuer, initialAccessToken, dataDir });
const httpServer = createHttpServer(remote.app);
httpServer.listen(port, bind, () => {
  console.log(JSON.stringify({ event: "listening", bind, port }));
});

let stopping = false;
async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await remote.close();
  await new Promise<void>((resolve, reject) => {
    httpServer.close((error) => error ? reject(error) : resolve());
  });
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
