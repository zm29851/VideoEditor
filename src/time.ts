import type { FrameRate } from "./schema.ts";

export const AUDIO_SAMPLE_RATE = 48_000;

export function fpsToNumber(fps: FrameRate): number {
  return fps.num / fps.den;
}

export function fpsToFilterString(fps: FrameRate): string {
  return `${fps.num}/${fps.den}`;
}

export function framesToSeconds(frame: number, fps: FrameRate): number {
  return (frame * fps.den) / fps.num;
}

/** Snaps a time in seconds to the nearest frame. */
export function secondsToFrame(seconds: number, fps: FrameRate): number {
  return Math.round((seconds * fps.num) / fps.den);
}

/** Sample where a timeline frame begins. Keeps audio in step with video on long timelines. */
export function frameToSample(frame: number, fps: FrameRate): number {
  return Math.round((frame * fps.den * AUDIO_SAMPLE_RATE) / fps.num);
}

/** Non-drop timecode, as hh:mm:ss:ff at the rounded frame rate. */
export function frameToTimecode(frame: number, fps: FrameRate): string {
  const base = Math.round(fpsToNumber(fps));
  const pad = (value: number) => String(value).padStart(2, "0");
  const totalSeconds = Math.floor(frame / base);
  return [
    pad(Math.floor(totalSeconds / 3600)),
    pad(Math.floor(totalSeconds / 60) % 60),
    pad(totalSeconds % 60),
    pad(frame % base),
  ].join(":");
}
