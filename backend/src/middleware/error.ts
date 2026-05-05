import type { ErrorHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { HttpError } from '../lib/errors.ts';
import { ZodError } from 'zod';
import type { AppEnv } from './auth.ts';

// Flat error shape the frontend ApiError class expects:
//   { error: <code>, detail: <human-readable message> }

export const errorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof HttpError) {
    return c.json(
      {
        error: err.code,
        detail: err.message !== err.code ? err.message : undefined,
      },
      err.status as ContentfulStatusCode,
    );
  }
  if (err instanceof ZodError) {
    return c.json(
      { error: 'validation_error', detail: err.issues[0]?.message, issues: err.issues },
      400,
    );
  }
  console.error('unhandled', err);
  return c.json({ error: 'internal_error', detail: 'internal error' }, 500);
};
