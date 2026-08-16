/**
 * Structured errors. Every failure a caller can act on carries a `code`, so
 * tools can feed the model a specific remedy instead of a stringified stack.
 * @module @navidid/dsh-taskboard/src/errors
 */

/** Every failure this package raises deliberately. */
export type TaskboardErrorCode =
  /** The referenced task or project does not exist. */
  | 'not-found'
  /** `expectedRevision` did not match the stored revision — reread and retry. */
  | 'revision-conflict'
  /** Input failed validation before any medium was touched. */
  | 'invalid-input'
  /** The write was refused by policy or by a human. */
  | 'write-denied'
  /** An import document is not a format this build understands. */
  | 'unsupported-document'
  /** A limit configured for this deployment was reached. */
  | 'limit-exceeded'

/** One deliberate failure, carrying the code a caller switches on. */
export class TaskboardError extends Error {
  /**
   * @param code - the machine-readable failure category.
   * @param message - human- and model-readable explanation.
   * @param options - standard error options (`cause`).
   */
  constructor(
    readonly code: TaskboardErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'TaskboardError'
  }
}
