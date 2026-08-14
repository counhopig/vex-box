/**
 * Browser tool tests — pure-logic and no-session-dispatch coverage only.
 *
 * Scope: browserLaunchArgs, assertNavigableUrl, resolveRefLocatorSpec,
 * parseAriaSnapshot, disposeBrowserOwner/disposeAllBrowsers, and
 * createBrowserTool's metadata + no-session dispatch behavior.
 *
 * Deliberately excluded: any real Chromium launch (start/navigate/click/
 * screenshot/snapshot against a live page) — CI has no browser binary
 * cached. See plans/015-browser-tool-tests.md.
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// browserLaunchArgs
// ---------------------------------------------------------------------------

describe("browserLaunchArgs", () => {
  let browserLaunchArgs: (noSandbox: boolean) => string[];

  beforeAll(async () => {
    ({ browserLaunchArgs } = await import("../src/tools/builtin/browser.js"));
  });

  it("returns [] when noSandbox is false", () => {
    expect(browserLaunchArgs(false)).toEqual([]);
  });

  it("returns the no-sandbox flags when noSandbox is true", () => {
    expect(browserLaunchArgs(true)).toEqual([
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ]);
  });
});

// ---------------------------------------------------------------------------
// assertNavigableUrl (delegates SSRF checks to the real assertWebFetchUrlAllowed)
// ---------------------------------------------------------------------------

describe("assertNavigableUrl", () => {
  let assertNavigableUrl: (rawUrl: string, allowPrivate: boolean) => URL;

  beforeAll(async () => {
    ({ assertNavigableUrl } = await import("../src/tools/builtin/browser.js"));
  });

  it("throws Invalid URL on unparseable input", () => {
    expect(() => assertNavigableUrl("not a url", false)).toThrow(/Invalid URL/);
  });

  it("blocks loopback address (127.0.0.1) via the real SSRF policy", () => {
    expect(() => assertNavigableUrl("http://127.0.0.1/", false)).toThrow();
  });

  it("blocks cloud metadata address (169.254.169.254)", () => {
    expect(() => assertNavigableUrl("http://169.254.169.254/", false)).toThrow();
  });

  it("returns a parsed URL for an allowed public URL", () => {
    const url = assertNavigableUrl("https://example.com/path", false);
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe("https://example.com/path");
  });

  it("does not throw for a private address when allowPrivate is true", () => {
    expect(() => assertNavigableUrl("http://127.0.0.1/", true)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// resolveRefLocatorSpec
// ---------------------------------------------------------------------------

describe("resolveRefLocatorSpec", () => {
  let resolveRefLocatorSpec: (
    ref: string,
    refs: Map<string, { role: string; name?: string; nth?: number }>,
  ) => { kind: "role"; role: string; name?: string; nth?: number } | { kind: "css"; selector: string };

  beforeAll(async () => {
    ({ resolveRefLocatorSpec } = await import("../src/tools/builtin/browser.js"));
  });

  const refs = new Map([["e1", { role: "button", name: "Submit" }]]);

  it("resolves a bare e<N> ref against the refs map", () => {
    expect(resolveRefLocatorSpec("e1", refs)).toEqual({
      kind: "role",
      role: "button",
      name: "Submit",
      nth: undefined,
    });
  });

  it("strips a leading @ prefix before resolving", () => {
    expect(resolveRefLocatorSpec("@e1", refs)).toEqual({
      kind: "role",
      role: "button",
      name: "Submit",
      nth: undefined,
    });
  });

  it("strips a leading ref= prefix before resolving", () => {
    expect(resolveRefLocatorSpec("ref=e1", refs)).toEqual({
      kind: "role",
      role: "button",
      name: "Submit",
      nth: undefined,
    });
  });

  it("resolves case-insensitively (uppercase E1)", () => {
    expect(resolveRefLocatorSpec("E1", refs)).toEqual({
      kind: "role",
      role: "button",
      name: "Submit",
      nth: undefined,
    });
  });

  it("throws Unknown ref for an e<N>-shaped ref missing from the map", () => {
    expect(() => resolveRefLocatorSpec("e99", refs)).toThrow(/Unknown ref "e99"/);
  });

  it("falls back to a CSS selector spec using the original ref string", () => {
    // Live code (browser.ts:134) returns `{ kind: "css", selector: ref }` — the
    // raw, un-stripped input — not the `normalized` value computed above it.
    expect(resolveRefLocatorSpec("#submit-button", refs)).toEqual({
      kind: "css",
      selector: "#submit-button",
    });
  });

  it("CSS fallback keeps the @ prefix (uses raw ref, not the @-stripped normalized value)", () => {
    // Distinguishes "returns ref" from "returns normalized": with a plain
    // selector like "#submit-button" (no @/ref= prefix) the two are
    // identical, so this case uses an @-prefixed, non-e\d+-shaped ref where
    // they diverge. Confirmed against browser.ts:119-134 by direct read: the
    // `normalized` value (stripped of "@") is only used for the e\d+ test;
    // the css-fallback return statement uses the original `ref` parameter.
    expect(resolveRefLocatorSpec("@.foo-selector", refs)).toEqual({
      kind: "css",
      selector: "@.foo-selector",
    });
  });
});

// ---------------------------------------------------------------------------
// parseAriaSnapshot
// ---------------------------------------------------------------------------

describe("parseAriaSnapshot", () => {
  let parseAriaSnapshot: (
    snapshot: string,
  ) => Map<string, { role: string; name?: string; nth?: number }>;

  beforeAll(async () => {
    ({ parseAriaSnapshot } = await import("../src/tools/builtin/browser.js"));
  });

  const snapshot = [
    '- button "Submit"',
    '- link "Home"',
    '- button "Submit"',
    '- generic "not interactive"',
  ].join("\n");

  it("produces exactly 3 refs, skipping the non-interactive generic role", () => {
    const refs = parseAriaSnapshot(snapshot);
    expect(refs.size).toBe(3);
  });

  it("e1 is the first Submit button with nth undefined", () => {
    const refs = parseAriaSnapshot(snapshot);
    expect(refs.get("e1")).toEqual({ role: "button", name: "Submit", nth: undefined });
  });

  it("e2 is the Home link with nth undefined", () => {
    const refs = parseAriaSnapshot(snapshot);
    expect(refs.get("e2")).toEqual({ role: "link", name: "Home", nth: undefined });
  });

  it("e3 is the second Submit button with nth: 1", () => {
    const refs = parseAriaSnapshot(snapshot);
    expect(refs.get("e3")).toEqual({ role: "button", name: "Submit", nth: 1 });
  });

  it("returns an empty Map for an empty-string snapshot", () => {
    const refs = parseAriaSnapshot("");
    expect(refs.size).toBe(0);
  });

  it("produces a ref with name undefined when the line has no quoted name", () => {
    const refs = parseAriaSnapshot("- button");
    expect(refs.get("e1")).toEqual({ role: "button", name: undefined, nth: undefined });
  });
});

// ---------------------------------------------------------------------------
// disposeBrowserOwner / disposeAllBrowsers (no-session idempotency)
// ---------------------------------------------------------------------------

describe("disposeBrowserOwner / disposeAllBrowsers", () => {
  let disposeBrowserOwner: (ownerKey: string) => Promise<void>;
  let disposeAllBrowsers: () => Promise<void>;

  beforeAll(async () => {
    ({ disposeBrowserOwner, disposeAllBrowsers } = await import(
      "../src/tools/builtin/browser.js"
    ));
  });

  it("resolves without throwing for an owner with no session", async () => {
    await expect(disposeBrowserOwner("no-such-owner")).resolves.toBeUndefined();
  });

  it("resolves without throwing when there are no sessions at all", async () => {
    await expect(disposeAllBrowsers()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// createBrowserTool — metadata + no-session dispatch
// ---------------------------------------------------------------------------

describe("createBrowserTool", () => {
  let createBrowserTool: (ownerKey?: string) => any;

  beforeAll(async () => {
    ({ createBrowserTool } = await import("../src/tools/builtin/browser.js"));
  });

  it("has correct metadata", () => {
    const tool = createBrowserTool("test-owner-metadata");
    expect(tool.name).toBe("browser");
    expect(tool.label).toBe("Browser Control");
  });

  it("stop with no session returns not_running (not an error)", async () => {
    const tool = createBrowserTool("test-owner-stop");
    const result = await tool.execute("call-1", { action: "stop" });
    expect(result.isError).toBeFalsy();
    expect(result.details.status).toBe("not_running");
  });

  it("navigate with no session returns the 'Browser not started' error", async () => {
    const tool = createBrowserTool("test-owner-navigate");
    const result = await tool.execute("call-1", {
      action: "navigate",
      url: "https://example.com",
    });
    expect(result.isError).toBe(true);
    expect(result.details.error).toBe(
      "Browser not started. Use 'start' action first.",
    );
  });

  it("an unknown action with no session also surfaces 'Browser not started', not 'Unknown action'", async () => {
    // getBrowserSession() throws before the switch statement is ever reached
    // for any action other than start/stop, so the "Unknown action: ..."
    // branch (browser.ts:340) is unreachable without an active session.
    const tool = createBrowserTool("test-owner-bogus");
    const result = await tool.execute("call-1", { action: "bogus-action" });
    expect(result.isError).toBe(true);
    expect(result.details.error).toBe(
      "Browser not started. Use 'start' action first.",
    );
  });
});
