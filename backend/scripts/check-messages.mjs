import pg from 'pg';
import { lookup } from 'node:dns/promises';

async function checkRecentMessages() {
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
  console.log('\nChecking recent WhatsApp messages...');
  
  const res = await client.query(`
    select m.id, m.direction, m.kind, m.status, m.ts, c.phone_e164
    from whatsapp_messages m
    join whatsapp_chats c on c.id = m.chat_id
    order by m.ts desc
    limit 5
  `);
  
  console.table(res.rows);
  await client.end();
}

await checkRecentMessages();
