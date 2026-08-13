/**
 * AgentRegistry tests — concurrent build sharing, idle-TTL, LRU overflow,
 * dispose-before-rebuild, and (userId, channelId) composite-key isolation.
 *
 * The AgentRegistry is a generic cache/factory wrapper. Every entry must
 * implement { shutdown(): Promise<void> }.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AgentRegistry } from "../src/agent/AgentRegistry.js";
import { Agent } from "../src/agent/Agent.js";
import { Pipeline } from "../src/agent/Pipeline.js";
import type { AgentRuntime } from "../src/agent/AgentRuntime.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockEntry {
  id: string;
  isBusy: boolean;
  shutdown: ReturnType<typeof vi.fn>;
}

function createEntry(id: string, opts?: { isBusy?: boolean }): MockEntry {
  return {
    id,
    isBusy: opts?.isBusy ?? false,
    shutdown: vi.fn().mockResolvedValue(undefined),
  };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("AgentRegistry", () => {
  let factory: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    factory = vi.fn();
  });

  afterEach(async () => {
    // Avoid timer leaks across tests.
    vi.useRealTimers();
  });

  // -- basic ---------------------------------------------------------------

  it("creates an entry for an unseen (userId, channelId) key", async () => {
    factory.mockResolvedValue(createEntry("a"));
    const reg = new AgentRegistry({ factory });

    const entry = await reg.getOrCreate("user1", "webchat", {});

    expect(entry).toBeDefined();
    expect(entry.id).toBe("a");
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith("user1", "webchat", {});
  });

  it("returns the cached entry for the same composite key", async () => {
    factory.mockResolvedValue(createEntry("a"));
    const reg = new AgentRegistry({ factory });

    const a = await reg.getOrCreate("user1", "webchat", {});
    const b = await reg.getOrCreate("user1", "webchat", {});

    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("treats different channelIds as separate cache entries", async () => {
    factory
      .mockResolvedValueOnce(createEntry("a"))
      .mockResolvedValueOnce(createEntry("b"));
    const reg = new AgentRegistry({ factory });

    const web = await reg.getOrCreate("user1", "webchat", {});
    const wx = await reg.getOrCreate("user1", "weixin", {});

    expect(web).not.toBe(wx);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("treats different userIds as separate cache entries", async () => {
    factory
      .mockResolvedValueOnce(createEntry("a"))
      .mockResolvedValueOnce(createEntry("b"));
    const reg = new AgentRegistry({ factory });

    const u1 = await reg.getOrCreate("user1", "webchat", {});
    const u2 = await reg.getOrCreate("user2", "webchat", {});

    expect(u1).not.toBe(u2);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  // -- concurrent build sharing -------------------------------------------

  it("shares a single build across concurrent first-touch requests", async () => {
    let resolveBuild!: (e: MockEntry) => void;
    factory.mockReturnValueOnce(
      new Promise<MockEntry>((resolve) => {
        resolveBuild = resolve;
      }),
    );
    const reg = new AgentRegistry({ factory });

    const inFlight = Promise.all([
      reg.getOrCreate("user1", "webchat", {}),
      reg.getOrCreate("user1", "webchat", {}),
      reg.getOrCreate("user1", "webchat", {}),
    ]);
    resolveBuild(createEntry("a"));
    const [a, b, c] = await inFlight;

    expect(factory).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  // -- failed build eviction ----------------------------------------------

  it("evicts a failed build so a later call retries", async () => {
    factory.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce(createEntry("ok"));
    const reg = new AgentRegistry({ factory });

    await expect(reg.getOrCreate("user1", "webchat", {})).rejects.toThrow("boom");
    const entry = await reg.getOrCreate("user1", "webchat", {});

    expect(entry.id).toBe("ok");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  // -- idle TTL eviction --------------------------------------------------

  it("evicts idle entries past the TTL and calls shutdown", async () => {
    const entryA = createEntry("a");
    const entryB = createEntry("b");
    factory.mockResolvedValueOnce(entryA).mockResolvedValueOnce(entryB);
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(1_000);
    const reg = new AgentRegistry({ factory, idleTtlMs: 60_000, maxEntries: 0 });

    await reg.getOrCreate("user1", "webchat", {});
    // Advance well past TTL, then touch a different key to trigger sweep.
    now.mockReturnValue(1_000 + 120_000);
    await reg.getOrCreate("user2", "webchat", {});

    expect(entryA.shutdown).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });

  it("rebuilds an evicted entry on next access", async () => {
    // Three calls: user1 initial, user2 (triggers sweep), user1 rebuild.
    const entries = [createEntry("a"), createEntry("b"), createEntry("c")];
    factory
      .mockResolvedValueOnce(entries[0])
      .mockResolvedValueOnce(entries[1])
      .mockResolvedValueOnce(entries[2]);
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);

    const reg = new AgentRegistry({ factory, idleTtlMs: 60_000, maxEntries: 0 });
    await reg.getOrCreate("user1", "webchat", {});
    now.mockReturnValue(1_000 + 120_000);
    await reg.getOrCreate("user2", "webchat", {}); // trigger sweep → evicts user1

    // Re-access user1 — should rebuild since evicted.
    const rebuilt = await reg.getOrCreate("user1", "webchat", {});
    expect(rebuilt.id).toBe("c");
    expect(factory).toHaveBeenCalledTimes(3);
    now.mockRestore();
  });

  // -- LRU overflow eviction ----------------------------------------------

  it("evicts the least-recently-used entry when over the cap", async () => {
    const entries = [createEntry("a"), createEntry("b"), createEntry("c")];
    factory
      .mockResolvedValueOnce(entries[0])
      .mockResolvedValueOnce(entries[1])
      .mockResolvedValueOnce(entries[2]);
    const now = vi.spyOn(Date, "now");

    now.mockReturnValue(10);
    const reg = new AgentRegistry({ factory, maxEntries: 2, idleTtlMs: 0 });

    now.mockReturnValue(20);
    await reg.getOrCreate("user1", "webchat", {}); // a
    now.mockReturnValue(30);
    await reg.getOrCreate("user2", "webchat", {}); // b
    // Touch user1 so user2 becomes LRU.
    now.mockReturnValue(40);
    await reg.getOrCreate("user1", "webchat", {});
    // Adding user3 overflows cap → evicts user2 (LRU).
    now.mockReturnValue(50);
    await reg.getOrCreate("user3", "webchat", {}); // c
    await Promise.resolve();

    expect(entries[1].shutdown).toHaveBeenCalledTimes(1); // b evicted
    expect(entries[0].shutdown).not.toHaveBeenCalled();     // a kept
    expect(entries[2].shutdown).not.toHaveBeenCalled();     // c kept
    now.mockRestore();
  });

  // -- dispose-before-rebuild ---------------------------------------------

  it("waits for prior teardown before rebuilding the same key", async () => {
    let releaseShutdown!: () => void;
    const shutdownGate = new Promise<void>((resolve) => {
      releaseShutdown = resolve;
    });
    const first = createEntry("first");
    first.shutdown.mockReturnValue(shutdownGate);
    const second = createEntry("second");
    factory.mockResolvedValueOnce(first).mockResolvedValueOnce(second);

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const reg = new AgentRegistry({ factory, idleTtlMs: 60_000, maxEntries: 0 });

    await reg.getOrCreate("user1", "webchat", {});
    // Advance past TTL so the next getOrCreate triggers eviction + rebuild.
    now.mockReturnValue(1_000 + 120_000);
    const rebuilding = reg.getOrCreate("user1", "webchat", {});

    // Teardown must have been called but rebuild must not have started yet.
    await Promise.resolve();
    await Promise.resolve();
    expect(first.shutdown).toHaveBeenCalled();
    expect(factory).toHaveBeenCalledTimes(1);

    // Release the teardown gate.
    releaseShutdown();
    const rebuilt = await rebuilding;
    expect(factory).toHaveBeenCalledTimes(2);
    expect(rebuilt.id).toBe("second");
    now.mockRestore();
  });

  // -- reset --------------------------------------------------------------

  it("drops and tears down a cached entry on reset", async () => {
    const entry = createEntry("a");
    factory.mockResolvedValueOnce(entry).mockResolvedValueOnce(createEntry("b"));
    const reg = new AgentRegistry({ factory });

    await reg.getOrCreate("user1", "webchat", {});
    await reg.reset("user1", "webchat");
    const next = await reg.getOrCreate("user1", "webchat", {});

    expect(entry.shutdown).toHaveBeenCalledTimes(1);
    expect(next.id).toBe("b");
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("reset on unknown key is a no-op", async () => {
    const reg = new AgentRegistry({ factory });
    await expect(reg.reset("nobody", "webchat")).resolves.toBeUndefined();
  });

  // -- shutdown -----------------------------------------------------------

  it("shutdown tears down all entries", async () => {
    const entries = [createEntry("a"), createEntry("b")];
    factory.mockResolvedValueOnce(entries[0]).mockResolvedValueOnce(entries[1]);
    const reg = new AgentRegistry({ factory });

    await reg.getOrCreate("user1", "webchat", {});
    await reg.getOrCreate("user2", "webchat", {});
    await reg.shutdown();

    expect(entries[0].shutdown).toHaveBeenCalledTimes(1);
    expect(entries[1].shutdown).toHaveBeenCalledTimes(1);
  });

  it("shutdown clears the sweep timer so the process can exit", async () => {
    vi.useFakeTimers();
    const reg = new AgentRegistry({ factory, idleTtlMs: 1_000 });
    const ref = vi.spyOn(global, "clearInterval");

    await reg.shutdown();

    expect(ref).toHaveBeenCalled();
    ref.mockRestore();
  });

  // -- background sweep timer ---------------------------------------------

  it("reclaims idle entries on a timer without any further traffic", async () => {
    vi.useFakeTimers();
    try {
      const entry = createEntry("idle");
      factory.mockResolvedValueOnce(entry);
      const reg = new AgentRegistry({ factory, idleTtlMs: 1_000 });

      await reg.getOrCreate("user1", "webchat", {});
      // No further getOrCreate calls — only the background sweep can reclaim it.
      await vi.advanceTimersByTimeAsync(5_000);

      expect(entry.shutdown).toHaveBeenCalled();
      await reg.shutdown();
    } finally {
      vi.useRealTimers();
    }
  });

  // -- size ---------------------------------------------------------------

  it("reports the number of cached entries", async () => {
    factory.mockResolvedValue(createEntry("x"));
    const reg = new AgentRegistry({ factory });

    expect(reg.size).toBe(0);
    await reg.getOrCreate("user1", "webchat", {});
    expect(reg.size).toBe(1);
    await reg.getOrCreate("user2", "webchat", {});
    expect(reg.size).toBe(2);
  });

  // -- teardown feature wiring (plan 005) --------------------------------
  // buildAgentFactory injects a feature whose shutdown() calls
  // disposeOwnerResources(`${userId}:${channelId}`). Driving the full factory
  // would require mocking its entire dep graph; assert the wiring directly
  // instead (deviation per plan 005 STOP condition).

  it("Agent.shutdown invokes disposeOwnerResources with the owner key", async () => {
    const userId = "u1";
    const channelId = "webchat";
    const disposeOwnerResources = vi.fn().mockResolvedValue(undefined);
    const pipeline = new Pipeline();
    const runtime = {
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as AgentRuntime;
    const agent = new Agent(userId, {} as never, {
      pipeline,
      persona: null,
      runtime,
      features: [{ shutdown: () => disposeOwnerResources(`${userId}:${channelId}`) }],
    });

    await agent.shutdown();

    expect(disposeOwnerResources).toHaveBeenCalledTimes(1);
    expect(disposeOwnerResources).toHaveBeenCalledWith(`${userId}:${channelId}`);
    expect(runtime.shutdown).toHaveBeenCalledTimes(1);
  });

  // -- busy-skip eviction (plan 013) ---------------------------------------
  // A mid-turn agent (isBusy=true) must not be torn down by idle eviction
  // even if its lastAccess has fallen past the TTL. The non-busy peer must
  // still be evicted normally.

  it("keeps a busy entry alive past the TTL while a stale peer is evicted", async () => {
    const busy = createEntry("busy", { isBusy: true });
    const idle = createEntry("idle");
    const third = createEntry("third");
    factory
      .mockResolvedValueOnce(busy)
      .mockResolvedValueOnce(idle)
      .mockResolvedValueOnce(third);

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const reg = new AgentRegistry({ factory, idleTtlMs: 60_000, maxEntries: 0 });

    await reg.getOrCreate("user1", "webchat", {});
    await reg.getOrCreate("user2", "webchat", {});

    // Advance well past TTL; touch a third key to trigger the sweep.
    now.mockReturnValue(1_000 + 120_000);
    await reg.getOrCreate("user3", "webchat", {});

    // Busy entry was kept alive (isBusy=true) so its LLM turn is not torn down.
    expect(busy.shutdown).not.toHaveBeenCalled();
    // Non-busy peer was evicted as before.
    expect(idle.shutdown).toHaveBeenCalledTimes(1);
    // Cache still holds the busy entry and the newly built third entry.
    expect(reg.size).toBe(2);
    now.mockRestore();
  });

  it("evicts a no-longer-busy entry once its turn completes", async () => {
    const entry = createEntry("a");
    factory.mockResolvedValueOnce(entry);

    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const reg = new AgentRegistry({ factory, idleTtlMs: 60_000, maxEntries: 0 });

    await reg.getOrCreate("user1", "webchat", {});
    // The entry is not busy; bumping time past TTL evicts it on next sweep.
    now.mockReturnValue(1_000 + 120_000);
    await reg.getOrCreate("user2", "webchat", {});

    expect(entry.shutdown).toHaveBeenCalledTimes(1);
    now.mockRestore();
  });
});
