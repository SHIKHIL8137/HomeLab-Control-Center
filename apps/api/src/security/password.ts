import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// scrypt cost, from OWASP's password-storage guidance (N=2^15, r=8, p=3 needs about 32 MiB).
// Parameters are stored with each hash, so raising them later upgrades users as they sign in.
const N = 32_768;
const R = 8;
const P = 3;
const KEYLEN = 64;
const MAXMEM = 96 * 1024 * 1024;

// Upper bounds for parameters read back from the database: a tampered row must not be able to
// make the server allocate gigabytes or burn minutes of CPU.
const LIMITS = { N: 2 ** 17, R: 16, P: 16 };

export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128; // bounds scrypt work per request

/** Hashing is serialised so concurrent sign-in attempts cannot exhaust memory in a small container. */
let chain: Promise<unknown> = Promise.resolve();
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function derive(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return exclusive(
    () =>
      new Promise<Buffer>((resolve, reject) =>
        scrypt(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) =>
          err ? reject(err) : resolve(key),
        ),
      ),
  );
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, N, R, P);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

interface Parsed {
  n: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

function parse(stored: string): Parsed | null {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !r || !p || !salt || !hash) return null;
  const nn = Number(n);
  const rr = Number(r);
  const pp = Number(p);
  const isPow2 = Number.isInteger(nn) && nn >= 2 && (nn & (nn - 1)) === 0;
  if (!isPow2 || nn > LIMITS.N) return null;
  if (!Number.isInteger(rr) || rr < 1 || rr > LIMITS.R) return null;
  if (!Number.isInteger(pp) || pp < 1 || pp > LIMITS.P) return null;
  const h = Buffer.from(hash, 'base64');
  if (h.length !== KEYLEN) return null;
  return { n: nn, r: rr, p: pp, salt: Buffer.from(salt, 'base64'), hash: h };
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const x = parse(stored);
  if (!x) return false;
  const actual = await derive(password, x.salt, x.n, x.r, x.p);
  return actual.length === x.hash.length && timingSafeEqual(actual, x.hash);
}

/** True when a stored hash was made with weaker settings than the current ones. */
export function needsRehash(stored: string): boolean {
  const x = parse(stored);
  return x === null || x.n < N || x.r < R || x.p < P;
}

let dummy: Promise<string> | undefined;
/** Verified against when the user does not exist, so login timing does not reveal valid names. */
export function dummyHash(): Promise<string> {
  return (dummy ??= hashPassword(randomBytes(12).toString('hex')));
}
