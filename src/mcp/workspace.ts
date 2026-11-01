import { existsSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { extname, isAbsolute, join, sep } from "node:path";
import type { CommandEngine } from "../engine.ts";
import { JobQueue } from "../jobs.ts";
import { createProjectFolder, openProjectFolder, projectPaths } from "../store.ts";

const PROJECT_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const VIDEO_EXTENSIONS = new Set([".mov", ".mp4", ".m4v", ".mkv", ".webm", ".avi"]);

export function defaultMediaDirs(): string[] {
  return ["Movies", "Downloads", "Desktop", "Pictures"].map((name) => join(homedir(), name));
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

  create(projectId: string, options: { width?: number; height?: number }): CommandEngine {
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
    if (!this.mediaDirs.some((dir) => real.startsWith(dir + sep))) {
      throw new Error(`"${path}" nằm ngoài các thư mục được phép: ${this.mediaDirs.join(", ")}.`);
    }
    return real;
  }
}
