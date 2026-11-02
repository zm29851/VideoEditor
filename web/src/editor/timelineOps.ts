import { isMediaClip, type Asset, type Clip, type FrameRate, type Project, type Track } from "../../../src/schema.ts";

export function clipEnd(clip: Clip): number {
  return clip.start + clip.duration;
}

export function timelineEnd(clips: readonly Clip[]): number {
  return clips.reduce((end, clip) => Math.max(end, clipEnd(clip)), 0);
}

export function clipAt<T extends Clip>(clips: readonly T[], frame: number): T | undefined {
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
  /** Absent for text, which has no source. */
  sourceIn?: number;
  duration: number;
  /** Only when pushing: how far the edge really moved, which a blocked start edge does not show. */
  delta?: number;
  /** Only when pushing: how far the clips from this frame on move back. */
  push?: number;
  pushFrom?: number;
}

/** Limits an edge to the source video, the neighbouring clips and a length of at least one frame. */
export function resolveTrim(
  clip: Clip,
  asset: Asset | undefined,
  others: Clip[],
  edge: "start" | "end",
  desired: number,
  snap?: SnapOptions,
  pushLater = false,
): TrimResult {
  const frame = snap ? snapFrame(desired, snap.targets, snap.tolerance) : desired;
  if (pushLater) return resolvePushingTrim(clip, asset, others, edge, frame);
  if (edge === "start") {
    const previousEnd = others.filter((other) => clipEnd(other) <= clip.start).reduce((end, other) => Math.max(end, clipEnd(other)), 0);
    const earliest = isMediaClip(clip) ? Math.max(previousEnd, clip.start - clip.sourceIn) : previousEnd;
    const start = Math.min(Math.max(frame, earliest), clipEnd(clip) - 1);
    const delta = start - clip.start;
    return { start, ...(isMediaClip(clip) ? { sourceIn: clip.sourceIn + delta } : {}), duration: clip.duration - delta };
  }
  const nextStart = others.filter((other) => other.start >= clipEnd(clip)).reduce((start, other) => Math.min(start, other.start), Infinity);
  const latest = isMediaClip(clip) && asset ? Math.min(nextStart, clip.start + asset.durationFrames - clip.sourceIn) : nextStart;
  const end = Math.max(Math.min(frame, latest), clip.start + 1);
  return { start: clip.start, ...(isMediaClip(clip) ? { sourceIn: clip.sourceIn } : {}), duration: end - clip.start };
}

/** As far as the source allows. A neighbour in the way moves back rather than stopping the edge. */
function resolvePushingTrim(clip: Clip, asset: Asset | undefined, others: Clip[], edge: "start" | "end", frame: number): TrimResult {
  const oldEnd = clipEnd(clip);
  const nextStart = others.filter((other) => other.start >= oldEnd).reduce((start, other) => Math.min(start, other.start), Infinity);
  const media = isMediaClip(clip);
  let start = clip.start;
  let delta: number;
  if (edge === "start") {
    const previousEnd = others.filter((other) => other.start < clip.start).reduce((end, other) => Math.max(end, clipEnd(other)), 0);
    delta = Math.min(frame - clip.start, clip.duration - 1);
    if (media) delta = Math.max(delta, -clip.sourceIn);
    start = delta < 0 ? Math.max(clip.start + delta, previousEnd) : clip.start + delta;
  } else {
    const latest = media && asset ? clip.start + asset.durationFrames - clip.sourceIn : Infinity;
    delta = Math.max(Math.min(frame, latest), clip.start + 1) - oldEnd;
  }
  const duration = edge === "start" ? clip.duration - delta : clip.duration + delta;
  return {
    start,
    ...(media ? { sourceIn: edge === "start" ? clip.sourceIn + delta : clip.sourceIn } : {}),
    duration,
    delta,
    push: Math.max(0, start + duration - nextStart),
    pushFrom: oldEnd,
  };
}

/** Whether a clip can be played by a track of this kind. */
export function trackAccepts(track: Track, clip: Clip, assets: readonly Asset[]): boolean {
  if (!isMediaClip(clip)) return track.kind === "text";
  const asset = assets.find((candidate) => candidate.id === clip.assetId);
  if (track.kind === "video") return asset?.hasVideo === true;
  return track.kind === "audio" && asset?.hasAudio === true;
}

/** The nearest track above or below that can take the clip, or undefined at the end of the list. */
export function neighbourTrack(tracks: readonly Track[], clip: Clip, direction: 1 | -1, assets: readonly Asset[]): Track | undefined {
  const current = tracks.findIndex((track) => track.clips.some((candidate) => candidate.id === clip.id));
  for (let index = current + direction; index >= 0 && index < tracks.length; index += direction) {
    if (trackAccepts(tracks[index]!, clip, assets)) return tracks[index];
  }
  return undefined;
}

/** A new track's id that nothing else on this timeline uses. */
export function freeTrackId(project: Project, kind: Track["kind"]): string {
  const used = new Set(project.timeline.tracks.map((track) => track.id));
  let number = 1;
  while (used.has(`${kind}_${number}`)) number++;
  return `${kind}_${number}`;
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
