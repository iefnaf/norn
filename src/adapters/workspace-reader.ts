/**
 * The workspace reader seam (design.md §6): read-only access to files in the
 * target repository's working tree during `/norn init`. Command detection
 * probes build manifests through this seam; nothing is ever written.
 *
 * The built-in production adapter reads the filesystem. Tests inject canned
 * file trees — no real I/O.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { error, ok } from '../core/outcome.ts'
import type { Outcome } from '../core/outcome.ts'

export type WorkspaceReaderErrorCode = 'workspace-read'

export type WorkspaceReaderAdapter = {
  /**
   * Read one UTF-8 text file below the repository root. `ok(undefined)` means
   * the path is absent (or names a directory); any other failure is a typed
   * error.
   */
  readTextFile(
    root: string,
    relativePath: string,
  ): Promise<Outcome<string | undefined, never, WorkspaceReaderErrorCode>>
}

/** The built-in production adapter over the local filesystem. */
export function fsWorkspaceReader(): WorkspaceReaderAdapter {
  return {
    async readTextFile(root, relativePath) {
      let text: string
      try {
        text = await readFile(join(root, relativePath), 'utf8')
      } catch (cause) {
        const code = (cause as NodeJS.ErrnoException | null)?.code
        if (code === 'ENOENT' || code === 'EISDIR') return ok(undefined)
        return error({
          scope: 'operation',
          code: 'workspace-read',
          reason: `reading ${relativePath} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
        })
      }
      return ok(text)
    },
  }
}
