# Norn

> Weave the graph. Prove the outcome.

Norn is a deterministic runner for GitHub Task Maps. It works on currently eligible Tickets in parallel, runs delegated Worker and Reviewer agents in visible Herdr panes, binds tests and independent review to exact Git trees, and ships reviewed changes serially as one canonical integration commit per Ticket — a zero-delta change ships no new commit. It closes a Ticket only after writing its delivery record and verifying that the tested, reviewed commit is reachable from the remote target branch; it closes the Map only after a verified post-close completion record.

Norn is designed as a Pi package whose extension exposes one `/norn` command with five subcommands:

```text
/norn init
/norn check <github-task-map-issue-url>
/norn run <github-task-map-issue-url>
/norn status <github-task-map-issue-url>
/norn abort <github-task-map-issue-url>
```

Per-repository configuration and runtime state live under `$PI_CODING_AGENT_DIR/norn` (default `~/.pi/agent/norn`), not inside the target repository. Distinct Task Maps in one repository may Work concurrently with a shared repository-wide capacity; Ship remains serial per target branch. An active Map may append new Tickets through a Compatible Map Extension, provided no existing specification or blocker set changes.

The design deliberately starts with one concrete runner rather than a generic workflow framework. The project is currently in the design phase.

- [Design](docs/design.md)
- [Domain language](CONTEXT.md)

Initial private validation fixture (authenticated access required): [`iefnaf/taskflow-dag-demo#6`](https://github.com/iefnaf/taskflow-dag-demo/issues/6).
