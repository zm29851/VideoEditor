import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { startMcpHttpServer, type McpHttpServer } from "../src/mcp/http.ts";
import { Workspace } from "../src/mcp/workspace.ts";
import type { Asset } from "../src/schema.ts";

const TOKEN = "test-token";
const AUTH = { authorization: `Bearer ${TOKEN}` };

const asset: Asset = {
  id: "a1",
  name: "a.mp4",
  originalPath: "/a.mp4",
  masterPath: "/a.mp4",
  proxyPath: "/p.mp4",
  durationFrames: 3000,
  width: 320,
  height: 180,
  hasVideo: true,
  hasAudio: false,
  normalization: { transcoded: false, reasons: [], sourceFps: 30, wasHdr: false },
};

let base: string;
let workspace: Workspace;
let http: McpHttpServer;
let origin: string;
let wsOrigin: string;
let client: Client;

/** Collects what the server pushes, and lets a test wait for the message it expects. */
class Listener {
  socket: WebSocket;
  messages: any[] = [];
  #waiting: Array<() => void> = [];

  constructor(projectId: string, headers: Record<string, string> = AUTH) {
    this.socket = new WebSocket(`${wsOrigin}/api/projects/${projectId}/events`, { headers });
    this.socket.on("message", (data) => {
      this.messages.push(JSON.parse(String(data)));
      for (const wake of this.#waiting.splice(0)) wake();
    });
  }

  async next(match: (message: any) => boolean): Promise<any> {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      const found = this.messages.find(match);
      if (found) return found;
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
        setTimeout(resolve, 100);
      });
    }
    throw new Error(`Không nhận được tin nhắn mong đợi. Đã nhận: ${JSON.stringify(this.messages.map((m) => m.type))}`);
  }
}

function refusal(path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`${wsOrigin}${path}`, { headers });
    socket.on("unexpected-response", (_req, res) => resolve(res.statusCode!));
    socket.on("open", () => reject(new Error("Kết nối đáng lẽ bị từ chối.")));
    socket.on("error", () => {});
  });
}

function setupProject(id: string) {
  const engine = workspace.create(id, { width: 320, height: 180 });
  engine.registerAsset(asset);
  return engine;
}

async function agentCall(name: string, args: Record<string, unknown>): Promise<any> {
  const result = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }>; isError?: boolean };
  if (result.isError) throw new Error(result.content[0]!.text);
  return JSON.parse(result.content[0]!.text);
}

async function rest(path: string, body?: unknown): Promise<Response> {
  return fetch(`${origin}/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { ...AUTH, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const addClip = (start: number, duration = 100) => ({ type: "add_clip", trackId: "video_1", assetId: "a1", start, duration });

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "ve-events-"));
  workspace = new Workspace(join(base, "projects"), [base]);
  http = await startMcpHttpServer(workspace, TOKEN, 0);
  origin = new URL(http.url).origin;
  wsOrigin = origin.replace("http", "ws");
  setupProject("access");
  client = new Client({ name: "agent-thu", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } } }));
});

afterAll(async () => {
  await client.close();
  await http.close();
  rmSync(base, { recursive: true, force: true });
});

describe("who may listen", () => {
  it("needs the token, by header or by cookie", async () => {
    const path = "/api/projects/access/events";
    expect(await refusal(path, {})).toBe(401);
    expect(await refusal(path, { authorization: "Bearer sai" })).toBe(401);
    expect(await refusal(path, { cookie: "ve_token=sai" })).toBe(401);
    const byCookie = new Listener("access", { cookie: `ve_token=${TOKEN}` });
    expect((await byCookie.next((m) => m.type === "snapshot")).state.project.name).toBe("access");
    byCookie.socket.terminate();
  });

  it("refuses a page from another site, even with the browser's cookie", async () => {
    expect(await refusal("/api/projects/access/events", { cookie: `ve_token=${TOKEN}`, origin: "https://ke-xau.example" })).toBe(403);
    expect(await refusal("/api/projects/access/events", { ...AUTH, host: "ke-xau.example" })).toBe(403);
  });

  it("refuses an unknown project or path", async () => {
    expect(await refusal("/api/projects/khong-co/events", AUTH)).toBe(404);
    expect(await refusal("/api/projects/..%2F..%2Fetc/events", AUTH)).toBe(404);
    expect(await refusal("/mcp", AUTH)).toBe(404);
  });
});

describe("live changes", () => {
  it("the first message holds everything, so a reconnect catches up", async () => {
    const engine = setupProject("snapshot");
    engine.applyBatch({ actor: "agent", baseRevision: engine.project.revision, label: "trước khi mở", commands: [addClip(0) as never] });
    const listener = new Listener("snapshot");
    const { state, jobs, agent } = await listener.next((m) => m.type === "snapshot");
    expect(state.project.revision).toBe(engine.project.revision);
    expect(state.activity[0]).toMatchObject({ actor: "agent", label: "trước khi mở" });
    expect(jobs).toEqual([]);
    expect(agent.state).toBeDefined();
    listener.socket.terminate();
  });

  it("an edit through MCP reaches the editor at once, marked as the agent's", async () => {
    const engine = setupProject("agent-edit");
    const listener = new Listener("agent-edit");
    await listener.next((m) => m.type === "snapshot");

    const result = await agentCall("add_clip", {
      projectId: "agent-edit",
      baseRevision: engine.project.revision,
      assetId: "a1",
      start: { frame: 10 },
      duration: { frame: 50 },
    });
    const { state } = await listener.next((m) => m.type === "state");
    expect(state.project.revision).toBe(result.revision);
    expect(state.activity[0]).toMatchObject({ actor: "agent", state: "active", revertible: true });
    expect(state.activity[0].changes.added).toEqual(result.createdClipIds);
    listener.socket.terminate();
  });

  it("only hears about its own project", async () => {
    setupProject("mine");
    const other = setupProject("other");
    const listener = new Listener("mine");
    await listener.next((m) => m.type === "snapshot");

    other.applyBatch({ actor: "user", baseRevision: other.project.revision, label: "t", commands: [addClip(0) as never] });
    workspace.jobs.enqueue("import", "other", async () => {}, "x");
    const job = workspace.jobs.enqueue("import", "mine", async ({ setProgress, setStage }) => {
      setStage("Tạo proxy");
      setProgress(40);
      setProgress(40.2);
      return "xong";
    }, "video.mp4");

    const finished = await listener.next((m) => m.type === "job" && m.job.id === job.id && m.job.status === "succeeded");
    expect(finished.job.result).toBe("xong");
    const seen = listener.messages.filter((m) => m.type === "job");
    expect(seen.every((m) => m.job.projectId === "mine")).toBe(true);
    expect(seen.filter((m) => m.job.progress === 40)).toHaveLength(1);
    expect(listener.messages.some((m) => m.type === "state")).toBe(false);
    listener.socket.terminate();
  });

  it("stops listening when the socket closes", async () => {
    const engine = setupProject("leak");
    const listener = new Listener("leak");
    await listener.next((m) => m.type === "snapshot");
    await new Promise<void>((resolve) => {
      listener.socket.once("close", () => resolve());
      listener.socket.close();
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const count = listener.messages.length;
    engine.applyBatch({ actor: "user", baseRevision: engine.project.revision, label: "t", commands: [addClip(0) as never] });
    expect(listener.messages).toHaveLength(count);
  });
});

describe("person and agent on one project", () => {
  it("a stale edit is refused, and after reading again both edits are kept", async () => {
    const engine = setupProject("both");
    const start = engine.project.revision;
    const person = await rest("/projects/both/batch", { baseRevision: start, label: "người thêm", commands: [addClip(0)] });
    expect(person.status).toBe(200);

    await expect(
      agentCall("add_clip", { projectId: "both", baseRevision: start, assetId: "a1", start: { frame: 500 }, duration: { frame: 100 } }),
    ).rejects.toThrow(/StaleRevisionError/);

    const timeline = await agentCall("get_timeline", { projectId: "both" });
    await agentCall("add_clip", { projectId: "both", baseRevision: timeline.revision, assetId: "a1", start: { frame: 500 }, duration: { frame: 100 } });

    const stale = await rest("/projects/both/batch", { baseRevision: timeline.revision, label: "người đẩy", commands: [addClip(900)] });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { code: string }).code).toBe("stale_revision");

    const latest = engine.project.revision;
    expect((await rest("/projects/both/batch", { baseRevision: latest, label: "người đẩy", commands: [addClip(900)] })).status).toBe(200);
    expect(engine.project.timeline.tracks[0]!.clips.map((clip) => clip.start)).toEqual([0, 500, 900]);
    expect(engine.activity().map((entry) => entry.actor)).toEqual(["user", "agent", "user"]);
  });

  it("the person takes back one agent batch and keeps their own later edit", async () => {
    const engine = setupProject("revert");
    const listener = new Listener("revert");
    await listener.next((m) => m.type === "snapshot");
    const added = await agentCall("add_clip", { projectId: "revert", baseRevision: engine.project.revision, assetId: "a1", start: { frame: 0 }, duration: { frame: 100 } });
    await rest("/projects/revert/batch", { baseRevision: added.revision, label: "người thêm", commands: [addClip(300)] });

    const response = await rest("/projects/revert/revert", { baseRevision: engine.project.revision, revision: added.revision });
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.activity[0]).toMatchObject({ actor: "user", revertsRevision: added.revision });
    expect(body.project.timeline.tracks[0].clips.map((clip: { start: number }) => clip.start)).toEqual([300]);
    await listener.next((m) => m.type === "state" && m.state.project.revision === body.project.revision);

    const again = await rest("/projects/revert/revert", { baseRevision: engine.project.revision, revision: added.revision });
    expect(again.status).toBe(422);
    expect(((await again.json()) as { error: string }).error).toContain("đã được hoàn tác");

    const history = await agentCall("get_history", { projectId: "revert", limit: 1 });
    expect(history[0].revertsRevision).toBe(added.revision);
    listener.socket.terminate();
  });
});

describe("agent status", () => {
  it("shows the agent's name and that it is working", async () => {
    await agentCall("list_projects", {});
    const status = workspace.agent.status;
    expect(status.state).toBe("working");
    expect(status.clientName).toBe("agent-thu");
    expect(status.lastSeenAt).toBeDefined();
  });

  it("a request without the token does not count", async () => {
    const before = workspace.agent.status.lastSeenAt;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await fetch(http.url, { method: "POST", body: "{}" });
    expect(workspace.agent.status.lastSeenAt).toBe(before);
  });
});
