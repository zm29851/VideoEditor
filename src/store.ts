import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CommandEngine, createProject, type Persistence } from "./engine.ts";
import { HistoryEntry, Project } from "./schema.ts";

export interface ProjectPaths {
  root: string;
  project: string;
  history: string;
  masters: string;
  proxies: string;
  cache: string;
}

export function projectPaths(root: string): ProjectPaths {
  return {
    root,
    project: join(root, "project.json"),
    history: join(root, "history.jsonl"),
    masters: join(root, "masters"),
    proxies: join(root, "proxies"),
    cache: join(root, "cache"),
  };
}

class FilePersistence implements Persistence {
  #paths: ProjectPaths;

  constructor(paths: ProjectPaths) {
    this.#paths = paths;
  }

  save(project: Project, entry?: HistoryEntry): void {
    if (entry) appendFileSync(this.#paths.history, `${JSON.stringify(entry)}\n`);
    const temporary = `${this.#paths.project}.tmp`;
    writeFileSync(temporary, JSON.stringify(project, null, 2));
    renameSync(temporary, this.#paths.project);
  }
}

export function createProjectFolder(
  root: string,
  options: Parameters<typeof createProject>[0],
): CommandEngine {
  const paths = projectPaths(root);
  if (existsSync(paths.project)) throw new Error(`Đã có project tại ${root}.`);
  for (const dir of [paths.root, paths.masters, paths.proxies, paths.cache]) {
    mkdirSync(dir, { recursive: true });
  }
  const project = createProject(options);
  const persistence = new FilePersistence(paths);
  persistence.save(project);
  return new CommandEngine(project, [], persistence);
}

export function openProjectFolder(root: string): CommandEngine {
  const paths = projectPaths(root);
  const project = Project.parse(JSON.parse(readFileSync(paths.project, "utf8")));
  const lines = existsSync(paths.history)
    ? readFileSync(paths.history, "utf8").split("\n").filter(Boolean)
    : [];
  // project.json is authoritative: a crash between the two writes can leave one extra history line.
  const history = lines
    .map((line) => HistoryEntry.parse(JSON.parse(line)))
    .filter((entry) => entry.revision <= project.revision);
  return new CommandEngine(project, history, new FilePersistence(paths));
}
