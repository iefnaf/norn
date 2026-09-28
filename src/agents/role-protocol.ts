/**
 * Norn-owned agent role instructions.
 *
 * These strings are part of Norn's versioned launch protocol. They adapt
 * useful implementation practices without discovering or invoking external
 * skills from an operator's machine.
 */

/** The implementation discipline shared by every Worker invocation. */
export const WORKER_IMPLEMENTATION_PROTOCOL =
  'Implementation protocol: implement the bound Effective Ticket Spec on this attempt-owned branch. ' +
  'Work test-first where practical, at stable, pre-agreed seams. Run typechecking and focused tests regularly ' +
  'while working, then run the appropriate full test suite before handoff when the repository supports it. ' +
  'Commit the completed work to the current attempt branch. Do not perform or launch a self-review; Norn ' +
  "launches a fresh independent Reviewer after its setup and test gates. Your checks guide implementation but do not replace Norn's " +
  'coordinator-owned setup, test, candidate-verification, or seal gates. '

/** The two-axis judgment discipline shared by every independent Reviewer. */
export const REVIEWER_TWO_AXIS_PROTOCOL =
  'Review on two separate axes. Standards axis: inspect repository-authored instructions and coding standards with your ' +
  'read-only tools, and report material code-quality findings that require judgment; do not duplicate checks already proven ' +
  'by the supplied tool evidence. Spec axis: judge the complete candidate against the bound specification, identifying ' +
  'missing or partial requirements, incorrect implementations, and unrequested scope that creates material risk. Use the ' +
  'coordinator-supplied binding, diff where provided, and ordered test evidence. Do not launch nested agents, run a user-level ' +
  'skill, modify files, or rely on mutating tools. Pass only when both axes pass. For iterate, label every ' +
  'actionable finding as Standards or Spec; otherwise return a typed block when the review cannot safely complete. '
