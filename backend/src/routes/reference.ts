import { Hono } from 'hono';
import type { AppEnv } from '../middleware/auth.ts';
import { withAnonDb } from '../middleware/rls.ts';

type CountryRow = {
  code: string;
  name: string;
  flag_emoji: string;
  currency_code: string;
  msg_cost_zar: string;
};

type CurrencyRow = {
  code: string;
  name: string;
  symbol: string;
  decimals: number;
  rate_to_zar: string | null;
};

function referenceRouter() {
  const app = new Hono<AppEnv>();

  app.get('/countries', async (c) => {
    const rows = await withAnonDb(async (tx) => {
      return await tx<CountryRow[]>`
        select code, name, flag_emoji, currency_code, msg_cost_zar
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
        currency_code: r.currency_code,
        msg_cost_zar: Number(r.msg_cost_zar),
      })),
    });
  });

  app.get('/currencies', async (c) => {
    const rows = await withAnonDb(async (tx) => {
      return await tx<CurrencyRow[]>`
        select c.code, c.name, c.symbol, c.decimals, fx.rate_to_zar
        from currencies c
        left join fx_rates fx on fx.currency_code = c.code
        where c.is_active = true
        order by c.code asc
      `;
    });
    return c.json({
      currencies: rows.map((r) => ({
        code: r.code,
        name: r.name,
        symbol: r.symbol,
        decimals: r.decimals,
        fx_to_zar: r.rate_to_zar !== null ? Number(r.rate_to_zar) : null,
      })),
    });
  });

  return app;
}

export const referenceRoutes = referenceRouter();
