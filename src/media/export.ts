import type { Asset, Clip, Project } from "../schema.ts";
import { AUDIO_SAMPLE_RATE, fpsToFilterString, frameToSample, framesToSeconds } from "../time.ts";
import { ffmpeg } from "./ffmpeg.ts";

export interface ExportOptions {
  encoder?: "libx264" | "h264_videotoolbox";
}

export interface Segment {
  /** Absent for a gap on the timeline, which renders as black and silence. */
  clip?: Clip;
  start: number;
  duration: number;
}

export function buildSegments(clips: Clip[]): Segment[] {
  const segments: Segment[] = [];
  let cursor = 0;
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    if (clip.start > cursor) segments.push({ start: cursor, duration: clip.start - cursor });
    segments.push({ clip, start: clip.start, duration: clip.duration });
    cursor = clip.start + clip.duration;
  }
  return segments;
}

/** Builds the FFmpeg arguments, separated from running them so they can be inspected. */
export function buildExportArgs(project: Project, output: string, options: ExportOptions = {}): string[] {
  const tracks = project.timeline.tracks;
  if (tracks.length !== 1) throw new Error("Phase 0 chỉ xuất được timeline có đúng một track video.");
  const segments = buildSegments(tracks[0]!.clips);
  if (segments.length === 0) throw new Error("Timeline đang rỗng, không có gì để xuất.");

  const fps = fpsToFilterString(project.fps);
  const assets = new Map<string, Asset>(project.assets.map((asset) => [asset.id, asset]));
  const inputs: string[] = [];
  const filters: string[] = [];
  const concatPads: string[] = [];
  let inputCount = 0;

  segments.forEach((segment, index) => {
    const seconds = framesToSeconds(segment.duration, project.fps);
    // Sample counts come from timeline positions, so rounding never accumulates across cuts.
    const samples =
      frameToSample(segment.start + segment.duration, project.fps) - frameToSample(segment.start, project.fps);
    const silence = `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[a${index}]`;

    if (!segment.clip) {
      filters.push(
        `color=c=black:s=${project.width}x${project.height}:r=${fps}:d=${seconds.toFixed(6)},` +
          `trim=end_frame=${segment.duration},setsar=1,format=yuv420p[v${index}]`,
        silence,
      );
    } else {
      const asset = assets.get(segment.clip.assetId);
      if (!asset) throw new Error(`Clip "${segment.clip.id}" dùng asset không tồn tại.`);

      // Seeking half a frame early keeps the wanted frame even if the seek time rounds up;
      // the frame before it is still dropped, and atrim removes the same half frame of audio.
      const frameSeconds = framesToSeconds(1, project.fps);
      const seek = Math.max(framesToSeconds(segment.clip.sourceIn, project.fps) - frameSeconds / 2, 0);
      const audioLeadIn = Math.round(
        (framesToSeconds(segment.clip.sourceIn, project.fps) - seek) * AUDIO_SAMPLE_RATE,
      );
      const input = inputCount++;
      inputs.push("-ss", seek.toFixed(6), "-t", (seconds + frameSeconds * 2).toFixed(6), "-i", asset.masterPath);

      filters.push(
        `[${input}:v:0]trim=end_frame=${segment.duration},setpts=N/(${fps}*TB),` +
          `scale=${project.width}:${project.height}:force_original_aspect_ratio=decrease:flags=lanczos,` +
          `pad=${project.width}:${project.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p[v${index}]`,
      );
      if (asset.hasAudio) {
        const volume = (segment.clip.volume / 100).toFixed(4);
        filters.push(
          `[${input}:a:0]aresample=${AUDIO_SAMPLE_RATE},aformat=channel_layouts=stereo,` +
            `atrim=start_sample=${audioLeadIn},asetpts=N/SR/TB,` +
            `volume=${volume},apad,atrim=end_sample=${samples},asetpts=N/SR/TB[a${index}]`,
        );
      } else {
        filters.push(silence);
      }
    }
    concatPads.push(`[v${index}][a${index}]`);
  });

  filters.push(`${concatPads.join("")}concat=n=${segments.length}:v=1:a=1[outv][outa]`);

  const encoder = options.encoder ?? "libx264";
  const videoArgs =
    encoder === "libx264"
      ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "18"]
      : ["-c:v", "h264_videotoolbox", "-b:v", "12M"];

  return [
    ...inputs,
    "-filter_complex",
    filters.join(";"),
    "-map",
    "[outv]",
    "-map",
    "[outa]",
    "-r",
    fps,
    "-fps_mode",
    "cfr",
    ...videoArgs,
    "-colorspace",
    "bt709",
    "-color_primaries",
    "bt709",
    "-color_trc",
    "bt709",
    "-c:a",
    "aac",
    "-b:a",
    "256k",
    "-movflags",
    "+faststart",
    output,
  ];
}

export async function exportProject(project: Project, output: string, options?: ExportOptions): Promise<void> {
  await ffmpeg(buildExportArgs(project, output, options));
}
