import pg from 'pg';
import { lookup } from 'node:dns/promises';

async function checkRecentLogs() {
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
  console.log('\nChecking all WhatsApp messages count...');
  const resCount = await client.query('select count(*) from whatsapp_messages');
  console.log('Total messages:', resCount.rows[0].count);
  
  console.log('\nLast 10 access logs:');
  const resAccess = await client.query('select * from access_logs order by created_at desc limit 10');
  console.table(resAccess.rows);

  await client.end();
}

await checkRecentLogs();
