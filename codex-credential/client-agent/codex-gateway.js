#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DEFAULT_PROFILE_ROOT, ProfileStore } from './lib/profile-store.js';

export async function launchSelected(args = process.argv.slice(2), {
  env = process.env,
  spawnImpl = spawn,
} = {}) {
  const store = new ProfileStore({
    root: env.CODEX_CRED_PROFILE_ROOT ?? DEFAULT_PROFILE_ROOT,
  });
  const selected = await store.readSelected();
  if (!selected) throw Object.assign(new Error('no Codex profile is selected'), { code: 'ERR_NO_PROFILE' });
  const profile = await store.readProfile(selected.profile);
  if (!profile.auth.complete || profile.auth.expired) {
    throw Object.assign(new Error('selected Codex profile is incomplete'), {
      code: 'ERR_PROFILE_INCOMPLETE',
    });
  }
  const command = env.CODEX_CLI_BIN || 'codex';
  const childEnv = { ...env, CODEX_HOME: profile.codex_home };
  for (const name of [
    'CODEX_CRED_TOKEN',
    'CODEX_CRED_ENDPOINT',
    'CODEX_CRED_CERT_PIN',
    'CODEX_CRED_ENROLLMENT_KEY',
    'CODEX_CRED_PROFILE_ROOT',
  ]) delete childEnv[name];
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, {
      stdio: 'inherit',
      shell: false,
      env: childEnv,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(Number.isInteger(code) ? code : 1);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  launchSelected().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    const reason = String(error?.code ?? error?.name ?? 'launch_failed').toLowerCase();
    process.stderr.write(`codex-gateway failed: ${/^[a-z0-9._-]+$/.test(reason) ? reason : 'launch_failed'}\n`);
    process.exitCode = 1;
  });
}
