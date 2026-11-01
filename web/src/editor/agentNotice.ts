import type { ClipChanges } from "../../../src/commands.ts";
import type { ActivityEntry } from "../../../src/engine.ts";

/** Agent changes newer than what the person has acknowledged and still in effect, newest first. */
export function unseenAgentEntries(activity: ActivityEntry[], seenRevision: number): ActivityEntry[] {
  return activity.filter(
    (entry) => entry.actor === "agent" && entry.revision > seenRevision && (entry.kind !== "apply" || entry.state === "active"),
  );
}

export function agentClipIds(entries: ActivityEntry[]): Set<string> {
  return new Set(entries.flatMap((entry) => [...entry.changes.added, ...entry.changes.modified]));
}

export function describeChanges({ added, removed, modified }: ClipChanges): string {
  return [
    added.length > 0 && `thêm ${added.length} clip`,
    modified.length > 0 && `sửa ${modified.length} clip`,
    removed.length > 0 && `xóa ${removed.length} clip`,
  ]
    .filter(Boolean)
    .join(", ");
}
