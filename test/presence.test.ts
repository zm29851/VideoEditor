import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPresence } from "../src/mcp/presence.ts";

describe("agent presence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("has seen nobody at first", () => {
    expect(new AgentPresence().status).toEqual({ state: "offline" });
  });

  it("goes from working to connected to offline, and tells listeners each time", () => {
    const presence = new AgentPresence();
    const states: string[] = [];
    presence.subscribe((status) => states.push(status.state));

    presence.requestStarted("claude-code");
    expect(states).toEqual(["working"]);
    vi.advanceTimersByTime(60_000);
    expect(presence.status.state).toBe("working");

    presence.requestFinished();
    vi.advanceTimersByTime(14_000);
    expect(presence.status.state).toBe("working");
    vi.advanceTimersByTime(2_000);
    expect(states).toEqual(["working", "connected"]);

    vi.advanceTimersByTime(10 * 60_000);
    expect(states).toEqual(["working", "connected", "offline"]);
    expect(presence.status.clientName).toBe("claude-code");
    expect(presence.status.lastSeenAt).toBeDefined();
  });

  it("a new request brings it back, without repeating while it is working", () => {
    const presence = new AgentPresence();
    const states: string[] = [];
    presence.subscribe((status) => states.push(status.state));
    presence.requestStarted();
    presence.requestStarted();
    presence.requestFinished();
    presence.requestFinished();
    vi.advanceTimersByTime(20_000);
    presence.requestStarted();
    expect(states).toEqual(["working", "connected", "working"]);
  });
});
