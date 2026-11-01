import type { FrameRate } from "./schema.ts";

export const AUDIO_SAMPLE_RATE = 48_000;

/** Reads "30", "29.97" or "30000/1001". Common NTSC decimals become their exact fractions. */
export function parseFps(text: string): FrameRate {
  const fraction = /^(\d+)\/(\d+)$/.exec(text.trim());
  const ntsc: Record<string, FrameRate> = {
    "23.976": { num: 24000, den: 1001 },
    "29.97": { num: 30000, den: 1001 },
    "59.94": { num: 60000, den: 1001 },
  };
  const fps = fraction
    ? { num: Number(fraction[1]), den: Number(fraction[2]) }
    : (ntsc[text.trim()] ?? (Number.isInteger(Number(text)) ? { num: Number(text), den: 1 } : undefined));
  const value = fps && fps.den > 0 ? fps.num / fps.den : NaN;
  if (!fps || !(value >= 1 && value <= 120)) {
    throw new Error(`Fps "${text}" không hợp lệ: dùng số nguyên từ 1 đến 120, 23.976, 29.97, 59.94 hoặc phân số như 30000/1001.`);
  }
  return fps;
}

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
