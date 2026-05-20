import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionTimers, type TimeoutReason } from "../../src/session/timers.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function collector() {
  const seen: TimeoutReason[] = [];
  return { seen, onTimeout: (r: TimeoutReason) => seen.push(r) };
}

describe("SessionTimers", () => {
  it("fires hard_cap at the hard deadline", () => {
    const c = collector();
    const t = new SessionTimers({ hardCapMs: 1_000, idleCapMs: 60_000, onTimeout: c.onTimeout });
    t.start();
    vi.advanceTimersByTime(999);
    expect(c.seen).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(c.seen).toEqual(["hard_cap"]);
  });

  it("fires idle at the idle deadline", () => {
    const c = collector();
    const t = new SessionTimers({ hardCapMs: 60_000, idleCapMs: 1_000, onTimeout: c.onTimeout });
    t.start();
    vi.advanceTimersByTime(1_000);
    expect(c.seen).toEqual(["idle"]);
  });

  it("onActivity resets the idle countdown", () => {
    const c = collector();
    const t = new SessionTimers({ hardCapMs: 60_000, idleCapMs: 1_000, onTimeout: c.onTimeout });
    t.start();
    vi.advanceTimersByTime(800);
    t.onActivity(); // reset idle
    vi.advanceTimersByTime(800); // 1600 wall, but only 800 since reset
    expect(c.seen).toEqual([]);
    vi.advanceTimersByTime(200); // 1000 since reset
    expect(c.seen).toEqual(["idle"]);
  });

  it("fires at most once even if both deadlines would pass", () => {
    const c = collector();
    const t = new SessionTimers({ hardCapMs: 1_000, idleCapMs: 1_000, onTimeout: c.onTimeout });
    t.start();
    vi.advanceTimersByTime(10_000);
    expect(c.seen).toEqual(["hard_cap"]);
  });

  it("stop() cancels both timers", () => {
    const c = collector();
    const t = new SessionTimers({ hardCapMs: 1_000, idleCapMs: 1_000, onTimeout: c.onTimeout });
    t.start();
    t.stop();
    vi.advanceTimersByTime(10_000);
    expect(c.seen).toEqual([]);
  });

  it("onActivity after stop is a no-op", () => {
    const c = collector();
    const t = new SessionTimers({ hardCapMs: 60_000, idleCapMs: 1_000, onTimeout: c.onTimeout });
    t.start();
    t.stop();
    t.onActivity();
    vi.advanceTimersByTime(10_000);
    expect(c.seen).toEqual([]);
  });
});
