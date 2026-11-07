import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

// Administrator sign-in for `CREDENTIAL_CONSOLE_ADMIN_AUTH=password`. Only a
// salted scrypt digest is stored; the password itself never reaches state.json
// or a log line.

export const ADMIN_USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const ADMIN_PASSWORD_MIN_LENGTH = 10;
const ADMIN_PASSWORD_MAX_LENGTH = 256;
// 16 MiB per hash: well inside the service's memory budget, and slow enough
// that a stolen state.json does not give the passwords away cheaply.
const SCRYPT = Object.freeze({ N: 16_384, r: 8, p: 1, keylen: 32 });

function derive(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    scrypt(String(password), salt, keylen, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, key) => (
      error ? reject(error) : resolve(key)
    ));
  });
}

export function assertAdminUsername(username) {
  if (typeof username !== 'string' || !ADMIN_USERNAME_PATTERN.test(username)) {
    throw new Error('username must use letters, numbers, dots, underscores, or hyphens');
  }
  return username;
}

export function assertAdminPassword(password) {
  if (typeof password !== 'string' || password.length < ADMIN_PASSWORD_MIN_LENGTH) {
    throw new Error(`password must be at least ${ADMIN_PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > ADMIN_PASSWORD_MAX_LENGTH) {
    throw new Error(`password must be at most ${ADMIN_PASSWORD_MAX_LENGTH} characters`);
  }
  return password;
}

export async function hashAdminPassword(password) {
  assertAdminPassword(password);
  const salt = randomBytes(16);
  const hash = await derive(password, salt, SCRYPT);
  return {
    algorithm: 'scrypt',
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
    salt: salt.toString('base64url'),
    hash: hash.toString('base64url'),
  };
}

// Compared against when the username is unknown, so a miss costs the same
// time as a wrong password and does not reveal which names exist.
let dummyDigest = null;

export async function verifyAdminPassword(digest, password) {
  if (typeof password !== 'string' || password.length > ADMIN_PASSWORD_MAX_LENGTH) return false;
  const usable = digest?.algorithm === 'scrypt' && typeof digest.salt === 'string'
    && typeof digest.hash === 'string';
  if (!usable) {
    dummyDigest ??= await hashAdminPassword('x'.repeat(ADMIN_PASSWORD_MIN_LENGTH));
    await verifyAdminPassword(dummyDigest, password);
    return false;
  }
  const expected = Buffer.from(digest.hash, 'base64url');
  const actual = await derive(password, Buffer.from(digest.salt, 'base64url'), {
    N: digest.N,
    r: digest.r,
    p: digest.p,
    keylen: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
