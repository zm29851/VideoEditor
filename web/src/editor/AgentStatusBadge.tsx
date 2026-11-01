import { Bot, WifiOff } from "lucide-react";
import type { AgentStatus } from "../api.ts";
import styles from "./Editor.module.css";

function words(agent: AgentStatus): string {
  switch (agent.state) {
    case "working":
      return "Agent đang làm việc";
    case "connected":
      return "Agent đã kết nối";
    case "offline":
      return agent.lastSeenAt ? "Agent không hoạt động" : "Chưa có agent";
  }
}

function details(agent: AgentStatus): string | undefined {
  if (!agent.lastSeenAt) return undefined;
  const seen = `Yêu cầu gần nhất lúc ${new Date(agent.lastSeenAt).toLocaleTimeString("vi-VN")}`;
  return agent.clientName ? `${agent.clientName}. ${seen}` : seen;
}

export function AgentStatusBadge({ agent, connected }: { agent: AgentStatus; connected: boolean }) {
  if (!connected) {
    return (
      <span className={styles.agentStatus} data-state="disconnected" role="status">
        <WifiOff size={16} aria-hidden />
        Mất kết nối tới server, đang thử lại
      </span>
    );
  }
  return (
    <span className={styles.agentStatus} data-state={agent.state} role="status" title={details(agent)}>
      <Bot size={16} aria-hidden />
      {words(agent)}
    </span>
  );
}
