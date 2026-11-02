import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { envelopeAt, gainAt, lookAt, sliceKeyframes, trackEnvelopes, valueAt } from "../src/animation.ts";
import { CommandEngine, createProject } from "../src/engine.ts";
import { isFinished, JobQueue } from "../src/jobs.ts";
import { exportProject } from "../src/media/export.ts";
import { extractFrame } from "../src/media/frames.ts";
import { ffmpeg } from "../src/media/ffmpeg.ts";
import { importAudio, importVideo } from "../src/media/import.ts";
import { probeMedia } from "../src/media/probe.ts";
import { renderTextImage } from "../src/media/text.ts";
import { Workspace } from "../src/mcp/workspace.ts";
import { Project, TextStyle, type Asset, type CommandInput, type MediaClip } from "../src/schema.ts";
import { createProjectFolder, openProjectFolder } from "../src/store.ts";
import { parseFps } from "../src/time.ts";
import { speechGaps, subtitleCues, type TimelineSegment } from "../src/transcript.ts";
import { findBeepStarts, readPcm } from "./helpers.ts";

const asset = (id: string, frames = 300): Asset => ({
  id,
  name: `${id}.mp4`,
  originalPath: `/${id}.mp4`,
  masterPath: `/${id}.mp4`,
  proxyPath: `/${id}.mp4`,
  durationFrames: frames,
  width: 1920,
  height: 1080,
  hasVideo: true,
  hasAudio: true,
  normalization: { transcoded: false, reasons: [], sourceFps: 30, wasHdr: false },
});

function engineWith(...assets: Asset[]): CommandEngine {
  const engine = new CommandEngine(createProject({ name: "t" }));
  for (const item of assets) engine.registerAsset(item);
  return engine;
}

function apply(engine: CommandEngine, ...commands: CommandInput[]) {
  return engine.applyBatch({ actor: "user", baseRevision: engine.project.revision, label: "x", commands });
}

const clipsOf = (engine: CommandEngine, trackId = "video_1") => engine.project.timeline.tracks.find((track) => track.id === trackId)!.clips;

describe("fps", () => {
  it("reads whole numbers, NTSC decimals and fractions", () => {
    expect(parseFps("25")).toEqual({ num: 25, den: 1 });
    expect(parseFps("29.97")).toEqual({ num: 30000, den: 1001 });
    expect(parseFps("24000/1001")).toEqual({ num: 24000, den: 1001 });
    for (const bad of ["0", "abc", "1000", "30/0", "12.5"]) expect(() => parseFps(bad)).toThrow(/không hợp lệ/);
  });

  it("is stored in a project made through the workspace, and stays after reopening", () => {
    const root = mkdtempSync(join(tmpdir(), "ve-fps-"));
    const workspace = new Workspace(root);
    workspace.create("p", { fps: parseFps("25") });
    expect(new Workspace(root).engine("p").project.fps).toEqual({ num: 25, den: 1 });
    rmSync(root, { recursive: true });
  });
});

describe("tracks and commands", () => {
  it("adds tracks in drawing order, with new picture tracks under the text", () => {
    const engine = engineWith();
    apply(engine, { type: "add_track", kind: "text" }, { type: "add_track", kind: "video" }, { type: "add_track", kind: "audio", id: "music" });
    expect(engine.project.timeline.tracks.map((track) => track.id)).toEqual(["video_1", "video_2", "text_1", "music"]);
    expect(() => apply(engine, { type: "add_track", kind: "audio", id: "music" })).toThrow(/Đã có track/);
  });

  it("keeps each kind of clip on the kind of track that can play it", () => {
    const sound: Asset = { ...asset("sound"), hasVideo: false, width: 0, height: 0 };
    const engine = engineWith(asset("a"), sound);
    apply(engine, { type: "add_track", kind: "text", id: "t" }, { type: "add_track", kind: "audio", id: "m" });
    expect(() => apply(engine, { type: "add_clip", trackId: "video_1", assetId: "sound", start: 0, duration: 10 })).toThrow(/chỉ có tiếng/);
    expect(() => apply(engine, { type: "add_clip", trackId: "t", assetId: "a", start: 0, duration: 10 })).toThrow(/không nhận video/);
    expect(() => apply(engine, { type: "add_text", trackId: "video_1", start: 0, duration: 10, text: "x" })).toThrow(/track chữ/);
    apply(engine, { type: "add_clip", trackId: "m", assetId: "sound", start: 0, duration: 10 });
    expect(clipsOf(engine, "m")).toHaveLength(1);
  });

  it("will not remove the last video track, and undo brings back a removed track with its clips", () => {
    const engine = engineWith(asset("a"));
    expect(() => apply(engine, { type: "remove_track", trackId: "video_1" })).toThrow(/ít nhất một track video/);
    apply(engine, { type: "add_track", kind: "video", id: "v2" }, { type: "add_clip", trackId: "v2", assetId: "a", start: 0, duration: 30 });
    apply(engine, { type: "remove_track", trackId: "v2" });
    expect(engine.project.timeline.tracks).toHaveLength(1);
    engine.undo("user", engine.project.revision);
    expect(clipsOf(engine, "v2")).toHaveLength(1);
  });

  it("cuts text tracks along with the video when asked, and leaves other tracks alone", () => {
    const engine = engineWith(asset("a"), asset("b"));
    apply(
      engine,
      { type: "add_track", kind: "text", id: "subs" },
      { type: "add_track", kind: "audio", id: "music" },
      { type: "add_clip", trackId: "video_1", assetId: "a", start: 0, duration: 100 },
      { type: "add_text", trackId: "subs", start: 60, duration: 20, text: "sau đoạn cắt" },
      { type: "add_clip", trackId: "music", assetId: "b", start: 0, duration: 100 },
    );
    apply(engine, { type: "delete_ranges", trackId: "video_1", alsoTrackIds: ["subs"], ranges: [{ start: 10, end: 40 }] });
    expect(clipsOf(engine, "subs")[0]!.start).toBe(30);
    expect(clipsOf(engine, "music")[0]!.duration).toBe(100);
  });

  it("changes the canvas in a way undo and reverting a batch both bring back", () => {
    const engine = engineWith();
    apply(engine, { type: "set_canvas", width: 1080, height: 1920 });
    expect(engine.project.height).toBe(1920);
    engine.undo("user", engine.project.revision);
    expect([engine.project.width, engine.project.height]).toEqual([1920, 1080]);
    engine.redo("user", engine.project.revision);
    expect(engine.project.width).toBe(1080);

    const revertible = engineWith();
    const { revision } = apply(revertible, { type: "set_canvas", width: 1080, height: 1080 });
    revertible.revert("user", revertible.project.revision, revision);
    expect(revertible.project.width).toBe(1920);
    expect(() => apply(revertible, { type: "set_canvas", width: 1081, height: 1080 })).toThrow(/số chẵn/);
  });

  it("reverts one batch that added a track, unless the track has been used since", () => {
    const engine = engineWith(asset("a"));
    const { revision } = apply(engine, { type: "add_track", kind: "video", id: "v2" });
    apply(engine, { type: "add_clip", trackId: "video_1", assetId: "a", start: 0, duration: 30 });
    engine.revert("user", engine.project.revision, revision);
    expect(engine.project.timeline.tracks.map((track) => track.id)).toEqual(["video_1"]);

    const used = engineWith(asset("a"));
    const added = apply(used, { type: "add_track", kind: "video", id: "v2" });
    apply(used, { type: "add_clip", trackId: "v2", assetId: "a", start: 0, duration: 30 });
    expect(() => used.revert("user", used.project.revision, added.revision)).toThrow(/đã có clip mới/);
  });

  it("detects a batch's change of effects when reverting, and conflicts on the same field", () => {
    const engine = engineWith(asset("a"));
    apply(engine, { type: "add_clip", trackId: "video_1", assetId: "a", start: 0, duration: 30, as: "c" });
    const id = clipsOf(engine)[0]!.id;
    const { revision } = apply(engine, { type: "set_transform", clipId: id, scale: 2 });
    apply(engine, { type: "set_volume", clipId: id, volume: 50 });
    engine.revert("user", engine.project.revision, revision);
    expect(clipsOf(engine)[0]!.transform).toBeUndefined();
    expect((clipsOf(engine)[0] as MediaClip).volume).toBe(50);

    const second = apply(engine, { type: "set_transform", clipId: id, scale: 2 });
    apply(engine, { type: "set_transform", clipId: id, scale: 3 });
    expect(() => engine.revert("user", engine.project.revision, second.revision)).toThrow(/đã được sửa sau đó/);
  });

  describe("growing a clip into its neighbours", () => {
    function setup() {
      const engine = engineWith(asset("a"));
      apply(
        engine,
        { type: "add_track", kind: "text", id: "subs" },
        { type: "add_track", kind: "audio", id: "music" },
        { type: "add_clip", trackId: "video_1", assetId: "a", sourceIn: 50, start: 0, duration: 100 },
        { type: "add_clip", trackId: "video_1", assetId: "a", sourceIn: 200, start: 100, duration: 50 },
        { type: "add_clip", trackId: "video_1", assetId: "a", sourceIn: 0, start: 170, duration: 10 },
        { type: "add_text", trackId: "subs", start: 90, duration: 20, text: "giữa điểm cắt" },
        { type: "add_text", trackId: "subs", start: 120, duration: 10, text: "phía sau" },
        { type: "add_clip", trackId: "music", assetId: "a", start: 120, duration: 10 },
      );
      return engine;
    }
    const starts = (engine: CommandEngine, track: string) => clipsOf(engine, track).map((clip) => clip.start);

    it("is still refused without ripple", () => {
      const engine = setup();
      expect(() => apply(engine, { type: "trim_clip", clipId: "clip_1", edge: "end", delta: 20 })).toThrow(/chồng/);
    });

    it("pushes everything after it back together, with the subtitles and not the music", () => {
      const engine = setup();
      apply(engine, { type: "trim_clip", clipId: "clip_1", edge: "end", delta: 20, ripple: true, alsoTrackIds: ["subs"] });
      expect(clipsOf(engine)[0]!.duration).toBe(120);
      expect(starts(engine, "video_1")).toEqual([0, 120, 190]);
      expect(starts(engine, "subs")).toEqual([90, 140]);
      expect(starts(engine, "music")).toEqual([120]);
      engine.undo("user", engine.project.revision);
      expect(starts(engine, "video_1")).toEqual([0, 100, 170]);
    });

    it("uses empty space before pushing", () => {
      const engine = setup();
      apply(engine, { type: "trim_clip", clipId: "clip_2", edge: "end", delta: 15, ripple: true });
      expect(starts(engine, "video_1")).toEqual([0, 100, 170]);
      apply(engine, { type: "trim_clip", clipId: "clip_2", edge: "end", delta: 25, ripple: true });
      expect(starts(engine, "video_1")).toEqual([0, 100, 190]);
    });

    it("keeps a start edge against the clip before and grows towards the later clips", () => {
      const engine = setup();
      apply(engine, { type: "trim_clip", clipId: "clip_2", edge: "start", delta: -40, ripple: true });
      const clip = clipsOf(engine)[1] as MediaClip;
      expect([clip.start, clip.sourceIn, clip.duration]).toEqual([100, 160, 90]);
      expect(starts(engine, "video_1")).toEqual([0, 100, 190]);
    });

    it("still stops at the end of the source, changing nothing", () => {
      const engine = setup();
      expect(() => apply(engine, { type: "trim_clip", clipId: "clip_1", edge: "end", delta: 200, ripple: true })).toThrow(/chỉ có 300 frame/);
      expect(starts(engine, "video_1")).toEqual([0, 100, 170]);
    });

    it("can be reverted on its own", () => {
      const engine = setup();
      const { revision } = apply(engine, { type: "trim_clip", clipId: "clip_1", edge: "end", delta: 20, ripple: true, alsoTrackIds: ["subs"] });
      engine.revert("user", engine.project.revision, revision);
      expect(starts(engine, "video_1")).toEqual([0, 100, 170]);
      expect(starts(engine, "subs")).toEqual([90, 120]);
    });
  });

  it("validates keyframes and sorts them", () => {
    const engine = engineWith(asset("a"));
    apply(engine, { type: "add_clip", trackId: "video_1", assetId: "a", start: 0, duration: 30 });
    const id = clipsOf(engine)[0]!.id;
    expect(() => apply(engine, { type: "set_keyframes", clipId: id, property: "opacity", keyframes: [{ frame: 30, value: 1 }] })).toThrow(/dài 30 frame/);
    expect(() => apply(engine, { type: "set_keyframes", clipId: id, property: "opacity", keyframes: [{ frame: 1, value: 2 }] })).toThrow(/ngoài khoảng/);
    expect(() => apply(engine, { type: "set_keyframes", clipId: id, property: "x", keyframes: [{ frame: 1, value: 0 }, { frame: 1, value: 1 }] })).toThrow(/cùng ở frame/);
    apply(engine, { type: "set_keyframes", clipId: id, property: "x", keyframes: [{ frame: 9, value: 1 }, { frame: 0, value: 0 }] });
    expect(clipsOf(engine)[0]!.keyframes?.x?.map((key) => key.frame)).toEqual([0, 9]);
    apply(engine, { type: "set_keyframes", clipId: id, property: "x", keyframes: [] });
    expect(clipsOf(engine)[0]!.keyframes).toBeUndefined();
  });

  it("keeps an animation on the same picture through a split and a trim", () => {
    const engine = engineWith(asset("a"));
    apply(engine, { type: "add_clip", trackId: "video_1", assetId: "a", start: 0, duration: 101 });
    const id = clipsOf(engine)[0]!.id;
    apply(engine, { type: "set_keyframes", clipId: id, property: "scale", keyframes: [{ frame: 0, value: 1 }, { frame: 100, value: 2 }] });
    apply(engine, { type: "split_clip", clipId: id, at: 50 });
    const [first, second] = clipsOf(engine);
    expect(valueAt(first!.keyframes!.scale, 49, 0)).toBeCloseTo(1.49, 5);
    expect(valueAt(second!.keyframes!.scale, 0, 0)).toBeCloseTo(1.5, 5);
    expect(valueAt(second!.keyframes!.scale, 50, 0)).toBeCloseTo(2, 5);

    apply(engine, { type: "trim_clip", clipId: second!.id, edge: "start", delta: 10 });
    expect(valueAt(clipsOf(engine)[1]!.keyframes!.scale, 0, 0)).toBeCloseTo(1.6, 5);
    apply(engine, { type: "trim_clip", clipId: second!.id, edge: "start", delta: -5 });
    expect(valueAt(clipsOf(engine)[1]!.keyframes!.scale, 5, 0)).toBeCloseTo(1.6, 5);
  });

  it("gives a transition only to the piece that keeps the clip's first frame", () => {
    const engine = engineWith(asset("a"));
    apply(engine, { type: "add_clip", trackId: "video_1", assetId: "a", start: 0, duration: 100 });
    const id = clipsOf(engine)[0]!.id;
    apply(engine, { type: "set_transition", clipId: id, transition: { type: "dip", duration: 10 } });
    apply(engine, { type: "split_clip", clipId: id, at: 50 });
    expect(clipsOf(engine)[0]!.transitionIn).toBeDefined();
    expect(clipsOf(engine)[1]!.transitionIn).toBeUndefined();
    expect(() => apply(engine, { type: "set_transition", clipId: id, transition: { type: "dip", duration: 51 } })).toThrow(/chỉ dài/);
  });

  it("opens a project saved before these features", () => {
    const old = {
      version: 1, name: "cũ", fps: { num: 30, den: 1 }, width: 1920, height: 1080, revision: 1, nextClipNumber: 2,
      assets: [{ ...asset("a"), hasVideo: undefined }],
      timeline: { tracks: [{ id: "video_1", kind: "video", clips: [{ id: "clip_1", assetId: "a", start: 0, sourceIn: 0, duration: 10, volume: 100 }] }] },
    };
    const parsed = Project.parse(JSON.parse(JSON.stringify(old)));
    expect(parsed.assets[0]!.hasVideo).toBe(true);
    expect(new CommandEngine(parsed).project.timeline.canvas).toEqual({ width: 1920, height: 1080 });
  });
});

describe("what each frame looks like", () => {
  const video = (id: string, start: number, duration: number, extra: Partial<MediaClip> = {}): MediaClip => ({ id, assetId: "a", start, sourceIn: 0, duration, volume: 100, ...extra });

  it("interpolates in straight lines and holds outside the keyframes", () => {
    const keys = [{ frame: 10, value: 0 }, { frame: 20, value: 1 }];
    expect(valueAt(keys, 0, 9)).toBe(0);
    expect(valueAt(keys, 15, 9)).toBe(0.5);
    expect(valueAt(keys, 99, 9)).toBe(1);
    expect(valueAt(undefined, 5, 9)).toBe(9);
    expect(sliceKeyframes(keys, 15, 30).map((key) => key.frame)).toEqual([0, 5, 14]);
  });

  it("dissolves from the clip before, shortening to the source that is left", () => {
    const assets = [asset("a", 100)];
    const a = video("a1", 0, 90);
    const b = video("b1", 90, 50, { transitionIn: { type: "crossfade", duration: 20 } });
    const envelope = trackEnvelopes([a, b], assets).get("b1")!;
    expect(envelope.tail).toEqual({ clip: a, frames: 10 });
    expect(envelope.fadeIn).toBe(10);
  });

  it("falls back to a fade-in when moved away from the clip before", () => {
    const b = video("b1", 200, 50, { transitionIn: { type: "crossfade", duration: 20 } });
    const envelope = trackEnvelopes([video("a1", 0, 90), b], [asset("a", 1000)]).get("b1")!;
    expect(envelope.tail).toBeUndefined();
    expect(envelope.fadeIn).toBe(20);
  });

  it("puts a dip's fades on both sides of the cut", () => {
    const a = video("a1", 0, 90);
    const b = video("b1", 90, 50, { transitionIn: { type: "dip", duration: 20 } });
    const envelopes = trackEnvelopes([a, b], [asset("a")]);
    expect(envelopes.get("a1")!.fadeOut).toBe(10);
    expect(envelopes.get("b1")!.fadeIn).toBe(10);
    expect(envelopeAt(envelopes.get("a1")!, 89, 90)).toBeCloseTo(1 / 11, 5);
    expect(envelopeAt(envelopes.get("a1")!, 79, 90)).toBe(1);
    expect(lookAt(a, 89, envelopes.get("a1")!).opacity).toBeCloseTo(1 / 11, 5);
    expect(gainAt(a, 89, envelopes.get("a1")!)).toBeCloseTo(1 / 11, 5);
  });
});

describe("subtitles", () => {
  const word = (text: string, start: number, end: number) => ({ text, start, end, sourceStart: start, sourceEnd: end, filler: false });

  it("breaks long lines and never lets a cue run into the next", () => {
    const segment: TimelineSegment = {
      clipId: "c", assetId: "a", start: 0, end: 40, text: "",
      words: [word("một", 0, 10), word("hai", 10, 12), word("ba", 12, 40)],
    };
    const cues = subtitleCues([segment], 7);
    expect(cues.map((cue) => cue.text)).toEqual(["một hai", "ba"]);
    expect(cues[0]).toMatchObject({ start: 0, end: 12 });
    expect(subtitleCues([{ ...segment, words: [word("ngắn", 0, 2)] }], 42)[0]!.end).toBe(15);
  });
});

describe("stretches with no words", () => {
  const word = (start: number, end: number) => ({ text: "x", start, end, sourceStart: start, sourceEnd: end, filler: false });
  const engine = engineWith(asset("a"));
  apply(engine, { type: "add_clip", trackId: "video_1", assetId: "a", start: 0, duration: 300 });
  const segment = (words: ReturnType<typeof word>[]): TimelineSegment => ({ clipId: "c", assetId: "a", start: 0, end: 0, text: "", words });

  it("finds the gaps, keeps room around words and ignores short pauses", () => {
    const gaps = speechGaps(engine.project, [segment([word(30, 40), word(45, 60), word(200, 220)])], 15, 3);
    expect(gaps).toEqual([{ start: 0, end: 27 }, { start: 63, end: 197 }, { start: 223, end: 300 }]);
  });

  it("treats a clip with no words as one gap", () => {
    expect(speechGaps(engine.project, [], 15, 3)).toEqual([{ start: 0, end: 300 }]);
  });
});

describe("jobs", () => {
  const blocked = () => {
    let release = () => {};
    return { promise: new Promise<void>((resolve) => (release = resolve)), release: () => release() };
  };

  it("stops a running job through its signal and reports it as cancelled", async () => {
    const queue = new JobQueue();
    const job = queue.enqueue("x", "p", ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("killed")))));
    await new Promise((resolve) => setTimeout(resolve, 5));
    queue.cancel(job.id);
    const finished = await queue.wait(job.id, 500);
    expect(finished?.status).toBe("cancelled");
    expect(finished?.error).toBeUndefined();
  });

  it("never starts a cancelled job that was waiting, and lets the next one run", async () => {
    const queue = new JobQueue();
    const gate = blocked();
    const first = queue.enqueue("x", "p", () => gate.promise);
    let started = false;
    const second = queue.enqueue("x", "p", async () => {
      started = true;
    });
    const third = queue.enqueue("x", "p", async () => "done");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(queue.cancel(second.id).status).toBe("cancelled");
    gate.release();
    await queue.wait(third.id, 500);
    expect(started).toBe(false);
    expect(queue.get(first.id)?.status).toBe("succeeded");
    expect(queue.get(third.id)?.result).toBe("done");
    expect(() => queue.cancel(first.id)).toThrow(/đã kết thúc/);
  });

  it("keeps results across a restart and reports unfinished work as interrupted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-jobs-"));
    const file = join(dir, "jobs.json");
    const queue = new JobQueue(file);
    const done = queue.enqueue("x", "p", async () => ({ path: "/a.mp4" }));
    await queue.wait(done.id, 500);
    const gate = blocked();
    const running = queue.enqueue("x", "p", () => gate.promise);
    await new Promise((resolve) => setTimeout(resolve, 5));

    const restarted = new JobQueue(file);
    expect(restarted.get(done.id)?.result).toEqual({ path: "/a.mp4" });
    const interrupted = restarted.get(running.id)!;
    expect(isFinished(interrupted)).toBe(true);
    expect(interrupted.error).toMatch(/khởi động lại/);
    restarted.dismiss(done.id);
    expect(new JobQueue(file).get(done.id)).toBeUndefined();
    gate.release();
    await queue.wait(running.id, 500);
    rmSync(dir, { recursive: true });
  });
});

describe("real media", () => {
  const WIDTH = 320;
  const HEIGHT = 180;
  let dir: string;
  let root: string;
  let engine: CommandEngine;
  let dark: Asset;
  let light: Asset;
  let music: Asset;

  async function solid(path: string, gray: number, tone: number): Promise<void> {
    const color = `0x${gray.toString(16).padStart(2, "0").repeat(3)}`;
    await ffmpeg([
      "-f", "lavfi", "-i", `color=c=${color}:s=${WIDTH}x${HEIGHT}:r=30:d=6,format=yuv420p`,
      "-f", "lavfi", "-i", `sine=f=${tone}:r=48000:d=6`,
      "-c:v", "libx264", "-preset", "ultrafast", "-qp", "0", "-g", "1", "-c:a", "aac", "-shortest", path,
    ]);
  }

  /** Average brightness of a region for every frame of a file. */
  async function brightness(path: string, region = `iw/4:ih/4:iw*3/8:ih*3/8`): Promise<number[]> {
    const { stdout } = await ffmpeg(["-i", path, "-vf", `crop=${region},scale=1:1:flags=area,format=gray`, "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"]);
    return [...stdout];
  }

  /** Limited-range video turned into 8-bit grey, compared with the level a mix of the two sources should reach. */
  const near = (actual: number, expected: number, tolerance = 4) => expect(Math.abs(actual - expected), `${actual} vs ${expected}`).toBeLessThanOrEqual(tolerance);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ve-phase5-"));
    await solid(join(dir, "dark.mp4"), 0x20, 440);
    await solid(join(dir, "light.mp4"), 0xe0, 880);
    await ffmpeg(["-f", "lavfi", "-i", "aevalsrc='if(lt(mod(t,1),0.1),0.5*sin(2*PI*880*t),0)':s=44100:d=3", join(dir, "beep.mp3")]);
    root = join(dir, "project");
    engine = createProjectFolder(root, { name: "p", width: WIDTH, height: HEIGHT });
    dark = (await importVideo(root, join(dir, "dark.mp4"), { num: 30, den: 1 })).asset;
    light = (await importVideo(root, join(dir, "light.mp4"), { num: 30, den: 1 })).asset;
    music = (await importAudio(root, join(dir, "beep.mp3"), { num: 30, den: 1 })).asset;
    for (const item of [dark, light, music]) engine.registerAsset(item);
  }, 120_000);

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A project with its own timeline, built from the same imported sources. */
  function timeline(...commands: CommandInput[]): Project {
    const fresh = new CommandEngine(createProject({ name: "t", width: WIDTH, height: HEIGHT }));
    for (const item of [dark, light, music]) fresh.registerAsset(item);
    apply(fresh, ...commands);
    return fresh.project;
  }

  async function render(project: Project, name: string): Promise<string> {
    const output = join(dir, `${name}.mp4`);
    await exportProject(project, output, { textDir: join(dir, "text") });
    return output;
  }

  it("imports a sound file with no picture, and refuses to show a frame of it", async () => {
    expect(music.hasVideo).toBe(false);
    expect(music.durationFrames).toBeGreaterThanOrEqual(89);
    expect(music.durationFrames).toBeLessThanOrEqual(91);
    await expect(extractFrame(engine.project, { kind: "asset", assetId: music.id }, 0, 100)).rejects.toThrow(/chỉ có tiếng/);
  });

  it("draws a later video track over an earlier one, exactly where it starts and ends", async () => {
    const project = timeline(
      { type: "add_track", kind: "video", id: "v2" },
      { type: "add_clip", trackId: "video_1", assetId: dark.id, start: 0, duration: 60 },
      { type: "add_clip", trackId: "v2", assetId: light.id, start: 20, duration: 10 },
    );
    const values = await brightness(await render(project, "overlay"));
    expect(values).toHaveLength(60);
    for (const frame of [0, 19, 30, 59]) near(values[frame]!, 0x20);
    for (const frame of [20, 29]) near(values[frame]!, 0xe0);
  }, 60_000);

  it("scales and moves a layer, leaving what is under it showing", async () => {
    const project = timeline(
      { type: "add_track", kind: "video", id: "v2" },
      { type: "add_clip", trackId: "video_1", assetId: dark.id, start: 0, duration: 10 },
      { type: "add_clip", trackId: "v2", assetId: light.id, start: 0, duration: 10 },
      { type: "set_transform", clipId: "clip_2", scale: 0.5, x: 0.25, y: 0.25 },
    );
    const output = await render(project, "pip");
    near((await brightness(output, "iw/4:ih/4:iw*5/8:ih*5/8"))[5]!, 0xe0);
    near((await brightness(output, "iw/4:ih/4:0:0"))[5]!, 0x20);
  }, 60_000);

  it("dissolves frame by frame with the values the preview works out, and keeps the length", async () => {
    const project = timeline(
      { type: "add_clip", trackId: "video_1", assetId: dark.id, start: 0, duration: 30 },
      { type: "add_clip", trackId: "video_1", assetId: light.id, start: 30, duration: 30 },
      { type: "set_transition", clipId: "clip_2", transition: { type: "crossfade", duration: 9 } },
    );
    const values = await brightness(await render(project, "crossfade"));
    expect(values).toHaveLength(60);
    near(values[29]!, 0x20);
    const envelope = trackEnvelopes(project.timeline.tracks[0]!.clips, project.assets).get("clip_2")!;
    for (let frame = 0; frame < 9; frame++) {
      near(values[30 + frame]!, 0x20 + (0xe0 - 0x20) * lookAt(project.timeline.tracks[0]!.clips[1]!, frame, envelope).opacity, 6);
    }
    near(values[39]!, 0xe0);
    expect(values[34]!).toBeGreaterThan(values[32]!);
  }, 60_000);

  it("dips through black on both sides of the cut", async () => {
    const project = timeline(
      { type: "add_clip", trackId: "video_1", assetId: light.id, start: 0, duration: 30 },
      { type: "add_clip", trackId: "video_1", assetId: light.id, sourceIn: 30, start: 30, duration: 30 },
      { type: "set_transition", clipId: "clip_2", transition: { type: "dip", duration: 10 } },
    );
    const values = await brightness(await render(project, "dip"));
    expect(values).toHaveLength(60);
    near(values[19]!, 0xe0);
    expect(values[29]!).toBeLessThan(0x40);
    expect(values[30]!).toBeLessThan(0x40);
    near(values[40]!, 0xe0);
  }, 60_000);

  it("animates opacity with keyframes along the same line as the preview", async () => {
    const project = timeline(
      { type: "add_track", kind: "video", id: "v2" },
      { type: "add_clip", trackId: "video_1", assetId: dark.id, start: 0, duration: 30 },
      { type: "add_clip", trackId: "v2", assetId: light.id, start: 0, duration: 30 },
      { type: "set_keyframes", clipId: "clip_2", property: "opacity", keyframes: [{ frame: 5, value: 0 }, { frame: 25, value: 1 }] },
    );
    const values = await brightness(await render(project, "keyframes"));
    const clip = project.timeline.tracks[1]!.clips[0]!;
    for (const frame of [0, 5, 10, 15, 20, 25, 29]) {
      near(values[frame]!, 0x20 + (0xe0 - 0x20) * lookAt(clip, frame).opacity, 6);
    }
  }, 60_000);

  it("animates scale so a layer grows over the frames", async () => {
    const project = timeline(
      { type: "add_track", kind: "video", id: "v2" },
      { type: "add_clip", trackId: "video_1", assetId: dark.id, start: 0, duration: 30 },
      { type: "add_clip", trackId: "v2", assetId: light.id, start: 0, duration: 30 },
      { type: "set_keyframes", clipId: "clip_2", property: "scale", keyframes: [{ frame: 0, value: 0.1 }, { frame: 29, value: 1 }] },
    );
    const values = await brightness(await render(project, "scale"), "iw/8:ih/8:0:0");
    near(values[0]!, 0x20);
    near(values[29]!, 0xe0);
  }, 60_000);

  it("mixes a music track at its own position with the video's sound", async () => {
    const project = timeline(
      { type: "add_track", kind: "audio", id: "music" },
      { type: "add_clip", trackId: "video_1", assetId: dark.id, start: 0, duration: 120, volume: 0 },
      { type: "add_clip", trackId: "music", assetId: music.id, start: 30, duration: 50 },
    );
    const output = await render(project, "music");
    const beeps = findBeepStarts(await readPcm(output));
    expect(beeps).toHaveLength(2);
    expect(Math.abs(beeps[0]! - 1)).toBeLessThan(0.06);
    expect(Math.abs(beeps[1]! - 2)).toBeLessThan(0.06);
    expect((await probeMedia(output)).frameCount).toBe(120);
  }, 60_000);

  it("fades sound with volume keyframes", async () => {
    const project = timeline(
      { type: "add_clip", trackId: "video_1", assetId: dark.id, start: 0, duration: 60 },
      { type: "set_keyframes", clipId: "clip_1", property: "volume", keyframes: [{ frame: 0, value: 100 }, { frame: 59, value: 0 }] },
    );
    const pcm = await readPcm(await render(project, "volume"));
    const level = (from: number) => {
      let peak = 0;
      for (let index = from; index < from + 2000; index++) peak = Math.max(peak, Math.abs(pcm[index]!));
      return peak;
    };
    expect(level(4000)).toBeGreaterThan(level(48000));
    expect(level(90000)).toBeLessThan(level(48000));
  }, 60_000);

  it("draws Vietnamese text into the video where the transform puts it", async () => {
    const project = timeline(
      { type: "add_track", kind: "text", id: "subs" },
      { type: "add_clip", trackId: "video_1", assetId: dark.id, start: 0, duration: 20 },
      { type: "add_text", trackId: "subs", start: 5, duration: 10, text: "Tiếng Việt", style: { fontSize: 20, color: "#ffffff" }, transform: { y: -0.3 } },
    );
    const output = await render(project, "text");
    const top = await brightness(output, "iw/2:ih/4:iw/4:0");
    const bottom = await brightness(output, "iw/2:ih/4:iw/4:ih*3/4");
    expect(top).toHaveLength(20);
    near(top[4]!, 0x20);
    expect(top[10]!).toBeGreaterThan(0x30);
    near(top[15]!, 0x20);
    near(bottom[10]!, 0x20);
  }, 60_000);

  it("renders the text picture with its transparency and box", () => {
    const style = TextStyle.parse({ background: "#112233" });
    const png = renderTextImage("Xin chào", style, 320, 180);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(renderTextImage("Xin chào", TextStyle.parse({}), 320, 180).equals(png)).toBe(false);
  });

  it("shows layers and text in get_frame", async () => {
    const project = timeline(
      { type: "add_track", kind: "video", id: "v2" },
      { type: "add_clip", trackId: "video_1", assetId: dark.id, start: 0, duration: 20 },
      { type: "add_clip", trackId: "v2", assetId: light.id, start: 10, duration: 10 },
    );
    const gray = async (frame: number) => {
      const path = join(dir, `frame-${frame}.jpg`);
      writeFileSync(path, await extractFrame(project, { kind: "timeline" }, frame, 160));
      return (await brightness(path, "iw/2:ih/2:iw/4:ih/4"))[0]!;
    };
    near(await gray(5), 0x20, 6);
    near(await gray(15), 0xe0, 6);
  }, 60_000);

  it("renders part of the timeline with a transition looking as it does in the whole", async () => {
    const project = timeline(
      { type: "add_clip", trackId: "video_1", assetId: dark.id, start: 0, duration: 30 },
      { type: "add_clip", trackId: "video_1", assetId: light.id, start: 30, duration: 30 },
      { type: "set_transition", clipId: "clip_2", transition: { type: "crossfade", duration: 9 } },
    );
    const whole = await brightness(await render(project, "whole"));
    const output = join(dir, "part.mp4");
    await exportProject(project, output, { range: { start: 33, end: 37 }, textDir: join(dir, "text") });
    const part = await brightness(output);
    expect(part).toHaveLength(4);
    part.forEach((value, index) => near(value, whole[33 + index]!, 3));
  }, 60_000);

  it("keeps frames of an fps other than 30 exact through a layered export", async () => {
    const fps = { num: 25, den: 1 };
    const fresh = new CommandEngine(createProject({ name: "t", width: WIDTH, height: HEIGHT, fps }));
    const made = await importVideo(root, join(dir, "dark.mp4"), fps);
    fresh.registerAsset(made.asset);
    apply(fresh, { type: "add_track", kind: "text", id: "t" }, { type: "add_clip", trackId: "video_1", assetId: made.asset.id, start: 0, duration: 50 }, { type: "add_text", trackId: "t", start: 10, duration: 10, text: "25" });
    const info = await probeMedia(await render(fresh.project, "fps25"));
    expect(info.frameCount).toBe(50);
    expect(info.averageFps).toBeCloseTo(25, 1);
  }, 60_000);

  it("kills a running export on cancel and leaves no file behind", async () => {
    const workspaceRoot = join(dir, "workspace");
    mkdirSync(workspaceRoot);
    const workspace = new Workspace(workspaceRoot, [dir]);
    const created = workspace.create("c", { width: 1280, height: 720 });
    const imported = await importVideo(workspace.projectRoot("c"), join(dir, "light.mp4"), { num: 30, den: 1 });
    created.registerAsset(imported.asset);
    apply(created, { type: "add_clip", trackId: "video_1", assetId: imported.asset.id, start: 0, duration: 180 }, { type: "set_transform", clipId: "clip_1", scale: 1.5 });
    const job = workspace.startExport("c", "stop");
    await new Promise((resolve) => setTimeout(resolve, 150));
    workspace.jobs.cancel(job.id);
    const finished = await workspace.jobs.wait(job.id, 10_000);
    expect(finished?.status).toBe("cancelled");
    const exports = join(workspace.projectRoot("c"), "exports");
    expect(existsSync(exports) ? readdirSync(exports) : []).toEqual([]);
    expect(openProjectFolder(workspace.projectRoot("c")).project.revision).toBe(created.project.revision);
  }, 60_000);
});
