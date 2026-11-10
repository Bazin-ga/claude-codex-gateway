#!/usr/bin/env node
import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { CredentialStore } from './lib/store.js';
import { acquireHomeLock } from './lib/home-lock.js';
import { externalAccountStatus } from './lib/external-account-status.js';

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
  node cli.js list
  node cli.js admin list
  node cli.js admin add <username> [--password-stdin]
  node cli.js admin passwd <username> [--password-stdin]
  node cli.js admin delete <username>
  node cli.js relay-chain show
  node cli.js relay-chain import <chains.json>`);
  process.exitCode = 2;
}

// Never from argv, where it would sit in shell history and the process list:
// typed twice at a terminal with echo off, or one line on stdin.
async function readPassword() {
  if (process.argv.includes('--password-stdin') || !process.stdin.isTTY) {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    return input.replace(/\r?\n$/, '');
  }
  const ask = (prompt) => new Promise((resolveAnswer, reject) => {
    process.stderr.write(prompt);
    let answer = '';
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const onData = (char) => {
      if (char === '\u0003') {
        process.stdin.setRawMode(false);
        process.stdin.off('data', onData);
        reject(new Error('cancelled'));
      } else if (char === '\r' || char === '\n') {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.off('data', onData);
        process.stderr.write('\n');
        resolveAnswer(answer);
      } else if (char === '\u007f') {
        answer = answer.slice(0, -1);
      } else {
        answer += char;
      }
    };
    process.stdin.on('data', onData);
  });
  const first = await ask('Password: ');
  const second = await ask('Repeat password: ');
  if (first !== second) throw new Error('the two passwords differ');
  return first;
}

async function main() {
  const command = process.argv[2];

  if (command === 'admin') {
    const action = process.argv[3];
    const username = process.argv[4];
    if (action === 'list') {
      const store = await new CredentialStore(HOME).init();
      console.log(JSON.stringify(store.adminUsers(), null, 2));
      return;
    }
    if (!['add', 'passwd', 'delete'].includes(action) || !username) return usage();
    const password = action === 'delete' ? null : await readPassword();
    const lock = await acquireHomeLock(HOME, { role: `cli:admin-${action}` });
    try {
      const store = await new CredentialStore(HOME).init();
      if (action === 'add') await store.addAdminUser({ username, password, actor: 'cli' });
      else if (action === 'passwd') await store.setAdminPassword(username, password, { actor: 'cli' });
      else await store.deleteAdminUser(username, { actor: 'cli' });
      console.log(`administrator ${username}: ${action} done`);
    } finally {
      await lock.release();
    }
    return;
  }

  if (command === 'relay-chain') {
    const action = process.argv[3];
    if (action === 'show') {
      const store = await new CredentialStore(HOME).init();
      console.log(JSON.stringify(store.relayChains(), null, 2));
      return;
    }
    const file = process.argv[4];
    if (action !== 'import' || !file) return usage();
    // The whole set of chains, as `show` prints it. A source's key is never in
    // what `show` prints: give it as `api_key`, or as `api_key_file` naming a
    // file that holds nothing else, or leave both out to keep the stored one.
    const described = JSON.parse(await readFile(resolve(file), 'utf8'));
    const chains = Array.isArray(described) ? described : described?.chains;
    if (!Array.isArray(chains)) throw new Error('the file must hold a list of chains');
    for (const chain of chains) {
      for (const source of Array.isArray(chain?.sources) ? chain.sources : []) {
        if (typeof source?.api_key_file !== 'string') continue;
        source.api_key = (await readFile(resolve(source.api_key_file), 'utf8')).trim();
      }
    }
    const lock = await acquireHomeLock(HOME, { role: 'cli:relay-chain-import' });
    try {
      const store = await new CredentialStore(HOME).init();
      console.log(JSON.stringify(await store.importRelayChains({ chains, actor: 'cli' }), null, 2));
    } finally {
      await lock.release();
    }
    return;
  }

  if (!['init-key', 'import-codex', 'checkpoint-metrics'].includes(command)) {
    if (command === 'list') {
      const store = await new CredentialStore(HOME).init();
      // `status` in the stored row is only refreshed by requests that reach
      // upstream, so an expired or quarantined Codex credential reads `healthy`
      // here forever. Overlay the same public health surface the dashboard
      // uses, and keep the stored value alongside it as `cached_status` so the
      // two can be told apart when they disagree.
      const accounts = await Promise.all(store.publicAccounts().map(async (account) => {
        const external = await externalAccountStatus(store.accountById(account.id));
        if (typeof external.status !== 'string') return account;
        return {
          ...account,
          status: external.status,
          cached_status: account.status,
          expires_at: external.expires_at ?? account.expires_at,
          refresh_health_status: external.refresh_health_status ?? null,
          quarantined: external.refresh_health?.quarantine?.present ?? null,
        };
      }));
      console.log(JSON.stringify(accounts, null, 2));
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
