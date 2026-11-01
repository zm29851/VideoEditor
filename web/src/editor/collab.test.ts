import { describe, expect, it } from "vitest";
import type { ActivityEntry } from "../../../src/engine.ts";
import { agentClipIds, describeChanges, unseenAgentEntries } from "./agentNotice.ts";
import { runRebased } from "./rebase.ts";

const stale = new Error("stale");

function attempts(...results: Array<number | Error>) {
  const calls = { attempt: 0, refresh: 0 };
  return {
    calls,
    options: {
      attempt: async () => {
        const result = results[calls.attempt++]!;
        if (result instanceof Error) throw result;
        return result;
      },
      refresh: async () => {
        calls.refresh++;
      },
      isStale: (error: unknown) => error === stale,
    },
  };
}

describe("resending an edit", () => {
  it("sends again on the new timeline when someone else got in first", async () => {
    const { calls, options } = attempts(stale, 7);
    expect(await runRebased({ ...options, maxAttempts: 3 })).toEqual({ kind: "done", value: 7 });
    expect(calls).toEqual({ attempt: 2, refresh: 1 });
  });

  it("says when the edit no longer fits the new timeline", async () => {
    const refused = new Error("chồng lên");
    const { options } = attempts(stale, refused);
    expect(await runRebased({ ...options, maxAttempts: 3 })).toEqual({ kind: "failed", error: refused, rebased: true });
  });

  it("a refusal on the first try is not blamed on the timeline changing", async () => {
    const refused = new Error("sai");
    const { calls, options } = attempts(refused);
    expect(await runRebased({ ...options, maxAttempts: 3 })).toEqual({ kind: "failed", error: refused, rebased: false });
    expect(calls.refresh).toBe(0);
  });

  it("undo is not resent, but the screen still catches up", async () => {
    const { calls, options } = attempts(stale, 7);
    expect(await runRebased({ ...options, maxAttempts: 1 })).toEqual({ kind: "stale" });
    expect(calls).toEqual({ attempt: 1, refresh: 1 });
  });

  it("gives up if the timeline keeps changing", async () => {
    const { calls, options } = attempts(stale, stale, stale, 7);
    expect(await runRebased({ ...options, maxAttempts: 3 })).toEqual({ kind: "stale" });
    expect(calls.attempt).toBe(3);
  });
});

const entry = (revision: number, partial: Partial<ActivityEntry> = {}): ActivityEntry => ({
  revision,
  kind: "apply",
  actor: "agent",
  label: `lô ${revision}`,
  at: "",
  changes: { added: [], removed: [], modified: [] },
  state: "active",
  revertible: true,
  ...partial,
});

describe("agent notice", () => {
  it("keeps only agent changes newer than what was seen and still in effect", () => {
    const list = [
      entry(6, { kind: "undo", state: undefined as never }),
      entry(5, { state: "reverted" }),
      entry(4, { state: "undone" }),
      entry(3, { actor: "user" }),
      entry(2),
      entry(1),
    ];
    expect(unseenAgentEntries(list, 1).map((item) => item.revision)).toEqual([6, 2]);
  });

  it("marks added and changed clips, not removed ones", () => {
    const ids = agentClipIds([entry(2, { changes: { added: ["a"], removed: ["b"], modified: ["c"] } })]);
    expect([...ids]).toEqual(["a", "c"]);
  });

  it("describes a change in words", () => {
    expect(describeChanges({ added: ["a"], removed: ["b", "c"], modified: [] })).toBe("thêm 1 clip, xóa 2 clip");
    expect(describeChanges({ added: [], removed: [], modified: [] })).toBe("");
  });
});
