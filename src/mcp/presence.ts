export interface AgentStatus {
  /** working: a request is running or has just ended. connected: seen recently. offline: neither. */
  state: "working" | "connected" | "offline";
  clientName?: string;
  lastSeenAt?: string;
}

export type AgentListener = (status: AgentStatus) => void;

const WORKING_MS = 15_000;
const CONNECTED_MS = 10 * 60_000;

/**
 * MCP here is stateless HTTP, so no connection exists to watch. An agent counts as connected
 * for a while after its last request, and the status says when that was.
 */
export class AgentPresence {
  #running = 0;
  #clientName: string | undefined;
  #lastSeen: number | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #listeners = new Set<AgentListener>();

  get status(): AgentStatus {
    const idle = this.#lastSeen === undefined ? Infinity : Date.now() - this.#lastSeen;
    return {
      state: this.#running > 0 || idle < WORKING_MS ? "working" : idle < CONNECTED_MS ? "connected" : "offline",
      ...(this.#clientName === undefined ? {} : { clientName: this.#clientName }),
      ...(this.#lastSeen === undefined ? {} : { lastSeenAt: new Date(this.#lastSeen).toISOString() }),
    };
  }

  subscribe(listener: AgentListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  requestStarted(clientName?: string): void {
    const before = this.status.state;
    this.#running++;
    this.#lastSeen = Date.now();
    this.#clientName = clientName ?? this.#clientName;
    clearTimeout(this.#timer);
    if (before !== "working") this.#notify();
  }

  requestFinished(): void {
    this.#running = Math.max(0, this.#running - 1);
    this.#lastSeen = Date.now();
    if (this.#running === 0) this.#schedule();
  }

  #schedule(): void {
    clearTimeout(this.#timer);
    const idle = Date.now() - this.#lastSeen!;
    const next = idle < WORKING_MS ? WORKING_MS : CONNECTED_MS;
    if (idle >= CONNECTED_MS) return;
    this.#timer = setTimeout(() => {
      this.#notify();
      this.#schedule();
    }, next - idle);
    this.#timer.unref();
  }

  #notify(): void {
    for (const listener of this.#listeners) listener(this.status);
  }
}
