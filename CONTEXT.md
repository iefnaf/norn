# Norn

Norn coordinates dependency maps of GitHub issues. It works independent tickets concurrently across active maps, ships reviewed trees serially to each target branch, and records remote evidence before closing anything.

## Language

**Norn**:
The concrete runner and Pi package. It exposes the `/norn` operator command and owns map loading, Waves, Work, Ship, recovery, and completion.
_Avoid_: Paneflow, Taskflow, workflow engine

**Task Map**:
The explicitly addressed root of a flat GitHub issue graph. Its title and body provide unstructured shared intent; its direct sub-issues are member Tickets, and GitHub-native dependencies connect them.
_Avoid_: Workflow, backlog, run plan

**Ticket**:
A bounded piece of work that is a direct member of one Task Map and may depend on other Tickets in that map.
_Avoid_: Job, node, task unit

**Map Revision**:
The content identity of one complete Task Map snapshot: Map title and body, every member Ticket specification, membership, and dependency topology. A run may accept multiple revisions through Compatible Map Extensions. Dynamic issue state and display metadata are not part of it.
_Avoid_: Run revision, target revision

**Compatible Map Extension**:
A monotonic addition of direct member Tickets that preserves the Map specification and every existing Ticket specification and blocker set. New Tickets may depend on existing or other new Tickets, but may not become blockers of existing Tickets.
_Avoid_: Live replanning, arbitrary topology edit

**Ticket Revision**:
The content identity of one Ticket's title and body within its stable repository and issue identity.
_Avoid_: Ticket state, issue update time

**Wave**:
One attempt to Work every currently eligible Ticket from the same map and target snapshot, followed by a serial Ship barrier.
_Avoid_: Stage, batch, phase

**Work**:
The isolated activity that turns an eligible Ticket into an exact tested and reviewed Git tree.
_Avoid_: Prepare, build candidate, implement phase

**Shippable Change**:
A candidate tree with tests and independent review bound to its map revision, ticket revision, base commit, and complete tree OID. It has not yet entered the target branch.
_Avoid_: Candidate, prepared ticket, ready artifact

**Ship**:
The serial transition that reconciles a Shippable Change with the current target, re-gates it when the target moved, pushes one canonical commit, records delivery evidence, and closes the Ticket.
_Avoid_: Land, deliver, merge phase

**Completed Ticket**:
A closed Ticket with a valid Norn delivery record whose integrated commit remains on the remote target branch and whose ticket text has not drifted.
_Avoid_: Closed issue, done ticket

**Waiting Ticket**:
A Ticket that is not eligible because one or more declared dependencies are not valid Completed Tickets.
_Avoid_: Blocked ticket, failed ticket

**Blocked Ticket**:
A Ticket whose attempted Work or Ship cannot safely progress under current trustworthy facts without changed code, input, configuration, or an operator decision.
_Avoid_: Waiting ticket, failed ticket

**Run Config**:
A resolved, versioned JSON document containing the target branch, commands, exact worker and reviewer models, attempt limits, repository-wide concurrency, and trusted evidence authors.
_Avoid_: Task Map configuration, Run Definition

**Delivery Record**:
A structured GitHub comment that binds a Ticket and its specification revisions to the exact tested, reviewed, and integrated Git tree.
_Avoid_: Agent handoff, completion claim
