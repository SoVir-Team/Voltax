/** An expected refusal with an HTTP status. Messages are safe to show to the caller. */
export class CloudError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string = code,
  ) {
    super(message);
  }
}

export const notFound = () => new CloudError(404, 'not_found', 'not found');
export const forbidden = (message = 'forbidden') => new CloudError(403, 'forbidden', message);
export const conflict = (message: string) => new CloudError(409, 'conflict', message);
export const badRequest = (message: string) => new CloudError(400, 'bad_request', message);
