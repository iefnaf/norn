# Norn validation runbook

Use this runbook to validate the implemented system against [`design.md`](design.md). It separates deterministic local tests, live production-adapter checks, one destructive happy-path run, and focused fault campaigns. It is written so a coordinator can delegate independent checks to subagents without allowing multiple agents to mutate the same fixture.

The first live run and the defects it exposed are preserved in [`validation-history.md`](validation-history.md). Historical run IDs and commit SHAs are evidence of that run, not expected values for a new run.

## 1. Verdicts and safety rules

A validation item has exactly one verdict:

- **PASS** — every listed assertion passed and the evidence files exist.
- **FAIL** — Norn or an external invariant contradicted the expected result.
- **BLOCKED** — the environment could not exercise the item, for example unavailable credentials, models, Herdr, or fixture ownership. BLOCKED is not PASS.

Apply these rules to every live test:

1. One coordinator owns all destructive operations on a fixture repository, target branch, Map, and member Tickets.
2. Subagents may perform read-only verification in parallel only after the writer has stopped.
3. Every run uses its own fixture checkout, evidence directory, and `PI_CODING_AGENT_DIR`.
4. No test uses a production repository or a branch containing work that cannot be discarded.
5. Back up the target tip before resetting it. Use `--force-with-lease`, never an unguarded force push.
6. Capture exact Ticket title/body text and topology before changing them. Revisions depend on those values.
7. A timing-sensitive test acts on a persisted Run State checkpoint. Do not approximate a push or close window with `sleep`.

The private reference fixture is `iefnaf/taskflow-dag-demo#6`. Its target branch is intentionally destructive test state. Obtain explicit fixture-owner approval before resetting it.

## 2. Validation layers

| Layer | Purpose | External systems | Required for release |
| --- | --- | --- | --- |
| L0 | Type checking and deterministic automated suite | none | yes |
| L1 | Read-only production-adapter and environment smoke | GitHub, Git, model catalog, Herdr | yes |
| L2 | Full Work → Ship → Map completion path | GitHub, Git, Pi, Herdr, real models | yes |
| L3 | Destructive recovery, race, and concurrency campaigns | dedicated fixtures plus fault harness | risk-based |

L0 is broad over pure rules, real temporary Git repositories, filesystem state, locks, slots, process groups, and injected recovery faults. It does not execute the real GitHub CLI wire path, a hosted push, Pi, or a model. L1 and L2 cover those residual integrations.

## 3. Standard test context

The coordinator assigns these values before delegating work:

```sh
export NORN_CHECKOUT=/absolute/path/to/norn
export NORN_REF=<commit-being-validated>
export FIXTURE_REPO=iefnaf/taskflow-dag-demo
export FIXTURE_CHECKOUT=/absolute/path/to/taskflow-dag-demo
export MAP_URL=https://github.com/iefnaf/taskflow-dag-demo/issues/6
export MAP_NUMBER=6
export TICKET_NUMBERS='1 2 3 4 5'
export TARGET_BRANCH=main
export BASELINE_SHA=a3081ba975309e39f11facc75b02e8e5e211a531
export RUN_TAG="$(date -u +%Y%m%dT%H%M%SZ)"
export EVIDENCE_DIR="/tmp/norn-validation-$RUN_TAG"
export PI_CODING_AGENT_DIR="/tmp/norn-validation-$RUN_TAG/agent"
mkdir -p "$EVIDENCE_DIR" "$PI_CODING_AGENT_DIR"
```

The coordinator must replace fixture-specific values when using another Map. Each subagent records its context before testing:

```sh
{
  date -u
  printf 'norn_ref=%s\n' "$NORN_REF"
  git -C "$NORN_CHECKOUT" rev-parse HEAD
  node --version
  npm --version
  gh --version | head -1
  herdr --version || true
  pi --version || true
} | tee "$EVIDENCE_DIR/00-context.txt"

test "$(git -C "$NORN_CHECKOUT" rev-parse HEAD)" = "$NORN_REF"
```

Run commands with `set -o pipefail` when piping to `tee`. Save stdout/stderr and the exit code. A report without the command output and independently checked postconditions is BLOCKED, not PASS.

## 4. L0 — deterministic local validation

Run from the pinned Norn checkout:

```sh
cd "$NORN_CHECKOUT"
npm ci 2>&1 | tee "$EVIDENCE_DIR/10-npm-ci.log"
npm run build 2>&1 | tee "$EVIDENCE_DIR/11-build.log"
npm test 2>&1 | tee "$EVIDENCE_DIR/12-tests.log"
npx tsc -p scripts/tsconfig.json 2>&1 | tee "$EVIDENCE_DIR/13-e2e-driver-typecheck.log"
```

PASS requires all four commands to exit zero. Record the test counts and skipped-test names. The live Herdr test is opt-in and belongs to L1:

```sh
cd "$NORN_CHECKOUT"
NORN_TEST_HERDR=1 node --test test/agent-herdr.test.ts \
  2>&1 | tee "$EVIDENCE_DIR/14-live-herdr-test.log"
```

## 5. L1 — environment and read-only smoke

### 5.1 Prerequisites

Verify, rather than assume:

```sh
gh auth status 2>&1 | tee "$EVIDENCE_DIR/20-gh-auth.log"
gh repo view "$FIXTURE_REPO" --json nameWithOwner,viewerPermission,defaultBranchRef \
  | tee "$EVIDENCE_DIR/21-fixture-access.json"
git -C "$FIXTURE_CHECKOUT" ls-remote origin "$TARGET_BRANCH" \
  | tee "$EVIDENCE_DIR/22-target-tip.txt"
herdr agent list 2>&1 | tee "$EVIDENCE_DIR/23-herdr-list.log"
command -v pi | tee "$EVIDENCE_DIR/24-pi-path.txt"
```

Also establish all of the following:

- `gh` has repository access and the fixture owner has authorized later issue and branch mutations.
- Git credentials can push to the fixture.
- The Herdr server is running and its process environment can resolve `pi`.
- The local Herdr build is inside norn's supported range `>=0.9.0 <0.10.0` (`HERDR_SUPPORTED_VERSION_RANGE` in `src/agents/herdr-runner.ts`). Herdr is an operator-installed, pre-1.0 binary whose CLI surface changed within the 0.7 → 0.9 line (issue #31), so the adapter probes `herdr --version` once before its first launch and fails fast on a build outside the range. Read the reported line from `00-context.txt`; a build outside the range is BLOCKED, not a mismatch for the adapter to discover mid-flight.
- Both configured model families are available to Pi processes launched by Herdr. A provider that answers `pi -p --model <id>` can still refuse a Herdr-launched child (quota, terms-of-service, or plan restrictions), so probe each model before spending a long run on it.
- Each agent invocation gets its **own Herdr tab** (labelled with the invocation ID) and that tab is closed again when the invocation settles — including timeout and abort paths. A run that leaves agent tabs behind after every agent settled is a FAIL.
- Pi trust is pre-seeded for the canonical Norn-home prefix. On macOS, `/tmp/x` normally canonicalizes to `/private/tmp/x`.
- Proxy variables needed by child agents are supplied through Run Config `agentEnv`, not assumed to propagate from the coordinator.

The headless driver selects its Worker and Reviewer models in `scripts/e2e-driver.ts`; `NORN_E2E_WORKER_MODEL` and `NORN_E2E_REVIEWER_MODEL` override them when the configured default is unavailable. Confirm those exact IDs are usable before a long run. `NORN_E2E_HTTP_PROXY` and `NORN_E2E_NO_PROXY` populate child `agentEnv` entries.

Reviewers launch with `--no-builtin-tools`; the completion extension loaded by every agent invocation registers the reviewer's read-only capability set (`read`, `grep`, `find`, `ls`, and `norn_complete`) inside the process. Do not "simplify" this back to a Pi `--tools read,grep,find,ls,norn_complete` allowlist: that allowlist is resolved while extensions load, so an extension-contributed name may be unknown in time, and one unknown name leaves the reviewer with no tools at all — the reviewer then answers in prose and can never settle.

### 5.2 Load the Map through the production GitHub adapter

```sh
cd "$FIXTURE_CHECKOUT"
node "$NORN_CHECKOUT/scripts/e2e-driver.ts" map "$MAP_URL" \
  2>&1 | tee "$EVIDENCE_DIR/25-map.log"
```

For the reference fixture, PASS requires the complete native topology. Ticket state and title may vary, so assert only identity and blockers:

```sh
grep -Eq '#1 (OPEN|CLOSED) blockedBy=\[\]' "$EVIDENCE_DIR/25-map.log"
grep -Eq '#2 (OPEN|CLOSED) blockedBy=\[#1\]' "$EVIDENCE_DIR/25-map.log"
grep -Eq '#3 (OPEN|CLOSED) blockedBy=\[#1\]' "$EVIDENCE_DIR/25-map.log"
grep -Eq '#4 (OPEN|CLOSED) blockedBy=\[#2,#3\]' "$EVIDENCE_DIR/25-map.log"
grep -Eq '#5 (OPEN|CLOSED) blockedBy=\[#4\]' "$EVIDENCE_DIR/25-map.log"
```

Issue ordering in raw API responses is not evidence. The normalized driver output must contain every member and blocker set.

### 5.3 Prove that `check` has no shared side effects

First initialize an isolated Norn home. This writes only local repository metadata and config:

```sh
cd "$FIXTURE_CHECKOUT"
node "$NORN_CHECKOUT/scripts/e2e-driver.ts" init \
  2>&1 | tee "$EVIDENCE_DIR/26-init.log"
```

Capture remote state before and after `check`:

```sh
snapshot_remote() {
  local out=$1
  {
    git -C "$FIXTURE_CHECKOUT" ls-remote origin
    for n in $TICKET_NUMBERS "$MAP_NUMBER"; do
      gh api "repos/$FIXTURE_REPO/issues/$n" \
        --jq '[.number,.state,.title,.body] | @json'
      gh api --paginate "repos/$FIXTURE_REPO/issues/$n/comments?per_page=100" \
        --jq '.[] | [.id,.user.node_id,.created_at,.body] | @json'
    done
  } >"$out"
}

snapshot_remote "$EVIDENCE_DIR/27-remote-before.txt"
find "$PI_CODING_AGENT_DIR/norn" -type f -print | sort \
  >"$EVIDENCE_DIR/27-local-files-before.txt"
node "$NORN_CHECKOUT/scripts/e2e-driver.ts" check "$MAP_URL" \
  2>&1 | tee "$EVIDENCE_DIR/28-check.log"
snapshot_remote "$EVIDENCE_DIR/29-remote-after.txt"
find "$PI_CODING_AGENT_DIR/norn" -type f -print | sort \
  >"$EVIDENCE_DIR/29-local-files-after.txt"
diff -u "$EVIDENCE_DIR/27-remote-before.txt" \
  "$EVIDENCE_DIR/29-remote-after.txt" \
  | tee "$EVIDENCE_DIR/30-check-remote-diff.txt"
diff -u "$EVIDENCE_DIR/27-local-files-before.txt" \
  "$EVIDENCE_DIR/29-local-files-after.txt" \
  | tee "$EVIDENCE_DIR/30-check-local-diff.txt"
test -z "$(find "$PI_CODING_AGENT_DIR/norn" -name run-state.json -o -type d -name runs)"
```

PASS requires:

- output contains `Norn check passed.`;
- the remote snapshots are identical;
- no `run-state.json`, run workspace, completion sidecar, or `norn/*` remote branch was created by `check`.

The headless driver's `check` and `run` subcommands return zero after rendering a typed blocked/error outcome. Exit code zero means “the driver executed,” not “Norn passed.” Always inspect the rendered marker and Run State.

## 6. L2 — destructive happy-path validation

### 6.1 Exclusive ownership gate

Before resetting anything, the coordinator must confirm:

- no other agent or operator is using the fixture, its Map, or its target branch;
- no Norn run for the fixture remains `running`;
- the expected baseline object exists locally and remotely recoverable state has been backed up;
- the exact comments to delete have been listed and approved.

If any condition is unknown, stop with BLOCKED.

### 6.2 Back up and reset the fixture

Use a unique backup ref and a lease on the observed target tip:

```sh
cd "$FIXTURE_CHECKOUT"
git fetch origin "$TARGET_BRANCH"
CURRENT_SHA="$(git rev-parse "origin/$TARGET_BRANCH")"
BACKUP_BRANCH="backup/norn-validation-$RUN_TAG"

git push origin "refs/remotes/origin/$TARGET_BRANCH:refs/heads/$BACKUP_BRANCH"
test "$(git ls-remote origin "refs/heads/$BACKUP_BRANCH" | cut -f1)" = "$CURRENT_SHA"
git cat-file -e "$BASELINE_SHA^{commit}"
```

List marked comments before resetting any remote state:

```sh
: >"$EVIDENCE_DIR/31-record-comments-before-reset.txt"
for n in $TICKET_NUMBERS "$MAP_NUMBER"; do
  gh api --paginate "repos/$FIXTURE_REPO/issues/$n/comments?per_page=100" \
    --jq '.[] | select(.body | contains("<!-- norn:record -->")) | [.id,.html_url] | @tsv' \
    | tee -a "$EVIDENCE_DIR/31-record-comments-before-reset.txt"
done
```

After the fixture owner approves that list, reset the target with the observed lease, delete only the approved comment IDs, and reopen the Map and members:

```sh
git push --force-with-lease="refs/heads/$TARGET_BRANCH:$CURRENT_SHA" \
  origin "$BASELINE_SHA:refs/heads/$TARGET_BRANCH"
git fetch origin "$TARGET_BRANCH"
test "$(git rev-parse "origin/$TARGET_BRANCH")" = "$BASELINE_SHA"

cut -f1 "$EVIDENCE_DIR/31-record-comments-before-reset.txt" | while read -r id; do
  test -n "$id" && gh api --method DELETE "repos/$FIXTURE_REPO/issues/comments/$id"
done

for n in $TICKET_NUMBERS "$MAP_NUMBER"; do
  gh api --method PATCH "repos/$FIXTURE_REPO/issues/$n" -f state=open >/dev/null
done

git reset --hard "origin/$TARGET_BRANCH"
git clean -ffd
```

Re-run the Map command from §5.2 and compare the topology before proceeding. The reset changes issue state, comments, and target history; it must not change Ticket text or native topology.

### 6.3 Initialize, check, and run

The reference fixture has no dependencies. Its honest setup list is empty because `npm install` creates an untracked lockfile and violates the gate cleanliness rule. The configured test is `npm test`.

```sh
cd "$FIXTURE_CHECKOUT"
export NORN_E2E_HTTP_PROXY=${NORN_E2E_HTTP_PROXY:-}
export NORN_E2E_NO_PROXY=${NORN_E2E_NO_PROXY:-}
export NORN_E2E_MAX_WORK_ROUNDS=${NORN_E2E_MAX_WORK_ROUNDS:-5}

node "$NORN_CHECKOUT/scripts/e2e-driver.ts" init \
  2>&1 | tee "$EVIDENCE_DIR/32-init.log"
node "$NORN_CHECKOUT/scripts/e2e-driver.ts" check "$MAP_URL" \
  2>&1 | tee "$EVIDENCE_DIR/33-check.log"
node "$NORN_CHECKOUT/scripts/e2e-driver.ts" run "$MAP_URL" \
  2>&1 | tee "$EVIDENCE_DIR/34-run.log"
```

Allow at least 90 minutes. Monitor headless runs with `herdr agent list`, `herdr tab list`, and the Run State JSON. `/norn status` is available only from an interactive Pi session; the driver does not expose a `status` subcommand.

A rendered recoverable error explicitly says that the run remains `running` and resumable. After correcting only the transient infrastructure problem, invoke the same `run` command again. It must resume the same run ID. Do not reset, re-init with different config, or start a new run over ambiguous shared state.

### 6.4 Authoritative PASS assertions

Locate the one Run State created under the isolated Norn home:

```sh
find "$PI_CODING_AGENT_DIR/norn/repositories" -name run-state.json -type f \
  | tee "$EVIDENCE_DIR/35-run-state-path.txt"
test "$(wc -l <"$EVIDENCE_DIR/35-run-state-path.txt" | tr -d ' ')" = 1
RUN_STATE="$(cat "$EVIDENCE_DIR/35-run-state-path.txt")"
cp "$RUN_STATE" "$EVIDENCE_DIR/36-run-state.json"

jq -e '
  .status == "terminal" and
  .report.label == "passed" and
  .report.sharedWrite == "confirmed" and
  (.report.completionSha | type == "string" and length > 0) and
  all(.report.tickets[]; .state == "completed") and
  (.activeProcesses | length == 0)
' "$RUN_STATE" | tee "$EVIDENCE_DIR/37-run-state-assertion.txt"
```

The run log must contain `Norn run passed — run <run-id>`, but Run State and remote facts are the authoritative result. Then independently verify all three evidence channels.

**GitHub:**

Save every marked comment and the fully paginated timeline, then run local assertions over the slurped pages. `gh api` does not allow `--slurp` together with `--jq`.

```sh
for n in $TICKET_NUMBERS "$MAP_NUMBER"; do
  gh api --paginate --slurp "repos/$FIXTURE_REPO/issues/$n/comments?per_page=100" \
    >"$EVIDENCE_DIR/issue-$n-comments.json"
  gh api --paginate --slurp "repos/$FIXTURE_REPO/issues/$n/timeline?per_page=100" \
    -H 'Accept: application/vnd.github+json' \
    >"$EVIDENCE_DIR/issue-$n-timeline.json"
done

for n in $TICKET_NUMBERS; do
  test "$(gh issue view "$n" -R "$FIXTURE_REPO" --json state --jq .state)" = CLOSED
  test "$(jq '[.[][] | select(.body | contains("\"schema\":\"norn-delivery:v1\""))] | length' \
    "$EVIDENCE_DIR/issue-$n-comments.json")" = 1
done

test "$(gh issue view "$MAP_NUMBER" -R "$FIXTURE_REPO" --json state --jq .state)" = CLOSED
test "$(jq '[.[][] | select(.body | contains("\"schema\":\"norn-map-completion:v1\""))] | length' \
  "$EVIDENCE_DIR/issue-$MAP_NUMBER-comments.json")" = 1
```

Verify that the Map completion record names the current closing event and follows it in the timeline:

```sh
python3 - "$EVIDENCE_DIR/issue-$MAP_NUMBER-comments.json" \
  "$EVIDENCE_DIR/issue-$MAP_NUMBER-timeline.json" <<'PY'
import json, re, sys

comments = [item for page in json.load(open(sys.argv[1])) for item in page]
timeline = [item for page in json.load(open(sys.argv[2])) for item in page]
marked = [c for c in comments if '"schema":"norn-map-completion:v1"' in c.get('body', '')]
assert len(marked) == 1, f'expected one completion record, found {len(marked)}'
blocks = re.findall(r'```json\s*\n(.*?)\n```', marked[0]['body'], re.S)
assert len(blocks) == 1, f'expected one JSON block, found {len(blocks)}'
record = json.loads(blocks[0])
state_events = [(i, e) for i, e in enumerate(timeline) if e.get('event') in {'closed', 'reopened'}]
assert state_events and state_events[-1][1].get('event') == 'closed', 'Map is not currently closed'
close_index, close_event = state_events[-1]
assert record['map']['closingEventId'] == close_event['node_id'], 'closing event ID mismatch'
comment_indexes = [
    i for i, event in enumerate(timeline)
    if event.get('id') == marked[0].get('id') or event.get('node_id') == marked[0].get('node_id')
]
assert len(comment_indexes) == 1, f'completion comment not uniquely present in timeline: {comment_indexes}'
assert comment_indexes[0] > close_index, 'completion record does not follow the close event'
print(record['map']['closingEventId'])
PY
```

Treat an API shape that prevents this comparison as BLOCKED, not as an implicit pass.

**Git:**

```sh
cd "$FIXTURE_CHECKOUT"
git fetch origin "$TARGET_BRANCH"
git log --format='%H%x09%P%x09%cn%x09%ce%x09%s' \
  "$BASELINE_SHA..origin/$TARGET_BRANCH" \
  | tee "$EVIDENCE_DIR/38-target-log.txt"
test -z "$(git rev-list --merges "$BASELINE_SHA..origin/$TARGET_BRANCH")"
test "$(git rev-list --count "$BASELINE_SHA..origin/$TARGET_BRANCH")" \
  = "$(printf '%s\n' $TICKET_NUMBERS | wc -l | tr -d ' ')"
awk -F '\t' '
  $3 != "Norn" || $4 != "norn@delivery.invalid" ||
  $5 !~ /^norn: ship ticket #[0-9]+$/ { exit 1 }
' "$EVIDENCE_DIR/38-target-log.txt"
for n in $TICKET_NUMBERS; do
  grep -q $'\tnorn: ship ticket #'"$n"'$' "$EVIDENCE_DIR/38-target-log.txt"
done
COMPLETION_SHA="$(jq -r '.report.completionSha | sub("^sha(1|256):"; "")' "$RUN_STATE")"
git merge-base --is-ancestor "$COMPLETION_SHA" "origin/$TARGET_BRANCH"
```

For the reference happy path, each delivered non-zero-delta Ticket contributes one linear commit with committer `Norn <norn@delivery.invalid>` and subject `norn: ship ticket #N`. Worker intermediate commits and GitHub auto-close keywords must be absent. If a scenario intentionally exercises zero-delta delivery, expect no commit for that Ticket and verify `integratedSha == baseSha` in its Delivery Record instead.

**Processes and local control state:**

```sh
herdr agent list 2>&1 | tee "$EVIDENCE_DIR/39-herdr-after.log"
git -C "$FIXTURE_CHECKOUT" status --short \
  | tee "$EVIDENCE_DIR/40-fixture-status.txt"
```

PASS requires no live process belonging to the completed run, no active process checkpoint, no Norn control file in the fixture working tree, and no agent tab left over by the run. `herdr tab list` must not show a tab labelled with an invocation ID of the completed run; leftover tabs are a FAIL (see §5.1).

### 6.5 Interactive command smoke

The headless driver does not validate Pi dialogs or rendering. At least once per release, run from a clean fixture checkout:

```text
pi -e /absolute/path/to/norn
/norn
/norn init
/norn check <map-url>
/norn run <map-url>
/norn status <map-url>
```

Use a disposable Map for `/norn abort <map-url>`. PASS requires typed prompts, readable event rendering, exact confirmation of the run ID, and outcomes consistent with the headless path.

## 7. L3 — focused fault campaigns

L2 proves the normal path, not every safety property. Prioritize the following campaigns. Each campaign needs its own small fixture Map and resettable target; do not repeatedly spend the five-Ticket reference fixture.

| ID | Risk exercised | Required action point | PASS oracle |
| --- | --- | --- | --- |
| R1 | Push-window crash recovery | `shipping.checkpoint.stage=prepared` and incremented `pushAttempts` | same run resumes; no double push or duplicate record; retry budget survives restart |
| R2 | Crash after push/comment/close | `push-verified`, `delivery-recorded`, and `ticket-closed` in separate runs | exact record is reused; close is not repeated; Completed Ticket requires full post-close validation |
| R3 | Map-completion recovery | `mapCompletion.stage=map-closed` and `recorded` | CLOSED Map routes through recovery; record binds actual current closing event; final report passes once |
| R4 | Incompatible edit after push | after `push-verified`, edit the Ticket body before resume | commit remains on target; no Delivery Record; Ticket remains open; run blocks with confirmed shared write |
| R5 | Zero-delta Ship | open Ticket already satisfied by the target | no new commit; fresh tests/review; record has `integratedSha == baseSha` |
| R6 | In-run integration conflict | parallel Tickets create the same new path | conflict is carried into bounded Rework at the advanced base; exhaustion parks rather than looping |
| R7 | Operator close/reopen race | after delivery record, manually close then reopen | resume detects operator intent and does not silently reclose |
| R8 | Compatible Map Extension | add a new member while a Wave or completion is active | revision lineage and Ticket claim update atomically; new Ticket enters a later Wave; stale completion gates are discarded |
| R9 | Cross-Map ownership and capacity | two Maps, one Norn home, low concurrency | duplicate/overlapping ownership blocks; Work slot cap is global; Ship is serial; later Ship re-gates |
| R10 | Hosted push rejection | enable fixture branch protection for the Ship window | run-scoped `push-rejected`; later Ship does not begin; fixture settings are restored |
| R11 | Evidence ambiguity | add identical and conflicting marked records | identical copy warns/reuses earliest; conflicting canonical evidence blocks rather than guessing |
| R12 | Lost local state | remove a throwaway Norn home after delivery | valid remote records preserve Completed Tickets; closed Ticket without valid evidence blocks |

A coordinator should not delegate R1–R4 until a checkpoint watcher can observe `run-state.json`, atomically claim the injection point, perform the mutation or terminate the coordinator, and capture before/after state. The watcher is a prerequisite because sleep-based races do not produce reproducible evidence.

Each campaign report must include:

```text
Scenario: Rn
Norn commit:
Fixture repository / Map / target branch:
Initial target SHA and Map revision:
Injection checkpoint and exact action:
Expected outcome:
Observed typed outcome and Run State transition:
Remote Git assertions:
GitHub timeline/comment assertions:
Process/slot/lock assertions:
Verdict: PASS | FAIL | BLOCKED
Evidence directory:
Cleanup performed:
```

## 8. Delegating to subagents

Use this execution graph:

```text
Coordinator
  ├─ A: L0 local suite                         (read-only)
  ├─ B: L1 environment + Map + check smoke     (read-only remote)
  └─ C: fixture reset + L2 run                 (exclusive writer)
         ├─ D1: GitHub evidence verifier       (read-only, after C stops)
         ├─ D2: Git history verifier           (read-only, after C stops)
         └─ D3: Run State/process verifier     (read-only, after C stops)
Coordinator aggregates A/B/C/D1/D2/D3
```

Give every subagent only one completion criterion. Example assignment:

> Validate the Git history channel for run `<run-id>` using §6.4. Do not mutate GitHub, the target branch, Norn home, or Herdr panes. Return PASS, FAIL, or BLOCKED plus the exact commands, output paths, target tip, commit list, parent shape, committer identity, and completion ancestry result.

The coordinator alone:

- grants and revokes fixture ownership;
- approves comment deletion and branch reset;
- decides whether a recoverable run is re-invoked;
- assigns L3 injection points;
- aggregates verdicts.

A release validation passes only when required L0–L2 items pass, no verifier disagrees with the writer's outcome, and every BLOCKED item is explicitly accepted as residual risk. Warnings, retained workspaces, duplicate records, or live process groups must be explained; silence is not acceptance.

## 9. Cleanup

After evidence capture:

1. Stop or archive run-owned live tabs; a run's own tabs are closed by Norn as each invocation settles, so anything left behind should be treated as a defect first, then closed after logs are retained.
2. Keep the unique backup branch until the report is accepted.
3. Record whether the fixture is intentionally left in delivered state or restored.
4. Remove only the isolated `PI_CODING_AGENT_DIR` and checkout created for this run.
5. Never delete Run State while a shared-write outcome is ambiguous.

The validation report should cite the backup ref, final target SHA, run ID, initial/final Map revisions, completion SHA, and evidence directory.