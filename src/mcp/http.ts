import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { handleApi } from "../api/routes.ts";
import { serveWebApp } from "../api/static.ts";
import { createMcpServer } from "./tools.ts";
import type { Workspace } from "./workspace.ts";

const HOST = "127.0.0.1";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const SESSION_COOKIE = "ve_token";

/** Reuses the token across restarts, so a configured client keeps working. */
export function loadOrCreateToken(workspaceRoot: string): string {
  const path = join(workspaceRoot, ".mcp-token");
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const token = randomBytes(32).toString("hex");
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}

function sameToken(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A video element cannot send an Authorization header, so the browser holds the token in a cookie.
 * SameSite=Strict and the Origin check keep other sites from using it.
 */
function cookieToken(req: IncomingMessage): string {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [name, value] = part.trim().split("=");
    if (name === SESSION_COOKIE && value) return value;
  }
  return "";
}

function reject(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }));
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Yêu cầu quá lớn."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        reject(new Error("Yêu cầu không phải JSON hợp lệ."));
      }
    });
  });
}

export interface McpHttpServer {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export interface ServerOptions {
  /** Folder of the built web app. Without it, only the APIs are served. */
  webRoot?: string;
}

export function startMcpHttpServer(
  workspace: Workspace,
  token: string,
  port: number,
  options: ServerOptions = {},
): Promise<McpHttpServer> {
  return new Promise((resolve, reject_) => {
    const server = createServer(async (req, res) => {
      const actualPort = (server.address() as AddressInfo).port;
      const allowedHosts = new Set([`127.0.0.1:${actualPort}`, `localhost:${actualPort}`]);

      // Host and Origin stop a web page from reaching this server through the browser.
      if (!allowedHosts.has(req.headers.host ?? "")) return reject(res, 403, "Host không được phép.");
      const origin = req.headers.origin;
      if (origin && !["http://", "https://"].some((scheme) => allowedHosts.has(origin.replace(scheme, "")))) {
        return reject(res, 403, "Origin không được phép.");
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const bearerOk = sameToken(req.headers.authorization ?? "", `Bearer ${token}`);

      if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
        if (!bearerOk && !sameToken(cookieToken(req), token)) {
          res.writeHead(401, { "content-type": "application/json" });
          res.end(JSON.stringify({ code: "unauthorized", error: "Thiếu hoặc sai token." }));
          return;
        }
        return handleApi(workspace, req, res, url, () => readBody(req));
      }

      if (url.pathname !== "/mcp" && options.webRoot && (req.method === "GET" || req.method === "HEAD")) {
        const given = url.searchParams.get("token");
        if (url.pathname === "/" && given !== null && sameToken(given, token)) {
          // Moves the token out of the address bar, and out of the browser history.
          res.writeHead(303, {
            location: "/",
            "set-cookie": `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
          });
          res.end();
          return;
        }
        return serveWebApp(req, res, options.webRoot, url.pathname);
      }

      if (!bearerOk) return reject(res, 401, "Thiếu hoặc sai token.");
      if (url.pathname !== "/mcp") return reject(res, 404, "Chỉ có đường dẫn /mcp.");
      if (req.method !== "POST") {
        res.setHeader("allow", "POST");
        return reject(res, 405, "Server này chỉ nhận POST.");
      }

      let body: unknown;
      try {
        body = await readBody(req);
      } catch (error) {
        return reject(res, 400, error instanceof Error ? error.message : "Yêu cầu không hợp lệ.");
      }

      // Stateless: each request gets its own protocol session; all state lives in the workspace.
      const mcp = createMcpServer(workspace);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      try {
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
      } catch (error) {
        if (!res.headersSent) reject(res, 500, error instanceof Error ? error.message : "Lỗi server.");
      }
    });

    server.on("error", reject_);
    server.listen(port, HOST, () => {
      const actualPort = (server.address() as AddressInfo).port;
      resolve({
        server,
        url: `http://${HOST}:${actualPort}/mcp`,
        close: () =>
          new Promise((done) => {
            server.closeAllConnections();
            server.close(() => done());
          }),
      });
    });
  });
}
