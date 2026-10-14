import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const N = 16_384;
const R = 8;
const P = 1;
const KEYLEN = 64;

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128; // bounds scrypt work per request

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: 64 * 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(
    password,
    Buffer.from(salt, 'base64'),
    Number(n),
    Number(r),
    Number(p),
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/** Verified against when the user does not exist, so login timing does not reveal valid names. */
export function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword(randomBytes(12).toString('hex')));
}
