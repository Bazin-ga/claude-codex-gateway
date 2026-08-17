#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CredentialStore } from './lib/store.js';
import { acquireHomeLock } from './lib/home-lock.js';

const HOME = process.env.CREDENTIAL_CONSOLE_HOME ?? '/var/lib/credential-console';

function valueOf(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  console.error(`usage:
  node cli.js init-key
  node cli.js import-codex --alias <alias> --home <path> [--email <label>]
  node cli.js checkpoint-metrics
  node cli.js list`);
  process.exitCode = 2;
}

async function main() {
  const command = process.argv[2];

  if (!['init-key', 'import-codex', 'checkpoint-metrics'].includes(command)) {
    if (command === 'list') {
      const store = await new CredentialStore(HOME).init();
      console.log(JSON.stringify(store.publicAccounts(), null, 2));
      return;
    }
    return usage();
  }

  const lock = await acquireHomeLock(HOME, { role: `cli:${command}` });
  try {
    if (command === 'checkpoint-metrics') {
      const metricsPath = resolve(HOME, 'metrics.sqlite');
      try {
        await access(metricsPath);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        console.log(`metrics database not present at ${metricsPath}; nothing to checkpoint`);
        return;
      }
      const { MetricsStore } = await import('./lib/metrics.js');
      const metrics = await new MetricsStore({
        home: HOME,
        flushIntervalMs: 60_000,
      }).init();
      let integrityPassed = false;
      try {
        metrics.integrityCheck();
        integrityPassed = true;
        const checkpoint = metrics.checkpoint();
        console.log(JSON.stringify({
          database: metricsPath,
          integrity: 'ok',
          checkpoint,
        }));
      } finally {
        metrics.close({ checkpoint: integrityPassed });
      }
      return;
    }

    if (command === 'init-key') {
      const keyPath = resolve(HOME, 'master.key');
      const statePath = resolve(HOME, 'state.json');
      try {
        await readFile(keyPath);
        throw new Error(`master key already exists at ${keyPath}; refusing to overwrite it`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        const state = JSON.parse(await readFile(statePath, 'utf8'));
        const encryptedCollections = ['accounts', 'devices', 'enrollments', 'oauth_flows'];
        if (encryptedCollections.some((collection) => state[collection]?.length > 0)) {
          throw new Error(
            'credential home already contains data encrypted under a different key; '
            + 'a new key cannot decrypt it; restore master.key from backup instead',
          );
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      try {
        await new CredentialStore(HOME, { allowKeyInit: true }).init();
      } catch (error) {
        if (error.code === 'EEXIST') {
          throw new Error(`master key already exists at ${keyPath}; refusing to overwrite it`);
        }
        throw error;
      }
      console.log(`master key created at ${keyPath}`);
      return;
    }

    const store = await new CredentialStore(HOME).init();

    if (command === 'import-codex') {
      const alias = valueOf('--alias');
      const home = valueOf('--home');
      if (!alias || !home) return usage();
      const account = await store.addAccount({
        provider: 'codex',
        alias,
        emailLabel: valueOf('--email') ?? '',
        external: { kind: 'codex-credential', home: resolve(home) },
      });
      console.log(JSON.stringify({ id: account.id, alias: account.alias, provider: account.provider }));
      return;
    }
  } finally {
    await lock.release();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
