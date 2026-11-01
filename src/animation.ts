import { isMediaClip, type Asset, type Clip, type Keyframe, type Keyframes, type MediaClip, type Transform } from "./schema.ts";

/** Shared by the preview and the export, so the two work out the same values for every frame. */

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, opacity: 1 };

export function valueAt(keyframes: Keyframe[] | undefined, frame: number, fallback: number): number {
  if (!keyframes || keyframes.length === 0) return fallback;
  const first = keyframes[0]!;
  if (frame <= first.frame) return first.value;
  for (let index = 1; index < keyframes.length; index++) {
    const next = keyframes[index]!;
    if (frame < next.frame) {
      const previous = keyframes[index - 1]!;
      return previous.value + ((next.value - previous.value) * (frame - previous.frame)) / (next.frame - previous.frame);
    }
  }
  return keyframes.at(-1)!.value;
}

/** The part of the keyframes inside from..to, counted from the new start. The ends keep their values. */
export function sliceKeyframes(keyframes: Keyframe[], from: number, to: number): Keyframe[] {
  const inside = keyframes.filter((key) => key.frame > from && key.frame < to).map((key) => ({ frame: key.frame - from, value: key.value }));
  return [{ frame: 0, value: valueAt(keyframes, from, 0) }, ...inside, { frame: to - from - 1, value: valueAt(keyframes, to - 1, 0) }].filter(
    (key, index, list) => index === 0 || key.frame > list[index - 1]!.frame,
  );
}

export function sliceAllKeyframes(keyframes: Keyframes | undefined, from: number, to: number): Keyframes | undefined {
  if (!keyframes) return undefined;
  return Object.fromEntries(Object.entries(keyframes).map(([property, list]) => [property, sliceKeyframes(list, from, to)])) as Keyframes;
}

export function shiftKeyframes(keyframes: Keyframes | undefined, by: number): Keyframes | undefined {
  if (!keyframes) return undefined;
  return Object.fromEntries(
    Object.entries(keyframes).map(([property, list]) => [property, list.map((key) => ({ frame: key.frame + by, value: key.value }))]),
  ) as Keyframes;
}

export interface ClipEnvelope {
  fadeIn: number;
  fadeOut: number;
  /** Frames the clip before keeps playing underneath, past its own end. */
  tail?: { clip: Clip; frames: number };
}

const NO_ENVELOPE: ClipEnvelope = { fadeIn: 0, fadeOut: 0 };

/** Frames of source left after a clip's last frame. A still text has as many as it needs. */
function handleAfter(clip: Clip, assets: readonly Asset[]): number {
  if (!isMediaClip(clip)) return Infinity;
  const asset = assets.find((candidate) => candidate.id === clip.assetId);
  return asset ? Math.max(0, asset.durationFrames - clip.sourceIn - clip.duration) : 0;
}

/**
 * What the transitions on one track mean right now. Later edits can move clips apart or use up the
 * source, so this never fails: with nothing to dissolve from, the clip simply fades in.
 */
export function trackEnvelopes(clips: readonly Clip[], assets: readonly Asset[]): Map<string, ClipEnvelope> {
  const sorted = [...clips].sort((a, b) => a.start - b.start);
  const envelopes = new Map<string, ClipEnvelope>(sorted.map((clip) => [clip.id, { ...NO_ENVELOPE }]));
  sorted.forEach((clip, index) => {
    const transition = clip.transitionIn;
    if (!transition) return;
    const envelope = envelopes.get(clip.id)!;
    const previous = sorted[index - 1];
    const touching = previous !== undefined && previous.start + previous.duration === clip.start;
    if (transition.type === "dip") {
      envelope.fadeIn = Math.min(Math.ceil(transition.duration / 2), clip.duration);
      if (touching) envelopes.get(previous.id)!.fadeOut = Math.min(Math.floor(transition.duration / 2), previous.duration);
      return;
    }
    envelope.fadeIn = Math.min(transition.duration, clip.duration);
    if (touching) {
      const frames = Math.min(envelope.fadeIn, handleAfter(previous, assets));
      if (frames > 0) {
        envelope.fadeIn = frames;
        envelope.tail = { clip: previous, frames };
      }
    }
  });
  return envelopes;
}

/** 1 outside the fades. Never quite 0 or 1 inside them, so each fade frame differs from a plain cut. */
export function envelopeAt(envelope: ClipEnvelope, frame: number, duration: number): number {
  const fadingIn = frame < envelope.fadeIn ? (frame + 1) / (envelope.fadeIn + 1) : 1;
  const fadingOut = frame >= duration - envelope.fadeOut ? (duration - frame) / (envelope.fadeOut + 1) : 1;
  return fadingIn * fadingOut;
}

export interface FrameLook {
  x: number;
  y: number;
  scale: number;
  opacity: number;
}

/** Position, size and opacity of a clip at a frame inside it. Frames past the end hold the last values. */
export function lookAt(clip: Clip, frame: number, envelope: ClipEnvelope = NO_ENVELOPE): FrameLook {
  const base = clip.transform ?? DEFAULT_TRANSFORM;
  const inside = Math.min(frame, clip.duration - 1);
  return {
    x: valueAt(clip.keyframes?.x, inside, base.x),
    y: valueAt(clip.keyframes?.y, inside, base.y),
    scale: Math.max(0.01, valueAt(clip.keyframes?.scale, inside, base.scale)),
    opacity: Math.min(1, Math.max(0, valueAt(clip.keyframes?.opacity, inside, base.opacity))) * (frame < clip.duration ? envelopeAt(envelope, frame, clip.duration) : 1),
  };
}

/** Linear gain, where 1 is the original level, including the fades of a transition. */
export function gainAt(clip: MediaClip, frame: number, envelope: ClipEnvelope = NO_ENVELOPE): number {
  const level = Math.max(0, valueAt(clip.keyframes?.volume, Math.min(frame, clip.duration - 1), clip.volume)) / 100;
  return level * (frame < clip.duration ? envelopeAt(envelope, frame, clip.duration) : 1);
}

/** Inside a dissolve the clip before keeps sounding and fades out as the new clip fades in. */
export function tailGainAt(clip: MediaClip, tailFrame: number, frames: number): number {
  return gainAt(clip, clip.duration) * (1 - (tailFrame + 1) / (frames + 1));
}
