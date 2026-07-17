import { Hono } from 'hono';
import type { AppEnv } from '../middleware/auth.ts';
import { withAnonDb } from '../middleware/rls.ts';

type CountryRow = {
  code: string;
  name: string;
  flag_emoji: string;
};

function referenceRouter() {
  const app = new Hono<AppEnv>();

  app.get('/countries', async (c) => {
    const rows = await withAnonDb(async (tx) => {
      return await tx<CountryRow[]>`
        select code, name, flag_emoji
        from countries
        where is_active = true
        order by name asc
      `;
    });
    return c.json({
      countries: rows.map((r) => ({
        code: r.code,
        name: r.name,
        flag: r.flag_emoji,
      })),
    });
  });

  return app;
}

export const referenceRoutes = referenceRouter();
