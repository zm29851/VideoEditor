import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { Asset, FrameRate } from "../schema.ts";
import { projectPaths } from "../store.ts";
import { AUDIO_SAMPLE_RATE, fpsToFilterString, fpsToNumber } from "../time.ts";
import { ffmpeg } from "./ffmpeg.ts";
import { writeHdrLut } from "./hdr.ts";
import { probeMedia, type MediaInfo } from "./probe.ts";

/** 29.97 and 30 differ by 0.1%, so anything near that is a different rate. */
const FPS_TOLERANCE = 0.0005;
/** Above half a frame, a timestamp can land on the wrong frame number. */
const MAX_JITTER_FRAMES = 0.5;
const PROXY_LONG_EDGE = 1280;

export function normalizationReasons(info: MediaInfo, fps: FrameRate): string[] {
  const reasons: string[] = [];
  const target = fpsToNumber(fps);
  if (Math.abs(info.averageFps - target) / target > FPS_TOLERANCE) {
    reasons.push(`fps ${info.averageFps.toFixed(3)} khác project ${target.toFixed(3)}`);
  }
  if (info.maxFrameJitter > MAX_JITTER_FRAMES) {
    reasons.push(`fps không đều, lệch tối đa ${info.maxFrameJitter.toFixed(2)} frame`);
  }
  if (info.isHdr) reasons.push(`HDR (${info.colorTransfer}) cần chuyển về SDR`);
  if (info.pixelFormat !== "yuv420p" && info.pixelFormat !== "yuvj420p") {
    reasons.push(`định dạng điểm ảnh ${info.pixelFormat}`);
  }
  if (info.hasAudio && info.audioSampleRate !== AUDIO_SAMPLE_RATE) {
    reasons.push(`âm thanh ${info.audioSampleRate} Hz, cần ${AUDIO_SAMPLE_RATE} Hz`);
  }
  if (Math.abs(info.firstVideoTime) > 1e-3 || Math.abs((info.firstAudioTime ?? 0) - info.firstVideoTime) > 1e-3) {
    reasons.push("hình và tiếng không bắt đầu cùng lúc");
  }
  return reasons;
}

export interface VideoEncoderOptions {
  encoder: "libx264" | "h264_videotoolbox";
}

function masterVideoArgs(options: VideoEncoderOptions): string[] {
  return options.encoder === "libx264"
    ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "16"]
    : ["-c:v", "h264_videotoolbox", "-b:v", "20M"];
}

export async function createMaster(
  source: string,
  output: string,
  info: MediaInfo,
  fps: FrameRate,
  lutDir: string,
  options: VideoEncoderOptions = { encoder: "libx264" },
): Promise<void> {
  const filters: string[] = [];
  if (info.isHdr) {
    const lut = join(lutDir, `hdr-to-sdr-${info.colorTransfer}.cube`);
    writeHdrLut(lut, info.colorTransfer!);
    filters.push(
      "scale=in_color_matrix=bt2020:out_color_matrix=bt709:flags=lanczos,format=gbrp16le",
      `lut3d=file='${lut.replaceAll("'", "\\'")}'`,
      // Frames keep their HDR tags through the filters, and those override the encoder options.
      "setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709",
    );
  }
  filters.push(`fps=${fpsToFilterString(fps)}:start_time=0:round=near`, "setsar=1", "format=yuv420p");

  await ffmpeg([
    "-i",
    source,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-map_metadata",
    "-1",
    "-vf",
    filters.join(","),
    ...masterVideoArgs(options),
    "-g",
    String(Math.round(fpsToNumber(fps))),
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-af",
    `aresample=${AUDIO_SAMPLE_RATE}:async=1:first_pts=0`,
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-movflags",
    "+faststart",
    output,
  ]);
}

export async function createProxy(master: string, output: string, fps: FrameRate): Promise<void> {
  const gop = Math.max(1, Math.round(fpsToNumber(fps) / 2));
  await ffmpeg([
    "-i",
    master,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0?",
    "-vf",
    `scale=w='min(${PROXY_LONG_EDGE},iw)':h='min(${PROXY_LONG_EDGE},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,format=yuv420p`,
    "-fps_mode",
    "passthrough",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "24",
    "-g",
    String(gop),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    output,
  ]);
}

export interface ImportTimings {
  masterSeconds: number;
  proxySeconds: number;
}

export interface ImportResult {
  asset: Asset;
  timings: ImportTimings;
}

/** Leaves the original untouched and returns an asset for the engine to register. */
export async function importVideo(
  projectRoot: string,
  source: string,
  fps: FrameRate,
  options?: VideoEncoderOptions,
): Promise<ImportResult> {
  const paths = projectPaths(projectRoot);
  const id = `asset_${randomUUID().slice(0, 8)}`;
  const info = await probeMedia(source);
  const reasons = normalizationReasons(info, fps);

  const masterStart = performance.now();
  let masterPath = source;
  if (reasons.length > 0) {
    masterPath = join(paths.masters, `${id}.mp4`);
    await createMaster(source, masterPath, info, fps, paths.cache, options);
  }
  const masterSeconds = (performance.now() - masterStart) / 1000;

  const proxyStart = performance.now();
  const proxyPath = join(paths.proxies, `${id}.mp4`);
  await createProxy(masterPath, proxyPath, fps);
  const proxySeconds = (performance.now() - proxyStart) / 1000;

  const master = reasons.length > 0 ? await probeMedia(masterPath) : info;
  const proxy = await probeMedia(proxyPath);
  if (proxy.frameCount !== master.frameCount) {
    throw new Error(`Proxy có ${proxy.frameCount} frame nhưng master có ${master.frameCount} frame.`);
  }

  return {
    asset: {
      id,
      name: basename(source),
      originalPath: source,
      masterPath,
      proxyPath,
      durationFrames: master.frameCount,
      width: master.width,
      height: master.height,
      hasAudio: master.hasAudio,
      normalization: {
        transcoded: reasons.length > 0,
        reasons,
        sourceFps: info.averageFps,
        wasHdr: info.isHdr,
      },
    },
    timings: { masterSeconds, proxySeconds },
  };
}
