import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Asset, Project } from "../schema.ts";
import { framesToSeconds } from "../time.ts";
import { ffmpeg } from "./ffmpeg.ts";

export type FrameSource = { kind: "timeline" } | { kind: "asset"; assetId: string };

function fitSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(maxEdge / Math.max(width, height), 1);
  return {
    width: Math.max(2, Math.round((width * scale) / 2) * 2),
    height: Math.max(2, Math.round((height * scale) / 2) * 2),
  };
}

const JPEG_ARGS = ["-frames:v", "1", "-c:v", "mjpeg", "-q:v", "4", "-f", "image2pipe", "pipe:1"];

async function assetFrame(project: Project, asset: Asset, frame: number, width: number, height: number): Promise<Buffer> {
  // Half a frame early, for the reason given in buildExportArgs.
  const seconds = framesToSeconds(frame, project.fps) - framesToSeconds(1, project.fps) / 2;
  const { stdout } = await ffmpeg([
    "-ss",
    Math.max(seconds, 0).toFixed(6),
    "-i",
    asset.proxyPath,
    "-map",
    "0:v:0",
    "-vf",
    `scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
      `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,format=yuvj420p`,
    ...JPEG_ARGS,
  ]);
  return stdout;
}

/** A JPEG of one frame from the proxy, or black for a gap on the timeline. */
export async function extractFrame(project: Project, source: FrameSource, frame: number, maxEdge: number): Promise<Buffer> {
  if (source.kind === "asset") {
    const asset = project.assets.find((candidate) => candidate.id === source.assetId);
    if (!asset) throw new Error(`Không có asset "${source.assetId}".`);
    if (frame >= asset.durationFrames) {
      throw new Error(`Asset "${asset.name}" chỉ có ${asset.durationFrames} frame, không có frame ${frame}.`);
    }
    const size = fitSize(asset.width, asset.height, maxEdge);
    return assetFrame(project, asset, frame, size.width, size.height);
  }

  const size = fitSize(project.width, project.height, maxEdge);
  const clips = project.timeline.tracks.flatMap((track) => track.clips);
  const end = clips.reduce((value, clip) => Math.max(value, clip.start + clip.duration), 0);
  if (frame >= end) throw new Error(`Timeline dài ${end} frame, không có frame ${frame}.`);

  const clip = clips.find((candidate) => frame >= candidate.start && frame < candidate.start + candidate.duration);
  if (!clip) {
    const { stdout } = await ffmpeg([
      "-f",
      "lavfi",
      "-i",
      `color=c=black:s=${size.width}x${size.height}:d=1,format=yuvj420p`,
      ...JPEG_ARGS,
    ]);
    return stdout;
  }
  const asset = project.assets.find((candidate) => candidate.id === clip.assetId);
  if (!asset) throw new Error(`Clip "${clip.id}" dùng asset không tồn tại.`);
  return assetFrame(project, asset, clip.sourceIn + frame - clip.start, size.width, size.height);
}

export interface Filmstrip {
  image: Buffer;
  frames: number[];
  columns: number;
  rows: number;
}

/** Evenly spaced frames from start up to, not including, end. Always includes the first frame. */
export function filmstripFrames(start: number, end: number, count: number): number[] {
  const length = end - start;
  const used = Math.min(count, length);
  return Array.from({ length: used }, (_, index) => start + Math.floor((index * length) / used));
}

/** One image holding the frames in a grid, read left to right, top to bottom. */
export async function extractFilmstrip(
  project: Project,
  source: FrameSource,
  start: number,
  end: number,
  count: number,
  tileEdge: number,
): Promise<Filmstrip> {
  const frames = filmstripFrames(start, end, count);
  const columns = Math.min(4, frames.length);
  const rows = Math.ceil(frames.length / columns);
  const directory = await mkdtemp(join(tmpdir(), "ve-filmstrip-"));
  try {
    for (const [index, frame] of frames.entries()) {
      const tile = await extractFrame(project, source, frame, tileEdge);
      await writeFile(join(directory, `tile-${String(index).padStart(3, "0")}.jpg`), tile);
    }
    const output = join(directory, "strip.jpg");
    await ffmpeg([
      "-framerate",
      "1",
      "-i",
      join(directory, "tile-%03d.jpg"),
      "-vf",
      `tile=${columns}x${rows}:padding=4:color=white,format=yuvj420p`,
      "-frames:v",
      "1",
      "-q:v",
      "4",
      output,
    ]);
    return { image: await readFile(output), frames, columns, rows };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
