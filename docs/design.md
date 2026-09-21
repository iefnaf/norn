# Norn Design

**Status:** Draft

**Tagline:** Weave the graph. Prove the outcome.

## 1. Purpose

Norn advances features represented by GitHub Task Maps. It works on currently eligible Tickets in parallel across active maps and ships reviewed changes serially to each target branch. It closes a Ticket only after verifying that a commit with the exact tested and reviewed tree is reachable from the remote target branch.

The design priorities are:

1. **Evidence** — tests and reviews bind to exact Git trees; agent claims alone are not evidence.
2. **Determinism** — code, not prompts, controls scheduling, retries, and side effects.
3. **Recoverability** — a process restart can safely continue a partially completed shipment.
4. **Visibility** — delegated agents run in Herdr panes the operator can inspect and steer.
5. **Simplicity** — prefer one concrete runner over a speculative framework.

## 2. Operator interface

### 2.1 Product shape

Norn is delivered as a Pi package. Its Pi extension registers one `/norn` command with subcommands and calls the Norn runner directly. The current Pi agent does not interpret an orchestration prompt or decide scheduling, retries, or side effects.

The extension renders structured runner events in the operator's current Pi pane. Worker and Reviewer Pi processes run in visible Herdr panes that the operator can inspect and steer.

### 2.2 Invocation context

The operator starts an interactive Pi session from a directory inside the target Git repository. Norn resolves the repository root from that working directory.

`/norn init` operates on the current repository. Commands that address a Task Map accept a full GitHub issue URL of the form `https://<github-host>/<owner>/<repository>/issues/<number>`. Issue-number shorthand such as `#123` is not accepted. Before any shared write, Norn resolves the URL to stable repository and issue IDs and verifies that its repository matches the local repository.

Norn stores operator configuration and runtime state under **Norn home**, `<pi-agent-dir>/norn`. `<pi-agent-dir>` is `PI_CODING_AGENT_DIR` when set and otherwise defaults to `~/.pi/agent`, so the default Norn home is `~/.pi/agent/norn`.

```text
<norn-home>/
└── repositories/
    └── <encoded-github-host>/
        └── <encoded-repository-id>/
            ├── metadata.json
            ├── config.json
            ├── locks/
            ├── maps/
            │   └── <encoded-issue-id>/
            │       └── run-state.json
            └── runs/
                └── <run-id>/
                    ├── completions/
                    └── workspaces/
```

The stable GitHub repository ID, rather than an owner/name pair or local checkout path, keys repository state. `metadata.json` retains the current human-readable repository identity. The repository directory above is called **repository home** in the rest of this document.

`config.json` contains no secrets and no Task Map URL. It is local operator state, is not version-controlled, and is shared by local checkouts that resolve to the same GitHub repository ID. Multiple Task Maps in that repository use it. Norn creates no configuration, state, lock, completion, or workspace files inside the target repository's working tree.

### 2.3 Commands

Norn exposes five subcommands:

```text
/norn init
/norn check <map-url>
/norn run <map-url>
/norn status <map-url>
/norn abort <map-url>
```

**`init`** runs a deterministic setup flow for the current repository. It resolves the stable GitHub repository ID, inspects repository metadata, obtains explicit operator choices for commands and exact Worker and Reviewer models, resolves the default target branch and trusted GitHub actor, and writes `metadata.json` and `config.json` under repository home. If multiple GitHub remotes are plausible, the operator must select one explicitly. Init does not ask an LLM to invent configuration, does not create or edit a Task Map, and does not write inside the target repository's working tree. If `config.json` already exists, Norn shows the proposed change and requires confirmation before replacing it. Init returns `blocked(config-in-use)` rather than replacing shared configuration while any run in the repository remains `running`.

**`check`** runs the same preflight used by `run`. It validates the local repository, repository-home configuration, GitHub identity and permissions, target branch, Task Map contract, topology, model availability, and existing delivery evidence. Against other active runs in the repository, it also verifies that no second live coordinator owns this map, any existing state for this map is resumable, member Tickets do not overlap, and `configRevision` and Norn version are compatible. It may read and fetch local or remote facts, but it does not create Run State, launch agents, create run branches, push, write GitHub comments, or close issues. It reports all independently discoverable findings rather than stopping after the first one.

**`run`** performs preflight and then creates or resumes one run for the complete Task Map. It remains attached in the foreground, renders structured events, and normally returns a terminal `RunReport`. A run repeatedly executes Waves until the map completes, trustworthy facts block further progress, or unavailable or ambiguous infrastructure facts produce an error. If an error follows a confirmed or unknown shared write and cannot be reconciled in that invocation, `run` instead returns a recoverable error: Run State remains `running`, no later Ship begins, and the next compatible invocation resumes the same run under §13.3 or §13.4.

**`status`** reads the local Run State and ownership information for the map. It reports the run ID, lifecycle state, accepted Map revision lineage, current Wave, Ticket states, any in-progress Ship or Map completion, retained workspace, and latest terminal report. It neither resumes nor mutates the run and does not present cached local state as current remote truth.

**`abort`** explicitly ends a run that the operator does not want Norn to resume. It requires confirmation of the exact run ID, stops or reconciles run-owned processes, and records `aborted` without deleting Run State. It never rolls back a pushed commit or removes remote evidence. If a possibly successful shared write cannot be reconciled, abort returns `error` and leaves the run recoverable; a new run cannot start from ambiguous state. A handled operator interrupt uses the same abort protocol.

Invoking `/norn` without a subcommand displays this command summary and performs no reads or writes beyond those required to load the extension.

### 2.4 Normal usage

Initial repository setup and an explicit preflight are:

```text
cd <repository>
pi
/norn init
/norn check https://github.com/owner/repository/issues/123
/norn run https://github.com/owner/repository/issues/123
```

The explicit `check` is optional because `run` always executes the same preflight. Once repository-home configuration exists, normal use is one command:

```text
/norn run https://github.com/owner/repository/issues/123
```

Each `run` remains attached to its own foreground Pi session. To work multiple Task Maps concurrently, the operator starts one `run` per map in separate Pi sessions. Their Work shares the repository-wide concurrency limit, while their Ship operations share the target lock.

### 2.5 Resume and abort

When Run State remains `running` because the coordinator exited unexpectedly or `run` returned a recoverable shared-write error, invoking `run` again with the same `configRevision` and Norn version resumes the same run ID and persisted checkpoint. Resume reloads the Map and may adopt a Compatible Map Extension under §7.4; an incompatible change ends the recovered run as blocked. No separate `resume` or `retry` command exists.

After an explicit abort, the next `run` creates a new run ID with an empty parked set and plans from current trustworthy facts. It retains valid Completed Tickets established by remote Delivery Records, but never reuses the aborted run's unshipped Work results, local test or review evidence, branches, or workspaces. A commit pushed without a Delivery Record remains on the target branch; an open Ticket can receive credit only through fresh Work, including a zero-delta test and review when appropriate.

## 3. Scope and trust model

Norn is a local automation tool. Each run is initiated by one trusted operator and manages one Task Map in one repository. The same operator may run multiple distinct Task Maps concurrently in that repository from separate local Pi sessions. Repository code, configured commands, Pi processes, and their child processes execute with the operator's local permissions.

For host security, Norn trusts the operator, the installed Norn package, and Norn-home configuration. It assumes repository contents, Task Map and Ticket text, configured commands, and delegated agents are non-malicious. Anyone who can change those inputs is therefore inside the host-security trust boundary. In particular, Norn does not contain the effects of prompt injection from hostile issue text or repository content.

For delivery correctness, non-malicious does not mean correct. Terminal prose and unbound agent claims are untrusted inputs. The coordinator accepts a Worker or Reviewer result only after verifying the protocol-required machine-checkable state and evidence bindings. A review verdict remains an attestation by the configured Reviewer; Norn verifies what tree and specification it judged, not that its semantic judgment is infallible.

Norn uses these guardrails:

- keep configuration and runtime state in Norn home rather than loading an execution-config file from the target working tree;
- use run-qualified workspaces and branches;
- omit coordinator-provided GitHub tokens and push credentials from child-process environments;
- expose no write-capable Pi tools to reviewers;
- verify the run-owned workspace, Git tree, and branch before accepting evidence;
- perform GitHub writes and target pushes only in coordinator code paths.

These measures reduce accidental interference and the impact of ordinary mistakes. They are policy and capability guardrails, not an operating-system security boundary. Child processes run with the operator's permissions and may still read or modify Norn home and other operator files, use credential helpers or an SSH agent, and reach the network. Running untrusted repository code, issue text, commands, or agents requires external isolation such as a container or VM and is unsupported.

From successful preflight until terminal state, Norn freezes the Map specification and every already accepted Ticket specification and blocker set. It does support a Compatible Map Extension: new direct member Tickets may be appended when no existing membership, specification, or blocker set changes. Norn adopts such extensions deterministically under §7.4 and schedules the added Tickets in later Waves.

Norn rechecks the Map at each Wave barrier and immediately before and after every push. An incompatible change detected before a push prevents stale Work from shipping. If detected after a push, it may leave a commit on the target branch without a Delivery Record, but Norn must not close a Ticket against stale facts. Ordinary target-branch advancement remains supported through reconciliation, tests, and review.

## 4. Non-goals

V1 does not provide:

- a generic workflow runtime;
- plugin or pattern registration;
- hidden in-process agents;
- prompt-driven scheduling;
- hostile-code sandboxing or prompt-injection containment;
- pull-request or stacked-branch orchestration;
- multi-repository Task Maps;
- arbitrary or non-monotonic topology editing during a run;
- automatic creation or attachment of Tickets from agent output;
- distributed coordinators or remote leases;
- an unattended daemon;
- Slack, email, or webhook notification plugins;
- a Skill-driven execution path;
- a standalone `norn` CLI.

The Pi extension is the sole operator adapter. It invokes the runner directly and renders its structured events.

## 5. Domain language

The canonical vocabulary is maintained in [`CONTEXT.md`](../CONTEXT.md).

```text
Ticket
  │ Work
  ▼
Shippable Change
  │ Ship
  ▼
Completed Ticket
```

A **Wave** runs Work concurrently for every currently eligible Ticket from one map and target snapshot. After a barrier, Norn ships successful changes serially in issue-number order.

## 6. System shape

```text
Operator
  │ /norn init | check | run | status | abort
  ▼
Pi extension — thin operator adapter
  │ typed command input, interaction, events, and outcome
  ▼
Norn runner module
  │ init repository
  │ check map
  │ run: preflight → Work Waves → serial Ship → map completion
  │ read status
  │ abort run
  │
  ├── GitHub gateway
  ├── Git repository
  ├── Visible agent runner
  ├── Command runner
  └── Local control store
```

The Norn runner is one deep module. Its external interface consists of the five operations corresponding to the `/norn` subcommands. Every operation returns a typed outcome and emits structured events. The Pi extension is the sole production adapter at this external seam: it parses command syntax, presents typed choices and confirmations, renders events, and returns operator responses. It does not own scheduling, retry, evidence, or side-effect policy.

`run` is the deepest path through the module. `check` executes the same preflight without creating run-owned resources or shared writes. `status` and `abort` operate through the same persisted state and ownership rules used by recovery. There is no separate generic workflow runtime or `TicketPattern` seam.

Each command invocation has its own runner instance. Distinct Task Map runs in the same repository do not communicate directly or share in-process state; their production adapters coordinate through repository home and the remote target. This permits concurrent Work while the shared target lock keeps Ship serial.

The five lower seams isolate external effects. Each has one built-in production adapter and one or more deterministic test adapters, and each returns typed outcomes rather than terminal prose:

- **GitHub gateway** — resolve stable repository and issue identities; load Task Maps, Ticket state, topology, timelines, and evidence; write evidence records; close and reopen issues.
- **Git repository** — identify the local repository; create and inspect workspaces, commits, and trees; reconcile candidates; fetch and push without force.
- **Visible agent runner** — launch Worker and Reviewer Pi processes in Herdr, settle their complete process groups, and return validated completion sidecars.
- **Command runner** — execute configured argument arrays with explicit working directories, environments, timeouts, process-group termination, and captured output.
- **Local control store** — load repository metadata and configuration; atomically persist Run State; enforce map, repository, and target locks; account for Work slots and active process reservations.

These seams are not runtime registries. Package bootstrap constructs the built-in production adapters directly, while tests replace them at the same interfaces. Pure rules such as normalizing and validating Task Maps, hashing revisions, computing frontiers, validating evidence, and ordering a run's Ship queue remain internal implementation functions. They are tested through the runner interface and are not promoted to seams merely for test convenience.

## 7. Task Map contract

A Task Map contract has three authoritative inputs: the map issue's title and body declare shared intent, each direct member's title and body declare Ticket-specific intent, and GitHub-native sub-issue and dependency relationships declare topology. Markdown lists, tables, checkboxes, and prose never define membership, dependencies, priority, or execution order.

### 7.1 Map specification

Norn does not discover or identify Task Maps from issue-body syntax. The issue explicitly addressed by `<map-url>` is the candidate Map root, and Norn accepts it as a Task Map when its native topology satisfies §7.2.

The Map title and body are an unstructured shared specification. They may use arbitrary GitHub Flavored Markdown and require no marker, headings, template, or non-empty body. A null body is the empty string. Norn supplies the normalized title and body to every Worker and Reviewer and binds them through `mapRevision`.

The body may describe the feature goal, shared constraints, acceptance criteria, or other context. Those statements guide Work and review but do not create graph edges. Only native GitHub relationships define topology.

### 7.2 Native topology

GitHub-native direct relationships are authoritative:

- membership is the map issue's complete direct `subIssues` set;
- a direct edge `A → B` means member B is natively `blockedBy` member A.

Sub-issue display order is not priority or scheduling input. Norn follows every pagination cursor and uses immutable IDs for identity, membership, and graph equality rather than title, URL, or API result order. Issue number remains a display locator and the explicit per-run Ship sort key; it is not identity.

A valid topology satisfies all of these rules:

1. The map has at least one direct member.
2. The map is not itself a sub-issue of another issue.
3. The map has no native blockers of its own.
4. Every member has a unique immutable issue ID, differs from the map issue, and currently belongs to the map's repository.
5. The graph is flat: a member has no sub-issues.
6. This map is each member's only parent issue.
7. Every direct `blockedBy` issue of a member is also a direct member of this map.
8. No member blocks itself, and the resulting dependency graph is acyclic.

Cross-repository members, external blockers, and nested Task Maps are rejected by this schema. A generated Markdown table may report the graph but never becomes another topology source.

Contract validity is independent of Run Config and local process ownership. Preflight separately verifies repository access, target-branch existence, model availability, map-lock ownership, compatible active runs, and disjoint active Ticket sets as specified elsewhere in this document.

### 7.3 Snapshot and revision identity

References carry both immutable identity and mutable display locators:

```ts
type StableIssueRef<Role extends 'map' | 'ticket'> = {
  role: Role
  githubHost: string
  repositoryId: string
  issueId: string
  number: number
  url: string
}

type MapRef = StableIssueRef<'map'>
type TicketRef = StableIssueRef<'ticket'>

type TaskMapSnapshot = {
  ref: MapRef
  title: string
  body: string
  state: 'OPEN' | 'CLOSED'
  mapRevision: string
  tickets: Array<{
    ref: TicketRef
    title: string
    body: string
    state: 'OPEN' | 'CLOSED'
    blockedBy: TicketRef[]
    ticketRevision: string
  }>
}
```

The role tag prevents Map and Ticket references from being mixed accidentally; it is not part of identity. Reference equality uses canonical `githubHost`, `repositoryId`, and `issueId`. The host is the issue URL's lowercase ASCII host with the default HTTPS port omitted; `repositoryId` and `issueId` are opaque GitHub node-ID strings preserved exactly as returned. Issue numbers and URLs are locators for commands and reports; repository renames or issue transfers cannot silently change identity.

Norn computes `ticketRevision` first from this logical payload:

```ts
type TicketRevisionPayload = {
  schema: 'norn-ticket-revision:v1'
  githubHost: string
  repositoryId: string
  ticketIssueId: string
  title: string
  body: string
}
```

It then computes `mapRevision` from this logical payload:

```ts
type MapRevisionPayload = {
  schema: 'norn-map-revision:v1'
  githubHost: string
  repositoryId: string
  mapIssueId: string
  title: string
  body: string
  members: Array<{
    ticketIssueId: string
    ticketRevision: string
  }>
  dependencies: Array<{
    blockerIssueId: string
    blockedIssueId: string
  }>
}
```

Before hashing, Norn normalizes CRLF and lone CR to LF, normalizes text to Unicode NFC, and removes only leading and trailing spaces, tabs, and LF characters from each complete revision text field. Interior Markdown bytes remain significant. A null GitHub issue body becomes the empty string. These normalized values populate Map title, Map body, Ticket title, and Ticket body in `TaskMapSnapshot` and `EffectiveTicketSpec`; agents never receive a different raw representation under the same revision. Members are sorted by `ticketIssueId`; dependencies are sorted by `blockerIssueId` and then `blockedIssueId`.

The normalized payload is encoded as RFC 8785 JSON Canonicalization Scheme UTF-8 bytes and hashed with SHA-256. Revisions are written as `sha256:<lowercase-hex>`.

Because Map title and body and every member's `ticketRevision` enter `mapRevision`, changing any Map or Ticket specification changes the whole map revision. Adding a member or dependency also creates a new revision. Issue state, issue number, URL, owner/name, labels, comments, assignees, reactions, timestamps, native completion percentage, and relationship display order do not enter either revision. They are display metadata or dynamic facts and are re-read when their current value matters.

A `mapRevision` identifies one stable Map snapshot, not an entire run. One run may accept a lineage of revisions when every transition is a Compatible Map Extension under §7.4.

Norn computes revisions only for snapshots that satisfy the specification and topology rules above. If a previously valid Map becomes structurally invalid, the change is incompatible.

GitHub does not provide a transactional read across all these issues and relationships. Norn performs at most three complete normalized loads and accepts a snapshot when two adjacent loads produce the same `mapRevision` and the same map and Ticket states. An incomplete page or failed read is an error; if no adjacent pair matches, the result is `blocked(changed-input)`.

### 7.4 Compatible Map Extensions

Successful preflight persists the initial accepted Map revision and its complete `MapRevisionPayload`. Existing accepted facts are frozen, but the Map may grow monotonically.

A current snapshot is a **Compatible Map Extension** of the latest accepted snapshot only when all of these conditions hold:

1. Map identity, title, and body are unchanged.
2. Every previously accepted member is still a direct member.
3. Every previously accepted member has the same `ticketRevision`.
4. Every previously accepted member has exactly the same complete `blockedBy` ID set.
5. The current complete snapshot still satisfies §7.2.

These rules mean every added dependency edge has a newly added Ticket as its blocked endpoint. A new Ticket may have no blockers, may depend on existing Tickets, or may depend on other new Tickets; it cannot become a new blocker of an existing Ticket.

For previously accepted Ticket A and newly added Tickets C and D:

| Change | Classification |
| --- | --- |
| add C with no blockers | compatible |
| add `A → C` | compatible |
| add `C → D` with C and D together | compatible |
| add `C → A` | incompatible: A gains a blocker |
| edit A or remove one of A's blockers | incompatible |
| remove an accepted member | incompatible |

Workers and Reviewers may report that more work is needed, but Norn never turns agent prose directly into a GitHub write. The trusted operator creates and fully specifies the Ticket and attaches it through GitHub; Norn then observes and classifies the resulting extension.

Before adopting an extension, Norn applies normal per-member preflight to every added Ticket, including stable reads, Delivery Record validation, and active-run ownership. A blocked added-Ticket preflight prevents adoption and is treated as an incompatible Map change. An errored preflight also prevents adoption and returns `error`; neither outcome permits another Ship. While holding the repository control lock, it then rechecks active ownership, atomically claims the added Ticket IDs, and appends the new revision and payload to Run State before scheduling or shipping against it. Once adopted, an added Ticket becomes an existing member and is frozen by the same rules, so operators should finish its title, body, and dependencies before attaching it to the Map.

At every Wave boundary and immediately before and after each push, Norn classifies the current snapshot against the latest accepted snapshot:

- an identical revision continues normally;
- a Compatible Map Extension is adopted without invalidating existing Work, Shippable Changes, or Completed Tickets, and its added Tickets enter frontier computation in the next Wave;
- an incompatible change before a push invalidates all remaining unshipped results and ends the run with `blocked(changed-input)`;
- an incompatible change observed after a push prevents the Delivery Record and Ticket close, records the partial shipment locally, and ends the run with `blocked(changed-input)`.

Evidence remains bound to the accepted `mapRevision` under which it was produced. Ship may use that evidence after later compatible extensions because Map specification, Ticket specification, and all blockers of the shipped Ticket are unchanged. The Delivery Record retains the historical revision.

Issue-state changes do not alter revisions. Run preflight requires the Task Map to be OPEN, and it must remain OPEN until Norn closes it. The only exception is recovery of the same running run from a persisted map-completion checkpoint: §13.4 must reconcile the close before ordinary preflight classifies the CLOSED Map. Any other unexpected map closure blocks the run. Current Ticket state and Delivery Records are independently revalidated wherever eligibility, Ship, or completion depends on them.

Any Compatible Map Extension observed during Map completion invalidates that completion attempt. Norn adopts it, returns to Wave planning when an added Ticket is not already a valid Completed Ticket, and eventually performs a fresh completion check against the latest revision.

A Completed Ticket whose current `ticketRevision` differs from its Delivery Record is integrity-blocked until the operator restores the recorded specification or reopens it for fresh Work. An extension first observed after the run has reached terminal state belongs to a new run; if the Map was already closed, the operator must reopen it before that run. Ordinary target-branch advancement does not change `mapRevision` and follows the reconciliation rules in §11.

## 8. Run Config

`/norn init` writes the user-facing execution choices to `<repository-home>/config.json`; that file is the only configuration input. Before `check` or `run`, the runner loads it through the Local control store, validates it, and expands all defaults into one resolved Run Config document:

```json
{
  "schema": "norn-run:v1",
  "targetBranch": "main",
  "setup": [
    { "argv": ["npm", "ci"], "timeoutMs": 180000 }
  ],
  "tests": [
    { "argv": ["npm", "test"], "timeoutMs": 120000 }
  ],
  "maxWorkRounds": 3,
  "maxPushRetries": 2,
  "concurrency": 4,
  "worker": {
    "model": "provider-a/model-x",
    "thinking": "medium",
    "timeoutMs": 3600000
  },
  "reviewer": {
    "model": "provider-b/model-y",
    "thinking": "high",
    "timeoutMs": 1800000
  },
  "trustedEvidenceAuthorIds": ["github-node-id"]
}
```

Validation, default expansion, and hashing are internal runner functions (§6). The Pi extension presents typed choices during `init`, supplies resolved secrets at invocation, and renders blocked outcomes; it never interprets configuration.

Required fields have no default; everything else expands from a fixed constant of the schema:

| Field | Default | Constraint |
| --- | --- | --- |
| `targetBranch` | — (required) | receives direct non-force pushes of integration commits — no PR path in v1, and a branch policy that rejects direct pushes is run-scoped `blocked(push-rejected)` (§11.3); preflight verifies it exists |
| `setup` | `[]` | zero or more command entries |
| `tests` | — (required) | one or more command entries |
| `maxWorkRounds` | `3` | integer ≥ 1 |
| `maxPushRetries` | `2` | integer ≥ 0 |
| `concurrency` | `4` | integer ≥ 1 |
| `worker` | — (required) | agent role (below) |
| `reviewer` | — (required) | agent role; different provider family from `worker` |
| `trustedEvidenceAuthorIds` | — (required) | one or more opaque GitHub node IDs |

A command entry is `{ argv, timeoutMs }` with non-empty `argv` and `timeoutMs > 0`. An agent role is `{ model, thinking, timeoutMs }` where `timeoutMs > 0` is the wall-clock budget of one launched agent invocation.

Rules:

- models are exact provider/model IDs; v1 has no fallback list; preflight resolves each against the authenticated model catalog and blocks when it is unavailable;
- worker and reviewer must resolve to different provider families;
- commands are argument arrays; `argv[0]` is the executable; no shell, environment, or working directory is configurable — the Command runner supplies the active gate workspace as working directory and a coordinator-defined environment that excludes GitHub tokens and push credentials;
- secrets are supplied by the Pi extension at invocation and never enter `config.json` or the resolved document;
- the authenticated GitHub actor must be in `trustedEvidenceAuthorIds`; further entries keep remote evidence written by other trusted accounts valid (§14–15);
- `tests` must not be empty: §14–15's per-test checks are the machine gate on delivery and completion, and an empty list would make them vacuous;
- every default is a fixed constant; no default is derived from repository, remote, or environment state — such facts (for example the default branch) are captured explicitly by `/norn init`.

Expansion is deterministic: identical `config.json` content always produces the same resolved document and the same `configRevision`, independent of checkout, environment, or invocation time. The complete resolved document is not persisted; every invocation recomputes it. Run State stores `configRevision`, while remote evidence records also store the minimal sealed `EvidenceGateV1` projection needed to validate historical reviewer independence and test policy without depending on a later `config.json` (§14–15). An invalid file is `blocked(invalid-config)` before any run-owned resource is created. Consequently a hand edit of `config.json` while a run is active is not adopted by that run: on resume the recomputed revision no longer matches, and §13.2 refuses rather than mixing executors.

Setup commands run before tests in every clean workspace the runner creates — Work gates, Ship reconciliation, and map completion alike.

`concurrency` is a repository-wide capacity shared by Work across every active Task Map run in that repository; it is not multiplied per run (§16). The Local control store adapter atomically reserves Work slots under repository home. A reservation belongs to one recorded Work attempt and remains charged until its outcome is persisted and every child process group is known to have exited or been terminated; recovery reconciliation releases stale reservations only after establishing those facts. Because concurrent runs must share one `configRevision`, the slot registry always has exactly one authoritative capacity value.

All concurrent runs in one repository must use the same `configRevision` and Norn version. A new run with incompatible values is blocked, and `/norn init` cannot replace `config.json` until every existing run has reached `terminal` or `aborted`.

`configRevision` is SHA-256 over RFC 8785 canonical JSON of the resolved document, written `sha256:<lowercase-hex>` like every other revision (§7.3). The Pi extension calls the runner directly with typed command input; configuration crosses the seam only as the file the runner itself loads:

```ts
norn.run(mapUrl)
```

No pattern name, adapter name, notification list, naming policy, or executable callback appears in v1 configuration.

## 9. Outcome model

An outcome answers three independent questions: what Norn knows, how far a non-success propagates, and whether an externally visible shared write may have occurred. Code, not terminal prose, controls all three.

```ts
type OutcomeScope = 'operation' | 'ticket' | 'run'
type SharedWriteState = 'none' | 'confirmed' | 'unknown'

type Outcome<
  T,
  BlockCode extends string,
  ErrorCode extends string,
> =
  | { kind: 'ok'; value: T }
  | {
      kind: 'blocked'
      scope: OutcomeScope
      code: BlockCode
      reason: string
      sharedWrite: Exclude<SharedWriteState, 'unknown'>
      evidence: Evidence[]
    }
  | {
      kind: 'error'
      scope: OutcomeScope
      code: ErrorCode
      reason: string
      sharedWrite: SharedWriteState
      evidence: Evidence[]
    }
```

Each operation fixes `BlockCode` and `ErrorCode` to closed string-literal unions and defines its allowed evidence payloads. Production code never branches on `reason` or rendered error prose. Evidence is serializable, operation-specific machine data; terminal text and unbound agent claims are not evidence. An `ok` value contains any evidence required by that operation's protocol rather than duplicating it in a generic evidence array.

The `kind` has epistemic meaning:

- **ok** — the operation completed and its value was validated; one successful Work operation does not by itself mean the run passed;
- **blocked** — trustworthy facts establish that progress requires changed code, input, configuration, or an operator decision; its shared-write state is known, though it may describe a confirmed partial shipment;
- **error** — Norn cannot establish the facts required for a safe domain decision because an infrastructure, adapter, or protocol operation failed, or because a shared write remains ambiguous.

`sharedWrite` covers externally visible business writes such as target pushes and GitHub mutations; atomic local checkpoint persistence is not a business shared write:

- **none** — no shared write was attempted, or its absence was proved;
- **confirmed** — at least one shared write occurred and the exact resulting state is recorded; this does not imply that the whole operation completed;
- **unknown** — a write may have succeeded but its exact remote state is not proved. Only `error` may carry this value.

`scope` describes scheduler impact rather than the source of the problem:

- **operation** — the current top-level command ends without parking a Ticket or terminating an existing run; this covers `init`, `check`, `status`, and preflight before acquiring or resuming run ownership;
- **ticket** — the Ticket is parked for this run and independent branches continue; a ticket-scoped non-`ok` outcome must have `sharedWrite: 'none'`;
- **run** — the current invocation stops scheduling that Task Map and no later Ship begins; Run State either becomes terminal or remains `running` for recovery as defined below.

An isolated worker, test, reviewer, or agent-protocol failure is normally ticket-scoped. Failure of the Local control store or a held lock, or violation of a frozen Map invariant after the run starts, is run-scoped. Configuration and ownership failures discovered before acquiring or resuming run ownership are operation-scoped; violation of an already established shared invariant is run-scoped. Ship may return a ticket-scoped outcome only before a shared write. A Compatible Map Extension is normal continuation, not a non-`ok` outcome.

A run-scoped `blocked`, including one after a confirmed partial shipment, is terminal because all relevant facts are known. A run-scoped `error` with `sharedWrite: 'none'` is also terminal. If a run-scoped `error` follows a `confirmed` or `unknown` shared write and cannot be reconciled in the current invocation, it is a recoverable interruption: Norn persists the checkpoint, leaves Run State `running`, returns the error to the caller, and resumes the same run ID on the next compatible invocation (§13.3).

There is no `skipped` outcome. A Ticket that is no longer eligible is not scheduled; a zero-delta change that passes its gates is `ok`. The generic outcome type does not make a stored success replayable: an operation may reuse a stored `ok` only when its protocol defines an idempotency key and revalidates the required current facts. Shared writes always follow the Ship or Map-completion reconciliation protocol in §13.3–13.4.

`passed` and `aborted` are not additional outcome kinds. `passed` is the terminal `RunReport` label for a final `ok`; `aborted` is a persisted Run State lifecycle decision made by `/norn abort` or a handled coordinator interrupt. Interrupting a child agent invocation before settlement remains ticket-scoped `blocked(user-abort)` unless the coordinator itself is aborted.

## 10. Work

### 10.1 Input, attempt, and workspace

Work receives one immutable input captured during Wave planning:

```ts
type EffectiveTicketSpec = {
  mapTitle: string
  mapBody: string
  mapRevision: string
  ticketTitle: string
  ticketBody: string
  ticketRevision: string
}

type WorkInput = {
  ticket: TicketRef
  spec: EffectiveTicketSpec
  target: {
    branch: string
    baseSha: string
    baseTreeOid: string
  }
}

type WorkspaceRef =
  | {
      kind: 'ticket'
      repositoryId: string
      runId: string
      path: string
      branch: string
      workAttemptId: string
    }
  | {
      kind: 'map-completion'
      repositoryId: string
      runId: string
      path: string
      completionAttemptId: string
    }
```

`baseSha` is the fetched remote target commit captured for the Wave. Work never silently refreshes this input: Map movement while agents run is classified at the Wave barrier, while target movement is reconciled during Ship (§11–12).

A **Work attempt** is one ticket execution within one run. It owns one Work slot, one branch, and one workspace, and may contain up to `maxWorkRounds` **worker rounds**. Before creating a branch, workspace, or child process, the coordinator records a unique `workAttemptId` and reserves the slot under the repository control lock:

```text
branch:    norn/<run-id>/<ticket-number>/<work-attempt-id>
workspace: <repository-home>/runs/<run-id>/workspaces/<ticket-number>/<work-attempt-id>
```

The branch is created exactly at `baseSha`; Norn verifies that commit resolves to `baseTreeOid` and that the workspace belongs to the expected repository and object format. The same branch and workspace are reused across the attempt's rounds so a later worker can amend the current candidate in response to feedback. Each individual worker or reviewer process is instead an **agent invocation** with its own identity and completion sidecar (§17).

The Work slot remains charged until the coordinator has persisted the attempt outcome and every child process group launched by that attempt is known to have exited or been terminated. Branches and workspaces are run-qualified, contain only attempt-local data, and never contain Run State. A later run never reuses them.

### 10.2 Round gate

```text
record Work attempt and reserve one slot
    ↓
create branch and workspace at exact Wave base
    ↓
run initial setup; retain a clean non-pass as worker feedback
    ↓
repeat at most maxWorkRounds times:
    run one fresh visible worker invocation with accumulated feedback
        ↓
    settle it and verify the candidate branch, commit, tree, and cleanliness
        ↓
    run setup commands again at the candidate tree
        ↓
    run the complete configured test list
        ↓
    run one fresh independent read-only reviewer
        ↓
    on clean setup/test failure or reviewer iterate: add feedback and repeat
    on reviewer pass: verify again and seal Shippable Change in Run State
```

`maxWorkRounds` counts worker invocations, including the first. The coordinator increments and persists the attempt's round plus its agent launch intent before each worker process is created, so a crash cannot reset the budget. A later round starts from the previous round's clean candidate commit rather than resetting to `baseSha`. It receives the accumulated structured setup, test, and review feedback. Setup and tests are rerun against every new candidate; no test or review evidence from an earlier round enters the final `ShippableChange`.

Configured setup and test commands execute sequentially in Run Config order and stop at the first non-pass. A command execution is protocol-valid only when:

- its complete process group has exited, or has been terminated and settled after timeout, before repository inspection;
- `HEAD` still equals the commit expected for that phase;
- the Git tree OID is unchanged;
- there are no staged or unstaged tracked changes and no non-ignored untracked files.

A protocol-valid command passes only when it exits with code zero before timeout. A non-zero exit or a timeout whose process group was successfully terminated is structured feedback, not machine evidence. Initial-setup feedback is supplied to the first worker; candidate-setup or test feedback advances to the next worker round when one remains. Failure to start or settle a command, or any unexpected repository mutation, is a protocol error. Ignored dependency and cache directories may remain, but they are not part of evidence.

A typed worker handoff is either `candidate`, carrying claimed commit and tree OIDs, or `block`, carrying a closed machine code and operator-facing reason. Only the discriminant and code control orchestration.

After a worker invocation settles, Norn accepts a `candidate` only when:

- its valid typed handoff exists and the complete agent process group has exited;
- the workspace is on the attempt-owned branch and that branch ref equals `HEAD`;
- `HEAD` equals `baseSha` or is reachable from it through a linear, no-merge commit sequence;
- the handoff's commit and tree OIDs equal those read independently by Norn;
- the workspace satisfies the cleanliness rules above.

`HEAD == baseSha` is a valid zero-delta candidate; the worker need not create an empty commit. Worker intermediate commits may otherwise form any linear sequence because Ship replaces them with one canonical integration commit.

The reviewer receives the Effective Ticket Spec, exact base and candidate OIDs, the coordinator-generated base-to-candidate diff, the ordered successful `TestEvidence` list and captured test output, and the repository at the candidate tree. Its typed verdict is `pass`, `iterate`, or `block` and binds those inputs. Verdict enums control orchestration; findings and other prose are feedback only. The reviewer has no write-capable Pi tools, and Norn re-verifies the same branch, `HEAD`, tree, and cleanliness after it exits.

A protocol-valid setup or test non-pass and reviewer `iterate` advance to the next round. A typed worker block, reviewer `block`, specification contradiction, exhausted rounds, or child user interruption returns ticket-scoped `blocked` with `sharedWrite: 'none'`. Failure to launch or settle an agent, a malformed sidecar, or an attempt-local repository invariant violation returns ticket-scoped `error` with `sharedWrite: 'none'`. Failure of the Local control store, slot registry, or a held shared lock is run-scoped under §9. Every process group is settled before Norn fingerprints a final tree or returns the attempt outcome.

### 10.3 Tree-bound evidence

Git OIDs are stored with their object format, for example `sha1:<hex>` or `sha256:<hex>`.

```ts
type TestEvidence = {
  phase: 'work' | 'ship' | 'map-completion'
  testIndex: number
  argv: string[]
  timeoutMs: number
  baseSha: string
  treeOid: string
  exitCode: 0
  outputDigest: string
}

type ReviewEvidence = {
  phase: 'work' | 'ship'
  provider: string
  model: string
  family: string
  thinking: string
  verdict: 'pass'
  mapRevision: string
  ticketRevision: string
  baseSha: string
  treeOid: string
  testEvidenceDigest: string
}

type MapCompletionReviewEvidence = {
  phase: 'map-completion'
  provider: string
  model: string
  family: string
  thinking: string
  verdict: 'pass'
  mapRevision: string
  completionSha: string
  treeOid: string
  testEvidenceDigest: string
}

type ShippableChange = {
  ticket: TicketRef
  mapRevision: string
  ticketRevision: string
  baseSha: string
  candidateCommit: string
  candidateTreeOid: string
  workspace: WorkspaceRef
  tests: TestEvidence[]
  review: ReviewEvidence
}
```

A successful test list contains exactly one entry for every configured test, in configuration order. `testIndex` is zero-based and its `argv` and `timeoutMs` must equal the corresponding resolved Run Config entry. For `map-completion` evidence, `baseSha` equals `completionSha`; the common field means “commit against which this tree was gated” in that phase rather than a patch base. `outputDigest` is SHA-256 over the command runner's exact framed stdout/stderr bytes. `testEvidenceDigest` is SHA-256 over RFC 8785 canonical JSON of the ordered `TestEvidence` list supplied to the reviewer. Both are written as `sha256:<lowercase-hex>`.

Before sealing a `ShippableChange`, Norn verifies that its Ticket and revisions equal the Work input; its candidate commit and tree equal the clean owned branch; every test binds the same base and candidate tree; and the review binds the same revisions, base, tree, and `testEvidenceDigest`. All agent and command process groups must already be settled. Setup is an execution prerequisite, not Delivery Evidence.

Evidence binds the complete candidate tree and the base against which it was judged. Norn does not use a custom patch fingerprint or path manifest.

A zero-delta change is valid when `candidateTreeOid` equals the base tree OID. The reviewer then judges the assertion that the existing target already satisfies the open ticket. If the target later changes, that review cannot be reused.

Worker commit history is local execution state. It is never pushed directly.

## 11. Ship

Ship is serial for one target branch.

### 11.1 Preconditions

Immediately before constructing a final candidate, Norn re-reads:

- the current stable Map snapshot and the Task Map's OPEN state;
- the ticket's `ticketRevision` and OPEN state;
- membership and blocker relationships;
- valid Completed Ticket evidence for every blocker;
- the latest remote target SHA.

An identical Map revision continues directly. A Compatible Map Extension is persisted and adopted before Ship continues; the Shippable Change retains the historical revision under which it was gated. Any incompatible Map change or mismatch in the shipped Ticket's specification, membership, blockers, or state returns run-scoped `blocked(changed-input)` before a push. Its `sharedWrite` is `confirmed` if this run already shipped an earlier Ticket and otherwise `none`.

### 11.2 Final candidate

If the remote target still equals `baseSha`, the Work review remains valid because both its base and complete tree are unchanged.

If the target advanced, Norn replays the candidate onto the new target without resolving conflicts. Then it:

1. replaces the worker's commit sequence with one canonical integration commit whose parent is the latest target and whose tree is the reconciled final tree;
2. runs the configured setup commands and then the complete configured test list in a clean workspace;
3. verifies the commit, tree, and cleanliness again;
4. runs a fresh independent review bound to the new base, complete final tree, and ordered test evidence;
5. verifies the commit, tree, and cleanliness once more.

A replay conflict returns ticket-scoped `blocked(integration-conflict)` with `sharedWrite: 'none'`. A failed integration setup or test, or a non-pass review, returns ticket-scoped `blocked(ship-gate-failed)` with `sharedWrite: 'none'`. No push occurs in either case. Norn never reuses review merely because changed files appear unchanged. A fresh Ship review after a Compatible Map Extension receives the latest accepted `mapRevision`, so the final review and Delivery Record advance to that revision. When no fresh review is required, reused Work evidence retains its earlier historical revision.

If the target did not advance and the change is non-empty, Norn still replaces worker history with one canonical integration commit. Because its parent and tree equal the reviewed base and tree, the Work evidence remains applicable. Whenever the final tree equals the current target tree, including after replay onto an advanced target, Norn creates no empty commit and uses the current target SHA as `integratedSha`.

Only the canonical commit, or the existing target commit for a zero-delta shipment, is eligible for delivery. Norn generates canonical commit metadata from a fixed template that includes stable locators but never copies Worker messages or issue text and never contains GitHub auto-close keywords. Intermediate worker commits, messages, and deleted content never enter the target branch history.

### 11.3 Push and close order

```text
re-read stable Map, Ticket, and blocker facts
    ↓
classify and adopt any Compatible Map Extension
    ↓
atomically store exact shipping candidate, gate evidence, and Delivery Record
    ↓
push exact integration commit without force (unless zero-delta)
    ↓
re-read remote and verify integrated SHA, parent, and tree
    ↓
re-read Map, Ticket, and blocker facts
    ↓
write or reuse the Delivery Record comment
    ↓
re-read Ticket state and timeline; reject an intervening close/reopen
    ↓
close the still-open Ticket
    ↓
re-read stable Map, Ticket, blockers, closing event, and remote target
    ↓
validate the complete §14 predicate and persist Completed Ticket
    ↓
clean up workspace
```

The shared local target lock is held from final target read through remote verification. It serializes Ship across every active Task Map run targeting that repository and branch. For a zero-delta shipment, no unique new commit marks the gated state, so Norn instead holds the target lock through comment, close, successful post-close validation, and the atomic `completed` update; the target must still equal `integratedSha` at that validation. Immediately before persistence and push, Norn performs the stable Map re-read shown above. If it observes a Compatible Map Extension while holding the target lock, it releases that lock, adopts the extension under the repository control lock, reacquires the target lock, and re-reads both Map and target; target movement triggers the normal fresh gates. This loop continues until the stable Map snapshot equals the latest accepted revision while the target lock is held, or an outcome stops Ship. An incompatible change prevents the push. A non-force push is the remote optimistic-concurrency guard.

`maxPushRetries` is the number of additional attempts allowed after the initial push loses optimistic concurrency; its persisted counter is not reset by recovery. Before each push call, Norn increments and persists `pushAttempts`, so an invocation interrupted around the call conservatively consumes one attempt. Reconciliation against a new target atomically replaces the prepared candidate and sealed Delivery Record while carrying that counter forward. Push outcomes are typed:

- `pushed` — continue verification;
- `target-advanced` — fetch and repeat reconciliation, tests, and review while retry budget remains; exhaustion returns ticket-scoped `blocked(target-advanced)` with `sharedWrite: 'none'`;
- `rejected` — authentication or branch policy returns run-scoped `blocked(push-rejected)` and stops the shipping queue; `sharedWrite` is `confirmed` if this run already shipped an earlier Ticket and otherwise `none`;
- `unknown` — perform bounded stable fetches; if the exact integration commit has the recorded integration shape and is an ancestor of the fetched target, continue; if its absence is proved, follow the remaining retry budget; only a remote state that remains ambiguous returns a recoverable run-scoped `error` with `sharedWrite: 'unknown'`.

A Compatible Map Extension observed after the push is persisted and adopted before Norn writes the Delivery Record; it does not invalidate the shipped Ticket. For a zero-delta shipment, extension adoption between target verification and persisted completion uses the same lock-order dance: release the target lock, adopt under the repository control lock, reacquire the target lock, and require the target still to equal `integratedSha`. If it moved after the Ticket was closed, Norn reopens the Ticket and repeats fresh gates. If an incompatible Map or Ticket change is observed, Norn does not write delivery evidence or close the issue. It records the outcome and returns run-scoped `blocked(changed-input)`. For a non-zero change whose push was verified, `sharedWrite` is `confirmed`; for zero-delta it is `confirmed` only if this run had an earlier shared write and otherwise `none`. A later explicit run can perform a fresh zero-delta Work against the new specification. Norn does not attempt to remove the already-pushed commit.

Before issuing close, Norn inspects the timeline after the selected Delivery Record comment. If a close followed by a reopen occurred, that operator-visible state change stops this Ship instead of being silently overwritten. If the Ticket is already closed with no later reopen and the record predates that close, Norn skips the close call and proceeds to validation. A close response is not completion evidence by itself. After comment and close, Norn repeats a stable Map read, re-reads the Ticket, blockers, current closing event, and remote target, and evaluates every predicate in §14. A Compatible Map Extension is adopted before completion is persisted. If the post-close read finds stale specification, membership, blocker, chronology, or target facts that would have prevented this Ship, Norn reopens the Ticket if necessary. A confirmed repair ends the run as `blocked(changed-input)` with the partial shared writes recorded; an unknown close or reopen result is a recoverable run-scoped `error`. Only a successfully persisted post-close validation makes the Ticket a Completed Ticket. Later changes are handled by §14's normal Completed Ticket validation.

A cleanup failure is a warning and cannot undo a verified Completed Ticket.

## 12. Waves and map execution

```text
load and validate map
    ↓
validate all previously completed members
    ↓
compute frontier
    ↓
capture map and target snapshot
    ↓
parallel Work(frontier)
    ↓
barrier
    ↓
re-read Map; classify and adopt any compatible extension
    ↓
serial Ship(current Wave successes) by issue number
    ↓
reload facts and repeat
```

Barrier policy:

- if the Task Map is no longer OPEN or its change is incompatible, no remaining result from that Wave ships and the run returns `blocked(changed-input)`;
- a Compatible Map Extension is persisted before Ship; existing results remain valid and added Tickets are deferred to the next frontier computation;
- blocked and ticket-scoped error outcomes park their ticket for the current run;
- descendants of parked tickets remain waiting;
- independent branches continue;
- failure of the Local control store, map lock, or target lock is run-scoped; an explicit coordinator abort follows the abort protocol in §2.3, while an unexpected coordinator exit leaves recoverable `running` state;
- successful Work results are persisted before the barrier completes.

When no unparked frontier remains, Norn performs one final stable Map read and extension classification before returning. A Compatible Map Extension is adopted and frontier computation repeats; otherwise Norn returns a blocked report listing every parked Ticket and waiting descendant.

A later explicit run for the same map starts with a new run ID and an empty parked set, but only after that map's previous run has reached a terminal state or was explicitly aborted.

Waves belonging to different maps have independent barriers and may Work concurrently. Within each persisted Wave queue, successful changes retain issue-number Ship order. A Ticket appended by a Compatible Map Extension enters a later Wave and never retroactively reorders an existing queue. Ship from another map may interleave between those changes, but every Ship re-reads the shared target under the target lock and re-gates whenever it advanced.

## 13. Run state and recovery

### 13.1 One state document

V1 uses one versioned `RunState` document per active map, not a generic step journal. The following persisted types show the recovery-critical payload rather than leaving it implicit:

```ts
type AcceptedMapRevision = {
  revision: string
  payload: MapRevisionPayload
  extension?: {
    fromRevision: string
    addedTicketIssueIds: string[]
  }
}

type ProcessGroupCheckpoint = {
  id: string
  owner: 'worker' | 'reviewer' | 'command'
  phase: 'work' | 'ship' | 'map-completion'
  workspace: WorkspaceRef
  ticketIssueId?: string
  workAttemptId?: string
  adapterHandle: string
  state: 'launch-intent' | 'running' | 'settled'
}

type WorkAttemptCheckpoint = {
  workAttemptId: string
  input: WorkInput
  branch: string
  workspace: WorkspaceRef
  round: number
  slot: 'awaiting-reservation' | 'reserved' | 'released'
  processGroupIds: string[]
}

type WaveState = {
  number: number
  mapRevision: string
  target: { branch: string; baseSha: string; baseTreeOid: string }
  frontierTicketIssueIds: string[]
  shipQueueTicketIssueIds: string[]
  nextShipIndex: number
}

type ShipCheckpoint = {
  stage: 'prepared' | 'push-verified' | 'delivery-recorded' | 'ticket-closed'
  pushAttempts: number
  zeroDelta: boolean
  baseSha: string
  integratedSha: string
  treeOid: string
  tests: TestEvidence[]
  review: ReviewEvidence
  delivery: DeliveryRecordV1
}

type TicketRunState =
  | { phase: 'waiting'; wave?: number }
  | { phase: 'working'; wave: number; attempt: WorkAttemptCheckpoint }
  | {
      phase: 'parked'
      wave: number
      workspace?: WorkspaceRef
      outcome: {
        kind: 'blocked' | 'error'
        code: string
        reason: string
        evidence: Evidence[]
      }
    }
  | { phase: 'shippable'; wave: number; change: ShippableChange }
  | {
      phase: 'shipping'
      wave: number
      change: ShippableChange
      checkpoint: ShipCheckpoint
    }
  | {
      phase: 'completed'
      deliveryId: string
      integratedSha: string
      cleanupWorkspace?: WorkspaceRef
    }

type MapCompletionCheckpoint = {
  stage: 'gated' | 'map-closed' | 'recorded'
  completionAttemptId: string
  timelineAnchorEventId: string | null
  workspace: WorkspaceRef
  mapRevision: string
  completionSha: string
  treeOid: string
  gate: EvidenceGateV1
  tests: TestEvidence[]
  review: MapCompletionReviewEvidence
  closingEventId?: string
  record?: MapCompletionRecordV1
}

type RunReport = {
  label: 'passed' | 'blocked' | 'error'
  code?: string
  runId: string
  initialMapRevision: string
  finalMapRevision: string
  acceptedExtensions: Array<{
    revision: string
    addedTicketIssueIds: string[]
  }>
  tickets: Array<{
    ticket: TicketRef
    state: 'completed' | 'parked' | 'waiting'
    code?: string
  }>
  sharedWrite: 'none' | 'confirmed'
  completionSha?: string
  warnings: string[]
  retainedWorkspace?: WorkspaceRef
}

type RunState = {
  schema: 'norn-run-state:v1'
  runId: string
  map: MapRef
  acceptedMapRevisions: AcceptedMapRevision[]
  configRevision: string
  nornVersion: string
  status: 'running' | 'terminal' | 'aborted'
  wave: number
  activeWave?: WaveState
  parkedTickets: TicketRef[]
  tickets: Record<string, TicketRunState>
  activeProcesses: ProcessGroupCheckpoint[]
  mapCompletion?: MapCompletionCheckpoint
  report?: RunReport
}
```

`TicketRunState` is a discriminated union; fields from one phase are not optional in another. The serialized `code: string` slots accept only members of the closed outcome-code unions for the recorded phase and `nornVersion`; an unknown code is a state-integrity error, not a new runtime branch. Ticket record keys are immutable Ticket issue IDs. `activeWave.shipQueueTicketIssueIds` is the exact persisted queue and therefore preserves issue-number order across restart and later Compatible Map Extensions. On load, `wave` must equal `activeWave.number` when a Wave exists, and `parkedTickets` must exactly match Tickets whose phase is `parked`; disagreement is a state-integrity error. A `ShipCheckpoint` contains the complete write-ahead intent before push; `zeroDelta` must agree with the persisted base, integrated commit, and trees. A `MapCompletionCheckpoint` contains a unique completion-attempt ID, a timeline anchor, the sealed evidence gate, and completed tests and review before Map close, and later gains the exact closing event and sealed record. Its map-completion workspace carries the same attempt ID. `timelineAnchorEventId` is the immutable node ID of the last fully paginated timeline item at the pre-close read, or `null` for an empty timeline; inability to relocate that anchor during recovery is an error rather than permission to guess. Checkpoint `stage` always means “last remotely confirmed stage”; recovery must still probe the next side effect because a process may have exited after the remote accepted it but before the following local update. A completed Ticket retains `cleanupWorkspace` until cleanup has succeeded or its failure has been persisted as a warning. A `passed` `RunReport` has no non-success code, requires `completionSha`, and has `sharedWrite: 'confirmed'` because Map closure is a shared write. `Blocked` and terminal `error` reports require a recognized code and have no completion SHA. A terminal `error` report always has `sharedWrite: 'none'`; errors after confirmed or unknown shared writes remain recoverable and do not create a terminal report.

Only the coordinator writes this document. `acceptedMapRevisions[0]` is the preflight snapshot; each later entry is a verified Compatible Map Extension, and the last entry is current. Added Ticket IDs are sorted. On load, Norn re-hashes every payload and verifies every recorded transition before trusting the lineage. The complete canonical payload is retained so recovery and Ship can prove compatibility for evidence created under an earlier revision. No recovery-critical queue, candidate, process-group identity, or shared-write intent exists only in memory.

Parallel workers return results to the coordinator, which serializes updates. Extension adoption, new Ticket state, and the accepted revision entry are committed in one Run State update. Each update writes a temporary file, flushes it, atomically renames it, and flushes the containing directory.

The document is stored at `<repository-home>/maps/<encoded-issue-id>/run-state.json`. Run-owned workspaces and completion sidecars live under `<repository-home>/runs/<run-id>/`. Status and the terminal `RunReport` summarize the initial and final Map revisions and the Ticket IDs added by each accepted extension. No Norn control file is stored in the target repository's working tree.

### 13.2 Lifecycle

- If state is `running`, the same `configRevision` and `nornVersion` resume the run ID, parked set, accepted Map lineage, exact Wave queue, and persisted retry counters.
- Resume first reconciles `activeProcesses`. It then reloads a stable Map snapshot. An identical snapshot continues; a Compatible Map Extension is appended atomically; an incompatible change settles active processes and terminates the run as blocked.
- A CLOSED Map with a pending `mapCompletion` checkpoint is routed to §13.4 before the ordinary OPEN-state preflight rule is applied. No other CLOSED Map is silently accepted.
- A config or Norn version mismatch refuses resume; it never mixes evidence produced by different executors.
- Before returning any terminal `RunReport` — `passed`, `blocked`, or `error` with `sharedWrite: 'none'` — Norn stores `status: terminal` and the report.
- If an error follows a confirmed or unknown shared write and cannot be reconciled in the current invocation, Norn persists the recovery checkpoint and returns without terminalizing; state remains `running`, no later Ship begins, and the next compatible `run` resumes the same run ID under §13.3 or §13.4.
- The next explicit invocation after a terminal run creates a new run ID and empty parked set.
- `/norn abort` records an explicit operator decision not to resume the run; state is never silently deleted.
- Abort first stops or reconciles every run-owned process and any possibly successful shared write. If reconciliation proves that Map completion already finalized, terminal `passed` takes precedence over abort. If remote state remains ambiguous, abort fails and leaves the run recoverable.
- The next invocation after an aborted run creates a new run ID and empty parked set. It does not reuse unshipped Work results or Work-attempt evidence from the aborted run.

Run-qualified branches and workspaces prevent an aborted Work attempt from colliding with a later run. Successful and obsolete workspaces are deleted. The latest blocked workspace may be retained for inspection and its path appears in the report; later runs never reuse it.

### 13.3 Ship recovery reconciliation

Before push, Ship stores the exact integration commit, tree, tests, review, intended Delivery Record, and current push-attempt count in `ShipCheckpoint`.

On resume, Norn first reconciles every recorded child process group belonging to a Work attempt or later gate. The Visible Agent Runner may reattach to a live agent invocation and wait for it; otherwise the owning adapter terminates and settles the complete process group. Norn neither inspects nor discards the workspace, and does not release its Work slot, before every recorded group is settled. A command or review result that was not atomically incorporated into a sealed `ShippableChange`, `ShipCheckpoint`, or `MapCompletionCheckpoint` is not reusable merely because a process exited or a sidecar exists; Norn reruns that gate from the last persisted input.

Map revalidation during recovery uses the same extension classifier as live Ship: an identical or compatible current snapshot may continue, while an incompatible change cannot reuse pending evidence.

Then:

1. Norn fetches the target and verifies the recorded integration shape: for non-zero delivery, `integratedSha` has exactly one parent equal to `baseSha` and its tree differs from the base tree; for zero-delta, `integratedSha == baseSha`. In both cases it has the recorded tree and is an ancestor of the fetched target. Merely finding the object in the object database is insufficient.
2. If the integration commit is absent, Ship may push only after revalidating all inputs and only while the persisted `1 + maxPushRetries` attempt budget remains. A remote probe does not consume budget; an actual push does. Proven absence with exhausted budget parks the Ticket as `blocked(target-advanced)` when the target moved, or `blocked(push-retries-exhausted)` otherwise, both with `sharedWrite: 'none'` for that Ticket.
3. If the integration commit is present, Ship revalidates Map, Ticket, and blocker facts, then writes or locates the exact sealed Delivery Record.
4. If that comment exists and the Ticket is OPEN, Ship validates the record and inspects all timeline events after the earliest trusted identical copy. It closes the Ticket only when no close-then-reopen sequence occurred; a detected reopen returns run-scoped `blocked(changed-input)` with `sharedWrite: 'confirmed'` rather than overwriting operator intent.
5. If the Ticket is CLOSED, Ship performs the full post-close validation from §11.3 and §14 before persisting `completed`; a pending zero-delta Ship requires the target still to equal `integratedSha`. A close with stale or invalid evidence follows the reopen repair path from §11.3.
6. Any remote state that cannot be classified after bounded reads returns a recoverable run-scoped `error`; recovery never guesses from a timeout or from the checkpoint stage alone.

The persisted push-attempt count survives process restart, so repeated recovery cannot create an unbounded retry loop.

If the entire local state directory is lost:

- a still-open Ticket may be worked again, including by a fresh zero-delta test and review;
- a closed Ticket without valid remote delivery evidence remains integrity-blocked.

Norn does not claim it can distinguish a lost prior push from an equivalent manual change when all local recovery state is gone. Fresh evidence, not reconstructed evidence, is required.

### 13.4 Map-completion recovery reconciliation

Before attempting to close a Map, Norn persists a `gated` `MapCompletionCheckpoint` containing the exact revision, target commit and tree, sealed evidence gate, tests, and completion review. This checkpoint is the only reason resume may inspect a CLOSED Map before ordinary preflight rejects it.

Recovery acquires the target lock and reconciles the checkpoint against a stable Map read, the remote target, the current closing event, and any matching completion comment:

1. If the Map is OPEN, revision and target still equal the checkpoint, and no close-then-reopen sequence occurred after `timelineAnchorEventId`, Norn may retry the close protocol in §15. A detected reopen discards the old gates and restarts full completion rather than silently reclosing. If revision or target moved, Norn also discards the stale gates, releases the target lock before taking any repository control lock, and then adopts, restarts, or blocks according to the ordinary rules.
2. If the Map is CLOSED, Norn binds it to the checkpoint only when the current closing event is the authenticated actor's first close after `timelineAnchorEventId` and no reopen follows it. It then completes the post-close reads. When revision and target still match, it seals or locates the `MapCompletionRecordV1` and validates it before terminalizing.
3. A valid current completion record makes the run passed even if the target advanced afterward in a descendant-only way; the record proves the post-close checkpoint completed at `completionSha`.
4. If the Map was closed against stale facts, or a completion record was written but the Map was subsequently reopened or revised, the record is historical. Norn reopens the Map when necessary, then releases the target lock before taking the repository control lock to adopt or replan.
5. An unknown close, comment, or reopen result is a recoverable run-scoped `error`. State remains `running`, and neither abort nor a new run may bypass that ambiguity.

A CLOSED Map with no matching local checkpoint follows normal preflight and is never retroactively stamped with a completion record.

## 14. Delivery evidence

Norn machine comments use one parsing envelope: RFC 8785 canonical JSON in the only fenced `json` block immediately following the exact marker `<!-- norn:record -->`. Human-readable prose may appear outside that envelope. Parsers ignore unmarked prose, reject a marked comment with a missing, malformed, or additional machine block, and follow every comment and timeline pagination cursor before deciding uniqueness or chronology.

Remote evidence seals the gate that applied when it was produced:

```ts
type EvidenceGateV1 = {
  worker: {
    provider: string
    model: string
    family: string
    thinking: string
  }
  reviewer: {
    provider: string
    model: string
    family: string
    thinking: string
  }
  tests: Array<{
    argv: string[]
    timeoutMs: number
  }>
}

type DeliveryRecordV1 = {
  schema: 'norn-delivery:v1'
  deliveryId: string
  run: {
    id: string
    configRevision: string
    nornVersion: string
  }
  gate: EvidenceGateV1
  map: {
    issueId: string
    revision: string
  }
  ticket: {
    issueId: string
    revision: string
  }
  target: {
    repositoryId: string
    branch: string
    baseSha: string
    integratedSha: string
    treeOid: string
  }
  review: ReviewEvidence
  tests: TestEvidence[]
  actorId: string
  recordedAt: string
}
```

`EvidenceGateV1` is derived from the resolved Run Config and authenticated model metadata. Its Worker and Reviewer families must differ, and `tests` must be non-empty. It contains no secrets. Historical evidence is validated against this sealed gate, not against a later reviewer or test configuration: changing models or tests affects future gates but does not rewrite existing records. Current Run Config still selects the target branch and trusted evidence authors, so changing either is an explicit policy change; changing unrelated settings does not retroactively invalidate delivery.

`recordedAt` is a UTC RFC 3339 timestamp with exactly three fractional-second digits, for example `2025-01-02T03:04:05.006Z`. Before the first comment write, Norn seals it and computes `deliveryId` as SHA-256 over RFC 8785 canonical JSON of the complete record except `deliveryId`. The sealed record is persisted in `ShipCheckpoint`; every replay reuses it verbatim.

Before writing, Norn parses marked comments and scans for the same `deliveryId`. A byte-identical canonical record is reused; duplicate identical records produce a warning, and close-window reconciliation uses the earliest trusted identical copy as its timeline anchor. The same ID with different canonical content is integrity-blocking. Distinct valid Delivery Records for the same current Ticket revision are also integrity-blocking rather than guessed away.

A member is a valid Completed Ticket only when:

1. the issue is CLOSED;
2. one unambiguous canonical `norn-delivery:v1` record is selected under the duplicate rules above, where byte-identical duplicate comments count as one record;
3. the record's Map and Ticket IDs match the current Map and member, `target.repositoryId` matches their repository, and `target.branch` equals the current Run Config target branch;
4. the comment author node ID equals `actorId` and is currently trusted by Run Config;
5. the GitHub timeline places the Delivery Record comment before the issue's current closing event;
6. the current `ticketRevision` equals the record's Ticket revision;
7. the gate is structurally valid, its Worker and Reviewer families differ, and the `pass` review has phase `work` or `ship`, exactly matches the gate's Reviewer, and binds the recorded Map revision, Ticket revision, base, tree, and digest of the ordered test evidence;
8. the ordered tests have the same phase as the review and contain exactly one successful entry for every sealed gate test at matching `testIndex`, `argv`, and `timeoutMs`, with no extras, all bound to the recorded base and delivered tree;
9. `deliveryId` recomputes exactly; for non-zero delivery, `integratedSha` has exactly one parent equal to `baseSha` and its tree differs from the base tree, while zero-delta requires `integratedSha == baseSha`; in both cases `integratedSha` has the recorded tree and is an ancestor of the fetched current target branch.

The `mapRevision`, `ticketRevision`, and gate recorded at delivery are historical facts. A later Map edit does not invalidate an already delivered Ticket unless that Ticket's own specification changed; final Map completion is judged again under the current Map revision. A later target advance also preserves completion while the recorded integration commit remains an ancestor.

A closed member without valid evidence blocks preflight. Norn never retroactively stamps evidence onto it. The operator must reopen it for fresh Work, remove a cancelled Ticket from the Map, or restore the missing facts.

An open member with a Delivery Record that satisfies every predicate above except CLOSED state and current-closing-event chronology is also blocked rather than silently worked again. The operator either recloses it or changes its specification before requesting new Work.

The record is an attestation by configured trusted GitHub actors, not a cryptographic transparency proof.

## 15. Map completion

After every member is a valid Completed Ticket, Norn:

1. allocates a unique `completionAttemptId` and reads `completionSha` from the remote target;
2. checks out exactly that commit in a clean run-owned map-completion workspace carrying that attempt ID;
3. runs the configured setup commands and then the complete configured test list, applying the same post-command commit, tree, and cleanliness checks used by Work and recording `baseSha = completionSha`;
4. runs a fresh read-only review of the complete normalized Task Map snapshot — Map title and body, member Ticket specifications, membership, and dependency topology — plus the ordered completion-test evidence against `completionSha`;
5. rechecks the commit, tree, and cleanliness after review;
6. acquires the target lock and re-reads a stable Map snapshot, Task Map state, every member's Completed Ticket evidence, and the remote target SHA;
7. blocks on a closed or incompatibly changed Map; adopts a Compatible Map Extension and returns to planning or restarts completion as appropriate; or restarts completion if only the target changed;
8. only when Map revision and target are unchanged, captures the current timeline head as `timelineAnchorEventId`, persists the `gated` `MapCompletionCheckpoint`, and closes the still-open Map;
9. while still holding the target lock, re-reads the stable Map snapshot, all member completion predicates, remote target, and current Map closing event;
10. only when those facts still match the checkpoint, seals and writes or reuses a `norn-map-completion:v1` record bound to that closing event;
11. re-reads the marked comment, stable Map snapshot, and remote target, then records terminal completion only when the record validates, the Map remains CLOSED at the checkpoint revision, and the current target still contains `completionSha`.

The completion comment is deliberately written after the close event: it is the remote finalization marker that recovery can distinguish from a close whose post-check never completed. GitHub permits comments on closed issues. The target lock is held from step 6 through step 11 for the unchanged case. For an earlier block or restart, Norn first releases it. An adopted extension invalidates the prior completion tests and review: if any added Ticket is not a valid Completed Ticket, execution returns to Wave planning; otherwise the complete completion check restarts against the new revision. This prevents another local Task Map from shipping between the final unchanged read and verified Map closure.

If step 9 detects a compatible extension, incompatible edit, reopened Map, invalid member completion, or any target movement before the record is written, Norn repairs the close. Step 11 likewise repairs a changed Map, invalid member completion, or loss of `completionSha` ancestry, but descendant-only target advancement after the record was written is allowed. Repair reopens the Map if necessary while still holding the target lock, then releases that lock before acquiring any repository control lock needed to adopt and replan, restart completion, or return blocked. A record from that repaired attempt is historical because its closing event is no longer current or its Map revision no longer matches. An unknown close, comment, or reopen outcome is a recoverable run-scoped `error`, never terminal success.

Completion evidence has an explicit schema:

```ts
type MapCompletionRecordV1 = {
  schema: 'norn-map-completion:v1'
  completionId: string
  run: {
    id: string
    completionAttemptId: string
    configRevision: string
    nornVersion: string
  }
  gate: EvidenceGateV1
  map: {
    issueId: string
    revision: string
    closingEventId: string
  }
  target: {
    repositoryId: string
    branch: string
    completionSha: string
    treeOid: string
  }
  review: MapCompletionReviewEvidence
  tests: TestEvidence[]
  actorId: string
  recordedAt: string
}
```

After the post-close read identifies `closingEventId`, Norn seals `recordedAt` in the §14 timestamp format and computes `completionId` as SHA-256 over RFC 8785 canonical JSON of the complete record except `completionId`. It stores the sealed record in `MapCompletionCheckpoint` before the first comment attempt. Comment parsing, identical replay, and conflicting-content handling use the envelope and rules from §14.

A record is current Map completion evidence only when:

1. the Map is CLOSED and the record names its current closing event;
2. the marked comment author and the named closing-event actor both equal `actorId`, that actor is currently trusted, and the GitHub timeline places the comment after the closing event;
3. the Map and repository IDs match, the current `mapRevision` equals the record revision, and the recorded branch equals the current Run Config target branch;
4. every current member remains a valid Completed Ticket under §14;
5. the gate is structurally valid, has different Worker and Reviewer families, and has a non-empty test list;
6. the `pass` completion review exactly matches the gate's Reviewer and binds the current Map revision, `completionSha`, tree, and digest of the ordered completion tests;
7. the ordered tests contain exactly one `map-completion` entry for every sealed gate test, with `baseSha = completionSha`, matching index, arguments, timeout, and tree, and no extras;
8. `completionId` recomputes exactly, `completionSha` has the recorded tree, and it is an ancestor of the fetched current target branch;
9. no conflicting valid record names the same current closing event.

The successful comment is evidence that Norn completed its post-close protocol, not merely that it intended to close the Map. The close followed by the validated completion record is the completion linearization protocol. Later descendant-only target advancement does not rewrite that history; reopening the Map or changing its revision requires a new completion check.

If completion setup, tests, or review do not pass, the run returns run-scoped `blocked(map-completion-gate-failed)`; `sharedWrite` is `confirmed` if this run already shipped any Ticket and otherwise `none`. The Map remains open with findings. The normal repair is to add a new direct child correction Ticket, or reopen and revise an existing Ticket. Previously delivered records remain historical and valid.

A Map with open Tickets but no eligible frontier returns a blocked report; it never claims completion. A Ship from another active Map that changes the target during completion verification is ordinary target advancement and causes the completion check to restart. Map-completion workspace cleanup occurs only after terminal state is persisted; failure is a warning and cannot undo valid completion.

## 16. Ownership and concurrency

One repository may have multiple local active runs, one for each distinct Task Map. Concurrent runs are supported only when they use the same repository home, `configRevision`, Norn version, and target branch, and their accepted member Ticket sets remain disjoint. Initial preflight and every Compatible Map Extension claim membership under the repository control lock.

Norn uses:

- one OS-backed map lock per Task Map, preventing duplicate active runs for the same map;
- one short-held repository control lock for atomic active-run registration, Compatible Map Extension Ticket claims, configuration replacement, and capacity accounting;
- one repository-wide persistent Work-slot registry with capacity `concurrency`;
- one OS-backed target lock per repository and branch, serializing Ship across maps;
- run-qualified ticket branches and workspaces;
- non-force push as the final remote optimistic-concurrency guard.

Lock and slot files live under `<repository-home>/locks/`. Norn never waits for the target lock while holding the repository control lock and releases the target lock before acquiring the control lock for extension adoption. OS-backed locks must be released automatically when the owning process exits and must not be inherited by child agents or commands.

Run State and the repository-wide slot registry are separate atomic documents, so slot acquisition uses a crash-safe handshake rather than claiming a multi-file transaction: persist an `awaiting-reservation` Work attempt; under the repository control lock reserve its unique ID; persist `reserved`; and only then launch a child. Recovery may release a registry entry with no matching recorded attempt only after proving that no associated process group exists, and may reacquire for an `awaiting-reservation` attempt before launch. A launch intent and stable adapter handle are persisted before process creation, so a crash cannot create an unidentifiable child. A reservation that does match a running run remains charged until that run's resume or abort reconciliation settles it; unrelated coordinators never reclaim it merely because its map lock disappeared.

Work-slot reservations are bound to those recorded Work-attempt and child-process-group identities. They remain counted across a coordinator crash until the attempt outcome is persisted and reconciliation proves that every child process group has exited or has been terminated. A crashed coordinator therefore leaves recoverable Run State without allowing orphaned Work to disappear from repository-wide capacity accounting.

Within one persisted Wave queue, successful changes Ship in issue-number order; Tickets appended later do not reorder already persisted queues. Across runs, there is no business ordering guarantee: a ready Ship proceeds when its coordinator acquires the target lock. This timing may determine which overlapping change ships first, but it cannot permit simultaneous pushes or reuse stale evidence. The later change reconciles against the new target, receives fresh gates when required, and returns blocked on conflict.

Concurrent coordinators on other machines are unsupported because local ownership, capacity, and target locks are not distributed. Their non-force pushes remain safe for Git history, but Norn makes no distributed ownership claim.

## 17. Agent settlement

For every worker or reviewer **agent invocation**, Norn creates a run-owned completion entry under `<repository-home>/runs/<run-id>/completions/`, outside the source workspace, and launches Pi with a small completion extension.

The extension:

- validates a typed worker handoff or reviewer verdict;
- binds it to the run, role, phase, relevant Map or Ticket, workspace, and Pi session IDs;
- for Work, additionally binds the `workAttemptId`, worker round, and immutable Work input;
- creates exactly one completion sidecar atomically;
- rejects conflicting second completions.

An agent invocation settles only when a valid sidecar exists and the complete Pi process group has exited. Process exit without a sidecar is a protocol error. Terminal prose never controls orchestration.

The sidecar is not business evidence. Norn independently verifies Git state, configured test results, review bindings, remote ancestry, and GitHub state before accepting an outcome.

User interruption before a valid sidecar is `blocked(user-abort)`. Agent timeout or malformed settlement is a ticket-scoped error for Work; Ship and map-completion reviewers use the scope of their enclosing operation. The adapter must terminate and settle the whole owned process group before Norn fingerprints the final Git tree.

## 18. Why this v1 is intentionally small

The following earlier ideas are deliberately absent:

- **Generic Paneflow runtime** — one orchestration policy has no reusable runtime yet.
- **Taskflow pattern layer and `TicketPattern` interface** — one pattern does not justify a registry or plug-in seam.
- **Patch fingerprint manifest** — full base and tree identity plus fresh review after target movement is simpler and stronger.
- **Worker commit preservation** — one canonical integration commit prevents unreviewed intermediate history from reaching the target.
- **Fine-grained topology revision** — topology is part of `mapRevision`.
- **Model fallback resolution** — one exact worker and reviewer model makes independence deterministic.
- **Notifier interface** — the Pi extension renders structured events; a second delivery channel can justify a seam later.
- **Generic append-only journal API** — one coordinator and one atomic Run State document are enough.
- **Remote shipping intent** — local state handles normal restart; complete state loss uses fresh attestation for open tickets.
- **Distributed lease** — outside the single-operator deployment model.
- **Automatic conflict resolution** — any changed final tree receives fresh tests and review; textual conflicts return blocked.

The deletion test for every remaining module is straightforward: removing any lower seam would spread external-effect logic and test setup back into the runner. Everything else stays an internal function until a second real use case appears.

## 19. Initial validation fixture

The initial private fixture is `iefnaf/taskflow-dag-demo#6`.

Its existing closed child issues predate Norn evidence and therefore cannot run as-is. Milestone zero is to create or reset a clean map, reopen the intended Tickets, and establish the intended native sub-issue and dependency relationships. Any Markdown graph may remain as explanatory prose, but Norn does not read it as topology.

No fixture mutation is part of this design document.
