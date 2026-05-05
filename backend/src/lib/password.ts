import { argon2id, argon2Verify } from 'hash-wasm';

const MEMORY_KIB = 64 * 1024; // 64 MB
const ITERATIONS = 3;
const PARALLELISM = 1;
const HASH_LENGTH = 32;
const SALT_LENGTH = 16;

export async function hashPassword(plain: string): Promise<string> {
  const salt = new Uint8Array(SALT_LENGTH);
  crypto.getRandomValues(salt);
  return await argon2id({
    password: plain,
    salt,
    iterations: ITERATIONS,
    parallelism: PARALLELISM,
    memorySize: MEMORY_KIB,
    hashLength: HASH_LENGTH,
    outputType: 'encoded',
  });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await argon2Verify({ password: plain, hash });
  } catch {
    return false;
  }
}
