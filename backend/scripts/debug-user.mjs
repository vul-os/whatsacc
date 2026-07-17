import pg from 'pg';
import { lookup } from 'node:dns/promises';

const email = 'andilemvumvu2@gmail.com';

async function run(envFile) {
  const url = process.env.DATABASE_URL;
  if (!url) return;
  
  const u = new URL(url);
  const { address } = await lookup(u.hostname, { family: 4 });
  const client = new pg.Client({
    host: address, port: 5432,
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, ''),
    ssl: { servername: u.hostname, rejectUnauthorized: false },
  });

  await client.connect();
  console.log(`\nChecking ${envFile}...`);
  
  const res = await client.query('select email from users where email = $1', [email]);
  if (res.rows[0]) {
    console.log(`[OK] User found in ${envFile}`);
  } else {
    console.log(`[NOT FOUND] User not in ${envFile}`);
  }
  await client.end();
}

// Minimal manual runner for the turn
const urlDev = process.env.DATABASE_URL; // Assuming the tool call passes the right env
await run('current env');
