import { accessSync, constants, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { cpus, homedir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { Transcript, type Asset, type FrameRate, type Project, type TranscriptWord } from "../schema.ts";
import { fpsToNumber } from "../time.ts";
import { ffmpeg, run } from "./ffmpeg.ts";

/** Best first. The large model is much better on Vietnamese, and slower. */
const MODEL_NAMES = ["ggml-large-v3-turbo.bin", "ggml-small.bin", "ggml-base.bin"];
const VAD_NAME = "ggml-silero-v5.1.2.bin";

export interface WhisperSetup {
  binary: string;
  model: string;
  vadModel?: string;
}

function findBinary(): string | undefined {
  const fromEnv = process.env.VE_WHISPER_BIN;
  if (fromEnv) return fromEnv;
  const folders = [...(process.env.PATH ?? "").split(delimiter), join(homedir(), ".local", "bin")];
  return folders
    .map((folder) => join(folder, "whisper-cli"))
    .find((path) => {
      try {
        accessSync(path, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
}

/** Paths come from VE_WHISPER_BIN, VE_WHISPER_MODEL and VE_WHISPER_VAD, otherwise the usual places. */
export function findWhisper(): WhisperSetup {
  const binary = findBinary();
  if (!binary) {
    throw new Error("Chưa tìm thấy whisper-cli. Hãy đặt nó vào ~/.local/bin hoặc đặt biến môi trường VE_WHISPER_BIN, rồi khởi động lại server.");
  }
  const folder = join(homedir(), ".local", "share", "whisper");
  const model = process.env.VE_WHISPER_MODEL ?? MODEL_NAMES.map((name) => join(folder, name)).find(existsSync);
  if (!model) {
    throw new Error(`Chưa tìm thấy model whisper. Hãy đặt ${MODEL_NAMES[0]} vào ${folder} hoặc đặt biến môi trường VE_WHISPER_MODEL, rồi khởi động lại server.`);
  }
  const vadModel = process.env.VE_WHISPER_VAD ?? [join(folder, VAD_NAME)].find(existsSync);
  return { binary, model, ...(vadModel ? { vadModel } : {}) };
}

interface WhisperToken {
  text: string;
  offsets: { from: number; to: number };
  p: number;
}

interface WhisperOutput {
  result: { language: string };
  transcription: Array<{ text: string; offsets: { from: number; to: number }; tokens: WhisperToken[] }>;
}

const SENTENCE_END = /[.?!…]$/;
const MAX_WORDS_PER_LINE = 30;
const LINE_BREAK_PAUSE_SECONDS = 0.7;

/**
 * Reads whisper's output when run with one word per segment. With VAD on, only segment times are mapped
 * back to the real audio: token times skip the silence, so they are used for a word's length and nothing else.
 * The file is read byte for byte because a token can end in the middle of a Vietnamese letter.
 */
export function parseWhisperOutput(raw: Buffer, assetId: string, durationFrames: number, fps: FrameRate, model: string): Transcript {
  const output = JSON.parse(raw.toString("latin1")) as WhisperOutput;
  const rate = fpsToNumber(fps);
  const breakFrames = LINE_BREAK_PAUSE_SECONDS * rate;
  const segments: Transcript["segments"] = [];
  let line: TranscriptWord[] = [];
  const endLine = () => {
    if (line.length > 0) segments.push({ words: line });
    line = [];
  };
  for (const segment of output.transcription) {
    const text = Buffer.from(segment.text, "latin1").toString("utf8").trim();
    const tokens = segment.tokens.filter((token) => !token.text.startsWith("[_") && !token.text.startsWith("<|"));
    if (!text || tokens.length === 0) continue;
    // A word after a skipped silence spans that silence. It was spoken at the end of the span.
    const spoken = tokens.at(-1)!.offsets.to - tokens[0]!.offsets.from;
    const toMs = segment.offsets.to;
    const fromMs = Math.max(segment.offsets.from, toMs - spoken);
    const start = Math.min(Math.floor((fromMs / 1000) * rate + 1e-6), durationFrames - 1);
    const end = Math.min(Math.max(Math.ceil((toMs / 1000) * rate - 1e-6), start + 1), durationFrames);
    const probability = tokens.reduce((sum, token) => sum + token.p, 0) / tokens.length;
    const previous = line.at(-1);
    if (previous && (SENTENCE_END.test(previous.text) || start - previous.end >= breakFrames || line.length >= MAX_WORDS_PER_LINE)) endLine();
    line.push({ text, start, end, probability: Math.round(probability * 1000) / 1000 });
  }
  endLine();
  return { assetId, language: output.result.language, model, segments };
}

function transcriptPath(projectRoot: string, assetId: string): string {
  return join(projectRoot, "transcripts", `${assetId}.json`);
}

export function loadTranscript(projectRoot: string, assetId: string): Transcript | undefined {
  const path = transcriptPath(projectRoot, assetId);
  return existsSync(path) ? Transcript.parse(JSON.parse(readFileSync(path, "utf8"))) : undefined;
}

export function loadTranscripts(projectRoot: string, project: Project): Map<string, Transcript> {
  const found = new Map<string, Transcript>();
  for (const asset of project.assets) {
    const transcript = loadTranscript(projectRoot, asset.id);
    if (transcript) found.set(asset.id, transcript);
  }
  return found;
}

export async function transcribeAsset(
  projectRoot: string,
  asset: Asset,
  fps: FrameRate,
  language: string,
  setup: WhisperSetup,
  onProgress: (stage: string, percent: number) => void,
  signal?: AbortSignal,
): Promise<Transcript> {
  if (!asset.hasAudio) throw new Error(`Video "${asset.name}" không có tiếng nên không tạo được transcript.`);
  const work = join(projectRoot, "cache", `whisper-${asset.id}`);
  mkdirSync(work, { recursive: true });
  try {
    onProgress("Đang tách âm thanh", 0);
    const audio = join(work, "audio.wav");
    await ffmpeg(["-i", asset.masterPath, "-map", "0:a:0", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", audio], signal);

    onProgress("Đang nhận dạng lời nói", 1);
    const prefix = join(work, "out");
    // No text carried between segments and silence skipped: both stop whisper looping or inventing lines.
    const args = ["-m", setup.model, "-f", audio, "-l", language, "-t", String(cpus().length), "-mc", "0", "-sns", "-ml", "1", "-sow", "-np", "-pp", "-ojf", "-of", prefix];
    if (setup.vadModel) args.push("--vad", "--vad-model", setup.vadModel);
    await run(setup.binary, args, () => {}, (chunk) => {
      for (const match of chunk.matchAll(/progress =\s*(\d+)%/g)) onProgress("Đang nhận dạng lời nói", Number(match[1]));
    }, signal);

    const transcript = parseWhisperOutput(readFileSync(`${prefix}.json`), asset.id, asset.durationFrames, fps, basename(setup.model));
    const path = transcriptPath(projectRoot, asset.id);
    mkdirSync(join(projectRoot, "transcripts"), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify(transcript));
    renameSync(`${path}.tmp`, path);
    return transcript;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
