import { createHmac } from 'node:crypto';

const BASE = 'https://lintel-backend-dev.lintelsupport.workers.dev';
const WA_APP_SECRET = (process.env.WHATSAPP_APP_SECRET ?? '').trim();

if (!WA_APP_SECRET) {
  console.error('WHATSAPP_APP_SECRET not set');
  process.exit(1);
}

function hmacSha256Hex(secret, body) {
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

const PHONE_ID = (process.env.WHATSAPP_PHONE_NUMBER_ID ?? 'PHONE_TEST').trim();

async function test() {
  const TS = Date.now();
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_TEST',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15551234567', phone_number_id: PHONE_ID },
          contacts: [{ profile: { name: 'Webhook Test' }, wa_id: '27821234567' }],
          messages: [{
            from: '27821234567', id: `wamid.manual_${TS}`,
            timestamp: String(Math.floor(TS / 1000)), type: 'text',
            text: { body: 'hi' },
          }],
        },
      }],
    }],
  });

  const sig = hmacSha256Hex(WA_APP_SECRET, body);
  console.log('Sending manual webhook to dev...');
  
  const res = await fetch(BASE + '/webhooks/whatsapp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Hub-Signature-256': 'sha256=' + sig,
    },
    body,
  });

  const text = await res.text();
  console.log('Status:', res.status);
  console.log('Response:', text);
}

test();
