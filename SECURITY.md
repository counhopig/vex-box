# Security

## Reporting a vulnerability

Do not open a public issue. Report privately to the maintainer (see
`package.json` `repository` / `bugs` fields for current contact), or via GitHub's
private vulnerability reporting if enabled for this repository.

## Vulnerability posture

Vex is a multi-user bot framework: it fetches arbitrary URLs on the model's behalf
(web/browser tools), executes shell commands (bash tool), and accepts WebSocket
connections (WebChat). The highest-value attack surface is therefore the SSRF/WS
layer, the filesystem sandbox, and the plugin loader — all covered by plans
001–005 in `plans/` and by the tests under `tests/tool-*.test.ts`.

`npm audit` is not run in CI because the two advisories it reports for
`@mariozechner/pi-coding-agent` are **unreachable dead code paths** in Vex's
SDK-embedding usage, not live attack surface. That assessment is documented below
and enforced with an allowlisted `audit-ci` gate (see `audit-ci.jsonc`).

## Accepted advisories (unreachable in Vex)

Vex embeds `@mariozechner/pi-coding-agent` via its **SDK** entry point
(`createAgentSession` + `AuthStorage` + `ModelRegistry` + `SessionManager`), never
via its CLI/interactive-mode entry points. Each advisory below traces to a
pi-coding-agent code path that only the CLI/interactive modes (or OAuth/subscription
flows Vex does not use) can reach. `grep -rn "ensureTool|tools-manager|extract-zip|export-html|exportHtml" src/`
returns zero matches: Vex's own tool surface (`src/tools/builtin/`) fully replaces
pi-coding-agent's built-in tools.

| Advisory | Severity | pi-coding-agent trigger path | Why it is unreachable in Vex |
|---|---|---|---|
| `GHSA-jfgx-wxx8-mp94` — predictable temp extension-install paths allow local priv-esc | **high** | `core/package-manager.js` `getTemporaryDir()` → `tmpdir()/pi-extensions/...`; reachable only via `pi install` (extension/package install) | Vex has its own 3-tier plugin system (`src/plugins/`); it never invokes pi-coding-agent's extension/package installer. |
| `GHSA-jmr9-qjv8-65gv` — `extract-zip` symlink traversal | **high** | `utils/tools-manager.js` `downloadTool()` → `extractZip()`; called only by `ensureTool("fd"/"rg")`, which only the built-in `find`/`grep` tools invoke | Vex passes `tools: []` to `createAgentSession` (`src/agent/createDefaultPiSession.ts`); the built-in `find`/`grep` tools are never activated, so `downloadTool`/`extractZip` never run. Vex uses its own filesystem tools instead. |
| `GHSA-r95r-rj6r-c39x` — `auth.json` write race exposing credentials | low | `core/auth-storage.js` `FileAuthStorageBackend.writeFileSync(auth.json)`; used by OAuth/subscription flows | Vex constructs `AuthStorage.inMemory()` (`createDefaultPiSession.ts`) — no OAuth flows, no on-disk credentials. |
| `GHSA-7v5m-pr3q-6453` — XSS in HTML session exports | low | `core/export-html/*` — reachable only via the `/export` command or `--export` CLI flag | Vex never calls the HTML export module; sessions persist via its own `FileSessionStore`, not pi-coding-agent's export. |

Only the two **high** advisories require an `audit-ci` allowlist entry; the two
**low** ones sit below the `high` failure threshold but are documented here for
completeness.

### Why `npm audit fix --force` is NOT the answer

`npm audit fix --force` proposes downgrading `pi-coding-agent` to `0.49.3`. That
downgrade drops `extract-zip` and clears `GHSA-jfgx` (`>=0.50.0`), but **still
matches** `GHSA-r95r` (`>=0.28.0`) and `GHSA-7v5m` (`>=0.27.5`) — so it would swap
2 highs for 2 lows while breaking the rewritten codebase. No published
`pi-coding-agent` version clears all four; only a future release `>0.73.1` can do
so.

## devDependencies (excluded from the audit gate)

`audit-ci` runs with `skip-dev: true`: Vex is a library whose `files` manifest
ships only `dist/**` + `skills/**`, so `devDependencies` (vitest, vite, esbuild)
never reach an end user. The dev-only advisories below are intentionally **not**
gated in CI; listing them here makes the exclusion a documented decision, not an
oversight:

| Advisory | Severity | Why excluded |
|---|---|---|
| `GHSA-5xrq-8626-4rwp` — Vitest UI server arbitrary file read/execute | critical | Requires `vitest --ui` (a listening UI server). Vex runs `vitest run` headless — no UI server is ever started. |
| `GHSA-fx2h-pf6j-xcff` — vite `server.fs.deny` bypass on Windows alternate paths | high | Windows-only, and affects vite's **dev server**, which Vex neither ships nor runs. |
| `GHSA-…` — esbuild dev-server request disclosure | moderate | Dev server only; not shipped. |

If Vex ever ships or invokes a dev server (vite/esbuild) or the vitest UI server at
runtime, drop `skip-dev` and re-assess.

## How the allowlist is enforced

`audit-ci.jsonc` allowlists the two **high** GHSA identifiers above and runs with
`skip-dev: true`. If any of the following changes, re-run the audit and re-justify
(or remove) the corresponding allowlist entry — the CI gate will fail otherwise:

- Vex starts using a pi-coding-agent built-in tool (`find`/`grep` → triggers
  `ensureTool`/`extract-zip`).
- Vex switches `AuthStorage.inMemory()` to a file-backed `AuthStorage` (OAuth /
  on-disk credentials → triggers the `auth.json` race).
- Vex starts calling pi-coding-agent's HTML session export.
- Vex starts using pi-coding-agent's extension/package installer instead of its
  own plugin system.
- `pi-coding-agent` publishes a release `>0.73.1` that fixes these — then remove
  the allowlist entries and re-run `npm audit --omit=dev`.

Run locally with:

```bash
npm run audit        # npx audit-ci@^7 --config ./audit-ci.jsonc
```
