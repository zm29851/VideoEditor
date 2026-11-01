import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandError } from "../src/commands.ts";
import { CommandEngine, StaleRevisionError, createProject } from "../src/engine.ts";
import type { Asset, CommandInput } from "../src/schema.ts";
import { createProjectFolder, openProjectFolder } from "../src/store.ts";
import { frameToSample, frameToTimecode, secondsToFrame } from "../src/time.ts";

const asset: Asset = {
  id: "a1",
  name: "a.mp4",
  originalPath: "/a.mp4",
  masterPath: "/a.mp4",
  proxyPath: "/p.mp4",
  durationFrames: 300,
  width: 1920,
  height: 1080,
  hasAudio: true,
  normalization: { transcoded: false, reasons: [], sourceFps: 30, wasHdr: false },
};

function setup(): CommandEngine {
  const engine = new CommandEngine(createProject({ name: "t" }));
  engine.registerAsset(asset);
  return engine;
}

function run(engine: CommandEngine, ...commands: CommandInput[]) {
  return engine.applyBatch({ actor: "user", baseRevision: engine.project.revision, label: "t", commands });
}

const add = (start: number, duration: number, sourceIn = 0): CommandInput => ({
  type: "add_clip",
  trackId: "video_1",
  assetId: "a1",
  start,
  sourceIn,
  duration,
});

const clips = (engine: CommandEngine) => engine.project.timeline.tracks[0]!.clips;

describe("commands", () => {
  it("split keeps source frames continuous", () => {
    const engine = setup();
    const [id] = run(engine, add(10, 100, 50)).createdClipIds;
    run(engine, { type: "split_clip", clipId: id!, at: 40 });
    expect(clips(engine).map((c) => [c.start, c.sourceIn, c.duration])).toEqual([
      [10, 50, 30],
      [40, 80, 70],
    ]);
  });

  it("rejects a split outside the clip with a useful message", () => {
    const engine = setup();
    const [id] = run(engine, add(10, 100)).createdClipIds;
    expect(() => run(engine, { type: "split_clip", clipId: id!, at: 10 })).toThrow(CommandError);
    expect(() => run(engine, { type: "split_clip", clipId: id!, at: 500 })).toThrow(/frame 10\.\.110/);
  });

  it("trims both edges", () => {
    const engine = setup();
    const [id] = run(engine, add(10, 100, 50)).createdClipIds;
    run(engine, { type: "trim_clip", clipId: id!, edge: "start", delta: 5 });
    expect(clips(engine)[0]).toMatchObject({ start: 15, sourceIn: 55, duration: 95 });
    run(engine, { type: "trim_clip", clipId: id!, edge: "end", delta: -15 });
    expect(clips(engine)[0]).toMatchObject({ start: 15, sourceIn: 55, duration: 80 });
  });

  it("rejects trims past the asset, past timeline start, or to zero length", () => {
    const engine = setup();
    const [id] = run(engine, add(10, 100, 5)).createdClipIds;
    expect(() => run(engine, { type: "trim_clip", clipId: id!, edge: "end", delta: 1000 })).toThrow(/300 frame/);
    expect(() => run(engine, { type: "trim_clip", clipId: id!, edge: "start", delta: -6 })).toThrow(CommandError);
    expect(() => run(engine, { type: "trim_clip", clipId: id!, edge: "start", delta: 100 })).toThrow(/1 frame/);
  });

  it("rejects overlaps on a track", () => {
    const engine = setup();
    run(engine, add(0, 100));
    expect(() => run(engine, add(99, 10))).toThrow(/chồng lên/);
    expect(() => run(engine, add(100, 10))).not.toThrow();
  });

  it("ripple delete closes the gap", () => {
    const engine = setup();
    const [first] = run(engine, add(0, 30), add(30, 30), add(60, 30)).createdClipIds;
    run(engine, { type: "delete_clip", clipId: first!, ripple: true });
    expect(clips(engine).map((c) => c.start)).toEqual([0, 30]);
  });
});

describe("engine", () => {
  it("rolls back a whole batch when one command fails", () => {
    const engine = setup();
    const before = engine.project;
    expect(() => run(engine, add(0, 30), add(10, 30))).toThrow(CommandError);
    expect(engine.project).toEqual(before);
    expect(engine.history).toHaveLength(0);
  });

  it("rejects stale revisions", () => {
    const engine = setup();
    const stale = engine.project.revision;
    run(engine, add(0, 30));
    expect(() =>
      engine.applyBatch({ actor: "agent", baseRevision: stale, label: "t", commands: [add(30, 30)] }),
    ).toThrow(StaleRevisionError);
  });

  it("undoes a batch as one step and redoes it", () => {
    const engine = setup();
    run(engine, add(0, 30));
    run(engine, add(30, 30), add(60, 30));
    engine.undo("user", engine.project.revision);
    expect(clips(engine)).toHaveLength(1);
    engine.undo("user", engine.project.revision);
    expect(clips(engine)).toHaveLength(0);
    expect(() => engine.undo("user", engine.project.revision)).toThrow(CommandError);
    engine.redo("user", engine.project.revision);
    engine.redo("user", engine.project.revision);
    expect(clips(engine)).toHaveLength(3);
    expect(() => engine.redo("user", engine.project.revision)).toThrow(CommandError);
  });

  it("a new edit clears redo", () => {
    const engine = setup();
    run(engine, add(0, 30));
    engine.undo("user", engine.project.revision);
    run(engine, add(100, 30));
    expect(() => engine.redo("user", engine.project.revision)).toThrow(CommandError);
  });

  it("undo does not remove assets", () => {
    const engine = setup();
    run(engine, add(0, 30));
    engine.undo("user", engine.project.revision);
    expect(engine.project.assets).toHaveLength(1);
  });

  it("records who made each change", () => {
    const engine = setup();
    engine.applyBatch({ actor: "agent", baseRevision: engine.project.revision, label: "Bỏ khoảng lặng", commands: [add(0, 30)] });
    expect(engine.history[0]).toMatchObject({ actor: "agent", label: "Bỏ khoảng lặng" });
  });
});

describe("store", () => {
  it("restores timeline, history and undo after reopening", () => {
    const root = join(mkdtempSync(join(tmpdir(), "ve-store-")), "project");
    try {
      const engine = createProjectFolder(root, { name: "t" });
      engine.registerAsset(asset);
      run(engine, add(0, 30));
      run(engine, add(30, 30));

      const reopened = openProjectFolder(root);
      expect(reopened.project).toEqual(engine.project);
      reopened.undo("user", reopened.project.revision);
      expect(clips(reopened)).toHaveLength(1);

      const again = openProjectFolder(root);
      again.redo("user", again.project.revision);
      expect(clips(again)).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("time", () => {
  it("snaps seconds to frames", () => {
    expect(secondsToFrame(10, { num: 30, den: 1 })).toBe(300);
    expect(secondsToFrame(10.01, { num: 30, den: 1 })).toBe(300);
    expect(secondsToFrame(1001 / 30000, { num: 30000, den: 1001 })).toBe(1);
  });

  it("formats timecode", () => {
    expect(frameToTimecode(0, { num: 30, den: 1 })).toBe("00:00:00:00");
    expect(frameToTimecode(3 * 3600 * 30 + 29, { num: 30, den: 1 })).toBe("03:00:00:29");
  });

  it("does not drift audio at 29.97 over an hour", () => {
    const fps = { num: 30000, den: 1001 };
    expect(frameToSample(30000 * 60, fps)).toBe(1001 * 60 * 48000);
  });
});
