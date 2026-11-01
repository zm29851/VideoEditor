import { tmpdir } from "node:os";
import { join } from "node:path";
import { gainAt, lookAt, trackEnvelopes, valueAt, type ClipEnvelope } from "../animation.ts";
import { isMediaClip, type Asset, type Clip, type Keyframe, type MediaClip, type Project, type Track } from "../schema.ts";
import { AUDIO_SAMPLE_RATE, fpsToFilterString, frameToSample, framesToSeconds } from "../time.ts";
import { ffmpeg, ffmpegWithProgress } from "./ffmpeg.ts";
import { textImagesFor } from "./text.ts";

export interface FrameWindow {
  start: number;
  /** Exclusive. */
  end: number;
}

export interface ExportOptions {
  encoder?: "libx264" | "h264_videotoolbox";
  /** Fast and small, for checking an edit rather than delivering it. */
  draft?: boolean;
  /** Only this part of the timeline. Transitions and keyframes look as they do in the whole. */
  range?: FrameWindow;
  /** Where the pictures of text clips are kept. */
  textDir?: string;
  signal?: AbortSignal;
}

const PREVIEW_LONG_EDGE = 640;

export function timelineDuration(project: Project): number {
  return project.timeline.tracks
    .flatMap((track) => track.clips)
    .reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
}

/** A copy of the project that renders small and from the proxies. */
export function buildPreviewProject(project: Project, longEdge = PREVIEW_LONG_EDGE): Project {
  const preview = structuredClone(project);
  for (const asset of preview.assets) asset.masterPath = asset.proxyPath;
  const scale = longEdge / Math.max(project.width, project.height);
  preview.width = Math.max(2, Math.round((project.width * scale) / 2) * 2);
  preview.height = Math.max(2, Math.round((project.height * scale) / 2) * 2);
  return preview;
}

interface Piece {
  /** Absent for a gap, which renders as nothing. */
  clip?: Clip;
  /** First frame used, counted inside the clip. */
  from: number;
  /** Position inside the rendered window. */
  start: number;
  duration: number;
}

/** A track's clips and gaps from the start of the window to its end, with no holes. */
function trackPieces(clips: Clip[], window: FrameWindow): Piece[] {
  const pieces: Piece[] = [];
  const total = window.end - window.start;
  let cursor = 0;
  for (const clip of [...clips].sort((a, b) => a.start - b.start)) {
    const first = Math.max(clip.start, window.start);
    const last = Math.min(clip.start + clip.duration, window.end);
    if (first >= last) continue;
    const start = first - window.start;
    if (start > cursor) pieces.push({ from: 0, start: cursor, duration: start - cursor });
    pieces.push({ clip, from: first - clip.start, start, duration: last - first });
    cursor = start + last - first;
  }
  if (cursor < total) pieces.push({ from: 0, start: cursor, duration: total - cursor });
  return pieces;
}

/** Straight lines between keyframes as an FFmpeg expression of the frame number v. */
function keyframeExpression(keyframes: Keyframe[], v: string): string {
  let expression = String(keyframes.at(-1)!.value);
  for (let index = keyframes.length - 1; index > 0; index--) {
    const a = keyframes[index - 1]!;
    const b = keyframes[index]!;
    expression = `if(lt(${v},${b.frame}),${a.value}+(${b.value - a.value})*(${v}-${a.frame})/${b.frame - a.frame},${expression})`;
  }
  return `if(lt(${v},${keyframes[0]!.frame}),${keyframes[0]!.value},${expression})`;
}

function propertyExpression(keyframes: Keyframe[] | undefined, fallback: number, v: string): string {
  return keyframes && keyframes.length > 0 ? keyframeExpression(keyframes, v) : String(fallback);
}

function envelopeExpression(envelope: ClipEnvelope, duration: number, v: string): string {
  const parts: string[] = [];
  if (envelope.fadeIn > 0) parts.push(`if(lt(${v},${envelope.fadeIn}),(${v}+1)/${envelope.fadeIn + 1},1)`);
  if (envelope.fadeOut > 0) parts.push(`if(gte(${v},${duration - envelope.fadeOut}),(${duration}-${v})/${envelope.fadeOut + 1},1)`);
  return parts.length > 0 ? parts.join("*") : "1";
}

const hasAnimatedLook = (clip: Clip) => Boolean(clip.keyframes?.x?.length || clip.keyframes?.y?.length || clip.keyframes?.scale?.length || clip.keyframes?.opacity?.length);

export interface RenderGraph {
  inputs: string[];
  filters: string[];
}

/** The whole filter graph, ending in [outv] and [outa]. Separate from running it so it can be inspected. */
export function buildRenderGraph(
  project: Project,
  options: { range?: FrameWindow; textImages?: ReadonlyMap<string, string>; video?: boolean; audio?: boolean } = {},
): RenderGraph {
  const window = options.range ?? { start: 0, end: timelineDuration(project) };
  const total = window.end - window.start;
  if (total <= 0) throw new Error("Timeline đang rỗng, không có gì để xuất.");

  const { fps, width, height } = project;
  const rate = fpsToFilterString(fps);
  const assets = new Map<string, Asset>(project.assets.map((asset) => [asset.id, asset]));
  const inputs: string[] = [];
  const filters: string[] = [];
  const opened = new Map<string, { index: number; audioLeadIn: number }>();
  let inputCount = 0;
  let labelCount = 0;
  const label = (prefix: string) => `${prefix}${labelCount++}`;
  const frameSeconds = framesToSeconds(1, fps);

  const assetOf = (clip: MediaClip): Asset => {
    const asset = assets.get(clip.assetId);
    if (!asset) throw new Error(`Clip "${clip.id}" dùng asset không tồn tại.`);
    return asset;
  };

  /** One input per stretch of a clip, shared by its picture and its sound. */
  const openMedia = (clip: MediaClip, from: number, duration: number) => {
    const key = `${clip.id}:${from}:${duration}`;
    const existing = opened.get(key);
    if (existing) return existing;
    const sourceTime = framesToSeconds(clip.sourceIn + from, fps);
    // Seeking half a frame early keeps the wanted frame even if the seek time rounds up;
    // the frame before it is still dropped, and atrim removes the same half frame of audio.
    const seek = Math.max(sourceTime - frameSeconds / 2, 0);
    const seconds = framesToSeconds(duration, fps);
    inputs.push("-ss", seek.toFixed(6), "-t", (seconds + frameSeconds * 2).toFixed(6), "-i", assetOf(clip).masterPath);
    const entry = { index: inputCount++, audioLeadIn: Math.round((sourceTime - seek) * AUDIO_SAMPLE_RATE) };
    opened.set(key, entry);
    return entry;
  };

  const fitFilter = (clip: MediaClip, background: string) =>
    clip.fit === "cover"
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase:flags=lanczos,crop=${width}:${height}`
      : `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:${background}`;

  /** The picture of a clip at canvas size, with its own alpha. Frame numbers start at 0. */
  const sourceLayer = (clip: Clip, from: number, duration: number): string => {
    const out = label("src");
    if (isMediaClip(clip)) {
      const { index } = openMedia(clip, from, duration);
      filters.push(`[${index}:v:0]trim=end_frame=${duration},setpts=N/(${rate}*TB),${fitFilter(clip, "black@0")},setsar=1,format=yuva420p[${out}]`);
      return out;
    }
    const image = options.textImages?.get(clip.id);
    if (!image) throw new Error(`Chưa có hình của clip chữ "${clip.id}".`);
    inputs.push("-loop", "1", "-framerate", rate, "-t", (framesToSeconds(duration, fps) + frameSeconds * 2).toFixed(6), "-i", image);
    const index = inputCount++;
    filters.push(`[${index}:v:0]trim=end_frame=${duration},setpts=N/(${rate}*TB),scale=out_color_matrix=bt709,setsar=1,format=yuva420p[${out}]`);
    return out;
  };

  /** Applies opacity by multiplying the alpha with a tiny grey picture, which costs far less than geq at full size. */
  const applyOpacity = (input: string, expression: string, duration: number): string => {
    const [keep, alpha, mask, faded, out] = [label("o"), label("o"), label("o"), label("o"), label("o")];
    filters.push(
      `[${input}]split[${keep}][${alpha}]`,
      `color=white:s=2x2:r=${rate}:d=${(framesToSeconds(duration, fps) + frameSeconds).toFixed(6)},format=gray,geq=lum='255*(${expression})',scale=${width}:${height},trim=end_frame=${duration}[${mask}]`,
      `[${alpha}]alphaextract,format=gray[${alpha}g]`,
      `[${alpha}g][${mask}]blend=all_mode=multiply[${faded}]`,
      `[${keep}][${faded}]alphamerge[${out}]`,
    );
    return out;
  };

  const canvasSource = (duration: number, opaque: boolean): string => {
    const out = label("bg");
    const color = opaque ? "black" : "black@0";
    const format = opaque ? "yuv420p" : "yuva420p";
    filters.push(`color=c=${color}:s=${width}x${height}:r=${rate}:d=${(framesToSeconds(duration, fps) + frameSeconds).toFixed(6)},format=${format},trim=end_frame=${duration},setsar=1,setpts=N/(${rate}*TB)[${out}]`);
    return out;
  };

  /** Lays a layer on the canvas stream, resized and moved for each frame when it has to be. */
  const placeLayer = (base: string, layer: string, clip: Clip, firstFrame: number, animated: boolean): string => {
    const out = label("c");
    const look = clip.transform ?? { x: 0, y: 0, scale: 1 };
    const atFrame = `(n+${firstFrame})`;
    const scale = propertyExpression(clip.keyframes?.scale, look.scale, atFrame);
    const x = propertyExpression(clip.keyframes?.x, look.x, atFrame);
    const y = propertyExpression(clip.keyframes?.y, look.y, atFrame);
    const position = `x='(W-w)/2+W*(${x})':y='(H-h)/2+H*(${y})'`;
    let layerOut = layer;
    if (scale !== "1") {
      layerOut = label("s");
      filters.push(`[${layer}]scale=w='2*round(${width}*(${scale})/2)':h='2*round(${height}*(${scale})/2)':eval=${animated ? "frame" : "init"}:flags=bilinear[${layerOut}]`);
    }
    filters.push(`[${base}][${layerOut}]overlay=${position}:eval=${animated ? "frame" : "init"}:format=yuv420:eof_action=pass:repeatlast=0[${out}]`);
    return out;
  };

  const needsNoCompositing = (clip: Clip, envelope: ClipEnvelope, from: number, duration: number): boolean => {
    if (hasAnimatedLook(clip)) return false;
    const look = lookAt({ ...clip, keyframes: {} }, 0);
    if (look.x !== 0 || look.y !== 0 || look.scale !== 1 || look.opacity !== 1) return false;
    const fadesIn = from < envelope.fadeIn;
    const fadesOut = from + duration > clip.duration - envelope.fadeOut && envelope.fadeOut > 0;
    return !fadesIn && !fadesOut && !(envelope.tail && from < envelope.tail.frames);
  };

  const buildVideoTrack = (track: Track, bottom: boolean): string => {
    const envelopes = trackEnvelopes(track.clips, project.assets);
    const pads: string[] = [];
    for (const piece of trackPieces(track.clips, window)) {
      const out = label("t");
      pads.push(`[${out}]`);
      if (!piece.clip) {
        filters.push(`[${canvasSource(piece.duration, bottom)}]null[${out}]`);
        continue;
      }
      const clip = piece.clip;
      const envelope = envelopes.get(clip.id)!;
      if (isMediaClip(clip) && needsNoCompositing(clip, envelope, piece.from, piece.duration)) {
        const { index } = openMedia(clip, piece.from, piece.duration);
        const background = bottom ? "black" : "black@0";
        filters.push(`[${index}:v:0]trim=end_frame=${piece.duration},setpts=N/(${rate}*TB),${fitFilter(clip, background)},setsar=1,format=${bottom ? "yuv420p" : "yuva420p"}[${out}]`);
        continue;
      }
      let canvas = canvasSource(piece.duration, bottom);
      const tail = envelope.tail;
      if (tail && piece.from < tail.frames) {
        const tailFrames = Math.min(tail.frames - piece.from, piece.duration);
        const tailFirst = tail.clip.duration + piece.from;
        let layer = sourceLayer(tail.clip, tailFirst, tailFrames);
        const tailOpacity = lookAt(tail.clip, tail.clip.duration - 1).opacity;
        if (tailOpacity < 1) layer = applyOpacity(layer, String(tailOpacity), tailFrames);
        canvas = placeLayer(canvas, layer, { ...tail.clip, keyframes: lastValues(tail.clip) }, 0, false);
      }
      let layer = sourceLayer(clip, piece.from, piece.duration);
      const base = propertyExpression(clip.keyframes?.opacity, (clip.transform?.opacity ?? 1), `(N+${piece.from})`);
      const fades = envelopeExpression(envelope, clip.duration, `(N+${piece.from})`);
      if (base !== "1" || fades !== "1") layer = applyOpacity(layer, `(${base})*(${fades})`, piece.duration);
      const animated = Boolean(clip.keyframes?.x?.length || clip.keyframes?.y?.length || clip.keyframes?.scale?.length);
      const placed = placeLayer(canvas, layer, clip, piece.from, animated);
      filters.push(`[${placed}]format=${bottom ? "yuv420p" : "yuva420p"}[${out}]`);
    }
    const result = label("track");
    filters.push(`${pads.join("")}concat=n=${pads.length}:v=1:a=0[${result}]`);
    return result;
  };

  const silence = (samples: number, out: string) =>
    `anullsrc=r=${AUDIO_SAMPLE_RATE}:cl=stereo,atrim=end_sample=${samples},asetpts=N/SR/TB[${out}]`;

  const buildAudioTrack = (track: Track): string => {
    const envelopes = trackEnvelopes(track.clips, project.assets);
    const pads: string[] = [];
    for (const piece of trackPieces(track.clips, window)) {
      const out = label("a");
      pads.push(`[${out}]`);
      // Sample counts come from timeline positions, so rounding never accumulates across cuts.
      const samples = frameToSample(piece.start + piece.duration, fps) - frameToSample(piece.start, fps);
      const clip = piece.clip;
      if (!clip || !isMediaClip(clip) || !assetOf(clip).hasAudio) {
        filters.push(silence(samples, out));
        continue;
      }
      const envelope = envelopes.get(clip.id)!;
      const atFrame = `(t*${fps.num}/${fps.den}+${piece.from})`;
      const fades = envelopeExpression(envelope, clip.duration, atFrame);
      const animated = Boolean(clip.keyframes?.volume?.length) || fades !== "1";
      const volume = animated
        ? `volume='(${propertyExpression(clip.keyframes?.volume, clip.volume, atFrame)})/100*(${fades})':eval=frame`
        : `volume=${(gainAt(clip, 0)).toFixed(4)}`;
      const { index, audioLeadIn } = openMedia(clip, piece.from, piece.duration);
      const main = `[${index}:a:0]aresample=${AUDIO_SAMPLE_RATE},aformat=channel_layouts=stereo,atrim=start_sample=${audioLeadIn},asetpts=N/SR/TB,${volume},apad,atrim=end_sample=${samples},asetpts=N/SR/TB`;
      const tail = envelope.tail;
      if (tail && piece.from < tail.frames && isMediaClip(tail.clip) && assetOf(tail.clip).hasAudio) {
        const tailFrames = Math.min(tail.frames - piece.from, piece.duration);
        const opened = openMedia(tail.clip, tail.clip.duration + piece.from, tailFrames);
        const tailSamples = frameToSample(tailFrames, fps);
        const level = gainAt(tail.clip, tail.clip.duration);
        const position = `(t*${fps.num}/${fps.den}+${piece.from})`;
        const [first, second] = [label("x"), label("x")];
        filters.push(
          `${main}[${first}]`,
          `[${opened.index}:a:0]aresample=${AUDIO_SAMPLE_RATE},aformat=channel_layouts=stereo,atrim=start_sample=${opened.audioLeadIn},asetpts=N/SR/TB,atrim=end_sample=${tailSamples},asetpts=N/SR/TB,volume='${level}*(1-(${position}+1)/${tail.frames + 1})':eval=frame[${second}]`,
          `[${first}][${second}]amix=inputs=2:duration=first:normalize=0[${out}]`,
        );
      } else {
        filters.push(`${main}[${out}]`);
      }
    }
    const result = label("mix");
    filters.push(`${pads.join("")}concat=n=${pads.length}:v=0:a=1[${result}]`);
    return result;
  };

  if (options.video !== false) {
    const visual = project.timeline.tracks.filter((track) => track.kind !== "audio" && track.clips.some((clip) => clip.start < window.end && clip.start + clip.duration > window.start));
    let result: string | undefined;
    visual.forEach((track, index) => {
      const stream = buildVideoTrack(track, index === 0);
      if (result === undefined) {
        result = stream;
      } else {
        const out = label("over");
        filters.push(`[${result}][${stream}]overlay=format=yuv420:eof_action=pass:repeatlast=0[${out}]`);
        result = out;
      }
    });
    filters.push(`[${result ?? canvasSource(total, true)}]format=yuv420p[outv]`);
  }

  if (options.audio !== false) {
    const sounding = project.timeline.tracks.filter(
      (track) => track.kind !== "text" && track.clips.some((clip) => isMediaClip(clip) && assets.get(clip.assetId)?.hasAudio && clip.start < window.end && clip.start + clip.duration > window.start),
    );
    if (sounding.length === 0) {
      filters.push(silence(frameToSample(total, fps), "outa"));
    } else {
      const streams = sounding.map(buildAudioTrack);
      filters.push(
        streams.length === 1
          ? `[${streams[0]}]anull[outa]`
          : `${streams.map((stream) => `[${stream}]`).join("")}amix=inputs=${streams.length}:duration=longest:normalize=0[outa]`,
      );
    }
  }

  return { inputs, filters };
}

/** The last value of each keyframed property, for the part of a clip that plays on underneath a dissolve. */
function lastValues(clip: Clip): Clip["keyframes"] {
  const entries = Object.entries(clip.keyframes ?? {}).map(([property, list]) => [property, [{ frame: 0, value: valueAt(list, clip.duration - 1, 0) }]]);
  return Object.fromEntries(entries) as Clip["keyframes"];
}

/** Builds the FFmpeg arguments, separated from running them so they can be inspected. */
export function buildExportArgs(project: Project, output: string, options: ExportOptions = {}, textImages?: ReadonlyMap<string, string>): string[] {
  const { inputs, filters } = buildRenderGraph(project, { ...(options.range ? { range: options.range } : {}), ...(textImages ? { textImages } : {}) });
  const fps = fpsToFilterString(project.fps);
  const encoder = options.encoder ?? "libx264";
  const videoArgs = options.draft
    ? ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28"]
    : encoder === "libx264"
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

export async function exportProject(
  project: Project,
  output: string,
  options: ExportOptions = {},
  onFrame?: (frame: number) => void,
): Promise<void> {
  const textImages = textImagesFor(project, options.textDir ?? join(tmpdir(), "ve-text"));
  const args = buildExportArgs(project, output, options, textImages);
  if (onFrame) await ffmpegWithProgress(args, onFrame, options.signal);
  else await ffmpeg(args, options.signal);
}
