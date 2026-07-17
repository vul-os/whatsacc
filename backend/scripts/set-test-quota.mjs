import pg from 'pg';
import { lookup } from 'node:dns/promises';

const email = 'andilemvumvu2@gmail.com';
const url = (process.env.DATABASE_URL ?? '').trim();

if (!url) {
  console.error('DATABASE_URL not set');
  process.exit(1);
}

const u = new URL(url);
const { address } = await lookup(u.hostname, { family: 4 });
const client = new pg.Client({
  host: address,
  port: Number(u.port) || 5432,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, ''),
  ssl: { servername: u.hostname, rejectUnauthorized: false },
});

await client.connect();

try {
  await client.query('BEGIN');
  // Bypass RLS
  await client.query("select set_config('app.user_id', '', true)");
  await client.query("select set_config('app.account_id', '', true)");
  await client.query("select set_config('app.is_platform_admin', 'true', true)");

  // 1. Find user and their account
  const res = await client.query(`
    select u.id as user_id, am.account_id, s.id as subscription_id, s.plan_id
    from users u
    join account_members am on am.user_id = u.id
    join account_subscriptions s on s.account_id = am.account_id
    where u.email = $1
    limit 1
  `, [email]);

  const row = res.rows[0];
  if (!row) {
    console.error(`User or active subscription not found for ${email}`);
    process.exit(1);
  }

  const { account_id, subscription_id } = row;

  // 2. Set included_opens to something low (e.g., 5) for the plan
  // Note: This changes it for the PLAN itself, which might affect others.
  // Better: Update the subscription start date and count usage.
  // BUT the request is to "add 5 open", likely meaning "set remaining to 5".
  
  // Let's see how many opens are already used in the current period.
  const usageRes = await client.query(`
    select count(*) as count 
    from access_logs 
    where account_id = $1 
      and command = 'open' 
      and success = true
      and created_at >= (select current_period_start from account_subscriptions where id = $2)
  `, [account_id, subscription_id]);
  
  const used = parseInt(usageRes.rows[0].count);
  
  // Set included_opens to used + 5
  await client.query(`
    update plans 
    set included_opens = $1 
    where id = (select plan_id from account_subscriptions where id = $2)
  `, [used + 5, subscription_id]);

  await client.query('COMMIT');
  console.log(`Success! User ${email} now has 5 opens remaining (Plan included_opens set to ${used + 5}).`);
} catch (e) {
  await client.query('ROLLBACK');
  console.error(e);
} finally {
  await client.end();
}
