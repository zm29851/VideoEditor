import type { MediaClip } from "../src/schema.ts";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMcpHttpServer, type McpHttpServer } from "../src/mcp/http.ts";
import { Workspace } from "../src/mcp/workspace.ts";
import { judderWarning } from "../src/media/import.ts";
import { peaksPerFrame } from "../src/media/peaks.ts";
import type { MediaInfo } from "../src/media/probe.ts";
import type { Project } from "../src/schema.ts";
import { clipAt, frameAtTime, seekTimeForFrame } from "../web/src/editor/timelineOps.ts";
import { makeSource, readBarcodes, type DecodedFrame } from "./helpers.ts";

const TOKEN = "test-token";
const FPS = { num: 30, den: 1 };

let base: string;
let source: string;
let otherSource: string;
let http: McpHttpServer;
let origin: string;

interface Options {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  auth?: boolean;
}

function api(path: string, { method, body, headers, auth = true }: Options = {}): Promise<Response> {
  return fetch(`${origin}/api${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    headers: {
      ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function ok<T = any>(path: string, options?: Options): Promise<T> {
  const response = await api(path, options);
  const data = (await response.json()) as T & { error?: string };
  expect(data.error, path).toBeUndefined();
  expect(response.ok).toBe(true);
  return data;
}

async function finished(projectId: string, jobId: string): Promise<any> {
  for (let attempt = 0; attempt < 600; attempt++) {
    const { jobs } = await ok(`/projects/${projectId}/status`);
    const job = jobs.find((candidate: { id: string }) => candidate.id === jobId);
    if (job.status === "failed") throw new Error(job.error);
    if (job.status === "succeeded") return job;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Job chạy quá lâu.");
}

async function setup(id: string): Promise<{ project: Project; assetId: string }> {
  await ok("/projects", { body: { id, name: `Tên ${id}`, width: 320, height: 180 } });
  const job = await ok(`/projects/${id}/import`, { body: { path: source } });
  const done = await finished(id, job.id);
  const { project } = await ok(`/projects/${id}`);
  return { project, assetId: done.result.asset.id };
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "ve-api-"));
  const media = join(base, "media");
  mkdirSync(join(media, "con"), { recursive: true });
  source = join(media, "source.mp4");
  otherSource = join(media, "con", "other.mp4");
  await makeSource(source, { sourceId: 1, fpsFilter: "30", seconds: 4 });
  await makeSource(otherSource, { sourceId: 2, fpsFilter: "30", seconds: 2 });
  writeFileSync(join(media, "ghi-chu.txt"), "không phải video");
  writeFileSync(join(media, ".an.mp4"), "");

  const web = join(base, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "index.html"), "<!doctype html><title>UI</title>");
  writeFileSync(join(base, "bi-mat.txt"), "bí mật");

  const workspace = new Workspace(join(base, "projects"), [media]);
  http = await startMcpHttpServer(workspace, TOKEN, 0, { webRoot: web });
  origin = new URL(http.url).origin;
}, 60_000);

afterAll(async () => {
  await http.close();
  rmSync(base, { recursive: true, force: true });
});

describe("access", () => {
  it("rejects a request without the token", async () => {
    const response = await api("/projects", { auth: false });
    expect(response.status).toBe(401);
    expect(((await response.json()) as { code: string }).code).toBe("unauthorized");
  });

  it("the link with the token signs the browser in, and hides the token", async () => {
    const wrong = await fetch(`${origin}/?token=sai`, { redirect: "manual" });
    expect(wrong.headers.get("set-cookie")).toBeNull();

    const login = await fetch(`${origin}/?token=${TOKEN}`, { redirect: "manual" });
    expect(login.status).toBe(303);
    expect(login.headers.get("location")).toBe("/");
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const response = await api("/projects", { auth: false, headers: { cookie: cookie.split(";")[0]! } });
    expect(response.status).toBe(200);
  });

  it("the MCP endpoint does not accept the browser cookie", async () => {
    const response = await fetch(http.url, {
      method: "POST",
      headers: { cookie: `ve_token=${TOKEN}`, "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(401);
  });

  it("rejects another site, even with the token", async () => {
    const response = await api("/projects", { headers: { origin: "http://evil.example" } });
    expect(response.status).toBe(403);
  });

  it("serves the web app without a token, but nothing outside its folder", async () => {
    const page = await fetch(`${origin}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    // Encoded dots, because fetch would clean a plain ".." before sending it.
    for (const path of ["/%2e%2e/bi-mat.txt", "/..%2Fbi-mat.txt"]) {
      expect((await fetch(`${origin}${path}`)).status).toBe(404);
    }
  });
});

describe("media folders", () => {
  it("lists folders and videos only", async () => {
    const top = await ok("/media");
    expect(top.entries).toHaveLength(1);
    const listing = await ok(`/media?path=${encodeURIComponent(top.entries[0].path)}`);
    expect(listing.entries.map((entry: { name: string }) => entry.name)).toEqual(["con", "source.mp4"]);
    expect(listing.parent).toBeUndefined();
    const child = await ok(`/media?path=${encodeURIComponent(listing.entries[0].path)}`);
    expect(child.parent).toBe(top.entries[0].path);
  });

  it("does not list anything outside the allowed folders", async () => {
    const response = await api(`/media?path=${encodeURIComponent(base)}`);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toContain("nằm ngoài");
  });
});

describe("with the whole machine allowed", () => {
  const everywhere = () => new Workspace(join(base, "projects"), ["/"]);

  it("opens a video from any folder, but still only videos", () => {
    const workspace = everywhere();
    expect(workspace.resolveMediaPath(source)).toContain("source.mp4");
    expect(() => workspace.resolveMediaPath(join(base, "bi-mat.txt"))).toThrow("không phải file video");
  });

  it("starts from the usual places and can walk up to the disk root", () => {
    const workspace = everywhere();
    const names = workspace.browseMedia().entries.map((entry) => entry.name);
    expect(names).toContain("Toàn bộ máy");
    expect(names.length).toBeGreaterThan(1);
    expect(workspace.browseMedia("/").parent).toBeUndefined();
    expect(workspace.browseMedia(join(base, "media")).parent).toBeDefined();
  });
});

describe("editing through REST", () => {
  let project: Project;
  let assetId: string;
  const ID = "edit";

  beforeAll(async () => {
    ({ project, assetId } = await setup(ID));
  }, 60_000);

  it("keeps the display name and lists the project", async () => {
    expect(project.name).toBe("Tên edit");
    const list = await ok("/projects");
    expect(list.find((item: { id: string }) => item.id === ID).assetCount).toBe(1);
  });

  it("refuses a project id that is already used, or unsafe", async () => {
    const duplicate = await api("/projects", { body: { id: ID, name: "x", width: 320, height: 180 } });
    expect(duplicate.status).toBe(409);
    const unsafe = await api("/projects", { body: { id: "../x", name: "x", width: 320, height: 180 } });
    expect(unsafe.status).toBe(400);
  });

  it("records the edit as made by the user, and undo and redo work", async () => {
    const added = await ok(`/projects/${ID}/batch`, {
      body: {
        baseRevision: project.revision,
        label: "Thêm clip",
        commands: [{ type: "add_clip", trackId: "video_1", assetId, start: 0, duration: 60 }],
      },
    });
    expect(added.createdClipIds).toHaveLength(1);
    expect(added.undoLabel).toBe("Thêm clip");

    const undone = await ok(`/projects/${ID}/undo`, { body: { baseRevision: added.project.revision } });
    expect(undone.project.timeline.tracks[0].clips).toEqual([]);
    expect(undone.undoLabel).toBeUndefined();
    expect(undone.redoLabel).toBe("Thêm clip");

    const redone = await ok(`/projects/${ID}/redo`, { body: { baseRevision: undone.project.revision } });
    expect(redone.project.timeline.tracks[0].clips).toHaveLength(1);
    project = redone.project;
  });

  it("answers 409 for an old revision and leaves the timeline alone", async () => {
    const response = await api(`/projects/${ID}/batch`, {
      body: { baseRevision: 0, label: "Cũ", commands: [{ type: "delete_clip", clipId: "clip_1" }] },
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as { code: string }).code).toBe("stale_revision");
    const { project: after } = await ok(`/projects/${ID}`);
    expect(after.revision).toBe(project.revision);
  });

  it("answers 422 with a readable reason for an impossible edit", async () => {
    const response = await api(`/projects/${ID}/batch`, {
      body: {
        baseRevision: project.revision,
        label: "Chồng",
        commands: [{ type: "add_clip", trackId: "video_1", assetId, start: 10, duration: 10 }],
      },
    });
    expect(response.status).toBe(422);
    expect(((await response.json()) as { error: string }).error).toContain("chồng lên");
  });

  it("answers 400 for a command that does not fit the schema", async () => {
    const response = await api(`/projects/${ID}/batch`, {
      body: { baseRevision: project.revision, label: "Sai", commands: [{ type: "khong_co" }] },
    });
    expect(response.status).toBe(400);
  });

  it("the proxy supports the range requests a video element makes", async () => {
    const response = await api(`/projects/${ID}/assets/${assetId}/proxy`, { headers: { range: "bytes=10-19" } });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toMatch(/^bytes 10-19\/\d+$/);
    expect((await response.arrayBuffer()).byteLength).toBe(10);

    const suffix = await api(`/projects/${ID}/assets/${assetId}/proxy`, { headers: { range: "bytes=-5" } });
    expect(suffix.status).toBe(206);
    expect((await suffix.arrayBuffer()).byteLength).toBe(5);

    const beyond = await api(`/projects/${ID}/assets/${assetId}/proxy`, { headers: { range: "bytes=999999999-" } });
    expect(beyond.status).toBe(416);
  });

  it("gives a thumbnail, and refuses a frame the video does not have", async () => {
    const image = await api(`/projects/${ID}/assets/${assetId}/thumbnail?frame=10`);
    expect(image.headers.get("content-type")).toBe("image/jpeg");
    expect((await image.arrayBuffer()).byteLength).toBeGreaterThan(100);
    expect((await api(`/projects/${ID}/assets/${assetId}/thumbnail?frame=99999`)).status).toBe(400);
  });

  it("gives one loudness value per frame, with the beep at the start of each second", async () => {
    const peaks = await ok<number[]>(`/projects/${ID}/assets/${assetId}/peaks`);
    expect(peaks).toHaveLength(120);
    expect(peaks[1]).toBeGreaterThan(0.2);
    expect(peaks[15]).toBeLessThan(0.05);
    expect(peaks[31]).toBeGreaterThan(0.2);
  });

  it("answers 404 for an unknown project or video", async () => {
    expect((await api("/projects/khong-co")).status).toBe(404);
    expect((await api(`/projects/${ID}/assets/khong-co/proxy`)).status).toBe(404);
  });

  it("refuses to export under a name that leaves the project folder", async () => {
    const response = await api(`/projects/${ID}/export`, { body: { name: "../ngoai" } });
    expect(response.status).toBe(400);
    expect((await api(`/projects/${ID}/exports/..%2Fproject.json`)).status).toBe(404);
  });
});

describe("preview matches export", () => {
  it("every timeline frame the preview shows is the frame the export contains", async () => {
    const id = "match";
    const { assetId } = await setup(id);
    const second = await ok(`/projects/${id}/import`, { body: { path: otherSource } });
    const secondAssetId = (await finished(id, second.id)).result.asset.id;
    const { project: current } = await ok<{ project: Project }>(`/projects/${id}`);

    await ok(`/projects/${id}/batch`, {
      body: {
        baseRevision: current.revision,
        label: "Dựng",
        commands: [
          { type: "add_clip", trackId: "video_1", assetId, start: 0, sourceIn: 11, duration: 20 },
          { type: "add_clip", trackId: "video_1", assetId: secondAssetId, start: 20, sourceIn: 7, duration: 15 },
          { type: "add_clip", trackId: "video_1", assetId, start: 35, sourceIn: 60, duration: 25 },
        ],
      },
    });
    const { project: edited } = await ok<{ project: Project }>(`/projects/${id}`);

    const job = await ok(`/projects/${id}/export`, { body: { name: "Bản xuất thử" } });
    const done = await finished(id, job.id);
    expect(done.label).toBe("Bản xuất thử.mp4");

    const download = await api(`/projects/${id}/exports/${encodeURIComponent(done.label)}`);
    expect(download.headers.get("content-disposition")).toContain("attachment");
    await download.arrayBuffer();

    const exported = await readBarcodes(done.result.path);
    expect(exported).toHaveLength(60);

    // A video element shows the frame containing the seek time, so the proxy is read by that same mapping.
    const clips = edited.timeline.tracks[0]!.clips;
    const proxies = new Map<string, DecodedFrame[]>();
    for (const asset of edited.assets) proxies.set(asset.id, await readBarcodes(asset.proxyPath));
    for (let frame = 0; frame < 60; frame++) {
      const clip = clipAt(clips, frame)!;
      const seconds = seekTimeForFrame((clip as MediaClip).sourceIn + frame - clip.start, edited.fps);
      const shown = proxies.get((clip as MediaClip).assetId)![frameAtTime(seconds, edited.fps)];
      expect(shown, `frame ${frame}`).toEqual(exported[frame]);
    }
  }, 120_000);

  it("the file exists only inside the project folder", () => {
    expect(existsSync(join(base, "Bản xuất thử.mp4"))).toBe(false);
  });
});

describe("helpers", () => {
  const info = (averageFps: number, maxFrameJitter = 0) => ({ averageFps, maxFrameJitter }) as MediaInfo;

  it("warns about frame rates that cannot map evenly onto the project", () => {
    expect(judderWarning(info(25), FPS)).toContain("giật");
    expect(judderWarning(info(24), FPS)).toContain("giật");
    expect(judderWarning(info(30, 1.2), FPS)).toContain("không đều");
  });

  it("stays quiet when frames map evenly", () => {
    expect(judderWarning(info(60), FPS)).toBeUndefined();
    expect(judderWarning(info(29.97), FPS)).toBeUndefined();
    expect(judderWarning(info(30), FPS)).toBeUndefined();
  });

  it("takes the loudest sample of each frame", () => {
    const pcm = new Float32Array(8000 / 15);
    pcm[10] = -0.5;
    pcm[300] = 0.25;
    expect(peaksPerFrame(pcm, 2, FPS)).toEqual([0.5, 0.25]);
  });
});

describe("Phase 5 routes", () => {
  it("creates a project at a chosen fps and refuses one out of range", async () => {
    const created = await ok("/projects", { body: { id: "rate", name: "Rate", width: 320, height: 180, fps: { num: 25, den: 1 } } });
    expect(created.project.fps).toEqual({ num: 25, den: 1 });
    const bad = await api("/projects", { body: { id: "rate2", name: "Rate", width: 320, height: 180, fps: { num: 500, den: 1 } } });
    expect(bad.status).toBe(400);
  });

  it("serves the picture of a text clip, and 404 for anything else", async () => {
    const { project } = await ok("/projects", { body: { id: "words", name: "Words", width: 320, height: 180 } });
    const state = await ok("/projects/words/batch", {
      body: {
        baseRevision: project.revision,
        label: "Chữ",
        commands: [
          { type: "add_track", kind: "text", id: "t" },
          { type: "add_text", trackId: "t", start: 0, duration: 30, text: "Xin chào" },
        ],
      },
    });
    const image = await api(`/projects/words/clips/${state.createdClipIds[0]}/text-image`);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect((await api("/projects/words/clips/nope/text-image")).status).toBe(404);
  });

  it("refuses to cancel or dismiss a job of another project", async () => {
    await ok("/projects", { body: { id: "jobs", name: "Jobs", width: 320, height: 180 } });
    expect((await api("/projects/jobs/jobs/job_nope/cancel", { body: {} })).status).toBe(404);
  });
});
