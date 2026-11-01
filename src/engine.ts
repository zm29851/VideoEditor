import { CommandError, applyCommand, diffTimelines, revertChanges, type ClipChanges } from "./commands.ts";
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
  /** The real id behind each name given with "as" in the batch. */
  aliases: Record<string, string>;
}

/** One line of the activity list: what happened, without the timeline copies kept for undo. */
export interface ActivityEntry {
  revision: number;
  kind: HistoryEntry["kind"];
  actor: Actor;
  label: string;
  at: string;
  changes: ClipChanges;
  revertsRevision?: number;
  /** Only for batches: whether its effect is still on the timeline, and if not, what removed it. */
  state?: "active" | "undone" | "reverted";
  /** It can be taken back on its own, leaving later edits in place. */
  revertible: boolean;
}

export type EngineListener = () => void;

export interface Persistence {
  save(project: Project, entry?: HistoryEntry): void;
}

export function createProject(options: {
  name: string;
  fps?: FrameRate;
  width?: number;
  height?: number;
}): Project {
  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  return {
    version: 1,
    name: options.name,
    fps: options.fps ?? { num: 30, den: 1 },
    width,
    height,
    revision: 0,
    nextClipNumber: 1,
    assets: [],
    timeline: { tracks: [{ id: "video_1", kind: "video", clips: [] }], canvas: { width, height } },
  };
}

/** The only way to change a project. The UI and the MCP server both go through it. */
export class CommandEngine {
  #project: Project;
  #history: HistoryEntry[];
  #persistence: Persistence | undefined;
  #listeners = new Set<EngineListener>();

  constructor(project: Project, history: HistoryEntry[] = [], persistence?: Persistence) {
    project.timeline.canvas ??= { width: project.width, height: project.height };
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

  /** Called after every change, whoever made it. Returns the function that stops the calls. */
  subscribe(listener: EngineListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** The most recent changes, newest first. */
  activity(limit = 100): ActivityEntry[] {
    const live = this.#stacks().undo;
    const liveRevisions = new Set(live.map((entry) => entry.revision));
    const revertedRevisions = new Set(live.flatMap((entry) => entry.revertsRevision ?? []));
    return this.#history
      .slice(-limit)
      .reverse()
      .map((entry) => {
        const reverted = revertedRevisions.has(entry.revision);
        const active = liveRevisions.has(entry.revision) && !reverted;
        return {
          revision: entry.revision,
          kind: entry.kind,
          actor: entry.actor,
          label: entry.label,
          at: entry.at,
          changes: diffTimelines(entry.before, entry.after),
          ...(entry.revertsRevision === undefined ? {} : { revertsRevision: entry.revertsRevision }),
          ...(entry.kind === "apply" ? { state: reverted ? ("reverted" as const) : active ? ("active" as const) : ("undone" as const) } : {}),
          revertible: active && entry.revertsRevision === undefined,
        };
      });
  }

  /** Runs every command or none of them, as one undo step. */
  applyBatch(request: BatchRequest): BatchResult {
    this.#assertRevision(request.baseRevision);
    if (request.commands.length === 0) throw new CommandError("Lô lệnh đang rỗng.");

    const draft = structuredClone(this.#project);
    const aliases = new Map<string, string>();
    const createdClipIds: string[] = [];
    // History keeps the real ids, since a name means nothing outside its batch.
    const commands = request.commands.map((input) => {
      const parsed = Command.parse(input);
      const command = "clipId" in parsed ? { ...parsed, clipId: aliases.get(parsed.clipId) ?? parsed.clipId } : parsed;
      const created = applyCommand(draft, command);
      createdClipIds.push(...created);
      if ("as" in command && command.as !== undefined) {
        if (aliases.has(command.as)) throw new CommandError(`Tên "${command.as}" đã được dùng trong lô này. Hãy đặt tên khác.`);
        if (draft.timeline.tracks.some((track) => track.clips.some((clip) => clip.id === command.as))) {
          throw new CommandError(`Tên "${command.as}" trùng với một clip đã có. Hãy đặt tên khác.`);
        }
        aliases.set(command.as, created[0]!);
      }
      return command;
    });

    this.#commit(draft, {
      kind: "apply",
      actor: request.actor,
      label: request.label,
      commands,
      before: this.#project.timeline,
    });
    return { revision: draft.revision, createdClipIds, aliases: Object.fromEntries(aliases) };
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

  /** Takes back one earlier batch and keeps what was done after it. Undo then brings the batch back. */
  revert(actor: Actor, baseRevision: number, revision: number): BatchResult {
    this.#assertRevision(baseRevision);
    const live = this.#undoStack();
    const target = live.find((entry) => entry.revision === revision);
    if (!target) throw new CommandError(`Lô ở revision ${revision} không còn trên timeline nên không cần hoàn tác.`);
    if (target.revertsRevision !== undefined) throw new CommandError("Đây là một lần hoàn tác lô. Hãy dùng Hoàn tác để lấy lại lô đó.");
    if (live.some((entry) => entry.revertsRevision === revision)) throw new CommandError(`Lô ở revision ${revision} đã được hoàn tác rồi.`);

    const draft = structuredClone(this.#project);
    revertChanges(draft, target.before, target.after);
    this.#commit(draft, {
      kind: "apply",
      actor,
      label: `Hoàn tác lô: ${target.label}`,
      commands: [],
      revertsRevision: revision,
      before: this.#project.timeline,
    });
    return { revision: draft.revision, createdClipIds: [], aliases: {} };
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
    this.#notify();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener();
  }

  #assertRevision(baseRevision: number): void {
    if (baseRevision !== this.#project.revision) {
      throw new StaleRevisionError(baseRevision, this.#project.revision);
    }
  }

  #restore(actor: Actor, kind: "undo" | "redo", label: string, timeline: Timeline): BatchResult {
    const draft = structuredClone(this.#project);
    draft.timeline = structuredClone(timeline);
    // Without a size the entry is older than any change of size, so the current one still holds.
    if (timeline.canvas) {
      draft.width = timeline.canvas.width;
      draft.height = timeline.canvas.height;
    } else {
      draft.timeline.canvas = { width: draft.width, height: draft.height };
    }
    this.#commit(draft, { kind, actor, label, commands: [], before: this.#project.timeline });
    return { revision: draft.revision, createdClipIds: [], aliases: {} };
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
    this.#notify();
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
