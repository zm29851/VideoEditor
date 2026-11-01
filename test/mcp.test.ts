import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMcpHttpServer, type McpHttpServer } from "../src/mcp/http.ts";
import { Workspace } from "../src/mcp/workspace.ts";
import { probeMedia } from "../src/media/probe.ts";
import { filmstripFrames } from "../src/media/frames.ts";
import { findBeepStarts, makeSource, readBarcodes, readPcm } from "./helpers.ts";

const TOKEN = "test-token";
const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } };

let base: string;
let media: string;
let source: string;
let http: McpHttpServer;
let client: Client;
let workspace: Workspace;

interface Content {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}
interface CallResult {
  content: Content[];
  isError?: boolean;
}

async function raw(name: string, args: Record<string, unknown>): Promise<CallResult> {
  return (await client.callTool({ name, arguments: args })) as CallResult;
}

async function call<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const result = await raw(name, args);
  if (result.isError) throw new Error(result.content[0]?.text);
  return JSON.parse(result.content[0]!.text!) as T;
}

async function finished(jobId: string): Promise<any> {
  const job = await call("get_job_status", { jobId, waitSeconds: 50 });
  expect(job.error).toBeUndefined();
  expect(job.status).toBe("succeeded");
  return job.result;
}

async function setupProject(projectId: string, size = { width: 320, height: 180 }): Promise<{ assetId: string; revision: number }> {
  await call("create_project", { projectId, ...size });
  const job = await call("import_asset", { projectId, path: source });
  const result = await finished(job.id);
  return { assetId: result.asset.id, revision: result.revision };
}

function post(body: unknown, headers: Record<string, string>): Promise<Response> {
  return fetch(http.url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  base = mkdtempSync(join(tmpdir(), "ve-mcp-"));
  media = join(base, "media");
  mkdirSync(media);
  source = join(media, "source.mp4");
  await makeSource(source, { sourceId: 3, fpsFilter: "30", seconds: 6 });

  workspace = new Workspace(join(base, "projects"), [media]);
  http = await startMcpHttpServer(workspace, TOKEN, 0);
  client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    }),
  );
}, 60_000);

afterAll(async () => {
  await client.close();
  await http.close();
  rmSync(base, { recursive: true, force: true });
});

describe("Phase 1 acceptance: an agent edits and exports through MCP only", () => {
  it("imports, looks, cuts, undoes, exports, and the file has exactly the planned frames", async () => {
    const { assetId, revision } = await setupProject("accept");

    const before = await call("get_timeline", { projectId: "accept" });
    expect(before.revision).toBe(revision);
    expect(before.assets[0].durationFrames).toBe(180);

    const added = await call("apply_batch", {
      projectId: "accept",
      baseRevision: revision,
      label: "Chọn 2 đoạn",
      commands: [
        { type: "add_clip", assetId, start: { frame: 0 }, sourceIn: { seconds: 1 }, duration: { seconds: 2 } },
        { type: "add_clip", assetId, start: { frame: 60 }, sourceIn: { frame: 120 }, duration: { frame: 30 } },
      ],
    });
    expect(added.durationFrames).toBe(90);

    const split = await call("split_clip", {
      projectId: "accept",
      baseRevision: added.revision,
      clipId: added.createdClipIds[0],
      at: { frame: 15 },
    });
    const removed = await call("delete_clip", {
      projectId: "accept",
      baseRevision: split.revision,
      clipId: split.createdClipIds[0],
      ripple: true,
    });
    expect(removed.durationFrames).toBe(45);

    const undone = await call("undo", { projectId: "accept", baseRevision: removed.revision });
    const redone = await call("redo", { projectId: "accept", baseRevision: undone.revision });

    const job = await call("export_video", { projectId: "accept", name: "kết quả" });
    const result = await finished(job.id);
    expect(result.revision).toBe(redone.revision);
    expect(result.path.endsWith("exports/kết quả.mp4")).toBe(true);

    const decoded = await readBarcodes(result.path);
    const expected = [
      ...Array.from({ length: 15 }, (_, index) => 30 + index),
      ...Array.from({ length: 30 }, (_, index) => 120 + index),
    ];
    expect(decoded.map((frame) => frame.frame)).toEqual(expected);

    const beeps = findBeepStarts(await readPcm(result.path));
    expect(Math.abs(beeps[0]!)).toBeLessThan(1 / 30);
    expect(Math.abs(beeps[1]! - 15 / 30)).toBeLessThan(1 / 30);

    const history = await call("get_history", { projectId: "accept" });
    expect(history[0].kind).toBe("redo");
    expect(history.every((entry: { actor: string }) => entry.actor === "agent")).toBe(true);
  }, 180_000);
});

describe("seeing", () => {
  it("get_frame returns the exact frame from an asset and from the timeline", async () => {
    const { assetId, revision } = await setupProject("frames");
    await call("add_clip", {
      projectId: "frames",
      baseRevision: revision,
      assetId,
      start: { frame: 10 },
      sourceIn: { frame: 77 },
      duration: { frame: 20 },
    });

    const decode = async (result: CallResult, name: string) => {
      const image = result.content.find((item) => item.type === "image")!;
      expect(image.mimeType).toBe("image/jpeg");
      const path = join(base, `${name}.jpg`);
      writeFileSync(path, Buffer.from(image.data!, "base64"));
      return (await readBarcodes(path))[0];
    };

    const fromAsset = await raw("get_frame", { projectId: "frames", assetId, at: { frame: 123 }, maxEdge: 320 });
    expect(await decode(fromAsset, "asset")).toEqual({ sourceId: 3, frame: 123 });

    const fromTimeline = await raw("get_frame", { projectId: "frames", at: { frame: 15 }, maxEdge: 320 });
    expect(await decode(fromTimeline, "timeline")).toEqual({ sourceId: 3, frame: 82 });

    const seconds = await raw("get_frame", { projectId: "frames", assetId, at: { seconds: 2.51 }, maxEdge: 320 });
    expect(JSON.parse(seconds.content[0]!.text!).frame).toBe(75);

    const gap = await raw("get_frame", { projectId: "frames", at: { frame: 5 }, maxEdge: 320 });
    expect(gap.isError).toBeFalsy();

    const past = await raw("get_frame", { projectId: "frames", at: { frame: 30 }, maxEdge: 320 });
    expect(past.isError).toBe(true);
    expect(past.content[0]!.text).toMatch(/30 frame/);
  }, 120_000);

  it("get_filmstrip returns one grid and names its tiles", async () => {
    const { assetId } = await setupProject("strip");
    const result = await raw("get_filmstrip", { projectId: "strip", assetId, start: { frame: 0 }, end: { frame: 180 }, count: 6 });
    const info = JSON.parse(result.content[0]!.text!);
    expect(info.tiles.map((tile: { frame: number }) => tile.frame)).toEqual([0, 30, 60, 90, 120, 150]);
    expect([info.columns, info.rows]).toEqual([4, 2]);
    const path = join(base, "strip.jpg");
    writeFileSync(path, Buffer.from(result.content[1]!.data!, "base64"));
    expect((await probeMedia2(path)).width).toBeGreaterThan(320 * 3);
  }, 120_000);

  it("filmstrip spacing handles short ranges", () => {
    expect(filmstripFrames(10, 12, 12)).toEqual([10, 11]);
    expect(filmstripFrames(0, 100, 4)).toEqual([0, 25, 50, 75]);
  });

  it("render_preview covers just the range, from proxies", async () => {
    const { assetId, revision } = await setupProject("preview", { width: 1920, height: 1080 });
    await call("add_clip", { projectId: "preview", baseRevision: revision, assetId, start: { frame: 0 }, sourceIn: { frame: 0 }, duration: { frame: 120 } });
    const job = await call("render_preview", { projectId: "preview", start: { frame: 30 }, end: { frame: 60 } });
    const result = await finished(job.id);
    const info = await probeMedia(result.path);
    expect([info.width, info.height, info.frameCount]).toEqual([640, 360, 30]);
    const frames = await readBarcodes(result.path);
    expect(frames[0]!.frame).toBe(30);
    expect(frames.at(-1)!.frame).toBe(59);
  }, 120_000);
});

async function probeMedia2(path: string): Promise<{ width: number }> {
  const { ffprobe } = await import("../src/media/ffmpeg.ts");
  const { stdout } = await ffprobe(["-show_entries", "stream=width", "-of", "csv=p=0", path]);
  return { width: Number.parseInt(stdout.toString(), 10) };
}

describe("errors an agent can act on", () => {
  it("rejects a stale revision and leaves the timeline alone", async () => {
    const { assetId, revision } = await setupProject("stale");
    const add = { projectId: "stale", assetId, start: { frame: 0 }, duration: { frame: 10 } };
    await call("add_clip", { ...add, baseRevision: revision });
    const stale = await raw("add_clip", { ...add, start: { frame: 50 }, baseRevision: revision });
    expect(stale.isError).toBe(true);
    expect(stale.content[0]!.text).toMatch(/StaleRevisionError.*đọc lại/s);
    expect((await call("get_timeline", { projectId: "stale" })).tracks[0].clips).toHaveLength(1);
  }, 60_000);

  it("a batch can cut a clip and change the new part without guessing its id", async () => {
    const { assetId, revision } = await setupProject("alias");
    const result = await call("apply_batch", {
      projectId: "alias",
      baseRevision: revision,
      label: "Cắt rồi giảm tiếng",
      commands: [
        { type: "add_clip", as: "goc", assetId, start: { frame: 0 }, duration: { seconds: 2 } },
        { type: "split_clip", as: "phan_sau", clipId: "goc", at: { seconds: 1 } },
        { type: "set_volume", clipId: "phan_sau", volume: 50 },
      ],
    });
    expect(result.aliases.phan_sau).toBe(result.createdClipIds[1]);
    const second = result.clips.find((clip: { id: string }) => clip.id === result.aliases.phan_sau);
    expect(second).toMatchObject({ start: 30, duration: 30, volume: 50 });
  }, 60_000);

  it("a failing batch changes nothing", async () => {
    const { assetId, revision } = await setupProject("atomic");
    const result = await raw("apply_batch", {
      projectId: "atomic",
      baseRevision: revision,
      label: "t",
      commands: [
        { type: "add_clip", assetId, start: { frame: 0 }, duration: { frame: 10 } },
        { type: "add_clip", assetId, start: { frame: 5 }, duration: { frame: 10 } },
      ],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/chồng lên/);
    const after = await call("get_timeline", { projectId: "atomic" });
    expect(after.revision).toBe(revision);
    expect(after.tracks[0].clips).toHaveLength(0);
  }, 60_000);

  it("exporting an empty timeline fails right away", async () => {
    await call("create_project", { projectId: "empty" });
    const result = await raw("export_video", { projectId: "empty" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/rỗng/);
  });

  it("a later edit does not change a running export, and names do not collide", async () => {
    const { assetId, revision } = await setupProject("snapshot");
    const added = await call("add_clip", { projectId: "snapshot", baseRevision: revision, assetId, start: { frame: 0 }, duration: { frame: 30 } });
    const first = await call("export_video", { projectId: "snapshot", name: "a" });
    await call("delete_clip", { projectId: "snapshot", baseRevision: added.revision, clipId: added.createdClipIds[0] });
    const result = await finished(first.id);
    expect((await probeMedia(result.path)).frameCount).toBe(30);

    await call("undo", { projectId: "snapshot", baseRevision: added.revision + 1 });
    const second = await finished((await call("export_video", { projectId: "snapshot", name: "a" })).id);
    expect(second.path.endsWith("a-2.mp4")).toBe(true);
    expect(statSync(result.path).size).toBeGreaterThan(0);
  }, 120_000);
});

describe("boundaries", () => {
  it("refuses a path outside the allowed folders, a link out of them, and non-video files", async () => {
    await call("create_project", { projectId: "paths" });
    const outside = join(base, "secret.mp4");
    writeFileSync(outside, "x");
    const link = join(media, "link.mp4");
    symlinkSync(outside, link);
    const text = join(media, "notes.txt");
    writeFileSync(text, "x");

    for (const path of [outside, link, join(media, "..", "secret.mp4")]) {
      const result = await raw("import_asset", { projectId: "paths", path });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/ngoài các thư mục/);
    }
    expect((await raw("import_asset", { projectId: "paths", path: text })).content[0]!.text).toMatch(/không phải file video/);
    expect((await raw("import_asset", { projectId: "paths", path: "source.mp4" })).content[0]!.text).toMatch(/tuyệt đối/);
    expect((await raw("import_asset", { projectId: "paths", path: "concat:/etc/passwd" })).isError).toBe(true);
  });

  it("refuses project ids and export names that could leave the workspace", async () => {
    for (const projectId of ["../evil", "a/b", ".hidden", ""]) {
      expect((await raw("create_project", { projectId })).isError).toBe(true);
    }
    await call("create_project", { projectId: "names" });
    for (const name of ["../evil", "/tmp/evil", "a/b", ".hidden"]) {
      expect((await raw("export_video", { projectId: "names", name })).isError).toBe(true);
    }
  });

  it("requires the token and rejects other sites", async () => {
    const authorization = `Bearer ${TOKEN}`;
    expect((await post(INIT, {})).status).toBe(401);
    expect((await post(INIT, { authorization: "Bearer wrong" })).status).toBe(401);
    expect((await post(INIT, { authorization, origin: "https://evil.example" })).status).toBe(403);
    expect((await post(INIT, { authorization })).status).toBe(200);
    const port = new URL(http.url).port;
    expect((await post(INIT, { authorization, origin: `http://localhost:${port}` })).status).toBe(200);
  });

  it("rejects a forged Host header, as used in DNS rebinding", async () => {
    const { request } = await import("node:http");
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(http.url, { method: "POST", headers: { host: "evil.example", authorization: `Bearer ${TOKEN}` } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on("error", reject);
      req.end("{}");
    });
    expect(status).toBe(403);
  });

  it("listens only on the loopback address", () => {
    expect(new URL(http.url).hostname).toBe("127.0.0.1");
    expect((http.server.address() as { address: string }).address).toBe("127.0.0.1");
  });

  it("reopens a project from disk with the same state", async () => {
    const reopened = new Workspace(workspace.root, [media]);
    expect(reopened.list()).toContain("accept");
    expect(reopened.engine("accept").project).toEqual(workspace.engine("accept").project);
    expect(readFileSync(join(workspace.root, "accept", "project.json"), "utf8")).toContain('"revision"');
  });

  it("removes pauses found by detect_silence as one undo step, with the sound kept in step", async () => {
    const { assetId, revision } = await setupProject("pauses");
    const added = await call("add_clip", { projectId: "pauses", baseRevision: revision, assetId, start: { frame: 0 }, duration: { frame: 180 } });

    // The source beeps for 0.1 s at the start of each second, so there are five full pauses and a last one.
    const silence = await call("detect_silence", { projectId: "pauses", minSeconds: 0.5, paddingSeconds: 0 });
    expect(silence.ranges.length).toBe(6);
    expect(silence.revision).toBe(added.revision);

    const result = await call("delete_ranges", {
      projectId: "pauses",
      baseRevision: silence.revision,
      label: "Bỏ khoảng lặng",
      ranges: silence.ranges.map(({ start, end }: { start: object; end: object }) => ({ start, end })),
    });
    expect(result.durationFrames).toBe(180 - silence.totalFrames);
    expect(result.clips.length).toBe(6);

    const stale = await raw("delete_ranges", { projectId: "pauses", baseRevision: silence.revision, label: "x", ranges: [{ start: { frame: 0 }, end: { frame: 1 } }] });
    expect(stale.isError).toBe(true);

    const history = await call("get_history", { projectId: "pauses", limit: 1 });
    expect(history[0].label).toBe("Bỏ khoảng lặng");

    const undone = await call("undo", { projectId: "pauses", baseRevision: result.revision });
    const timeline = await call("get_timeline", { projectId: "pauses" });
    expect(timeline.revision).toBe(undone.revision);
    expect(timeline.durationFrames).toBe(180);
  });

  it("says which videos still need a transcript, and measures the timeline", async () => {
    const { assetId, revision } = await setupProject("words");
    await call("add_clip", { projectId: "words", baseRevision: revision, assetId, start: { frame: 0 }, duration: { frame: 90 } });
    const transcript = await call("get_transcript", { projectId: "words" });
    expect(transcript.segments).toEqual([]);
    expect(transcript.assetsWithoutTranscript.map((asset: { id: string }) => asset.id)).toEqual([assetId]);
    expect((await call("get_loudness", { projectId: "words" })).integratedLufs).toBeLessThan(0);
    expect((await finished((await call("detect_scenes", { projectId: "words", threshold: 0.9 })).id)).revision).toBeGreaterThan(0);
  });

  it("explains what to do when whisper is not installed", async () => {
    const { assetId } = await setupProject("nowhisper");
    const saved = { path: process.env.PATH, home: process.env.HOME, bin: process.env.VE_WHISPER_BIN };
    delete process.env.VE_WHISPER_BIN;
    process.env.PATH = "/usr/bin";
    process.env.HOME = base;
    try {
      const result = await raw("transcribe_asset", { projectId: "nowhisper", assetId });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain("VE_WHISPER_BIN");
    } finally {
      process.env.PATH = saved.path;
      process.env.HOME = saved.home;
      if (saved.bin !== undefined) process.env.VE_WHISPER_BIN = saved.bin;
    }
  });
});

describe("Phase 5 through MCP", () => {
  it("creates a project at a chosen fps and rejects a bad one with a readable message", async () => {
    const project = await call("create_project", { projectId: "fps25", width: 320, height: 180, fps: "25" });
    expect(project.fps).toBe("25/1");
    const bad = await raw("create_project", { projectId: "fpsbad", fps: "abc" });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]!.text).toContain("không hợp lệ");
  });

  it("builds layers, text, a transition and keyframes in one batch, and exports them", async () => {
    const { assetId, revision } = await setupProject("layers");
    const result = await call("apply_batch", {
      projectId: "layers",
      baseRevision: revision,
      label: "Dựng nhiều lớp",
      commands: [
        { type: "add_track", kind: "video", id: "over" },
        { type: "add_track", kind: "text", id: "subs" },
        { type: "add_clip", trackId: "video_1", assetId, start: { frame: 0 }, duration: { seconds: 1 } },
        { type: "add_clip", as: "second", trackId: "video_1", assetId, start: { seconds: 1 }, sourceIn: { seconds: 2 }, duration: { seconds: 1 } },
        { type: "set_transition", clipId: "second", transition: { type: "crossfade", duration: { frame: 10 } } },
        { type: "add_clip", as: "pip", trackId: "over", assetId, start: { frame: 5 }, duration: { frame: 20 } },
        { type: "set_transform", clipId: "pip", scale: 0.5, x: 0.25 },
        { type: "set_keyframes", clipId: "pip", property: "opacity", keyframes: [{ at: { frame: 0 }, value: 0 }, { at: { frame: 19 }, value: 1 }] },
        { type: "add_text", trackId: "subs", start: { frame: 0 }, duration: { frame: 30 }, text: "Xin chào" },
      ],
    });
    expect(result.aliases.second).toBeDefined();

    const timeline = await call("get_timeline", { projectId: "layers" });
    expect(timeline.tracks.map((track: { kind: string }) => track.kind)).toEqual(["video", "video", "text"]);
    expect(timeline.tracks[0].clips[1].transitionApplied).toBe("crossfade over 10 frames");

    const frame = await raw("get_frame", { projectId: "layers", at: { frame: 15 } });
    expect(frame.isError).toBeUndefined();
    expect(frame.content[1]!.mimeType).toBe("image/jpeg");

    const job = await call("export_video", { projectId: "layers", name: "layers" });
    const done = await finished(job.id);
    expect((await probeMedia(done.path)).frameCount).toBe(60);
  }, 60_000);

  it("changes the canvas with one tool, and undo brings it back", async () => {
    const { revision } = await setupProject("portrait");
    const changed = await call("set_canvas", { projectId: "portrait", baseRevision: revision, width: 180, height: 320 });
    expect((await call("get_timeline", { projectId: "portrait" })).size).toBe("180x320");
    await call("undo", { projectId: "portrait", baseRevision: changed.revision });
    expect((await call("get_timeline", { projectId: "portrait" })).size).toBe("320x180");
  }, 60_000);

  it("fills a text track with subtitles from the transcript", async () => {
    const { assetId, revision } = await setupProject("subs");
    const added = await call("add_clip", { projectId: "subs", baseRevision: revision, assetId, start: { frame: 0 }, duration: { frame: 150 } });
    const empty = await raw("generate_subtitles", { projectId: "subs", baseRevision: added.revision });
    expect(empty.content[0]!.text).toContain("transcribe_asset");

    const folder = join(workspace.projectRoot("subs"), "transcripts");
    mkdirSync(folder, { recursive: true });
    const word = (text: string, start: number, end: number) => ({ text, start, end, probability: 1 });
    writeFileSync(join(folder, `${assetId}.json`), JSON.stringify({ assetId, language: "vi", model: "m", segments: [{ words: [word("Xin", 0, 20), word("chào", 20, 40)] }, { words: [word("các", 90, 100), word("bạn", 100, 120)] }] }));

    const result = await call("generate_subtitles", { projectId: "subs", baseRevision: added.revision });
    expect(result.count).toBe(2);
    const track = (await call("get_timeline", { projectId: "subs" })).tracks.find((candidate: { id: string }) => candidate.id === result.trackId);
    expect(track.clips.map((clip: { text: string; start: number }) => [clip.text, clip.start])).toEqual([["Xin chào", 0], ["các bạn", 90]]);
  }, 60_000);

  it("cancels a job, and says so when it has already ended", async () => {
    const { assetId, revision } = await setupProject("stop");
    await call("add_clip", { projectId: "stop", baseRevision: revision, assetId, start: { frame: 0 }, duration: { frame: 150 } });
    const job = await call("export_video", { projectId: "stop", name: "stop" });
    await call("cancel_job", { jobId: job.id });
    const status = await call("get_job_status", { jobId: job.id, waitSeconds: 20 });
    expect(status.status).toBe("cancelled");
    const again = await raw("cancel_job", { jobId: job.id });
    expect(again.content[0]!.text).toContain("đã kết thúc");
  }, 60_000);
});

describe("requests that must not take the server down", () => {
  const origin = () => new URL(http.url).origin;

  async function rawRequest(path: string, extra = ""): Promise<string> {
    const { connect } = await import("node:net");
    const url = new URL(http.url);
    return new Promise((resolve, reject) => {
      const socket = connect(Number(url.port), url.hostname, () => socket.write(`GET ${path} HTTP/1.1\r\nHost: ${url.host}\r\n${extra}Connection: ${extra ? "Upgrade" : "close"}\r\n\r\n`));
      let reply = "";
      socket.on("data", (chunk) => (reply += chunk.toString()));
      socket.on("close", () => resolve(reply));
      socket.on("end", () => resolve(reply));
      socket.on("error", reject);
    });
  }

  it("answers a malformed address and keeps running", async () => {
    for (const path of ["/%zz", "//", "/api/projects/%zz", "/api/%E0%A4%A"]) {
      expect(await rawRequest(path)).toMatch(/^HTTP\/1\.1 4/);
    }
    expect((await call<{ projects: string[] }>("list_projects", {})).projects).toBeDefined();
    expect((await fetch(`${origin()}/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(405);
  });

  it("refuses a malformed WebSocket address and keeps running", async () => {
    const upgrade = `Upgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nAuthorization: Bearer ${TOKEN}\r\n`;
    expect(await rawRequest("/api/projects/%zz/events", upgrade)).toMatch(/^HTTP\/1\.1 404/);
    expect(await rawRequest("//", upgrade)).toMatch(/^HTTP\/1\.1 404/);
    expect((await call<{ projects: string[] }>("list_projects", {})).projects).toBeDefined();
  });

  it("refuses a canvas FFmpeg could not encode", async () => {
    for (const size of [{ width: 1081, height: 1920 }, { width: 100000, height: 1080 }]) {
      const result = await raw("create_project", { projectId: `bad${size.width}`, ...size });
      expect(result.content[0]!.text).toContain("không hợp lệ");
    }
  });
});
