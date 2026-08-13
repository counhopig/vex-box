/**
 * Bash tool tests — env allowlist filtering, cwd sandbox, execution,
 * background process spawning, timeout escalation, and per-owner stamping.
 *
 * Real child processes (`echo`, `sleep`) and real temp dirs under
 * `os.tmpdir()` — no mocking of `child_process`. `disposeOwnerSessions` is
 * called in `afterEach` so background processes do not leak across tests.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildChildEnv,
  createBashTool,
} from "../src/tools/builtin/bash.js";
import {
  listRunningSessions,
  disposeOwnerSessions,
} from "../src/tools/builtin/process-registry.js";

// Synthetic key unlikely to collide with real env vars. We control its
// presence in `process.env` for the duration of each test.
const SECRET_KEY = "VEX_BASH_TEST_SECRET_KEY";

describe("buildChildEnv — env allowlist", () => {
  // Save and restore any pre-existing value for SECRET_KEY around each test.
  const originalSecret = process.env[SECRET_KEY];

  afterEach(() => {
    if (originalSecret === undefined) {
      delete process.env[SECRET_KEY];
    } else {
      process.env[SECRET_KEY] = originalSecret;
    }
  });

  it("does NOT leak a non-allowlisted secret from process.env", () => {
    process.env[SECRET_KEY] = "sk-supersecret-98765";
    const result = buildChildEnv([]);
    expect(result[SECRET_KEY]).toBeUndefined();
  });

  it("includes PATH, HOME, and LC_*-prefixed variables from process.env", () => {
    process.env.HOME = "/tmp/vex-bash-test-home";
    process.env.PATH = "/usr/bin:/bin";
    process.env.LC_ALL = "C";
    const result = buildChildEnv([]);
    expect(result.PATH).toBe("/usr/bin:/bin");
    expect(result.HOME).toBe("/tmp/vex-bash-test-home");
    expect(result.LC_ALL).toBe("C");
  });

  it("includes a var in the passthrough list that would otherwise be filtered", () => {
    process.env[SECRET_KEY] = "sk-supersecret-98765";
    const result = buildChildEnv([SECRET_KEY]);
    expect(result[SECRET_KEY]).toBe("sk-supersecret-98765");
  });
});

describe("createBashTool — cwd sandbox + execution", () => {
  let sandbox: string;
  const OWNER = "test:bash-tool";

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "vex-bash-test-"));
  });

  afterEach(() => {
    disposeOwnerSessions(OWNER);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("rejects a cwd outside allowedPaths with Access denied", async () => {
    const tool = createBashTool({
      allowedPaths: [sandbox],
      owner: OWNER,
      defaultTimeout: 2000,
    });
    const result = await tool.execute(
      "call-1",
      { command: "echo should-not-run", cwd: "/etc" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as Parameters<typeof tool.execute>[4],
    );
    const details = result.details as { status: string; error: string };
    expect(details.status).toBe("error");
    expect(details.error).toMatch(/Access denied/);
    // Nothing should have been spawned — registry stays empty for this owner.
    expect(listRunningSessions(OWNER)).toHaveLength(0);
  });

  it("executes a simple echo and returns its stdout in the sandbox", async () => {
    const tool = createBashTool({
      allowedPaths: [sandbox],
      owner: OWNER,
      defaultTimeout: 2000,
    });
    const result = await tool.execute(
      "call-2",
      { command: "echo hello-bash" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as Parameters<typeof tool.execute>[4],
    );
    const text = result.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("\n");
    expect(text).toContain("hello-bash");
  });
});

describe("createBashTool — background, timeout, owner stamping", () => {
  let sandbox: string;
  const OWNER = "test:bash-tool";

  beforeEach(() => {
    sandbox = mkdtempSync(join(tmpdir(), "vex-bash-test-"));
  });

  afterEach(() => {
    disposeOwnerSessions(OWNER);
    rmSync(sandbox, { recursive: true, force: true });
  });

  it("returns a backgrounded session_id and disposeOwnerSessions clears it", async () => {
    const tool = createBashTool({
      allowedPaths: [sandbox],
      owner: OWNER,
      defaultTimeout: 2000,
    });
    const result = await tool.execute(
      "call-bg",
      { command: "sleep 30", run_in_background: true },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as Parameters<typeof tool.execute>[4],
    );
    const details = result.details as {
      status: string;
      session_id: string;
      pid?: number;
    };
    expect(details.status).toBe("backgrounded");
    expect(details.session_id).toMatch(/^[a-z0-9]{8}$/);
    expect(typeof details.pid).toBe("number");

    // Visible in the registry for this owner before disposal.
    const running = listRunningSessions(OWNER);
    expect(running.find((s) => s.id === details.session_id)).toBeDefined();

    disposeOwnerSessions(OWNER);
    expect(listRunningSessions(OWNER)).toHaveLength(0);
  });

  it("kills a long-running command on timeout with reason 'timeout'", async () => {
    const tool = createBashTool({
      allowedPaths: [sandbox],
      owner: OWNER,
      defaultTimeout: 200,
    });
    const start = Date.now();
    const result = await tool.execute(
      "call-timeout",
      { command: "sleep 30" },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as Parameters<typeof tool.execute>[4],
    );
    const details = result.details as {
      status: string;
      reason?: string;
      session_id?: string;
    };
    expect(details.status).toBe("killed");
    expect(details.reason).toBe("timeout");
    // Should resolve well before the 30s sleep would have completed
    // (SIGTERM escalation ~200ms, not the 5s SIGKILL fallback).
    expect(Date.now() - start).toBeLessThan(3000);
  });

  it("stamps ownerKey on every backgrounded session", async () => {
    const tool = createBashTool({
      allowedPaths: [sandbox],
      owner: OWNER,
      defaultTimeout: 2000,
    });
    const result = await tool.execute(
      "call-owner",
      { command: "sleep 30", run_in_background: true },
      undefined,
      undefined,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as Parameters<typeof tool.execute>[4],
    );
    const details = result.details as { session_id: string };
    const session = listRunningSessions(OWNER).find(
      (s) => s.id === details.session_id,
    );
    expect(session).toBeDefined();
    expect(session?.ownerKey).toBe(OWNER);
  });
});