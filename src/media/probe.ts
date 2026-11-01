import { ffmpeg, ffprobe } from "./ffmpeg.ts";

export interface MediaInfo {
  /** Dimensions after applying the rotation metadata. */
  width: number;
  height: number;
  rotation: number;
  codec: string;
  pixelFormat: string;
  colorTransfer: string | undefined;
  isHdr: boolean;
  hasAudio: boolean;
  /** Which audio stream to read, counting audio streams only. Undefined when none can be read. */
  audioIndex: number | undefined;
  /** The audio codec passed over because this FFmpeg cannot decode it. */
  skippedAudioCodec: string | undefined;
  audioSampleRate: number | undefined;
  frameCount: number;
  averageFps: number;
  /** Largest gap between neighbouring frames compared with the average gap, in frames. */
  maxFrameJitter: number;
  firstVideoTime: number;
  firstAudioTime: number | undefined;
}

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  color_transfer?: string;
  sample_rate?: string;
  start_time?: string;
  side_data_list?: Array<{ rotation?: number; side_data_type?: string }>;
}

const HDR_TRANSFERS = new Set(["arib-std-b67", "smpte2084"]);

let decodableCodecs: Promise<Set<string>> | undefined;

/** The audio codecs this FFmpeg can decode. */
function audioDecoders(): Promise<Set<string>> {
  decodableCodecs ??= ffmpeg(["-codecs"]).then(({ stdout }) => new Set([...stdout.toString().matchAll(/^ D.A\S* (\S+)/gm)].map((match) => match[1]!)));
  return decodableCodecs;
}

/**
 * An iPhone with spatial audio writes APAC first, which FFmpeg cannot decode yet, and a plain AAC copy after it.
 */
export function chooseAudioStream(codecs: string[], decodable: Set<string>): { index: number | undefined; skipped: string | undefined } {
  const index = codecs.findIndex((codec) => decodable.has(codec));
  return { index: index === -1 ? undefined : index, skipped: index === 0 ? undefined : codecs[0] };
}

/** How long a sound file lasts. Fails if it holds nothing this FFmpeg can decode. */
export async function probeAudio(path: string): Promise<{ seconds: number }> {
  const { stdout } = await ffprobe(["-select_streams", "a", "-show_entries", "stream=codec_name:format=duration", "-of", "json", path]);
  const parsed = JSON.parse(stdout.toString()) as { streams?: Array<{ codec_name?: string }>; format?: { duration?: string } };
  const chosen = chooseAudioStream((parsed.streams ?? []).map((stream) => stream.codec_name ?? "unknown"), await audioDecoders());
  const seconds = Number.parseFloat(parsed.format?.duration ?? "");
  if (chosen.index === undefined || !Number.isFinite(seconds)) throw new Error(`Không đọc được âm thanh trong ${path}.`);
  return { seconds };
}

export async function probeMedia(path: string): Promise<MediaInfo> {
  const streams = await ffprobe([
    "-show_entries",
    "stream=codec_type,codec_name,width,height,pix_fmt,color_transfer,sample_rate,start_time:stream_side_data",
    "-of",
    "json",
    path,
  ]);
  const parsed = JSON.parse(streams.stdout.toString()) as { streams: ProbeStream[] };
  const video = parsed.streams.find((stream) => stream.codec_type === "video");
  if (!video?.width || !video.height) throw new Error(`Không tìm thấy luồng video trong ${path}.`);
  const audioStreams = parsed.streams.filter((stream) => stream.codec_type === "audio");
  const chosen = chooseAudioStream(audioStreams.map((stream) => stream.codec_name ?? "unknown"), await audioDecoders());
  const audio = chosen.index === undefined ? undefined : audioStreams[chosen.index];

  const rawRotation = video.side_data_list?.find((data) => data.rotation !== undefined)?.rotation ?? 0;
  const rotation = ((Math.round(rawRotation) % 360) + 360) % 360;
  const swapped = rotation === 90 || rotation === 270;

  const packets = await ffprobe([
    "-select_streams",
    "v:0",
    "-show_entries",
    "packet=pts_time",
    "-of",
    "csv=p=0",
    path,
  ]);
  const times = packets.stdout
    .toString()
    .split("\n")
    .map((line) => Number.parseFloat(line))
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  if (times.length < 2) throw new Error(`Video ${path} có quá ít frame để xử lý.`);

  const span = times.at(-1)! - times[0]!;
  const averageGap = span / (times.length - 1);
  let maxFrameJitter = 0;
  for (let index = 1; index < times.length; index++) {
    const gap = times[index]! - times[index - 1]!;
    maxFrameJitter = Math.max(maxFrameJitter, Math.abs(gap - averageGap) / averageGap);
  }

  return {
    width: swapped ? video.height : video.width,
    height: swapped ? video.width : video.height,
    rotation,
    codec: video.codec_name ?? "unknown",
    pixelFormat: video.pix_fmt ?? "unknown",
    colorTransfer: video.color_transfer,
    isHdr: HDR_TRANSFERS.has(video.color_transfer ?? ""),
    hasAudio: audio !== undefined,
    audioIndex: chosen.index,
    skippedAudioCodec: chosen.skipped,
    audioSampleRate: audio?.sample_rate ? Number.parseInt(audio.sample_rate, 10) : undefined,
    frameCount: times.length,
    averageFps: 1 / averageGap,
    maxFrameJitter,
    firstVideoTime: times[0]!,
    firstAudioTime: audio?.start_time ? Number.parseFloat(audio.start_time) : undefined,
  };
}
