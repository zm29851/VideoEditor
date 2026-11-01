import { CommandError, applyCommand } from "./commands.ts";
import {
  Command,
  type Actor,
  type Asset,
  type CommandInput,
  type FrameRate,
  type HistoryEntry,
  type Project,
  type Timeline,
} from "./schema.ts";

/** The timeline changed after the caller last read it. */
export class StaleRevisionError extends Error {
  override name = "StaleRevisionError";
  constructor(expected: number, actual: number) {
    super(`Timeline đã ở revision ${actual}, lệnh dựa trên revision ${expected}. Hãy đọc lại rồi gửi lại.`);
  }
}

export interface BatchRequest {
  actor: Actor;
  baseRevision: number;
  label: string;
  commands: CommandInput[];
}

export interface BatchResult {
  revision: number;
  createdClipIds: string[];
}

export interface Persistence {
  save(project: Project, entry?: HistoryEntry): void;
}

export function createProject(options: {
  name: string;
  fps?: FrameRate;
  width?: number;
  height?: number;
}): Project {
  return {
    version: 1,
    name: options.name,
    fps: options.fps ?? { num: 30, den: 1 },
    width: options.width ?? 1920,
    height: options.height ?? 1080,
    revision: 0,
    nextClipNumber: 1,
    assets: [],
    timeline: { tracks: [{ id: "video_1", kind: "video", clips: [] }] },
  };
}

/** The only way to change a project. The UI and the MCP server both go through it. */
export class CommandEngine {
  #project: Project;
  #history: HistoryEntry[];
  #persistence: Persistence | undefined;

  constructor(project: Project, history: HistoryEntry[] = [], persistence?: Persistence) {
    this.#project = project;
    this.#history = history;
    this.#persistence = persistence;
  }

  get project(): Project {
    return structuredClone(this.#project);
  }

  get history(): HistoryEntry[] {
    return structuredClone(this.#history);
  }

  /** What undo would revert, or undefined when there is nothing to undo. */
  get undoLabel(): string | undefined {
    return this.#undoStack().at(-1)?.label;
  }

  get redoLabel(): string | undefined {
    return this.#redoStack().at(-1)?.label;
  }

  /** Runs every command or none of them, as one undo step. */
  applyBatch(request: BatchRequest): BatchResult {
    this.#assertRevision(request.baseRevision);
    if (request.commands.length === 0) throw new CommandError("Lô lệnh đang rỗng.");

    const commands = request.commands.map((command) => Command.parse(command));
    const draft = structuredClone(this.#project);
    const createdClipIds = commands.flatMap((command) => applyCommand(draft, command));

    this.#commit(draft, {
      kind: "apply",
      actor: request.actor,
      label: request.label,
      commands,
      before: this.#project.timeline,
    });
    return { revision: draft.revision, createdClipIds };
  }

  undo(actor: Actor, baseRevision: number): BatchResult {
    this.#assertRevision(baseRevision);
    const target = this.#undoStack().at(-1);
    if (!target) throw new CommandError("Không còn thao tác nào để hoàn tác.");
    return this.#restore(actor, "undo", `Hoàn tác: ${target.label}`, target.before);
  }

  redo(actor: Actor, baseRevision: number): BatchResult {
    this.#assertRevision(baseRevision);
    const target = this.#redoStack().at(-1);
    if (!target) throw new CommandError("Không còn thao tác nào để làm lại.");
    return this.#restore(actor, "redo", `Làm lại: ${target.label}`, target.after);
  }

  /** Assets are not undoable: undoing an edit must never remove media from the library. */
  registerAsset(asset: Asset): void {
    const draft = structuredClone(this.#project);
    if (draft.assets.some((existing) => existing.id === asset.id)) {
      throw new CommandError(`Asset "${asset.id}" đã tồn tại.`);
    }
    draft.assets.push(asset);
    draft.revision++;
    this.#project = draft;
    this.#persistence?.save(draft);
  }

  #assertRevision(baseRevision: number): void {
    if (baseRevision !== this.#project.revision) {
      throw new StaleRevisionError(baseRevision, this.#project.revision);
    }
  }

  #restore(actor: Actor, kind: "undo" | "redo", label: string, timeline: Timeline): BatchResult {
    const draft = structuredClone(this.#project);
    draft.timeline = structuredClone(timeline);
    this.#commit(draft, { kind, actor, label, commands: [], before: this.#project.timeline });
    return { revision: draft.revision, createdClipIds: [] };
  }

  #commit(draft: Project, partial: Omit<HistoryEntry, "revision" | "after" | "at">): void {
    draft.revision = this.#project.revision + 1;
    const entry: HistoryEntry = {
      ...partial,
      revision: draft.revision,
      before: structuredClone(partial.before),
      after: structuredClone(draft.timeline),
      at: new Date().toISOString(),
    };
    this.#persistence?.save(draft, entry);
    this.#project = draft;
    this.#history.push(entry);
  }

  #stacks(): { undo: HistoryEntry[]; redo: HistoryEntry[] } {
    const undo: HistoryEntry[] = [];
    let redo: HistoryEntry[] = [];
    for (const entry of this.#history) {
      if (entry.kind === "apply") {
        undo.push(entry);
        redo = [];
      } else if (entry.kind === "undo") {
        const undone = undo.pop();
        if (undone) redo.push(undone);
      } else {
        const redone = redo.pop();
        if (redone) undo.push(redone);
      }
    }
    return { undo, redo };
  }

  #undoStack(): HistoryEntry[] {
    return this.#stacks().undo;
  }

  #redoStack(): HistoryEntry[] {
    return this.#stacks().redo;
  }
}
