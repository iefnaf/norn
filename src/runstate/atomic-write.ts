/**
 * The one atomic-write discipline every Norn-home document uses
 * (design.md §13.1): write a unique temporary file in the target directory,
 * flush it, atomically rename it over the target, and flush the containing
 * directory. A writer killed at any point leaves either the previous or the
 * complete new document at the target path — never a torn one — and at most
 * an ignorable leftover temporary file.
 */
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Atomically write `text` to `path`. Creates parent directories when absent.
 * Throws whatever the underlying filesystem operations throw; callers own
 * mapping failures to typed outcomes.
 */
export function writeDocumentAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${randomUUID()}`
  writeFileSync(temporary, text, 'utf8')
  const handle = openSync(temporary, 'r+')
  try {
    fsyncSync(handle)
  } finally {
    closeSync(handle)
  }
  renameSync(temporary, path)
  syncDirectory(dirname(path))
}

/** Directory flush after rename (design.md §13.1); best effort only. */
function syncDirectory(directory: string): void {
  try {
    const handle = openSync(directory, 'r')
    try {
      fsyncSync(handle)
    } finally {
      closeSync(handle)
    }
  } catch {
    // Unsupported on some platforms; the atomic rename already guarantees the
    // file content.
  }
}
