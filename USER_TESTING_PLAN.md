# User Testing Plan

Manual, scenario-based UX testing for Vex — finding friction points in the human-facing
experience, as opposed to the automated unit/integration/E2E coverage backlog tracked in
`plans/README.md`. This document does not overlap with that backlog: it does not test logical
correctness, only usability.

## Scope

Three tracks, matching the three entry points described in `README.md`:

1. **Developer onboarding** — install, configure, run, and operate the service from the command
   line.
2. **End-user chat experience** — talking to the bot over WeChat / WebChat, using tools, and
   relying on memory across turns.
3. **Web control panel** — login, per-user settings, session history, admin/user permission
   boundaries.

## Method

Scenario-based, goal-directed walkthroughs. Each scenario states a goal, not steps — the tester
figures out how to get there and records where they got stuck, confused, or surprised. This
matters specifically because the testers are developers with full knowledge of the codebase;
fixed step scripts would just have them execute a checklist rather than expose real friction.
Testers are the maintainer and a collaborator, each playing a role (a first-time operator, a
non-technical end user, an admin vs. a regular web user).

## Scenarios

### Track 1 — Developer onboarding

| # | Goal | Watch for |
|---|------|-----------|
| D1 | Fresh install: build locally and get the WebChat UI running | `vex-bot` is not published to the npm registry — use `npm run build && npm link` (or `npm pack` + install the tarball), not `npm install -g vex-bot`. Is the onboarding wizard's guidance sufficient without that context? |
| D2 | Run WebChat only, without touching WeChat | Known trap: `--web-only` only relaxes the "must configure a channel" startup check — it does **not** disable an already-configured WeChat channel. |
| D3 | Break the config on purpose (missing required field, then a YAML syntax error) and self-diagnose using the tool's own error output | Does `vex check` / the startup error point at the actual problem? |
| D4 | Try to turn off Persona, and separately enable one of the bundled skills (`skills/clawhub` or `skills/greeting`) | Known trap: `persona`/`skills`/`sharelink` are opt-in by *section presence* — `enabled: false` does not turn them off, omitting the whole section does. |
| D5 | "The bot stopped responding" — diagnose using `vex status` / `vex logs -f` / `vex restart` alone | Do the command outputs give an actionable next step, or just raw state? |
| D6 | Configure the personal WeChat channel and complete the QR login flow | **Use a throwaway WeChat account, never a primary one** — the iLink OC API is an unofficial protocol against personal accounts and carries a real ban risk. |

### Track 2 — End-user chat experience

| # | Goal | Watch for |
|---|------|-----------|
| U1 | First conversation on WebChat, casual back-and-forth | Does the Persona's tone feel natural, or scripted? |
| U2 | Ask the bot for the weather | Is tool invocation visible/legible to the user? Is a failure message understandable? |
| U3 | Ask the bot to set a reminder (cron) | Async and possibly cross-channel delivery (`deliver`/`channel`/`to`, recently touched by plan 010) — does the user find out whether it actually worked, and when? |
| U4 | Start a new session later and ask if the bot remembers something from before | Is recall accurate, or does it misattribute facts? |
| U5 | Mix Chinese/English, internet slang, and typos in the same conversation | CJK tokenization and recall quality; reply naturalness |
| U6 | Send several messages in rapid succession, one very long message, and an empty/emoji-only message | Concurrent dedup behavior; graceful handling of edge-case input |

### Track 3 — Web control panel

| # | Goal | Watch for |
|---|------|-----------|
| W1 | Log in, deliberately get the password wrong once, then succeed | Is the error message clear? |
| W2 | As a regular user, change a personal setting and figure out whether it's actually taking effect over the system YAML default | Can you tell, from the UI alone, which layer (system default vs. your override) is currently in effect? |
| W3 | Find a past conversation's session record in the panel | Is it easy to locate and easy to read? |
| W4 | As a non-admin user, try to reach an admin-only action | Backend already 403s this — is the **frontend** message clear about what happened and why? |

## Recording findings

One row per friction point found:

| Field | Notes |
|-------|-------|
| ID | `<scenario>-<seq>`, e.g. `D1-01` |
| Severity | See scale below |
| What happened | Observed behavior |
| Expected | What a reasonable user would expect instead |
| Repro steps | Scenarios don't prescribe steps, so record how you actually got there |
| Evidence | Screenshot / log excerpt |
| Suspected module (optional) | Cross-reference the module table in `AGENTS.md`, e.g. `src/config/` |

### Severity scale

- **Blocker** — the critical path doesn't complete at all (e.g. onboarding wizard crashes with
  no way forward).
- **Major** — workable, but misleading or requires reading code/docs to understand (e.g. the D2,
  D4, D6 known traps above).
- **Minor** — affects perceived quality but doesn't block task completion (unclear wording,
  broken formatting).
- **Cosmetic** — polish-only, no functional impact.

Output: one findings table, sorted by severity, handed back for triage.

## Environment setup

- Check Node version against `.nvmrc` (currently 24) before install — a version mismatch throws
  unrelated errors that read like product bugs.
- Use a clean `~/.vex` directory — not your regular dev config — to avoid stale state skewing
  results.
- At least one working model API key (DeepSeek recommended — cheap, and you likely already have
  one).
- Build locally and `npm link`; do not rely on `npm install -g vex-bot` (see D1).
- One throwaway WeChat account for D6 — never the primary account.
- Register two web accounts before starting Track 3: the first registered user becomes `admin`
  automatically (`src/web/routes/auth.ts`), the second is a regular `user` — reuse it directly for
  W4.

## Out of scope

- Anything covered by the automated test coverage backlog in `plans/README.md` (unit/integration/
  E2E, security regressions, perf).
- Multi-channel consistency (same user active on WebChat and WeChat simultaneously) — worth
  testing eventually, but not included here: exercising it meaningfully needs more than one live
  WeChat test account, which this pass doesn't budget for.
