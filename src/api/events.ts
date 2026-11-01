import type { IncomingMessage, Server } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import type { Workspace } from "../mcp/workspace.ts";
import { projectState } from "./routes.ts";

const PATH = /^\/api\/projects\/([^/]+)\/events$/;
const PING_MS = 30_000;

export interface AccessDenied {
  status: number;
  message: string;
}

function refuse(socket: Socket, { status, message }: AccessDenied): void {
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} Refused\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

/**
 * Pushes every change of one project to the editor: edits by anyone, job progress and the agent's status.
 * The first message holds the whole state, so a reconnect also catches up on anything it missed.
 */
function watch(workspace: Workspace, projectId: string, socket: WebSocket): void {
  const engine = workspace.engine(projectId);
  const send = (message: object) => {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const stops = [
    engine.subscribe(() => send({ type: "state", state: projectState(engine) })),
    workspace.jobs.subscribe((job) => {
      if (job.projectId === projectId) send({ type: "job", job });
    }),
    workspace.agent.subscribe((agent) => send({ type: "agent", agent })),
  ];
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const ping = setInterval(() => {
    if (!alive) return socket.terminate();
    alive = false;
    socket.ping();
  }, PING_MS);
  ping.unref();
  socket.on("error", () => socket.terminate());
  socket.once("close", () => {
    clearInterval(ping);
    for (const stop of stops) stop();
  });

  send({ type: "snapshot", state: projectState(engine), jobs: workspace.jobs.listForProject(projectId), agent: workspace.agent.status });
}

export function attachEvents(
  server: Server,
  workspace: Workspace,
  authorize: (req: IncomingMessage) => AccessDenied | undefined,
): { close(): void } {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  server.on("upgrade", (req, socket: Socket, head) => {
    socket.on("error", () => socket.destroy());
    const denied = authorize(req);
    if (denied) return refuse(socket, denied);
    let id: string;
    try {
      const projectId = PATH.exec(new URL(req.url ?? "/", "http://localhost").pathname)?.[1];
      if (!projectId) return refuse(socket, { status: 404, message: "Không có đường dẫn này." });
      id = decodeURIComponent(projectId);
      workspace.engine(id);
    } catch (error) {
      return refuse(socket, { status: 404, message: error instanceof Error ? error.message : "Không có project này." });
    }
    sockets.handleUpgrade(req, socket, head, (client) => watch(workspace, id, client));
  });

  return {
    // An upgraded socket no longer counts as an HTTP connection, so closing the server would wait for it.
    close: () => {
      for (const client of sockets.clients) client.terminate();
      sockets.close();
    },
  };
}
