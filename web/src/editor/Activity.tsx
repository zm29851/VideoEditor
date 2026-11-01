import { Bot, Undo2, User } from "lucide-react";
import type { ActivityEntry } from "../api.ts";
import { Button, EmptyState } from "../ui/ui.tsx";
import { describeChanges } from "./agentNotice.ts";
import { useEditor } from "./Editor.tsx";
import styles from "./Editor.module.css";

function timeOf(at: string): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString("vi-VN");
  return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString("vi-VN")} ${time}`;
}

function Row({ entry }: { entry: ActivityEntry }) {
  const { revertBatch } = useEditor();
  const byAgent = entry.actor === "agent";
  const changes = describeChanges(entry.changes);
  const status = entry.state === "undone" ? "Đã hoàn tác" : entry.state === "reverted" ? "Đã hoàn tác riêng lô này" : undefined;
  return (
    <li className={styles.activityItem}>
      <span className={styles.activityActor} data-actor={entry.actor}>
        {byAgent ? <Bot size={16} aria-hidden /> : <User size={16} aria-hidden />}
        {byAgent ? "Agent" : "Bạn"}
        <span className={styles.activityTime}>{timeOf(entry.at)}</span>
      </span>
      <span className={styles.activityLabel}>{entry.label}</span>
      {changes && <span className={styles.muted}>{changes}</span>}
      {status && <span className={styles.muted}>{status}</span>}
      {byAgent && entry.revertible && (
        <Button variant="ghost" className={styles.activityRevert} onClick={() => revertBatch(entry)}>
          <Undo2 size={16} aria-hidden />
          Hoàn tác lô này
        </Button>
      )}
    </li>
  );
}

export function Activity() {
  const { activity } = useEditor();
  if (activity.length === 0) {
    return (
      <EmptyState title="Chưa có thay đổi nào">
        <p>Mọi thay đổi của bạn và agent sẽ hiện ở đây.</p>
      </EmptyState>
    );
  }
  return (
    <ol className={styles.activity}>
      {activity.map((entry) => (
        <Row key={entry.revision} entry={entry} />
      ))}
    </ol>
  );
}
