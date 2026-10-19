/** An error the HTTP layer turns into `{ error: message, ...body }` with this status. */
export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}
