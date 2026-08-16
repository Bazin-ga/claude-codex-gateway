import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const PASSWORD_KEY_BYTES = 32;

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export async function hashPassword(password, salt = randomBytes(16).toString('base64url')) {
  if (typeof password !== 'string' || password.length < 14) {
    throw new Error('admin password must be at least 14 characters');
  }
  const key = await scrypt(password, salt, PASSWORD_KEY_BYTES);
  return {
    algorithm: 'scrypt',
    salt,
    hash: Buffer.from(key).toString('base64url'),
  };
}

export async function verifyPassword(password, record) {
  if (!record || record.algorithm !== 'scrypt' || !record.salt || !record.hash) return false;
  const actual = Buffer.from(await scrypt(String(password), record.salt, PASSWORD_KEY_BYTES));
  const expected = Buffer.from(record.hash, 'base64url');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function encryptJson(masterKey, value, aad) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    iv: iv.toString('base64url'),
    tag: cipher.getAuthTag().toString('base64url'),
    ciphertext: ciphertext.toString('base64url'),
  };
}

export function decryptJson(masterKey, envelope, aad) {
  if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') {
    throw new Error('unsupported credential envelope');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    masterKey,
    Buffer.from(envelope.iv, 'base64url'),
  );
  decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64url')),
    decipher.final(),
  ]);
  return JSON.parse(plaintext.toString('utf8'));
}

export function secretMatches(presented, expectedHex) {
  if (typeof presented !== 'string' || typeof expectedHex !== 'string') return false;
  const actual = createHash('sha256').update(presented).digest();
  let expected;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
