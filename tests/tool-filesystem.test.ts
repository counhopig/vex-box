/**
 * Filesystem tool tests — path traversal protection.
 */

import { describe, it, expect, vi } from "vitest";
import { resolve } from "path";
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, rmdirSync, symlinkSync } from "fs";
import { tmpdir } from "os";

describe("resolveUserPath", () => {
  let resolveUserPath: (allowed: string[], p: string) => string;

  beforeAll(async () => {
    ({ resolveUserPath } = await import("../src/tools/builtin/filesystem.js"));
  });

  it("resolves relative paths against first allowed path", () => {
    expect(resolveUserPath(["/sandbox"], "file.txt")).toBe("/sandbox/file.txt");
  });

  it("leaves absolute paths intact", () => {
    expect(resolveUserPath(["/sandbox"], "/etc/passwd")).toBe("/etc/passwd");
  });
});

describe("isRealPathAllowed", () => {
  let isRealPathAllowed: (p: string, allowed: string[]) => Promise<boolean>;

  beforeAll(async () => {
    ({ isRealPathAllowed } = await import("../src/tools/builtin/filesystem.js"));
  });

  it("allows path inside allowed directory", async () => {
    const dir = mkdtempSync(`${tmpdir()}/vex-fs-test-`);
    try {
      const f = resolve(dir, "test.txt");
      writeFileSync(f, "hello");
      expect(await isRealPathAllowed(f, [dir])).toBe(true);
    } finally {
      rmdirSync(dir, { recursive: true });
    }
  });

  it("rejects path outside allowed directory", async () => {
    const dir = mkdtempSync(`${tmpdir()}/vex-fs-test-`);
    try {
      const outside = resolve(dir, "../../etc/passwd");
      expect(await isRealPathAllowed(outside, [dir])).toBe(false);
    } finally {
      rmdirSync(dir, { recursive: true });
    }
  });
});

describe("filesystem tools metadata", () => {
  it("creates read_file tool", async () => {
    const { createReadFileTool } = await import(
      "../src/tools/builtin/filesystem.js"
    );
    const t = createReadFileTool();
    expect(t.name).toBe("read_file");
  });

  it("creates write_file tool", async () => {
    const { createWriteFileTool } = await import(
      "../src/tools/builtin/filesystem.js"
    );
    const t = createWriteFileTool();
    expect(t.name).toBe("write_file");
  });

  it("creates edit_file tool", async () => {
    const { createEditFileTool } = await import(
      "../src/tools/builtin/filesystem.js"
    );
    const t = createEditFileTool();
    expect(t.name).toBe("edit_file");
  });

  it("createFilesystemTools returns 6 tools", async () => {
    const { createFilesystemTools } = await import(
      "../src/tools/builtin/filesystem.js"
    );
    const tools = createFilesystemTools();
    expect(tools).toHaveLength(6);
    const names = tools.map((t: any) => t.name);
    expect(names).toContain("read_file");
    expect(names).toContain("write_file");
    expect(names).toContain("edit_file");
    expect(names).toContain("list_directory");
    expect(names).toContain("glob");
    expect(names).toContain("grep");
  });
});

describe("glob/grep pattern traversal protection", () => {
  let createGlobTool: typeof import("../src/tools/builtin/filesystem.js").createGlobTool;
  let createGrepTool: typeof import("../src/tools/builtin/filesystem.js").createGrepTool;

  beforeAll(async () => {
    const mod = await import("../src/tools/builtin/filesystem.js");
    createGlobTool = mod.createGlobTool;
    createGrepTool = mod.createGrepTool;
  });

  it("glob rejects parent-traversal pattern with Unsafe glob pattern error", async () => {
    const sandbox = mkdtempSync(`${tmpdir()}/vex-glob-traversal-`);
    try {
      const tool = createGlobTool({ allowedPaths: [sandbox] });
      const result = await tool.execute(
        "test",
        { pattern: "../*", path: sandbox },
        undefined,
        undefined,
        {} as Parameters<ReturnType<typeof createGlobTool>["execute"]>[4],
      );
      const details = result.details as { status: string; error: string };
      expect(details.status).toBe("error");
      expect(details.error).toContain("Unsafe glob pattern");
      expect(details.error).toContain("../*");
    } finally {
      rmdirSync(sandbox, { recursive: true });
    }
  });

  it("glob rejects absolute pattern with Unsafe glob pattern error", async () => {
    const sandbox = mkdtempSync(`${tmpdir()}/vex-glob-abs-`);
    try {
      const tool = createGlobTool({ allowedPaths: [sandbox] });
      const result = await tool.execute(
        "test",
        { pattern: "/etc/*", path: sandbox },
        undefined,
        undefined,
        {} as Parameters<ReturnType<typeof createGlobTool>["execute"]>[4],
      );
      const details = result.details as { status: string; error: string };
      expect(details.status).toBe("error");
      expect(details.error).toContain("Unsafe glob pattern");
      expect(details.error).toContain("/etc/*");
    } finally {
      rmdirSync(sandbox, { recursive: true });
    }
  });

  it("grep rejects parent-traversal glob_pattern with Unsafe glob pattern error", async () => {
    const sandbox = mkdtempSync(`${tmpdir()}/vex-grep-traversal-`);
    try {
      const tool = createGrepTool({ allowedPaths: [sandbox] });
      const result = await tool.execute(
        "test",
        { pattern: "anything", glob_pattern: "../*", path: sandbox },
        undefined,
        undefined,
        {} as Parameters<ReturnType<typeof createGrepTool>["execute"]>[4],
      );
      const details = result.details as { status: string; error: string };
      expect(details.status).toBe("error");
      expect(details.error).toContain("Unsafe glob pattern");
      expect(details.error).toContain("../*");
    } finally {
      rmdirSync(sandbox, { recursive: true });
    }
  });

  it("grep drops symlink targets that resolve outside the sandbox", async () => {
    const sandbox = mkdtempSync(`${tmpdir()}/vex-grep-symlink-sandbox-`);
    const outside = mkdtempSync(`${tmpdir()}/vex-grep-symlink-outside-`);
    try {
      writeFileSync(resolve(outside, "secret.txt"), "SECRET-MARKER-XYZ");
      symlinkSync(resolve(outside, "secret.txt"), resolve(sandbox, "link.txt"));
      writeFileSync(resolve(sandbox, "innocent.txt"), "nothing here");

      const tool = createGrepTool({ allowedPaths: [sandbox] });
      const result = await tool.execute(
        "test",
        {
          pattern: "SECRET-MARKER-XYZ",
          glob_pattern: "**/*",
          path: sandbox,
        },
        undefined,
        undefined,
        {} as Parameters<ReturnType<typeof createGrepTool>["execute"]>[4],
      );
      // Post-validation drops the symlink target — content stays hidden.
      const details = result.details as {
        pattern: string;
        totalMatches: number;
      };
      expect(details.totalMatches).toBe(0);
      const text = result.content
        .map((c) => (c.type === "text" ? c.text : ""))
        .join("\n");
      expect(text).not.toContain("SECRET-MARKER-XYZ");
      expect(text).not.toContain("secret.txt");
    } finally {
      rmdirSync(sandbox, { recursive: true });
      rmdirSync(outside, { recursive: true });
    }
  });
});
