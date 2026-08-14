/**
 * fetch-compat tests — the ByteString-header workaround.
 *
 * src/providers/fetch-compat.ts monkey-patches globalThis.fetch to catch
 * Node/undici's "Cannot convert argument to a ByteString" TypeError (thrown
 * when a Chinese API provider like MiniMax/Zhipu returns a non-ASCII HTTP
 * header value) and retry the request via raw node:http/node:https instead,
 * sanitizing non-ASCII bytes out of the response headers.
 *
 * Key testability fact: `const originalFetch = globalThis.fetch;` is
 * captured once, at module import time (fetch-compat.ts:13). To control what
 * "original fetch" the patch wraps, globalThis.fetch must be stubbed BEFORE
 * the module is imported, and the module must be freshly re-imported per
 * test that needs a different originalFetch behavior (vi.resetModules() +
 * dynamic import), since the module (and its captured closure) is otherwise
 * cached for the lifetime of this test file.
 *
 * Isolation empirically verified: vitest.config.ts's `isolate: true` gives
 * each test FILE a fresh module registry, but does NOT reset the registry
 * between individual it() blocks within the same file — a manual probe
 * confirmed that without vi.resetModules() in afterEach, a second test's
 * dynamic import() returns the same cached module (and thus the same
 * originalFetch closure) as an earlier test in the file, causing a stub set
 * in test 2 to be silently ignored in favor of test 1's stale stub. The
 * afterEach hook below (vi.resetModules()) is therefore load-bearing, not
 * defensive boilerplate, and is required before every dynamic import.
 */

import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import * as http from "node:http";

let realFetch: typeof globalThis.fetch;

beforeAll(() => {
  realFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.resetModules();
});

async function startEchoServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const BYTESTRING_ERROR_MESSAGE =
  "Cannot convert argument to a ByteString because the character at index 5 has a value of " +
  "20320 which is greater than 255.";

describe("fetch-compat", () => {
  it("passes through to the original fetch on success (no rawFetch involvement)", async () => {
    const stub = vi.fn().mockResolvedValue(new Response("ok", { status: 200 }));
    globalThis.fetch = stub;
    const { applyFetchCompatPatch } = await import("../src/providers/fetch-compat.js");
    applyFetchCompatPatch();

    const res = await globalThis.fetch("https://example.com");

    expect(stub).toHaveBeenCalledTimes(1);
    expect(await res.text()).toBe("ok");
  });

  it("rethrows a plain Error unrelated to ByteString, without invoking rawFetch", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("network down"));
    const { applyFetchCompatPatch } = await import("../src/providers/fetch-compat.js");
    applyFetchCompatPatch();

    await expect(globalThis.fetch("https://example.com")).rejects.toThrow("network down");
  });

  it("rethrows a TypeError that does not mention ByteString, without invoking rawFetch", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("something else entirely"));
    const { applyFetchCompatPatch } = await import("../src/providers/fetch-compat.js");
    applyFetchCompatPatch();

    await expect(globalThis.fetch("https://example.com")).rejects.toThrow("something else entirely");
  });

  it("falls back to rawFetch on a ByteString TypeError and round-trips a real request", async () => {
    const { url, close } = await startEchoServer((req, res) => {
      res.writeHead(200, { "x-echo-method": req.method ?? "" });
      res.end("fallback-ok");
    });
    try {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError(BYTESTRING_ERROR_MESSAGE));
      const { applyFetchCompatPatch } = await import("../src/providers/fetch-compat.js");
      applyFetchCompatPatch();

      const res = await globalThis.fetch(url, { method: "GET" });

      expect(res.status).toBe(200);
      expect(await res.text()).toBe("fallback-ok");
      expect(res.headers.get("x-echo-method")).toBe("GET");
    } finally {
      await close();
    }
  });

  it("defaults the method to POST when init is omitted entirely (documented existing behavior, not a fetch-spec default)", async () => {
    const { url, close } = await startEchoServer((req, res) => {
      res.writeHead(200, { "x-echo-method": req.method ?? "" });
      res.end("ok");
    });
    try {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError(BYTESTRING_ERROR_MESSAGE));
      const { applyFetchCompatPatch } = await import("../src/providers/fetch-compat.js");
      applyFetchCompatPatch();

      const res = await globalThis.fetch(url);

      expect(res.headers.get("x-echo-method")).toBe("POST");
    } finally {
      await close();
    }
  });

  it("converts init.headers from a Headers instance", async () => {
    const { url, close } = await startEchoServer((req, res) => {
      res.writeHead(200, { "x-echo-test-header": req.headers["x-test-header"] ?? "" });
      res.end("ok");
    });
    try {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError(BYTESTRING_ERROR_MESSAGE));
      const { applyFetchCompatPatch } = await import("../src/providers/fetch-compat.js");
      applyFetchCompatPatch();

      const res = await globalThis.fetch(url, {
        method: "GET",
        headers: new Headers({ "x-test-header": "abc" }),
      });

      expect(res.headers.get("x-echo-test-header")).toBe("abc");
    } finally {
      await close();
    }
  });

  it("converts init.headers from an array of pairs", async () => {
    const { url, close } = await startEchoServer((req, res) => {
      res.writeHead(200, { "x-echo-test-header": req.headers["x-test-header"] ?? "" });
      res.end("ok");
    });
    try {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError(BYTESTRING_ERROR_MESSAGE));
      const { applyFetchCompatPatch } = await import("../src/providers/fetch-compat.js");
      applyFetchCompatPatch();

      const res = await globalThis.fetch(url, {
        method: "GET",
        headers: [["x-test-header", "def"]],
      });

      expect(res.headers.get("x-echo-test-header")).toBe("def");
    } finally {
      await close();
    }
  });

  it("converts init.headers from a plain object", async () => {
    const { url, close } = await startEchoServer((req, res) => {
      res.writeHead(200, { "x-echo-test-header": req.headers["x-test-header"] ?? "" });
      res.end("ok");
    });
    try {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError(BYTESTRING_ERROR_MESSAGE));
      const { applyFetchCompatPatch } = await import("../src/providers/fetch-compat.js");
      applyFetchCompatPatch();

      const res = await globalThis.fetch(url, {
        method: "GET",
        headers: { "x-test-header": "ghi" },
      });

      expect(res.headers.get("x-echo-test-header")).toBe("ghi");
    } finally {
      await close();
    }
  });

  it("passes Latin-1-range response header bytes through untouched", async () => {
    // Hand-craft the response head as raw bytes via res.socket.write(), bypassing
    // Node's own res.setHeader validation, so we control exactly what byte value
    // reaches the client. 0xe9 is the Latin-1 encoding of 'é' — a single byte
    // within fetch-compat.ts:82's inclusive \x00-\xff range, so the sanitizer
    // must leave it untouched.
    const { url, close } = await startEchoServer((req, res) => {
      const head = Buffer.concat([
        Buffer.from("HTTP/1.1 200 OK\r\nx-provider-msg: caf", "ascii"),
        Buffer.from([0xe9]), // Latin-1 'é' as a single raw byte
        Buffer.from("\r\nContent-Length: 2\r\n\r\nok", "ascii"),
      ]);
      res.socket?.write(head);
      res.socket?.end();
    });
    try {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError(BYTESTRING_ERROR_MESSAGE));
      const { applyFetchCompatPatch } = await import("../src/providers/fetch-compat.js");
      applyFetchCompatPatch();

      const res = await globalThis.fetch(url, { method: "GET" });

      expect(await res.text()).toBe("ok");
      expect(res.headers.get("x-provider-msg")).toBe("caf\xe9");
    } finally {
      await close();
    }
  });

  // The raw-socket approach above (writing hand-crafted response-head bytes and
  // reading them back through Node's real http client) turns out to be
  // structurally unable to exercise the "?"-replacement branch at all — not a
  // flakiness issue, but a property of how Node decodes incoming headers.
  // Verified empirically with a standalone script: writing genuine multi-byte
  // UTF-8 bytes for "你好" (e.g. Buffer.from("你好", "utf8")) as a raw header
  // value and reading it back via node:http's IncomingMessage.headers yields
  // the *mojibake* string "ä½ å¥½" (char codes [228,189,160,229,165,189]) — every
  // decoded character lands in \x00-\xff, because Node's header parser decodes
  // incoming header bytes one-for-one as Latin-1/binary. Since a raw byte can
  // never exceed 0xff to begin with, and Node never merges those bytes back
  // into multi-byte codepoints for header *values*, there is no sequence of
  // wire bytes that produces a decoded res.headers string containing a
  // character outside \x00-\xff. fetch-compat.ts:82's replace() branch is
  // therefore unreachable via any genuine incoming HTTP response through
  // node:http/node:https as currently used by rawFetch.
  //
  // This is exactly the documented fallback in plan 016 Step 7: assert the
  // sanitization regex's *contract* directly. This documents the same regex
  // as fetch-compat.ts:82 — keep this test in sync if that line changes.
  it("the sanitization regex replaces out-of-Latin-1-range characters with '?' (fetch-compat.ts:82 contract)", () => {
    const sanitize = (v: string) => v.replace(/[^\x00-\xff]/g, "?");

    // "你好" — genuine multi-byte CJK characters (U+4F60, U+597D), the exact
    // shape of header MiniMax/Zhipu are known to send.
    expect(sanitize("你好")).toBe("??");
    // Mixed ASCII + CJK: only the out-of-range characters are replaced.
    expect(sanitize("error: 服务器错误")).toBe("error: ?????");
    // Latin-1-range characters (like the raw-socket café case above) are left
    // untouched by this same regex.
    expect(sanitize("caf\xe9")).toBe("caf\xe9");
  });
});
