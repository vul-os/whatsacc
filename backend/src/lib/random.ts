function toBase64Url(bytes: Uint8Array): string {
  let str = '';
  for (let i = 0; i < bytes.length; i++) {
    str += String.fromCharCode(bytes[i]!);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

export function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

export function randomCode(digits = 6): string {
  const max = 10 ** digits;
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  const n = buf[0]! % max;
  return n.toString().padStart(digits, '0');
}

export { toBase64Url };
