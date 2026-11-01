import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, parse, sep } from "node:path";
import type { CommandEngine } from "../engine.ts";
import { JobQueue, type Job } from "../jobs.ts";
import { buildPreviewProject, exportProject, timelineDuration } from "../media/export.ts";
import { importVideo } from "../media/import.ts";
import type { Project } from "../schema.ts";
import { createProjectFolder, openProjectFolder, projectPaths } from "../store.ts";
import { frameToTimecode } from "../time.ts";

const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".mkv", ".webm", ".avi"]);

/** Export names are checked, so a file always stays inside the project folder. */
const EXPORT_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,99}$/u;

export interface MediaEntry {
  name: string;
  path: string;
  kind: "dir" | "video";
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
  readonly jobs = new JobQueue();
  readonly mediaDirs: string[];
  #engines = new Map<string, CommandEngine>();

  constructor(root: string, mediaDirs: string[] = defaultMediaDirs()) {
    mkdirSync(root, { recursive: true });
    this.root = realpathSync(root);
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

  create(projectId: string, options: { name?: string; width?: number; height?: number }): CommandEngine {
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
    if (!VIDEO_EXTENSIONS.has(extname(real).toLowerCase())) {
      throw new Error(`"${path}" không phải file video được hỗ trợ (${[...VIDEO_EXTENSIONS].join(", ")}).`);
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
      async ({ setStage, setProgress }) => {
        const { asset, timings } = await importVideo(this.projectRoot(projectId), source, engine.project.fps, undefined, ({ stage, percent }) => {
          setStage(stage);
          setProgress(percent);
        });
        engine.registerAsset(asset);
        return { asset, timings, revision: engine.project.revision };
      },
      basename(source),
    );
  }

  #startRender(type: string, projectId: string, project: Project, output: string, draft: boolean, revision: number): Job {
    const total = timelineDuration(project);
    if (total === 0) throw new Error("Timeline đang rỗng, không có gì để xuất.");
    return this.jobs.enqueue(
      type,
      projectId,
      async ({ setProgress }) => {
        await exportProject(project, output, { draft }, (frame) => setProgress((frame / total) * 99));
        return { path: output, revision, durationFrames: total, durationTimecode: frameToTimecode(total, project.fps) };
      },
      basename(output),
    );
  }

  startPreview(projectId: string, from: number, to: number): Job {
    const project = this.engine(projectId).project;
    if (from < 0 || to <= from) throw new Error(`Khoảng frame ${from}..${to} không hợp lệ.`);
    const output = uniquePath(join(this.projectRoot(projectId), "previews"), `preview-r${project.revision}-${from}-${to}.mp4`);
    return this.#startRender("preview", projectId, buildPreviewProject(project, from, to), output, true, project.revision);
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
