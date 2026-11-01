import type { MediaClip } from "../src/schema.ts";
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
  hasVideo: true,
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
    expect((clips(engine) as MediaClip[]).map((c) => [c.start, c.sourceIn, c.duration])).toEqual([
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
    expect((clips(engine) as MediaClip[]).map((c) => c.start)).toEqual([0, 30]);
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

describe("reverting one batch", () => {
  const batch = (engine: CommandEngine, actor: "user" | "agent", label: string, ...commands: CommandInput[]) =>
    engine.applyBatch({ actor, baseRevision: engine.project.revision, label, commands });
  const layout = (engine: CommandEngine) => (clips(engine) as MediaClip[]).map((c) => [c.id, c.start, c.duration, c.volume]);

  it("takes back an older batch and keeps later edits", () => {
    const engine = setup();
    const [a] = batch(engine, "user", "thêm", add(0, 100)).createdClipIds;
    const agent = batch(engine, "agent", "agent cắt", { type: "split_clip", clipId: a!, at: 40 });
    const [later] = batch(engine, "user", "thêm nữa", add(200, 50)).createdClipIds;
    batch(engine, "user", "âm lượng", { type: "set_volume", clipId: a!, volume: 50 });

    engine.revert("user", engine.project.revision, agent.revision);
    expect(layout(engine)).toEqual([
      [a, 0, 100, 50],
      [later, 200, 50, 100],
    ]);
  });

  it("restores clips the batch deleted, and undo brings the batch back", () => {
    const engine = setup();
    const [a] = batch(engine, "user", "thêm", add(0, 100)).createdClipIds;
    const agent = batch(engine, "agent", "agent xóa", { type: "delete_clip", clipId: a!, ripple: false });
    const without = layout(engine);

    engine.revert("user", engine.project.revision, agent.revision);
    expect(layout(engine)).toEqual([[a, 0, 100, 100]]);
    expect(engine.undoLabel).toBe("Hoàn tác lô: agent xóa");

    engine.undo("user", engine.project.revision);
    expect(layout(engine)).toEqual(without);
    expect(engine.activity().find((entry) => entry.revision === agent.revision)?.state).toBe("active");
  });

  it("refuses when a later edit changed what the batch touched, and changes nothing", () => {
    const engine = setup();
    const [a] = batch(engine, "user", "thêm", add(0, 100)).createdClipIds;
    const agent = batch(engine, "agent", "agent đẩy", { type: "move_clip", clipId: a!, start: 50 });
    batch(engine, "user", "người đẩy", { type: "move_clip", clipId: a!, start: 80 });
    const revision = engine.project.revision;
    const before = layout(engine);

    expect(() => engine.revert("user", revision, agent.revision)).toThrow(new RegExp(`clip "${a}" đã được sửa sau đó`));
    expect(layout(engine)).toEqual(before);
    expect(engine.project.revision).toBe(revision);
  });

  it("refuses a result with overlapping clips", () => {
    const engine = setup();
    const [a] = batch(engine, "user", "thêm", add(0, 100)).createdClipIds;
    const agent = batch(engine, "agent", "agent đẩy", { type: "move_clip", clipId: a!, start: 200 });
    batch(engine, "user", "lấp chỗ", add(0, 100));
    expect(() => engine.revert("user", engine.project.revision, agent.revision)).toThrow(/chồng lên/);
  });

  it("cannot revert twice, or a batch already undone, or a stale revision", () => {
    const engine = setup();
    const [a] = batch(engine, "user", "thêm", add(0, 100)).createdClipIds;
    const agent = batch(engine, "agent", "âm lượng", { type: "set_volume", clipId: a!, volume: 10 });

    expect(() => engine.revert("user", 0, agent.revision)).toThrow(StaleRevisionError);
    const reverted = engine.revert("user", engine.project.revision, agent.revision);
    expect(() => engine.revert("user", engine.project.revision, agent.revision)).toThrow(/đã được hoàn tác/);
    expect(() => engine.revert("user", engine.project.revision, reverted.revision)).toThrow(/Hoàn tác để lấy lại/);

    engine.undo("user", engine.project.revision);
    engine.undo("user", engine.project.revision);
    expect(() => engine.revert("user", engine.project.revision, agent.revision)).toThrow(/không còn trên timeline/);
  });

  it("activity says who changed which clips and what is still in effect", () => {
    const engine = setup();
    const [a] = batch(engine, "user", "thêm", add(0, 100)).createdClipIds;
    const agent = batch(engine, "agent", "cắt", { type: "split_clip", clipId: a!, at: 40 });
    engine.revert("user", engine.project.revision, agent.revision);

    const [revertEntry, agentEntry, userEntry] = engine.activity();
    expect(revertEntry).toMatchObject({ actor: "user", revertsRevision: agent.revision, state: "active", revertible: false });
    expect(agentEntry).toMatchObject({ actor: "agent", state: "reverted", revertible: false });
    expect(agentEntry!.changes).toEqual({ added: [agent.createdClipIds[0]], removed: [], modified: [a] });
    expect(userEntry).toMatchObject({ actor: "user", state: "active", revertible: true });
    expect(engine.activity(1)).toHaveLength(1);
  });

  it("survives reopening the project", () => {
    const root = mkdtempSync(join(tmpdir(), "ve-revert-"));
    try {
      const engine = createProjectFolder(root, { name: "t" });
      engine.registerAsset(asset);
      const [a] = batch(engine, "user", "thêm", add(0, 100)).createdClipIds;
      const agent = batch(engine, "agent", "âm lượng", { type: "set_volume", clipId: a!, volume: 10 });
      engine.revert("user", engine.project.revision, agent.revision);

      const reopened = openProjectFolder(root);
      expect(reopened.activity()[1]?.state).toBe("reverted");
      expect(() => reopened.revert("user", reopened.project.revision, agent.revision)).toThrow(/đã được hoàn tác/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("tells subscribers about every change until they stop listening", () => {
    const engine = setup();
    let calls = 0;
    const stop = engine.subscribe(() => calls++);
    const [a] = batch(engine, "user", "thêm", add(0, 100)).createdClipIds;
    engine.registerAsset({ ...asset, id: "a2" });
    expect(() => batch(engine, "user", "sai", { type: "split_clip", clipId: a!, at: 0 })).toThrow();
    expect(calls).toBe(2);
    stop();
    batch(engine, "user", "âm lượng", { type: "set_volume", clipId: a!, volume: 1 });
    expect(calls).toBe(2);
  });
});

describe("naming a new clip inside a batch", () => {
  it("a later command can act on a clip made earlier in the batch, and undo reverts all of it", () => {
    const engine = setup();
    const start = engine.project.revision;
    const result = engine.applyBatch({
      actor: "agent",
      baseRevision: start,
      label: "t",
      commands: [
        { ...add(0, 100), as: "dau" } as CommandInput,
        { type: "split_clip", clipId: "dau", at: 40, as: "sau" },
        { type: "set_volume", clipId: "sau", volume: 50 },
      ],
    });
    expect(result.aliases).toEqual({ dau: result.createdClipIds[0], sau: result.createdClipIds[1] });
    expect((clips(engine) as MediaClip[]).map((c) => [c.id, c.start, c.duration, c.volume])).toEqual([
      [result.aliases.dau, 0, 40, 100],
      [result.aliases.sau, 40, 60, 50],
    ]);

    const stored = engine.history.at(-1)!.commands;
    expect(stored[1]).toMatchObject({ clipId: result.aliases.dau });
    expect(stored[2]).toMatchObject({ clipId: result.aliases.sau });

    engine.undo("agent", result.revision);
    expect(clips(engine)).toEqual([]);
  });

  it("the name is forgotten after the batch", () => {
    const engine = setup();
    engine.applyBatch({ actor: "agent", baseRevision: engine.project.revision, label: "t", commands: [{ ...add(0, 100), as: "dau" } as CommandInput] });
    expect(() => run(engine, { type: "set_volume", clipId: "dau", volume: 1 })).toThrow(/Không có clip "dau"/);
  });

  it("refuses a repeated name, or one that hides an existing clip, and changes nothing", () => {
    const engine = setup();
    const [existing] = run(engine, add(0, 10)).createdClipIds;
    const revision = engine.project.revision;
    const batch = (...commands: CommandInput[]) => engine.applyBatch({ actor: "agent", baseRevision: revision, label: "t", commands });

    expect(() => batch({ ...add(20, 10), as: "x" } as CommandInput, { ...add(40, 10), as: "x" } as CommandInput)).toThrow(/đã được dùng/);
    expect(() => batch({ ...add(20, 10), as: existing } as CommandInput)).toThrow(/trùng với một clip/);
    expect(engine.project.revision).toBe(revision);
    expect(clips(engine)).toHaveLength(1);
  });
});
