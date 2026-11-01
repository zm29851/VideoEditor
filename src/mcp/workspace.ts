import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, sep } from "node:path";
import type { CommandEngine } from "../engine.ts";
import { JobQueue, type Job } from "../jobs.ts";
import { buildPreviewProject, exportProject, timelineDuration } from "../media/export.ts";
import { importAudio, importVideo } from "../media/import.ts";
import { detectScenes } from "../media/analyze.ts";
import { findWhisper, loadTranscript, loadTranscripts, transcribeAsset } from "../media/whisper.ts";
import { isMediaClip, type Asset, type FrameRate, type Project, type Transcript } from "../schema.ts";
import { AgentPresence } from "./presence.ts";
import { createProjectFolder, openProjectFolder, projectPaths } from "../store.ts";
import { frameToTimecode } from "../time.ts";

const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const LANGUAGE = /^(auto|[a-z]{2,3})$/;
const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".mkv", ".webm", ".avi"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"]);

export function isAudioFile(path: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(path).toLowerCase());
}

/** Export names are checked, so a file always stays inside the project folder. */
const EXPORT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,99}$/u;

export interface MediaEntry {
  name: string;
  path: string;
  kind: "dir" | "video" | "audio";
  sizeBytes?: number;
}

export interface MediaListing {
  /** Absent at the top level, which lists the allowed folders. */
  path?: string;
  parent?: string;
  entries: MediaEntry[];
}

function uniquePath(directory: string, name: string): string {
  mkdirSync(directory, { recursive: true });
  const extension = extname(name);
  const stem = name.slice(0, name.length - extension.length);
  let candidate = join(directory, name);
  for (let suffix = 2; existsSync(candidate); suffix++) {
    candidate = join(directory, `${stem}-${suffix}${extension}`);
  }
  return candidate;
}

/** The whole machine: this is a local app and the person chooses which video to open. */
export function defaultMediaDirs(): string[] {
  return [parse(homedir()).root];
}

function isInside(dir: string, real: string): boolean {
  return real === dir || real.startsWith(dir.endsWith(sep) ? dir : dir + sep);
}

/** The projects on disk, kept as one engine each so every caller shares the same revision. */
export class Workspace {
  readonly root: string;
  readonly jobs: JobQueue;
  readonly agent = new AgentPresence();
  readonly mediaDirs: string[];
  #engines = new Map<string, CommandEngine>();

  constructor(root: string, mediaDirs: string[] = defaultMediaDirs()) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
    this.jobs = new JobQueue(join(this.root, ".jobs.json"));
    this.mediaDirs = mediaDirs.filter(existsSync).map((dir) => realpathSync(dir));
  }

  projectRoot(projectId: string): string {
    if (!PROJECT_ID.test(projectId)) {
      throw new Error(`Tên project "${projectId}" không hợp lệ: chỉ dùng chữ, số, "_" và "-", tối đa 64 ký tự.`);
    }
    return join(this.root, projectId);
  }

  list(): string[] {
    return readdirSync(this.root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && PROJECT_ID.test(entry.name))
      .filter((entry) => existsSync(projectPaths(join(this.root, entry.name)).project))
      .map((entry) => entry.name);
  }

  create(projectId: string, options: { name?: string; width?: number; height?: number; fps?: FrameRate }): CommandEngine {
    const { width = 1920, height = 1080 } = options;
    if (width % 2 !== 0 || height % 2 !== 0 || width < 16 || height < 16 || width > 7680 || height > 7680) {
      throw new Error(`Khung ${width} × ${height} không hợp lệ: chiều rộng và chiều cao phải là số chẵn, từ 16 đến 7680.`);
    }
    const engine = createProjectFolder(this.projectRoot(projectId), { name: projectId, ...options });
    this.#engines.set(projectId, engine);
    return engine;
  }

  engine(projectId: string): CommandEngine {
    const cached = this.#engines.get(projectId);
    if (cached) return cached;
    const root = this.projectRoot(projectId);
    if (!existsSync(projectPaths(root).project)) throw new Error(`Không có project "${projectId}".`);
    const engine = openProjectFolder(root);
    this.#engines.set(projectId, engine);
    return engine;
  }

  /** Only real video files inside the allowed folders can be read, whoever is asking. */
  resolveMediaPath(path: string): string {
    if (!isAbsolute(path)) throw new Error(`Cần đường dẫn tuyệt đối, nhận được "${path}".`);
    if (!existsSync(path)) throw new Error(`Không tìm thấy file "${path}".`);
    const real = realpathSync(path);
    if (!VIDEO_EXTENSIONS.has(extname(real).toLowerCase()) && !isAudioFile(real)) {
      throw new Error(`"${path}" không phải file video hoặc âm thanh được hỗ trợ (${[...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].join(", ")}).`);
    }
    if (!this.mediaDirs.some((dir) => isInside(dir, real))) {
      throw new Error(`"${path}" nằm ngoài các thư mục được phép: ${this.mediaDirs.join(", ")}.`);
    }
    return real;
  }

  /** With the whole machine allowed, the usual places come first so nobody has to start from the disk root. */
  #startingPoints(): string[] {
    const roots = this.mediaDirs.filter((dir) => parse(dir).root === dir);
    if (roots.length === 0) return this.mediaDirs;
    const home = homedir();
    const usual = [home, ...["Desktop", "Downloads", "Movies", "Documents", "Pictures"].map((name) => join(home, name)), "/Volumes"];
    return [...usual.filter(existsSync), ...this.mediaDirs];
  }

  /** Folders and videos inside the allowed folders. Hidden files and other file types stay out of it. */
  browseMedia(path?: string): MediaListing {
    if (!path) {
      return { entries: this.#startingPoints().map((dir) => ({ name: basename(dir) || "Toàn bộ máy", path: dir, kind: "dir" })) };
    }
    if (!isAbsolute(path) || !existsSync(path)) throw new Error(`Không tìm thấy thư mục "${path}".`);
    const real = realpathSync(path);
    if (!this.mediaDirs.some((dir) => isInside(dir, real))) {
      throw new Error(`"${path}" nằm ngoài các thư mục được phép: ${this.mediaDirs.join(", ")}.`);
    }
    const entries: MediaEntry[] = [];
    for (const entry of readdirSync(real)) {
      if (entry.startsWith(".")) continue;
      const full = join(real, entry);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) entries.push({ name: entry, path: full, kind: "dir" });
        else if (VIDEO_EXTENSIONS.has(extname(entry).toLowerCase())) {
          entries.push({ name: entry, path: full, kind: "video", sizeBytes: stat.size });
        } else if (isAudioFile(entry)) {
          entries.push({ name: entry, path: full, kind: "audio", sizeBytes: stat.size });
        }
      } catch {
        // A broken link or a file removed while listing is simply not shown.
      }
    }
    entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, "vi"));
    const parent = this.mediaDirs.includes(real) ? undefined : dirname(real);
    return { path: real, ...(parent ? { parent } : {}), entries };
  }

  startImport(projectId: string, path: string): Job {
    const source = this.resolveMediaPath(path);
    const engine = this.engine(projectId);
    return this.jobs.enqueue(
      "import",
      projectId,
      async ({ setStage, setProgress, signal }) => {
        const report = ({ stage, percent }: { stage: string; percent: number }) => {
          setStage(stage);
          setProgress(percent);
        };
        const root = this.projectRoot(projectId);
        const { fps } = engine.project;
        const { asset, timings } = isAudioFile(source)
          ? await importAudio(root, source, fps, report, signal)
          : await importVideo(root, source, fps, undefined, report, signal);
        engine.registerAsset(asset);
        return { asset, timings, revision: engine.project.revision };
      },
      basename(source),
    );
  }

  #asset(projectId: string, assetId: string): Asset {
    const asset = this.engine(projectId).project.assets.find((candidate) => candidate.id === assetId);
    if (!asset) throw new Error(`Không có asset "${assetId}".`);
    return asset;
  }

  /** Asking again while the same video is waiting or running returns that job. */
  startTranscribe(projectId: string, assetId: string, language: string): Job {
    if (!LANGUAGE.test(language)) throw new Error(`Ngôn ngữ "${language}" không hợp lệ: dùng mã như "vi", "en" hoặc "auto".`);
    const asset = this.#asset(projectId, assetId);
    if (!asset.hasAudio) throw new Error(`Video "${asset.name}" không có tiếng nên không tạo được transcript.`);
    const running = this.jobs
      .listForProject(projectId)
      .find((job) => job.type === "transcribe" && job.assetId === assetId && (job.status === "queued" || job.status === "running"));
    if (running) return running;
    const setup = findWhisper();
    const { fps } = this.engine(projectId).project;
    return this.jobs.enqueue(
      "transcribe",
      projectId,
      async ({ setStage, setProgress, signal }) => {
        const transcript = await transcribeAsset(this.projectRoot(projectId), asset, fps, language, setup, (stage, percent) => {
          setStage(stage);
          setProgress(percent);
        }, signal);
        return { assetId, language: transcript.language, model: transcript.model, wordCount: transcript.segments.reduce((sum, segment) => sum + segment.words.length, 0) };
      },
      asset.name,
      assetId,
    );
  }

  transcript(projectId: string, assetId: string): Transcript | undefined {
    this.#asset(projectId, assetId);
    return loadTranscript(this.projectRoot(projectId), assetId);
  }

  transcripts(projectId: string): Map<string, Transcript> {
    return loadTranscripts(this.projectRoot(projectId), this.engine(projectId).project);
  }

  /** Reads the whole picture of every video on the timeline, so it runs as a job. */
  startDetectScenes(projectId: string, threshold: number): Job {
    const project = this.engine(projectId).project;
    const clips = project.timeline.tracks.filter((track) => track.kind === "video").flatMap((track) => track.clips).filter(isMediaClip);
    const used = project.assets.filter((asset) => clips.some((clip) => clip.assetId === asset.id));
    if (used.length === 0) throw new Error("Timeline đang rỗng, không có gì để phân tích.");
    return this.jobs.enqueue("detect_scenes", projectId, async ({ setProgress, signal }) => {
      const cuts: Array<{ frame: number; timecode: string; clipId: string; score: number }> = [];
      for (const [index, asset] of used.entries()) {
        const scenes = await detectScenes(asset, project.fps, threshold, signal);
        for (const clip of clips.filter((candidate) => candidate.assetId === asset.id)) {
          for (const scene of scenes) {
            // A cut on the clip's first frame is already a cut on the timeline.
            if (scene.frame <= clip.sourceIn || scene.frame >= clip.sourceIn + clip.duration) continue;
            const frame = clip.start + scene.frame - clip.sourceIn;
            cuts.push({ frame, timecode: frameToTimecode(frame, project.fps), clipId: clip.id, score: scene.score });
          }
        }
        setProgress(((index + 1) / used.length) * 99);
      }
      return { revision: project.revision, cuts: cuts.sort((a, b) => a.frame - b.frame) };
    });
  }

  #startRender(type: string, projectId: string, project: Project, output: string, draft: boolean, revision: number, range?: { start: number; end: number }): Job {
    const end = timelineDuration(project);
    const window = range ? { start: range.start, end: Math.min(range.end, end) } : { start: 0, end };
    const total = window.end - window.start;
    if (total <= 0) throw new Error("Timeline đang rỗng, không có gì để xuất.");
    const textDir = join(this.projectRoot(projectId), "cache", "text");
    return this.jobs.enqueue(
      type,
      projectId,
      async ({ setProgress, signal }) => {
        try {
          await exportProject(project, output, { draft, range: window, textDir, signal }, (frame) => setProgress((frame / total) * 99));
        } catch (error) {
          // A half-written file would look like a finished export.
          rmSync(output, { force: true });
          throw error;
        }
        return { path: output, revision, durationFrames: total, durationTimecode: frameToTimecode(total, project.fps) };
      },
      basename(output),
    );
  }

  startPreview(projectId: string, from: number, to: number): Job {
    const project = this.engine(projectId).project;
    if (from < 0 || to <= from) throw new Error(`Khoảng frame ${from}..${to} không hợp lệ.`);
    const output = uniquePath(join(this.projectRoot(projectId), "previews"), `preview-r${project.revision}-${from}-${to}.mp4`);
    return this.#startRender("preview", projectId, buildPreviewProject(project), output, true, project.revision, { start: from, end: to });
  }

  /** Renders the timeline as it is now. Later edits do not affect the running job. */
  startExport(projectId: string, name: string): Job {
    if (!EXPORT_NAME.test(name)) {
      throw new Error(`Tên file "${name}" không hợp lệ: bắt đầu bằng chữ hoặc số, chỉ dùng chữ, số, dấu cách, "_", "-" và ".".`);
    }
    const project = this.engine(projectId).project;
    const output = uniquePath(join(this.projectRoot(projectId), "exports"), `${name.replace(/\.mp4$/i, "")}.mp4`);
    return this.#startRender("export", projectId, project, output, false, project.revision);
  }
}
