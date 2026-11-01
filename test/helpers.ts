import { ffmpeg } from "../src/media/ffmpeg.ts";
import { AUDIO_SAMPLE_RATE } from "../src/time.ts";

const FRAME_BITS = 12;
const SOURCE_BITS = 4;
const BITS = FRAME_BITS + SOURCE_BITS;
const WIDTH = 320;
const HEIGHT = 180;

export interface SourceOptions {
  sourceId: number;
  fpsFilter: string;
  seconds: number;
  /** Beep length at the start of each second, for checking sync. */
  audio?: boolean;
  width?: number;
  height?: number;
  extraOutputArgs?: string[];
}

/**
 * Every frame stores its own number and its source as a barcode. drawtext is missing from
 * this FFmpeg build, and a barcode is read by the test exactly, frame by frame.
 */
function barcodeExpression(sourceId: number): string {
  const value = `(N+${sourceId}*${2 ** FRAME_BITS})`;
  const bit = `floor(X*${BITS}/W)`;
  return `lum='if(gte(Y,H/2),128,255*mod(floor(${value}/pow(2,${bit})),2))':cb=128:cr=128`;
}

export async function makeSource(path: string, options: SourceOptions): Promise<void> {
  const width = options.width ?? WIDTH;
  const height = options.height ?? HEIGHT;
  const audio = options.audio ?? true;
  const audioInput = audio
    ? [
        "-f",
        "lavfi",
        "-i",
        `aevalsrc='if(lt(mod(t,1),0.1),0.5*sin(2*PI*880*t),0)':s=${AUDIO_SAMPLE_RATE}:d=${options.seconds}`,
      ]
    : [];
  await ffmpeg([
    "-f",
    "lavfi",
    "-i",
    `color=c=gray:s=${width}x${height}:r=${options.fpsFilter}:d=${options.seconds},format=yuv420p,geq=${barcodeExpression(options.sourceId)}`,
    ...audioInput,
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-qp",
    "4",
    "-pix_fmt",
    "yuv420p",
    ...(audio ? ["-c:a", "aac", "-b:a", "192k"] : []),
    ...(options.extraOutputArgs ?? []),
    path,
  ]);
}

export interface DecodedFrame {
  sourceId: number;
  frame: number;
}

/** Reads the barcode of every frame in a file. The crop keeps only the barcode band. */
export async function readBarcodes(path: string, crop?: string): Promise<DecodedFrame[]> {
  const filter = [crop, "crop=iw:ih/2:0:0", `scale=${BITS}:1:flags=area`, "format=gray"].filter(Boolean).join(",");
  const { stdout } = await ffmpeg(["-i", path, "-map", "0:v:0", "-vf", filter, "-fps_mode", "passthrough", "-f", "rawvideo", "pipe:1"]);
  const frames: DecodedFrame[] = [];
  for (let offset = 0; offset + BITS <= stdout.length; offset += BITS) {
    let value = 0;
    for (let bit = 0; bit < BITS; bit++) {
      if (stdout[offset + bit]! >= 128) value += 2 ** bit;
    }
    frames.push({ frame: value % 2 ** FRAME_BITS, sourceId: Math.floor(value / 2 ** FRAME_BITS) });
  }
  return frames;
}

export async function readPcm(path: string): Promise<Float32Array> {
  const { stdout } = await ffmpeg(["-i", path, "-map", "0:a:0", "-ac", "1", "-ar", String(AUDIO_SAMPLE_RATE), "-f", "f32le", "pipe:1"]);
  const copy = stdout.buffer.slice(stdout.byteOffset, stdout.byteOffset + stdout.length);
  return new Float32Array(copy);
}

/** Times in seconds where sound begins after at least 200 ms of silence. */
export function findBeepStarts(pcm: Float32Array): number[] {
  const starts: number[] = [];
  const minimumSilence = AUDIO_SAMPLE_RATE * 0.2;
  let silent = minimumSilence;
  for (let index = 0; index < pcm.length; index++) {
    if (Math.abs(pcm[index]!) > 0.1) {
      if (silent >= minimumSilence) starts.push(index / AUDIO_SAMPLE_RATE);
      silent = 0;
    } else {
      silent++;
    }
  }
  return starts;
}

/** Average 8-bit luma of a region at the given time, for checking colour and bars. */
export async function sampleFrameGray(path: string, region: string): Promise<number> {
  const { stdout } = await ffmpeg(["-i", path, "-frames:v", "1", "-vf", `crop=${region},scale=1:1:flags=area,format=gray`, "-f", "rawvideo", "pipe:1"]);
  return stdout[0]!;
}
