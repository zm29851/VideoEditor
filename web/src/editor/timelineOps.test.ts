import { describe, expect, it } from "vitest";
import type { Asset, Clip, MediaClip, Track } from "../../../src/schema.ts";
import {
  clipAt,
  cutPoints,
  frameAtTime,
  nearestFreeStart,
  neighbourTrack,
  trackAccepts,
  resolveMove,
  resolveTrim,
  rulerStep,
  seekTimeForFrame,
  slugify,
  snapFrame,
} from "./timelineOps.ts";

const FPS = { num: 30, den: 1 };

function clip(id: string, start: number, duration: number, sourceIn = 0): MediaClip {
  return { id, assetId: "a", start, sourceIn, duration, volume: 100 };
}
const asset = { durationFrames: 300 } as Asset;

describe("frame mapping", () => {
  it("a seek to any frame reads back as that frame", () => {
    for (const fps of [FPS, { num: 30000, den: 1001 }, { num: 24, den: 1 }]) {
      for (let frame = 0; frame < 5000; frame += 37) {
        expect(frameAtTime(seekTimeForFrame(frame, fps), fps)).toBe(frame);
      }
    }
  });

  it("a clip owns its first frame but not the frame after its end", () => {
    const clips = [clip("a", 10, 5)];
    expect(clipAt(clips, 9)).toBeUndefined();
    expect(clipAt(clips, 10)?.id).toBe("a");
    expect(clipAt(clips, 14)?.id).toBe("a");
    expect(clipAt(clips, 15)).toBeUndefined();
  });
});

describe("moving", () => {
  it("stays where it was dropped when there is room", () => {
    expect(resolveMove([clip("b", 100, 50)], 20, 40)).toBe(40);
  });

  it("goes to the nearest free place instead of overlapping", () => {
    const others = [clip("b", 100, 50)];
    expect(resolveMove(others, 20, 95)).toBe(80);
    expect(resolveMove(others, 20, 140)).toBe(150);
  });

  it("skips a gap too small for the clip", () => {
    const others = [clip("b", 0, 50), clip("c", 60, 50)];
    expect(nearestFreeStart(others, 52, 20)).toBe(110);
  });

  it("does not go before the start of the timeline", () => {
    expect(resolveMove([], 20, -30)).toBe(0);
  });

  it("snaps by either edge", () => {
    const snap = { targets: [100], tolerance: 5 };
    expect(resolveMove([], 20, 97, snap)).toBe(100);
    expect(resolveMove([], 20, 78, snap)).toBe(80);
    expect(resolveMove([], 20, 40, snap)).toBe(40);
  });
});

describe("trimming", () => {
  it("cannot extend past the start of the source", () => {
    const result = resolveTrim(clip("a", 100, 50, 10), asset, [], "start", 50);
    expect(result).toEqual({ start: 90, sourceIn: 0, duration: 60 });
  });

  it("cannot extend past the end of the source", () => {
    const result = resolveTrim(clip("a", 0, 50, 280), asset, [], "end", 500);
    expect(result.duration).toBe(20);
  });

  it("stops at the neighbouring clips", () => {
    const others = [clip("b", 0, 95), clip("c", 160, 10)];
    expect(resolveTrim(clip("a", 100, 50, 50), asset, others, "start", 60).start).toBe(95);
    expect(resolveTrim(clip("a", 100, 50, 50), asset, others, "end", 200).duration).toBe(60);
  });

  it("keeps at least one frame", () => {
    expect(resolveTrim(clip("a", 100, 50), asset, [], "end", 10).duration).toBe(1);
    const result = resolveTrim(clip("a", 100, 50, 0), asset, [], "start", 400);
    expect(result).toEqual({ start: 149, sourceIn: 49, duration: 1 });
  });

  it("keeps the source frame under the end edge when trimming the start", () => {
    const before = clip("a", 100, 50, 20);
    const after = resolveTrim(before, asset, [], "start", 110);
    expect(after.sourceIn! + after.duration).toBe(before.sourceIn + before.duration);
    expect(after.start + after.duration).toBe(before.start + before.duration);
  });
});

describe("helpers", () => {
  it("snaps only within the tolerance", () => {
    expect(snapFrame(103, [100, 200], 5)).toBe(100);
    expect(snapFrame(110, [100, 200], 5)).toBe(110);
  });

  it("lists each cut once, in order", () => {
    expect(cutPoints([clip("b", 50, 10), clip("a", 0, 50)])).toEqual([0, 50, 60]);
  });

  it("uses wider ruler steps when zoomed out", () => {
    expect(rulerStep(16, FPS)).toBe(10);
    expect(rulerStep(4, FPS)).toBe(30);
    expect(rulerStep(0.1, FPS)).toBe(1800);
  });

  it("turns a Vietnamese name into a folder name", () => {
    expect(slugify("Video đầu tiên của tôi!")).toBe("Video-dau-tien-cua-toi");
    expect(slugify("!!!")).toBe("");
  });
});

describe("tracks", () => {
  const video = { id: "a", hasVideo: true, hasAudio: true, durationFrames: 300 } as Asset;
  const sound = { id: "s", hasVideo: false, hasAudio: true, durationFrames: 300 } as Asset;
  const text: Clip = { id: "t", kind: "text", start: 0, duration: 10, text: "x", style: { fontSize: 5, color: "#ffffff", background: null, weight: 600 } };
  const media = clip("c", 0, 10);
  const tracks: Track[] = [
    { id: "v1", kind: "video", clips: [media] },
    { id: "m", kind: "audio", clips: [] },
    { id: "v2", kind: "video", clips: [] },
    { id: "s", kind: "text", clips: [text] },
  ];

  it("lets each track take only what it can play", () => {
    expect(trackAccepts(tracks[0]!, media, [video])).toBe(true);
    expect(trackAccepts(tracks[1]!, media, [video])).toBe(true);
    expect(trackAccepts(tracks[3]!, media, [video])).toBe(false);
    expect(trackAccepts(tracks[0]!, { ...media, assetId: "s" }, [sound])).toBe(false);
    expect(trackAccepts(tracks[3]!, text, [])).toBe(true);
    expect(trackAccepts(tracks[0]!, text, [])).toBe(false);
  });

  it("finds the next track that can take the clip", () => {
    expect(neighbourTrack(tracks, media, 1, [video])?.id).toBe("m");
    expect(neighbourTrack(tracks, media, -1, [video])).toBeUndefined();
    expect(neighbourTrack(tracks, text, 1, [])).toBeUndefined();
  });

  it("trims text without any limit from a source", () => {
    expect(resolveTrim(text, undefined, [], "end", 500)).toEqual({ start: 0, duration: 500 });
  });
});
