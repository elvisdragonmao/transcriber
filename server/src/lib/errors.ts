/** Raised when a stage is cancelled (or stopped for a pause) cooperatively. */
export class CancelledError extends Error {
  constructor() {
    super("cancelled");
  }
}

/** Errors that must not be retried automatically (bad input, configuration). */
export class FatalStageError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
