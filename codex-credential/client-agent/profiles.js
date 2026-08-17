#!/usr/bin/env node

import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import {
  DEFAULT_PROFILE_ROOT,
  ProfileStore,
  validateSource,
} from './lib/profile-store.js';
import {
  accountDigest,
  authFromCredential,
  fetchCredential,
  hardenWindowsAcl,
} from './pull.js';

const MAX_ENV_BYTES = 16 * 1024;
const REQUIRED_ENV = Object.freeze([
  'CODEX_CRED_ENDPOINT',
  'CODEX_CRED_CERT_PIN',
  'CODEX_CRED_TOKEN',
]);

function fixedReason(error) {
  const code = String(error?.code ?? error?.name ?? 'operation_failed').toLowerCase();
  return /^[a-z0-9._-]{1,64}$/.test(code) ? code : 'operation_failed';
}

async function safeAudit(store, event, detail) {
  try {
    await store.audit(event, detail);
  } catch {
    // An audit failure cannot turn a safe failed selection into a credential
    // mutation. The primary operation still reports its own fixed error.
  }
}

export async function sourceFromEnvFile(path) {
  let handle;
  let text;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink()) {
      throw Object.assign(new Error('profile env file is unsafe'), { code: 'ERR_UNSAFE_ENV_FILE' });
    }
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const item = await handle.stat();
    if (item.dev !== before.dev || item.ino !== before.ino) {
      throw Object.assign(new Error('profile env file changed while opening'), { code: 'ERR_UNSAFE_ENV_FILE' });
    }
    if (!item.isFile() || item.nlink !== 1 || item.size > MAX_ENV_BYTES) {
      throw Object.assign(new Error('profile env file is unsafe'), { code: 'ERR_UNSAFE_ENV_FILE' });
    }
    if (process.platform !== 'win32' && (item.mode & 0o777) !== 0o600) {
      throw Object.assign(new Error('profile env file must have mode 600'), { code: 'ERR_INSECURE_ENV_FILE' });
    }
    text = await handle.readFile('utf8');
  } catch (error) {
    if (error.code === 'ELOOP') {
      throw Object.assign(new Error('profile env file is unsafe'), { code: 'ERR_UNSAFE_ENV_FILE' });
    }
    throw error;
  } finally {
    if (handle) await handle.close();
  }
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw;
    if (!line || /^\s*#/.test(line)) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || values.has(match[1])) {
      throw Object.assign(new Error('profile env file is ambiguous'), { code: 'ERR_INVALID_ENV_FILE' });
    }
    values.set(match[1], match[2]);
  }
  return validateSource({
    endpoint: values.get('CODEX_CRED_ENDPOINT'),
    pin: values.get('CODEX_CRED_CERT_PIN'),
    device_bearer: values.get('CODEX_CRED_TOKEN'),
  }, { requireBearer: true });
}

export function sourceFromProcessEnv(env = process.env) {
  const missing = REQUIRED_ENV.filter((name) => !env[name]);
  if (missing.length) {
    throw Object.assign(new Error('profile credential source is incomplete'), {
      code: 'ERR_PROFILE_SOURCE_MISSING',
    });
  }
  return validateSource({
    endpoint: env.CODEX_CRED_ENDPOINT,
    pin: env.CODEX_CRED_CERT_PIN,
    device_bearer: env.CODEX_CRED_TOKEN,
  }, { requireBearer: true });
}

export async function activateProfile(store, name, { fetcher = fetchCredential, now = new Date() } = {}) {
  return store.withRuntimeLock(async () => {
    try {
      let profile = await store.readProfile(name);
      const source = validateSource(profile.source, { requireBearer: true });
      const issued = await fetcher({
        endpoint: source.endpoint,
        token: source.device_bearer,
        pin: source.pin,
      });
      const digest = accountDigest(issued.account_id);
      if (source.account_id_sha256 && source.account_id_sha256 !== digest) {
        throw Object.assign(new Error('profile account binding changed'), {
          code: 'ERR_PROFILE_ACCOUNT_MISMATCH',
        });
      }
      if (!source.account_id_sha256) profile = await store.bindDigest(name, digest);
      const auth = authFromCredential(issued, { now });
      await store.writeProfileAuth(name, auth);
      const selected = await store.selectProfile(name);
      await safeAudit(store, 'profile.selected', {
        profile: name,
        generation: selected.generation,
        outcome: 'success',
      });
      return { ...selected, codex_home: profile.codex_home };
    } catch (error) {
      await safeAudit(store, 'profile.select_failed', {
        profile: name,
        outcome: 'failure',
        reason: fixedReason(error),
      });
      throw error;
    }
  });
}

export async function installProfile(store, name, sourceInput, {
  fetcher = fetchCredential,
  now = new Date(),
} = {}) {
  const candidate = validateSource(sourceInput, { requireBearer: true });
  return store.withRuntimeLock(async () => {
    try {
      const issued = await fetcher({
        endpoint: candidate.endpoint,
        token: candidate.device_bearer,
        pin: candidate.pin,
      });
      const digest = accountDigest(issued.account_id);
      let profile;
      try {
        profile = await store.readProfile(name);
      } catch (error) {
        if (error.code !== 'ERR_PROFILE_NOT_FOUND') throw error;
        profile = await store.addProfile(name, candidate);
      }
      if (profile.source.account_id_sha256 && profile.source.account_id_sha256 !== digest) {
        throw Object.assign(new Error('profile account binding changed'), {
          code: 'ERR_PROFILE_ACCOUNT_MISMATCH',
        });
      }
      if (!profile.source.account_id_sha256) await store.bindDigest(name, digest);
      await store.replaceProfileSource(name, candidate, digest);
      await store.writeProfileAuth(name, authFromCredential(issued, { now }));
      const selected = await store.selectProfile(name);
      await safeAudit(store, 'profile.installed', {
        profile: name,
        generation: selected.generation,
        outcome: 'success',
      });
      return selected;
    } catch (error) {
      await safeAudit(store, 'profile.install_failed', {
        profile: name,
        outcome: 'failure',
        reason: fixedReason(error),
      });
      throw error;
    }
  });
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = { command, positional: [] };
  for (let index = 0; index < rest.length; index += 1) {
    const value = rest[index];
    if (value === '--name' || value === '--env-file') {
      values[value.slice(2).replace('-', '_')] = rest[++index];
    } else {
      values.positional.push(value);
    }
  }
  return values;
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export async function runProfiles(argv = process.argv.slice(2), {
  env = process.env,
  fetcher = fetchCredential,
  now = new Date(),
} = {}) {
  const args = parseArgs(argv);
  const root = env.CODEX_CRED_PROFILE_ROOT ?? DEFAULT_PROFILE_ROOT;
  const store = new ProfileStore({
    root,
    aclHardener: process.platform === 'win32'
      ? async (path, options) => hardenWindowsAcl(path, options)
      : null,
  });
  if (args.command === 'add') {
    const name = args.name ?? args.positional[0];
    const source = args.env_file ? await sourceFromEnvFile(args.env_file) : sourceFromProcessEnv(env);
    await store.addProfile(name, source);
    await safeAudit(store, 'profile.added', { profile: name, outcome: 'success' });
    output({ profile: name, added: true, selected: false });
    return;
  }
  if (args.command === 'select') {
    const name = args.name ?? args.positional[0];
    const selected = await activateProfile(store, name, { fetcher, now });
    output({ profile: selected.profile, generation: selected.generation, selected: true });
    return;
  }
  if (args.command === 'install') {
    const name = args.name ?? args.positional[0];
    const source = args.env_file ? await sourceFromEnvFile(args.env_file) : sourceFromProcessEnv(env);
    const selected = await installProfile(store, name, source, { fetcher, now });
    output({ profile: selected.profile, generation: selected.generation, installed: true, selected: true });
    return;
  }
  if (args.command === 'list' || args.command === 'status') {
    const profiles = await store.listProfiles();
    const selected = await store.readSelected();
    output({
      selected: selected?.profile ?? null,
      generation: selected?.generation ?? null,
      profiles: profiles.map((profile) => ({
        name: profile.name,
        selected: profile.name === selected?.profile,
        ready: profile.auth.complete && !profile.auth.expired,
        state: profile.auth.complete
          ? (profile.auth.expired ? 'expired' : 'ready')
          : profile.auth.reason,
        expires_at: profile.auth.expires_at ?? null,
      })),
    });
    return;
  }
  throw Object.assign(new Error('usage: profiles.js add|install|select|list|status'), { code: 'ERR_USAGE' });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runProfiles().catch((error) => {
    output({ ok: false, error: fixedReason(error) });
    process.exitCode = error.code === 'ERR_USAGE' ? 2 : 1;
  });
}
