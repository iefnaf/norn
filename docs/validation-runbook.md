# Norn validation runbook

What an operator actually runs to validate Norn end-to-end against the
private fixture `iefnaf/taskflow-dag-demo` (design.md §19), and a frank log
of the friction the first real run surfaced. Everything here was executed
for real on 2026-09-22 (ticket #18); the fixture now carries a fully
delivered map and a `passed` RunReport as remote evidence.

## Prerequisites

- `gh` authenticated against github.com with `repo` scope (the gateway,
  evidence reader, and issue writer all shell out to `gh api`).
- Git credentials for HTTPS pushes (e.g. the macOS `osxkeychain` helper —
  it is configured at the *system* level here, not in `--global`).
- A running Herdr server, with `pi` on the server's `PATH` (child agents
  are `herdr agent start … -- pi …` and inherit the *server's* environment,
  not the coordinator's).
- Both configured model families reachable **from Herdr pane processes**.
  On this machine `zai-coding-cn` works directly, but `openai-codex`
  (chatgpt.com) is only reachable through the local proxy. During `/norn
  init`, add per-run child-agent entries instead of changing Pi's global
  settings:

  ```jsonc
  "agentEnv": {
    "HTTP_PROXY": "http://127.0.0.1:7897",
    "HTTPS_PROXY": "http://127.0.0.1:7897"
  }
  ```

  Without them, every reviewer invocation dies with `fetch failed`, pi
  abandons the turn after three retries, and the pane sits at a prompt
  until the agent timeout.
- Pi project trust pre-seeded for the Norn-home prefix, **using the
  canonical path** (on macOS `/tmp/…` is really `/private/tmp/…`):

  ```jsonc
  // ~/.pi/agent/trust.json — a parent decision covers every workspace
  { "/private/tmp/norn-e2e": true }
  ```

  Without it, every child agent opens with the "Trust project folder?"
  dialog (the fixture's baseline contains `.pi/skills`) and parks until a
  human answers it in the pane.
- A repository checkout of `norn` with `npm install` done; `npm run build`
  and `npm test` green before you start.

## Fixture reset (what #18 did)

The fixture map is `iefnaf/taskflow-dag-demo#6`; members `#1`–`#5` with
native sub-issue and `blockedBy` relationships (#1 → #2, #1 → #3,
{#2,#3} → #4, #4 → #5). Topology is **native only**; the Markdown table in
#6's body is prose Norn never reads.

1. Reopen all member tickets (`gh api --method PATCH
   repos/iefnaf/taskflow-dag-demo/issues/N -f state=open`).
2. Delete stale `<!-- norn:record -->` envelope comments on the tickets and
   the map, if any exist (list comments, delete those whose body starts
   with the marker). In this reset there were **none** — the old taskflow
   demo's comments are unmarked prose, which the §14 envelope grammar
   ignores, so they were left in place.
3. Back up the remote target and reset it to the pre-map baseline:

   ```sh
   git push origin main:refs/heads/backup/pre-norn-e2e   # 67e06d0 preserved
   git push --force origin a3081ba975309e39f11facc75b02e8e5e211a531:main
   ```

   `main` went `67e06d0` (old demo's tip) → `a3081ba` (the last pre-map
   commit, just before ticket #1's delivery). The local checkout must then
   `git fetch && git reset --hard origin/main`.
4. Re-verify the topology through Norn's own read path:

   ```sh
   node scripts/e2e-driver.ts map https://github.com/iefnaf/taskflow-dag-demo/issues/6
   ```

## Running the flow

`/norn` is a Pi extension command, so the operator path is an interactive
`pi` session inside the fixture checkout:

```text
cd <fixture-checkout>
pi
/norn init
/norn check https://github.com/iefnaf/taskflow-dag-demo/issues/6
/norn run  https://github.com/iefnaf/taskflow-dag-demo/issues/6
```

For headless validation (what #18 actually drove), use the driver in
`scripts/e2e-driver.ts`. It calls the same production code paths —
`initRepository` with the built-in adapters, `executeCheckCommand`, and
`executeRunCommand` — with scripted init answers and a printing UI:

```sh
cd <fixture-checkout>
export PI_CODING_AGENT_DIR=/tmp/norn-e2e/agent   # isolate Norn home
export NORN_E2E_HTTP_PROXY=http://127.0.0.1:7897 # optional; writes agentEnv

node <norn-checkout>/scripts/e2e-driver.ts init
node <norn-checkout>/scripts/e2e-driver.ts check https://github.com/iefnaf/taskflow-dag-demo/issues/6
node <norn-checkout>/scripts/e2e-driver.ts run  https://github.com/iefnaf/taskflow-dag-demo/issues/6
```

The explicit choices used for the validated run: target branch `main`;
setup **empty** (the fixture has zero dependencies — see friction #8);
tests `npm test` (120 s); Worker `zai-coding-cn/glm-5.3` thinking `low`;
Reviewer `openai-codex/gpt-5.6-luna` thinking `minimal`; concurrency 2;
`HTTP_PROXY` and `HTTPS_PROXY` set from `NORN_E2E_HTTP_PROXY` when needed;
maxPushRetries 2; maxWorkRounds 3 for the first full run, raised to 5 for
the final run after a `work-rounds-exhausted` park (`NORN_E2E_MAX_WORK_ROUNDS=5`
in the environment, re-`init` first — a config change requires no active
runs). Type-check the driver with `npx tsc -p scripts/tsconfig.json`.

Give the run wall-clock: each agent invocation is a real model session
(minutes each), a map of five tickets ran for roughly an hour including
restarts. Watch progress with `/norn status`, the Run State JSON under
`<norn-home>/repositories/<host>/<repo-id>/maps/<issue>/run-state.json`,
and `herdr agent list`. If an invocation parks, read its pane
(`herdr agent read <pane>`) before touching anything.

## Post-run verification

- Every member issue CLOSED, each carrying exactly one
  `<!-- norn:record -->` delivery record comment.
- `git log origin/main`: one canonical `norn: ship ticket #N` integration
  commit per ticket (committer `Norn <norn@delivery.invalid>`, template
  body only), linear history on top of the reset baseline.
- The map issue CLOSED, with a `norn-map-completion:v1` record comment
  whose `closingEventId` matches the issue's actual ClosedEvent node ID
  and whose `completionSha` is an ancestor of `origin/main`.
- The terminal RunReport reads `passed` with that `completionSha`
  (persisted in the Run State and rendered by the run command).

## Friction log (first real run, 2026-09-22)

Fixed in this change (norn defects — each ships with a regression test):

1. **Herdr liveness contract** (`src/agents/herdr-runner.ts`): Herdr keeps
   a finished agent's pane listed with `agent_status: "done"`, so
   `isLive` — which only accepted `agent_not_found` as "exited" — never
   returned false and every invocation stalled until its agent timeout.
   `done` now counts as exited.
2. **Children never exited after completing** (`src/agents/completion-extension.ts`):
   a terminating tool result only skips the follow-up LLM call in Pi; the
   process stayed alive at the prompt. The §17 settlement protocol needs
   the process group gone, so a successful `norn_complete` now also calls
   `ctx.shutdown()`.
3. **Map-completion reviewer session mismatch** (`src/extension/run-command.ts`,
   `src/run/completion.ts`): the production launch plan hardcoded
   `--session-id map-completion-rev-N-pi` while the completion context
   binds `<invocationId>-pi`, so every completion call was rejected with a
   session-mismatch error. The invocation ID now threads through the
   launch input.
4. **Empty timeline anchor** (`src/run/completion.ts`): the anchor was the
   last timeline item's `eventId`, but "other" event kinds (sub-issue
   added, …) carry no ID in GitHub's timeline union, producing `""` —
   which the Run State validator (correctly) rejects, so the gated
   completion checkpoint could never persist. #18 initially fell back to
   the last real event ID; follow-up #23 now preserves the exact boundary
   with a length-and-digest synthetic prefix whenever the head is ID-less.

Operator-side findings (no norn change, documented above in
Prerequisites):

5. **Trust dialog parks fresh workspaces** — plus the macOS `/tmp` vs
   `/private/tmp` canonicalization trap: a trust entry for the
   non-canonical path silently does not apply.
6. **Proxied model providers** — panes inherit the Herdr server's
   environment, so the original run needed Pi's global `httpProxy` setting.
   Ticket #24 replaced that workaround with Run Config `agentEnv`, passed as
   explicit `herdr agent start --env` entries. A failed first submission still
   does not exit the pane; the invocation then waits out its timeout unless
   the operator notices.
7. **Parallel-wave path conflicts park a ticket** — two wave-2 members
   each invented `test/index.js`; the second ship replayed onto the
   advanced target, hit an add/add conflict, and parked with
   `integration-conflict`. By design (§11.2 never resolves conflicts),
   and a fresh run re-worked the ticket from the advanced base — but
   operators should expect it whenever parallel tickets create the same
   auxiliary path.

Process observations:

8. **Setup commands must not dirty the tree** — `npm install` on a
   zero-dependency repo still writes `package-lock.json`, which is
   untracked (the fixture's `.gitignore` only covers `node_modules/`)
   and fails the §10.2 cleanliness check. The honest setup for this
   fixture is empty; repos that need installs should gitignore the lock
   or commit it at baseline.
9. **Recoverable errors need re-invocation** — a transient
   `SSL_ERROR_SYSCALL` during a wave-snapshot fetch ended that invocation
   with a recoverable `target-read` error (Run State stayed `running`);
   the next `run` resumed the same run ID and finished. Operators must
   read the error tail, not assume failure.
10. **Round budget pressure** — the fiddly e2e ticket exhausted its
    default 3 review rounds; the remedy (new run, or a higher
    `maxWorkRounds` via re-init) works but discards the parked attempt's
    feedback, so the fresh worker starts from zero context.
11. **Pane litter and poll cost** — every invocation opens a new Herdr
    pane; done panes linger for inspection (useful) but accumulate, and
    each split narrows the remainder. At validation time, `waitForExit`
    spawned `herdr agent get` every ≤100 ms for up to an hour per agent;
    it now delegates to one bounded `herdr agent wait` process per
    invocation (#22).
12. **Headless operation needs the driver** — the `/norn` extension
    requires an interactive Pi session; scripted validation goes through
    `scripts/e2e-driver.ts` (kept for operators).

## Validated outcome (2026-09-22)

`main`: `a3081ba` → `4d2685b` (#1) → `cedcda4` (#2) → `e24234a` (#3) →
`72761f3` (#4) → `fe998e7` (#5), all canonical. Issues #1–#6 closed; five
delivery records plus one map-completion record (`closingEventId`
`CE_lADOUfl3ds8AAAABR4m41M8AAAAHWg0AyQ`, `completionSha` `fe998e7`).
Terminal RunReport of run `run-3a2406368f837d59`: `passed`, shared write
`confirmed`, every member `completed`.
