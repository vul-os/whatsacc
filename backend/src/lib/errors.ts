export class HttpError extends Error {
  status: number;
  code: string;

  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.status = status;
    this.code = code;
  }
}

export const BadRequest = (code: string, message?: string) => new HttpError(400, code, message);
export const Unauthorized = (code = 'unauthorized', message?: string) => new HttpError(401, code, message);
export const Forbidden = (code = 'forbidden', message?: string) => new HttpError(403, code, message);
export const NotFound = (code = 'not_found', message?: string) => new HttpError(404, code, message);
export const Conflict = (code = 'conflict', message?: string) => new HttpError(409, code, message);
