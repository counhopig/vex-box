/**
 * Cron tool tests — createCronTools.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Tool, ToolResult } from "../src/tools/types.js";

describe("createCronTools", () => {
  let createCronTools: typeof import(
    "../src/tools/builtin/cron.js"
  ).createCronTools;
  let CronService: typeof import("../src/cron/service.js").CronService;
  let service: InstanceType<
    typeof import("../src/cron/service.js").CronService
  >;
  let storePath: string;
  let tmpDir: string;

  const OWNER_A = "user-a";
  const OWNER_B = "user-b";

  beforeAll(async () => {
    ({ createCronTools } = await import(
      "../src/tools/builtin/cron.js"
    ));
    ({ CronService } = await import("../src/cron/service.js"));
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "vex-cron-tool-"));
    storePath = join(tmpDir, "jobs.json");
    service = new CronService({
      storePath,
      enabled: false,
      nowMs: () => Date.now(),
      executeJob: async () => ({ status: "ok" as const }),
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeTools(owner: string): Tool[] {
    return createCronTools({ service, owner });
  }

  function getTool(tools: Tool[], name: string): Tool {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) {
      throw new Error(`Missing tool: ${name}`);
    }
    return tool;
  }

  async function run(
    tool: Tool,
    params: Record<string, unknown>,
  ): Promise<ToolResult> {
    return tool.execute(
      "call-1",
      params,
      undefined,
      undefined,
      {} as Parameters<typeof tool.execute>[4],
    );
  }

  function asDetails(result: ToolResult): Record<string, unknown> {
    if (typeof result.details !== "object" || result.details === null) {
      throw new Error("Tool returned non-object details");
    }
    return result.details as Record<string, unknown>;
  }

  function readString(details: Record<string, unknown>, key: string): string {
    const value = details[key];
    if (typeof value !== "string") {
      throw new Error(`Expected string detail: ${key}`);
    }
    return value;
  }

  async function addJob(tools: Tool[], name: string): Promise<string> {
    const result = await run(getTool(tools, "cron_add"), {
      name,
      scheduleType: "every",
      everyMs: 60_000,
      message: `message for ${name}`,
    });
    const details = asDetails(result);
    expect(details.status).toBe("success");
    return readString(details, "jobId");
  }

  function expectAccessDenied(result: ToolResult): void {
    const details = asDetails(result);
    expect(details.status).toBe("error");
    expect(details.error).toContain("Access denied");
  }

  it("returns 5 tools when called without service", () => {
    const tools = createCronTools();
    expect(tools).toHaveLength(5);
    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "cron_add",
      "cron_list",
      "cron_remove",
      "cron_run",
      "cron_update",
    ]);
  });

  it("each tool returns disabled status when service is undefined", async () => {
    const tools = createCronTools();
    for (const tool of tools) {
      const result = await run(tool, {});
      expect(result.details).toMatchObject({
        status: "disabled",
        message: expect.stringContaining("not enable"),
      });
    }
  });

  it("stamps jobs created by an owner with that ownerId", async () => {
    const jobId = await addJob(makeTools(OWNER_A), "owned-a");
    expect(service.get(jobId)?.ownerId).toBe(OWNER_A);
  });

  it("lists only jobs owned by the requesting owner", async () => {
    const ownerATools = makeTools(OWNER_A);
    const ownerBTools = makeTools(OWNER_B);
    const ownerAJobId = await addJob(ownerATools, "owned-a");
    const ownerBJobId = await addJob(ownerBTools, "owned-b");
    const result = await run(getTool(ownerATools, "cron_list"), {});
    const details = asDetails(result);

    expect(service.get(ownerBJobId)?.ownerId).toBe(OWNER_B);
    expect(details).toMatchObject({
      status: "success",
      count: 1,
      jobs: [{ id: ownerAJobId, name: "owned-a" }],
    });
  });

  it("denies remove, run, and update for another owner's jobs", async () => {
    const ownerATools = makeTools(OWNER_A);
    const ownerBTools = makeTools(OWNER_B);
    const removeJobId = await addJob(ownerBTools, "remove-target");
    const runJobId = await addJob(ownerBTools, "run-target");
    const updateJobId = await addJob(ownerBTools, "update-target");

    expectAccessDenied(
      await run(getTool(ownerATools, "cron_remove"), {
        jobId: removeJobId,
      }),
    );
    expect(service.get(removeJobId)?.name).toBe("remove-target");

    expectAccessDenied(
      await run(getTool(ownerATools, "cron_run"), { jobId: runJobId }),
    );
    expect(service.get(runJobId)?.state.lastRunAtMs).toBeUndefined();

    expectAccessDenied(
      await run(getTool(ownerATools, "cron_update"), {
        jobId: updateJobId,
        name: "tampered",
      }),
    );
    expect(service.get(updateJobId)?.name).toBe("update-target");
  });
});
