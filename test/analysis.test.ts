import type { MediaClip } from "../src/schema.ts";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CommandEngine, createProject } from "../src/engine.ts";
import { assetLoudness, clipsLoudness, detectScenes, detectSilence, parseLoudness, parseSceneCuts, parseSilences } from "../src/media/analyze.ts";
import { ffmpeg } from "../src/media/ffmpeg.ts";
import { importVideo } from "../src/media/import.ts";
import { createProjectFolder } from "../src/store.ts";
import { findWhisper, parseWhisperOutput, transcribeAsset } from "../src/media/whisper.ts";
import type { Asset, Project, Transcript } from "../src/schema.ts";
import { isFiller, rangesForWords, sourceRangesOnTimeline, timelineTranscript } from "../src/transcript.ts";

const FPS = { num: 30, den: 1 };

function asset(id: string, durationFrames = 1000): Asset {
  return {
    id,
    name: `${id}.mp4`,
    originalPath: "/a",
    masterPath: "/a",
    proxyPath: "/a",
    durationFrames,
    width: 320,
    height: 180,
    hasVideo: true,
    hasAudio: true,
    normalization: { transcoded: false, reasons: [], sourceFps: 30, wasHdr: false },
  };
}

function engineWithClips(clips: Array<{ start: number; sourceIn: number; duration: number }>): CommandEngine {
  const project = createProject({ name: "t" });
  project.assets.push(asset("a"));
  const engine = new CommandEngine(project);
  engine.applyBatch({
    actor: "user",
    baseRevision: 0,
    label: "setup",
    commands: clips.map((clip) => ({ type: "add_clip" as const, trackId: "video_1", assetId: "a", ...clip })),
  });
  return engine;
}

function deleteRanges(engine: CommandEngine, ranges: Array<{ start: number; end: number }>, ripple = true) {
  return engine.applyBatch({
    actor: "agent",
    baseRevision: engine.project.revision,
    label: "xóa",
    commands: [{ type: "delete_ranges", trackId: "video_1", ranges, ripple }],
  });
}

const placed = (project: Project) => (project.timeline.tracks[0]!.clips as MediaClip[]).map(({ id, start, sourceIn, duration }) => ({ id, start, sourceIn, duration }));

describe("delete_ranges", () => {
  it("cuts several parts at once, reading each against the timeline before the edit", () => {
    const engine = engineWithClips([{ start: 0, sourceIn: 0, duration: 100 }]);
    const result = deleteRanges(engine, [
      { start: 60, end: 70 },
      { start: 10, end: 20 },
    ]);
    expect(placed(engine.project)).toEqual([
      { id: "clip_1", start: 0, sourceIn: 0, duration: 10 },
      { id: "clip_2", start: 10, sourceIn: 20, duration: 40 },
      { id: "clip_3", start: 50, sourceIn: 70, duration: 30 },
    ]);
    expect(result.createdClipIds).toEqual(["clip_2", "clip_3"]);
  });

  it("removes whole clips, spans clips and moves later clips up", () => {
    const engine = engineWithClips([
      { start: 0, sourceIn: 0, duration: 50 },
      { start: 50, sourceIn: 100, duration: 50 },
      { start: 100, sourceIn: 200, duration: 50 },
    ]);
    deleteRanges(engine, [{ start: 40, end: 100 }]);
    expect(placed(engine.project)).toEqual([
      { id: "clip_1", start: 0, sourceIn: 0, duration: 40 },
      { id: "clip_3", start: 40, sourceIn: 200, duration: 50 },
    ]);
  });

  it("can leave the gaps open, and undo takes it all back in one step", () => {
    const engine = engineWithClips([{ start: 0, sourceIn: 0, duration: 100 }]);
    const before = placed(engine.project);
    deleteRanges(engine, [{ start: 10, end: 20 }], false);
    expect(placed(engine.project)[1]).toMatchObject({ start: 20, sourceIn: 20, duration: 80 });
    engine.undo("user", engine.project.revision);
    expect(placed(engine.project)).toEqual(before);
  });

  it("merges overlapping ranges, and rejects what cannot apply without changing anything", () => {
    const engine = engineWithClips([{ start: 0, sourceIn: 0, duration: 100 }]);
    deleteRanges(engine, [
      { start: 10, end: 30 },
      { start: 20, end: 40 },
    ]);
    expect(placed(engine.project)[1]).toMatchObject({ start: 10, sourceIn: 40 });
    const revision = engine.project.revision;
    expect(() => deleteRanges(engine, [{ start: 500, end: 600 }])).toThrow(/không chạm vào clip nào/);
    expect(() => deleteRanges(engine, [{ start: 5, end: 5 }])).toThrow(/không hợp lệ/);
    expect(engine.project.revision).toBe(revision);
  });

  it("can be reverted on its own while later edits stay", () => {
    const engine = engineWithClips([{ start: 0, sourceIn: 0, duration: 100 }]);
    deleteRanges(engine, [{ start: 10, end: 20 }]);
    const revision = engine.project.revision;
    engine.applyBatch({ actor: "user", baseRevision: revision, label: "âm lượng", commands: [{ type: "set_volume", clipId: "clip_1", volume: 50 }] });
    engine.revert("user", engine.project.revision, revision);
    expect(engine.project.timeline.tracks[0]!.clips).toMatchObject([{ id: "clip_1", duration: 100, volume: 50 }]);
  });
});

describe("transcript on the timeline", () => {
  const transcript: Transcript = {
    assetId: "a",
    language: "vi",
    model: "m",
    segments: [
      {
        words: [
          { text: "xin", start: 0, end: 10, probability: 1 },
          { text: "ờ", start: 12, end: 20, probability: 1 },
          { text: "chào", start: 30, end: 40, probability: 1 },
          { text: "bạn", start: 40, end: 50, probability: 1 },
        ],
      },
    ],
  };
  const map = new Map([["a", transcript]]);

  it("follows the cuts: a word belongs to the clip holding its midpoint", () => {
    const { project } = engineWithClips([
      { start: 100, sourceIn: 30, duration: 20 },
      { start: 200, sourceIn: 0, duration: 11 },
    ]);
    const segments = timelineTranscript(project, map);
    expect(segments.map((segment) => [segment.clipId, segment.text, segment.start, segment.end])).toEqual([
      ["clip_1", "chào bạn", 100, 120],
      ["clip_2", "xin", 200, 210],
    ]);
  });

  it("marks only meaningless sounds as filler", () => {
    expect(isFiller("Ờ,")).toBe(true);
    expect(isFiller("ừm...")).toBe(true);
    expect(isFiller("chào")).toBe(false);
  });

  it("finds chosen words again after the timeline moved, joining the pause between them", () => {
    const refs = [
      { assetId: "a", sourceStart: 0, sourceEnd: 10, timelineStart: 0 },
      { assetId: "a", sourceStart: 12, sourceEnd: 20, timelineStart: 12 },
    ];
    expect(rangesForWords(engineWithClips([{ start: 0, sourceIn: 0, duration: 100 }]).project, refs)).toEqual([{ start: 0, end: 20 }]);
    expect(rangesForWords(engineWithClips([{ start: 500, sourceIn: 0, duration: 100 }]).project, refs)).toEqual([{ start: 500, end: 520 }]);
    expect(rangesForWords(engineWithClips([{ start: 0, sourceIn: 300, duration: 100 }]).project, refs)).toEqual([]);
  });

  it("chooses the nearest use when the same source is on the timeline twice", () => {
    const { project } = engineWithClips([
      { start: 0, sourceIn: 0, duration: 50 },
      { start: 100, sourceIn: 0, duration: 50 },
    ]);
    expect(rangesForWords(project, [{ assetId: "a", sourceStart: 30, sourceEnd: 40, timelineStart: 130 }])).toEqual([{ start: 130, end: 140 }]);
  });

  it("joins silence across a cut and leaves out what no clip uses", () => {
    const { project } = engineWithClips([
      { start: 0, sourceIn: 0, duration: 50 },
      { start: 50, sourceIn: 200, duration: 50 },
    ]);
    const ranges = sourceRangesOnTimeline(project, new Map([["a", [{ start: 40, end: 60 }, { start: 190, end: 210 }, { start: 500, end: 600 }]]]));
    expect(ranges).toEqual([{ start: 40, end: 60, clipIds: ["clip_1", "clip_2"] }]);
  });
});

describe("reading tool output", () => {
  it("rounds silence inward and closes one still open at the end", () => {
    const output = "lavfi.silence_start=1.01\nlavfi.silence_end=2.01\nlavfi.silence_start=9.5\n";
    expect(parseSilences(output, 300, FPS)).toEqual([
      { start: 31, end: 60 },
      { start: 285, end: 300 },
    ]);
  });

  it("reads scene cuts and loudness", () => {
    expect(parseSceneCuts("frame:0    pts:1000000 pts_time:1\nlavfi.scene_score=0.400000\n", FPS)).toEqual([{ frame: 30, score: 0.4 }]);
    expect(parseLoudness("Summary:\n I: -18.1 LUFS\n Threshold: -28.1 LUFS\n LRA: 9.1 LU\n Peak: -0.6 dBFS\n")).toEqual({
      integratedLufs: -18.1,
      loudnessRangeLu: 9.1,
      truePeakDbtp: -0.6,
    });
    expect(parseLoudness("Summary:\n I: -70.0 LUFS\n LRA: 0.0 LU\n Peak: -inf dBFS\n").integratedLufs).toBeNull();
  });

  it("keeps Vietnamese letters whole, starts a new line after a sentence, and places a word after skipped silence", () => {
    const latin1 = (text: string) => Buffer.from(text, "utf8").toString("latin1");
    const word = (text: string, from: number, to: number, tokenFrom: number, tokenTo: number, p = 1) => ({
      text: latin1(` ${text}`),
      offsets: { from, to },
      tokens: [{ text: latin1(` ${text}`), offsets: { from: tokenFrom, to: tokenTo }, p }],
    });
    const raw = Buffer.from(
      JSON.stringify({
        result: { language: "vi" },
        transcription: [
          { text: "", offsets: { from: 0, to: 100 }, tokens: [{ text: "[_BEG_]", offsets: { from: 0, to: 0 }, p: 1 }] },
          word("Việt", 100, 400, 100, 400, 0.5),
          word("Nam.", 400, 700, 400, 700),
          // Whisper saw 300 ms, and the span crosses ten seconds of silence that VAD skipped.
          word("Xin", 700, 11000, 700, 1000),
        ],
      }),
      "latin1",
    );
    expect(parseWhisperOutput(raw, "a", 1000, FPS, "m").segments).toEqual([
      {
        words: [
          { text: "Việt", start: 3, end: 12, probability: 0.5 },
          { text: "Nam.", start: 12, end: 21, probability: 1 },
        ],
      },
      { words: [{ text: "Xin", start: 321, end: 330, probability: 1 }] },
    ]);
  });
});

describe("real media", () => {
  let dir: string;
  let source: Asset;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ve-analysis-"));
    const path = join(dir, "source.mp4");
    // One second of tone, one of silence, one of tone. The picture changes colour at two seconds.
    await ffmpeg([
      "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=2",
      "-f", "lavfi", "-i", "color=blue:s=320x180:r=30:d=1",
      "-f", "lavfi", "-i", "aevalsrc='if(between(t,1,2),0,0.3*sin(2*PI*440*t))':s=48000:d=3",
      "-filter_complex", "[0][1]concat=n=2,format=yuv420p[v]",
      "-map", "[v]", "-map", "2:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", path,
    ]);
    createProjectFolder(join(dir, "p"), { name: "p" });
    ({ asset: source } = await importVideo(join(dir, "p"), path, FPS));
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("finds the silence and the scene change at the right frames", async () => {
    const [silence] = await detectSilence(source, FPS, -35, 0.5);
    expect(Math.abs(silence!.start - 30)).toBeLessThanOrEqual(2);
    expect(Math.abs(silence!.end - 60)).toBeLessThanOrEqual(2);
    expect((await detectScenes(source, FPS, 0.3)).map((scene) => scene.frame)).toEqual([60]);
  });

  it("measures loudness, and clip volume changes it by the right amount", async () => {
    const whole = await assetLoudness(source);
    expect(whole.integratedLufs).toBeGreaterThan(-30);
    const project = createProject({ name: "t" });
    project.assets.push(source);
    const clip = { id: "c", assetId: source.id, start: 0, sourceIn: 0, duration: 30, volume: 100 };
    const full = await clipsLoudness(project, [clip]);
    const half = await clipsLoudness(project, [{ ...clip, volume: 50 }]);
    expect(full.integratedLufs! - half.integratedLufs!).toBeCloseTo(6, 0);
  }, 30_000);
});

/** Real speech through the real binary, where this machine has both `say` and whisper. */
const canTranscribe = (() => {
  try {
    findWhisper();
    execFileSync("which", ["say"]);
    return process.env.VE_SKIP_WHISPER !== "1";
  } catch {
    return false;
  }
})();

describe.runIf(canTranscribe)("whisper", () => {
  it("transcribes speech with timings that land on the right frames", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ve-whisper-"));
    try {
      const first = join(dir, "first.aiff");
      const second = join(dir, "second.aiff");
      execFileSync("say", ["-v", "Samantha", "-o", first, "The quick brown fox."]);
      execFileSync("say", ["-v", "Samantha", "-o", second, "Jumps over the lazy dog."]);
      const path = join(dir, "source.mp4");
      // Silence before each sentence, so a word's time shows whether frames survive VAD skipping it.
      await ffmpeg([
        "-f", "lavfi", "-i", "color=gray:s=320x180:r=30:d=14",
        "-i", first,
        "-i", second,
        "-filter_complex", "[1:a]adelay=3000:all=1[a];[2:a]adelay=9000:all=1[b];[a][b]amix=inputs=2:normalize=0,apad[out]",
        "-map", "0:v", "-map", "[out]", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", path,
      ]);
      const root = join(dir, "p");
      createProjectFolder(root, { name: "p" });
      const { asset: video } = await importVideo(root, path, FPS);
      const stages: number[] = [];
      const transcript = await transcribeAsset(root, video, FPS, "en", findWhisper(), (_stage, percent) => stages.push(percent));
      const words = transcript.segments.flatMap((segment) => segment.words);
      const text = words.map((word) => word.text.toLowerCase()).join(" ");
      expect(text).toContain("quick brown fox");
      expect(Math.abs(words[0]!.start - 90)).toBeLessThanOrEqual(15);
      const jumps = words.find((word) => word.text.toLowerCase().startsWith("jump"))!;
      expect(Math.abs(jumps.start - 270)).toBeLessThanOrEqual(15);
      expect(stages.at(-1)).toBe(100);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 300_000);
});
