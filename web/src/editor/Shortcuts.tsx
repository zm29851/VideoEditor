import { useEffect, useRef } from "react";
import { Dialog } from "../ui/ui.tsx";
import type { EditorContextValue } from "./Editor.tsx";
import { cutPoints } from "./timelineOps.ts";
import styles from "./Editor.module.css";

const LIST: Array<[string, string]> = [
  ["Phát hoặc dừng", "Space"],
  ["Lùi, tiến một frame", "← →"],
  ["Lùi, tiến một giây", "⇧← ⇧→"],
  ["Điểm cắt trước, sau", "↑ ↓"],
  ["Đầu, cuối timeline", "Home End"],
  ["Cắt clip tại playhead", "S"],
  ["Bỏ phần trước, sau playhead", "[ ]"],
  ["Kéo dài đầu, cuối clip, đẩy clip sau", "⌥[ ⌥]"],
  ["Di chuyển clip một frame", ", ."],
  ["Di chuyển clip mười frame", "⇧, ⇧."],
  ["Chuyển clip lên, xuống track khác", "⌥↑ ⌥↓"],
  ["Thêm chữ tại playhead", "T"],
  ["Xóa clip", "Delete"],
  ["Xóa và dồn", "⇧Delete"],
  ["Bỏ chọn clip", "Esc"],
  ["Trong Transcript: đi giữa các từ, chọn đoạn", "← → ⇧← ⇧→"],
  ["Trong Transcript: xóa và dồn đoạn đã chọn", "Delete"],
  ["Bật, tắt bám điểm cắt", "N"],
  ["Phóng to, thu nhỏ timeline", "+ −"],
  ["Vừa khít timeline", "⇧Z"],
  ["Hoàn tác, làm lại", "⌘Z ⇧⌘Z"],
  ["Hoàn tác lô mới nhất của agent", "⌥⌘Z"],
  ["Xuất video", "⌘E"],
  ["Xem phím tắt", "?"],
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="Phím tắt" wide>
      <dl className={styles.shortcuts}>
        {LIST.map(([action, keys]) => (
          <div key={action} className={styles.shortcut}>
            <dt>{action}</dt>
            <dd>
              <kbd className={styles.kbd}>{keys}</kbd>
            </dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}

function ignoresShortcuts(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement;
  if (document.querySelector('[role="dialog"]')) return true;
  if (target.closest("input, textarea, [role='slider']")) return true;
  // A focused button keeps its own Space. On a clip, Space still plays and Enter selects.
  if (event.key === " " && target.closest("button, a") && !target.closest("[data-clip]")) return true;
  return false;
}

export function useShortcuts(editor: EditorContextValue | null): void {
  // Read through a ref, so the listener is added once and always sees the current state.
  const latest = useRef(editor);
  latest.current = editor;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const e = latest.current;
      if (!e || ignoresShortcuts(event)) return;
      const { player } = e;
      const command = event.metaKey || event.ctrlKey;
      const secondFrames = Math.round(e.project.fps.num / e.project.fps.den);
      // Option changes the character a key types on a Mac, so this one is read from the physical key.
      const physical: Record<string, string> = { KeyZ: "z", BracketLeft: "[", BracketRight: "]" };
      const key = event.altKey && physical[event.code] ? physical[event.code]! : event.key.length === 1 ? event.key.toLowerCase() : event.key;

      const actions: Record<string, () => void> = command
        ? {
            z: event.altKey ? e.revertLatestAgentBatch : event.shiftKey ? e.redo : e.undo,
            e: e.openExport,
          }
        : {
            " ": () => player.toggle(),
            ArrowLeft: () => player.step(event.shiftKey ? -secondFrames : -1),
            ArrowRight: () => player.step(event.shiftKey ? secondFrames : 1),
            ArrowUp: () => {
              if (event.altKey) return e.moveToTrack(1);
              const previous = cutPoints(e.clips).filter((point) => point < player.frame).at(-1);
              player.seek(previous ?? 0);
            },
            ArrowDown: () => {
              if (event.altKey) return e.moveToTrack(-1);
              const next = cutPoints(e.clips).find((point) => point > player.frame);
              if (next !== undefined) player.seek(next);
            },
            Home: () => player.seek(0),
            End: () => player.seek(player.duration),
            s: e.cut,
            t: e.addText,
            "[": () => (event.altKey ? e.extendClip("start") : e.trimToPlayhead("start")),
            "]": () => (event.altKey ? e.extendClip("end") : e.trimToPlayhead("end")),
            ",": () => e.nudge(-1),
            ".": () => e.nudge(1),
            "<": () => e.nudge(-10),
            ">": () => e.nudge(10),
            Delete: () => e.remove(event.shiftKey),
            Backspace: () => e.remove(event.shiftKey),
            Escape: () => e.select(undefined),
            n: e.toggleSnap,
            "+": () => e.zoom(1),
            "=": () => e.zoom(1),
            "-": () => e.zoom(-1),
            z: () => {
              if (event.shiftKey) e.zoomFit();
            },
            "?": e.openShortcuts,
          };

      const action = actions[key];
      if (!action) return;
      event.preventDefault();
      action();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}
