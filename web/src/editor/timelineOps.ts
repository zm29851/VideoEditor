import type { Asset, Clip, FrameRate } from "../../../src/schema.ts";

export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration;
}

export function timelineEnd(clips: Clip[]): number {
  return clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);
}

export function clipAt(clips: Clip[], frame: number): Clip | undefined {
  return clips.find((clip) => frame >= clip.start && frame < clipEnd(clip));
}

export function nextClipAfter(clips: Clip[], frame: number): Clip | undefined {
  return clips.filter((clip) => clip.start >= frame).sort((a, b) => a.start - b.start)[0];
}

/** Lands in the middle of the frame, so rounding in the decoder cannot show its neighbour. */
export function seekTimeForFrame(sourceFrame: number, fps: FrameRate): number {
  return ((sourceFrame + 0.5) * fps.den) / fps.num;
}

/** The source frame on screen at a given media time. */
export function frameAtTime(seconds: number, fps: FrameRate): number {
  return Math.floor((seconds * fps.num) / fps.den + 1e-3);
}

/** Every position worth stopping at: clip edges and the start of the timeline. */
export function cutPoints(clips: Clip[]): number[] {
  return [...new Set([0, ...clips.flatMap((clip) => [clip.start, clipEnd(clip)])])].sort((a, b) => a - b);
}

export function snapFrame(frame: number, targets: number[], tolerance: number): number {
  let best = frame;
  let bestDistance = tolerance + 1;
  for (const target of targets) {
    const distance = Math.abs(target - frame);
    if (distance < bestDistance) {
      best = target;
      bestDistance = distance;
    }
  }
  return best;
}

export interface SnapOptions {
  targets: number[];
  tolerance: number;
}

/** The nearest start at or after 0 where a clip of this length touches no other clip. */
export function nearestFreeStart(others: Clip[], desired: number, duration: number): number {
  const sorted = [...others].sort((a, b) => a.start - b.start);
  const candidates = [0, ...sorted.map(clipEnd), ...sorted.map((clip) => clip.start - duration)].filter((start) => start >= 0);
  const fits = (start: number) => others.every((clip) => start + duration <= clip.start || start >= clipEnd(clip));
  if (desired >= 0 && fits(desired)) return desired;
  return candidates.filter(fits).sort((a, b) => Math.abs(a - desired) - Math.abs(b - desired))[0]!;
}

/** Where a dragged clip lands: either edge may snap, and it never lands on another clip. */
export function resolveMove(others: Clip[], duration: number, desired: number, snap?: SnapOptions): number {
  let start = Math.max(0, desired);
  if (snap) {
    const byStart = snapFrame(start, snap.targets, snap.tolerance);
    const byEnd = snapFrame(start + duration, snap.targets, snap.tolerance) - duration;
    const snapped = [byStart, byEnd].filter((candidate) => candidate !== start);
    start = snapped.sort((a, b) => Math.abs(a - start) - Math.abs(b - start))[0] ?? start;
  }
  return nearestFreeStart(others, Math.max(0, start), duration);
}

export interface TrimResult {
  start: number;
  sourceIn: number;
  duration: number;
}

/** Limits an edge to the source video, the neighbouring clips and a length of at least one frame. */
export function resolveTrim(
  clip: Clip,
  asset: Asset,
  others: Clip[],
  edge: "start" | "end",
  desired: number,
  snap?: SnapOptions,
): TrimResult {
  const frame = snap ? snapFrame(desired, snap.targets, snap.tolerance) : desired;
  if (edge === "start") {
    const previousEnd = others.filter((other) => clipEnd(other) <= clip.start).reduce((end, other) => Math.max(end, clipEnd(other)), 0);
    const earliest = Math.max(previousEnd, clip.start - clip.sourceIn);
    const start = Math.min(Math.max(frame, earliest), clipEnd(clip) - 1);
    const delta = start - clip.start;
    return { start, sourceIn: clip.sourceIn + delta, duration: clip.duration - delta };
  }
  const nextStart = others.filter((other) => other.start >= clipEnd(clip)).reduce((start, other) => Math.min(start, other.start), Infinity);
  const latest = Math.min(nextStart, clip.start + asset.durationFrames - clip.sourceIn);
  const end = Math.max(Math.min(frame, latest), clip.start + 1);
  return { start: clip.start, sourceIn: clip.sourceIn, duration: end - clip.start };
}

const TICK_STEPS_SECONDS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
const MIN_TICK_SPACING_PX = 96;

/** Frames between labelled ruler marks: whole seconds, or fractions of one when zoomed far in. */
export function rulerStep(pxPerFrame: number, fps: FrameRate): number {
  const base = Math.round(fps.num / fps.den);
  for (const frames of [1, 5, 10, Math.round(base / 2)]) {
    if (frames < base && frames * pxPerFrame >= MIN_TICK_SPACING_PX) return frames;
  }
  for (const seconds of TICK_STEPS_SECONDS) {
    if (seconds * base * pxPerFrame >= MIN_TICK_SPACING_PX) return seconds * base;
  }
  return 7200 * base;
}

/** A project name written in Vietnamese becomes a safe folder name. */
export function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
}
