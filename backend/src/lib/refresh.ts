import { randomToken } from './random.ts';

export type RefreshToken = {
  plain: string;
  hash: string;
};

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

export async function hashToken(plain: string): Promise<string> {
  const data = new TextEncoder().encode(plain);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return toHex(digest);
}

export async function mintRefreshToken(): Promise<RefreshToken> {
  const plain = randomToken(32);
  const hash = await hashToken(plain);
  return { plain, hash };
}

export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30; // 30d
