import type { Asset, FrameRate, MediaClip, Project } from "../schema.ts";
import { buildRenderGraph } from "./export.ts";
import { framesToSeconds, fpsToNumber } from "../time.ts";
import type { FrameRange } from "../transcript.ts";
import { run } from "./ffmpeg.ts";

const QUIET_ARGS = ["-hide_banner", "-nostdin", "-y"];
/** Small frames are enough to compare pictures, and much faster to score. */
const SCENE_SCALE = "scale=160:-2";

async function filterOutput(args: string[], signal?: AbortSignal): Promise<string> {
  let output = "";
  await run("ffmpeg", [...QUIET_ARGS, "-loglevel", "error", ...args], (chunk) => {
    output += chunk;
  }, undefined, signal);
  return output;
}

/** Reads what silencedetect printed. Rounds inward, so a silent range never reaches into sound. */
export function parseSilences(output: string, durationFrames: number, fps: FrameRate): FrameRange[] {
  const rate = fpsToNumber(fps);
  const ranges: FrameRange[] = [];
  let open: number | undefined;
  for (const match of output.matchAll(/lavfi\.silence_(start|end)=(-?[\d.]+)/g)) {
    const seconds = Number(match[2]);
    if (match[1] === "start") {
      open = Math.max(0, Math.ceil(seconds * rate - 1e-6));
    } else if (open !== undefined) {
      const end = Math.min(durationFrames, Math.floor(seconds * rate + 1e-6));
      if (end > open) ranges.push({ start: open, end });
      open = undefined;
    }
  }
  if (open !== undefined && open < durationFrames) ranges.push({ start: open, end: durationFrames });
  return ranges;
}

export async function detectSilence(asset: Asset, fps: FrameRate, noiseDb: number, minSeconds: number): Promise<FrameRange[]> {
  if (!asset.hasAudio) return [];
  const output = await filterOutput([
    "-i",
    asset.proxyPath,
    "-map",
    "0:a:0",
    "-af",
    `aformat=channel_layouts=mono,silencedetect=n=${noiseDb}dB:d=${minSeconds},ametadata=mode=print:file=-`,
    "-f",
    "null",
    "-",
  ]);
  return parseSilences(output, asset.durationFrames, fps);
}

/** Reads what select and metadata printed: the first frame of each new scene. */
export function parseSceneCuts(output: string, fps: FrameRate): Array<{ frame: number; score: number }> {
  const rate = fpsToNumber(fps);
  return [...output.matchAll(/pts_time:(-?[\d.]+)\s*\n\s*lavfi\.scene_score=([\d.]+)/g)].map((match) => ({
    frame: Math.round(Number(match[1]) * rate),
    score: Math.round(Number(match[2]) * 1000) / 1000,
  }));
}

export async function detectScenes(asset: Asset, fps: FrameRate, threshold: number, signal?: AbortSignal): Promise<Array<{ frame: number; score: number }>> {
  const output = await filterOutput([
    "-i",
    asset.proxyPath,
    "-map",
    "0:v:0",
    "-vf",
    `${SCENE_SCALE},select='gt(scene,${threshold})',metadata=mode=print:file=-`,
    "-fps_mode",
    "passthrough",
    "-f",
    "null",
    "-",
  ], signal);
  return parseSceneCuts(output, fps);
}

export interface Loudness {
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number | null;
}

/** Reads the summary ebur128 logs at the end. Values too quiet to measure come back as null. */
export function parseLoudness(log: string): Loudness {
  const summary = log.slice(log.lastIndexOf("Summary:"));
  const read = (pattern: RegExp, floor: number) => {
    const value = Number(summary.match(pattern)?.[1] ?? Number.NaN);
    return Number.isFinite(value) && value > floor ? value : null;
  };
  return {
    integratedLufs: read(/\bI:\s*(-?[\d.]+) LUFS/, -70),
    loudnessRangeLu: read(/LRA:\s*(-?[\d.]+) LU/, -1),
    truePeakDbtp: read(/Peak:\s*(-?[\d.]+) dBFS/, -70),
  };
}

const EBUR128 = "ebur128=peak=true:framelog=quiet";

async function measure(args: string[]): Promise<Loudness> {
  const { stderr } = await run("ffmpeg", [...QUIET_ARGS, "-loglevel", "info", ...args, "-f", "null", "-"]);
  return parseLoudness(stderr);
}

export function assetLoudness(asset: Asset): Promise<Loudness> {
  return measure(["-i", asset.proxyPath, "-map", "0:a:0", "-af", EBUR128]);
}

/** The whole timeline as it would be exported: every track mixed, with volume keyframes and transitions. */
export function timelineLoudness(project: Project): Promise<Loudness> {
  const preview = structuredClone(project);
  for (const asset of preview.assets) asset.masterPath = asset.proxyPath;
  const graph = buildRenderGraph(preview, { video: false });
  if (!project.timeline.tracks.some((track) => track.clips.some((clip) => "assetId" in clip && project.assets.find((asset) => asset.id === clip.assetId)?.hasAudio))) {
    throw new Error("Không có clip nào có tiếng để đo.");
  }
  return measure([...graph.inputs, "-filter_complex", `${graph.filters.join(";")};[outa]${EBUR128}[out]`, "-map", "[out]"]);
}

/** The clips as they would sound in the export, at their own volume. Clips without audio are left out. */
export function clipsLoudness(project: Project, clips: MediaClip[]): Promise<Loudness> {
  const assets = new Map(project.assets.map((asset) => [asset.id, asset]));
  const inputs: string[] = [];
  const pads: string[] = [];
  const filters: string[] = [];
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    const asset = assets.get(clip.assetId);
    if (!asset?.hasAudio) continue;
    const index = pads.length;
    const seek = framesToSeconds(clip.sourceIn, project.fps).toFixed(6);
    const length = framesToSeconds(clip.duration, project.fps).toFixed(6);
    inputs.push("-ss", seek, "-t", length, "-i", asset.proxyPath);
    filters.push(`[${index}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,volume=${(clip.volume / 100).toFixed(4)}[a${index}]`);
    pads.push(`[a${index}]`);
  }
  if (pads.length === 0) throw new Error("Không có clip nào có tiếng để đo.");
  filters.push(`${pads.join("")}concat=n=${pads.length}:v=0:a=1,${EBUR128}[out]`);
  return measure([...inputs, "-filter_complex", filters.join(";"), "-map", "[out]"]);
}
