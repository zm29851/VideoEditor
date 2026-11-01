export type RebaseOutcome<T> =
  | { kind: "done"; value: T }
  /** The timeline kept changing, or the action must not be resent. */
  | { kind: "stale" }
  /** Refused for another reason. rebased says it might have worked on the timeline the person saw. */
  | { kind: "failed"; error: unknown; rebased: boolean };

/** Sends an edit, and when someone else got in first, sends it again on top of their change. */
export async function runRebased<T>(options: {
  attempt: () => Promise<T>;
  refresh: () => Promise<void>;
  isStale: (error: unknown) => boolean;
  maxAttempts: number;
}): Promise<RebaseOutcome<T>> {
  let rebased = false;
  for (let attempt = 1; ; attempt++) {
    try {
      return { kind: "done", value: await options.attempt() };
    } catch (error) {
      if (!options.isStale(error)) return { kind: "failed", error, rebased };
      try {
        await options.refresh();
      } catch (refreshError) {
        return { kind: "failed", error: refreshError, rebased };
      }
      if (attempt >= options.maxAttempts) return { kind: "stale" };
      rebased = true;
    }
  }
}
