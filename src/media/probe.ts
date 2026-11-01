import { ffprobe } from "./ffmpeg.ts";

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
  const audio = parsed.streams.find((stream) => stream.codec_type === "audio");

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
    audioSampleRate: audio?.sample_rate ? Number.parseInt(audio.sample_rate, 10) : undefined,
    frameCount: times.length,
    averageFps: 1 / averageGap,
    maxFrameJitter,
    firstVideoTime: times[0]!,
    firstAudioTime: audio?.start_time ? Number.parseFloat(audio.start_time) : undefined,
  };
}
