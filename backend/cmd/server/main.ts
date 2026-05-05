import { createApp } from '../../src/app.ts';
import { getEnv } from '../../src/lib/env.ts';

const app = createApp();
const env = getEnv();
console.log(`whatsacc server listening on :${env.PORT} (${env.APP_ENV})`);
Deno.serve({ port: env.PORT }, app.fetch);
