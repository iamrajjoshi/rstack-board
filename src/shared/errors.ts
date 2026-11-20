/** A failure with a stable machine-readable reason, printed as `{reason, message}` by the CLI and API. */
export class BoardError extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}
