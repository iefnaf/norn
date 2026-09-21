/**
 * The Norn package version (design.md §8, §13.2).
 *
 * Every Run State document records the Norn version of the executor that
 * wrote it; `/norn check` compares persisted states against this constant to
 * decide resumability and active-run compatibility, because concurrent runs
 * in one repository must share one `configRevision` and one Norn version.
 *
 * The value must track `package.json`; it is a constant so identity never
 * depends on file reads at runtime.
 */
export const NORN_VERSION = '0.1.0'
