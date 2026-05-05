import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '../lib/errors.ts';
import { ZodError } from 'zod';
import type { AppEnv } from './auth.ts';

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      { error: { code: err.code, message: err.message } },
      err.status as ContentfulStatusCode,
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      { error: { code: 'validation_error', issues: err.issues } },
      400,
    );
  }
  console.error('unhandled', err);
  return c.json({ error: { code: 'internal_error', message: 'internal error' } }, 500);
};
