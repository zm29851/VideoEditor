import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Asset, FrameRate } from "../schema.ts";
import { ffmpeg } from "./ffmpeg.ts";

/** Enough to find the loudest point of a frame, and far cheaper to decode than 48 kHz. */
const PEAK_SAMPLE_RATE = 8000;

/** Loudest sample of each frame, from 0 to 1, so a clip can slice the waveform by frame number. */
export function peaksPerFrame(pcm: Float32Array, durationFrames: number, fps: FrameRate): number[] {
  const samplesPerFrame = (PEAK_SAMPLE_RATE * fps.den) / fps.num;
  const peaks: number[] = [];
  for (let frame = 0; frame < durationFrames; frame++) {
    const from = Math.round(frame * samplesPerFrame);
    const to = Math.min(Math.round((frame + 1) * samplesPerFrame), pcm.length);
    let peak = 0;
    for (let index = from; index < to; index++) peak = Math.max(peak, Math.abs(pcm[index]!));
    peaks.push(Math.round(Math.min(peak, 1) * 1000) / 1000);
  }
  return peaks;
}

const running = new Map<string, Promise<number[]>>();

/** Computed once per asset, then read from the project's cache folder. */
export function loadPeaks(cacheDir: string, asset: Asset, fps: FrameRate): Promise<number[]> {
  if (!asset.hasAudio) return Promise.resolve([]);
  const path = join(cacheDir, `peaks-${asset.id}.json`);
  if (existsSync(path)) return Promise.resolve(JSON.parse(readFileSync(path, "utf8")) as number[]);

  const pending = running.get(path);
  if (pending) return pending;
  const work = (async () => {
    const { stdout } = await ffmpeg(["-i", asset.proxyPath, "-map", "0:a:0", "-ac", "1", "-ar", String(PEAK_SAMPLE_RATE), "-f", "f32le", "pipe:1"]);
    const copy = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length);
    const peaks = peaksPerFrame(new Float32Array(copy), asset.durationFrames, fps);
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(path, JSON.stringify(peaks));
    return peaks;
  })().finally(() => running.delete(path));
  running.set(path, work);
  return work;
}
