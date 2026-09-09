import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const DEFAULT_REFRESH_INTERVAL_MS = 6 * 60 * 60_000;
const REFRESH_SCRIPT = fileURLToPath(new URL(
  '../../codex-credential/refresh-center/refresh.js',
  import.meta.url,
));

function canonical(value) {
  return value ? resolvePath(String(value)) : null;
}

function managedHome(managedRoot, accountId) {
  const root = canonical(managedRoot);
  if (!root) return null;
  if (typeof accountId !== 'string' || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error('Codex account id cannot be used as a managed credential directory');
  }
  return join(root, accountId);
}

export function validateManagedCodexRoot(managedRoot, consoleHome) {
  const root = canonical(managedRoot);
  const home = canonical(consoleHome);
  if (!root) return null;
  if (!home) throw new Error('credential console home is required for a managed Codex root');
  const child = relative(home, root);
  if (!child || child === '..' || child.startsWith(`..${sep}`)
    || isAbsolute(child)) {
    throw new Error('managed Codex root must be a child of CREDENTIAL_CONSOLE_HOME');
  }
  return root;
}

/**
 * Pick the one credential home an account may write.
 *
 * An existing binding is writable only when an explicit writer mode covers its
 * exact path, so a read-only import cannot silently become writable. New
 * accounts use a stable path below the managed root. The historical single-home
 * setting remains the final fallback for deployments that have not opted into
 * managed accounts.
 */
export function codexSeedHomeForAccount(account, {
  managedRoot = null,
  legacySeedHome = null,
} = {}) {
  if (!account || account.provider !== 'codex') return null;
  if (account.external?.kind === 'codex-credential' && account.external.home) {
    const bound = canonical(account.external.home);
    const managed = managedRoot && bound === managedHome(managedRoot, account.id);
    const legacy = legacySeedHome && bound === canonical(legacySeedHome);
    // An imported home is read-only unless an explicit writer mode covers that
    // exact path. Merely having an external pointer must never grant write
    // authority or turn a manual auth.json handoff into an in-place seed.
    if (managed || legacy) return bound;
    if (!managedRoot && legacySeedHome) return canonical(legacySeedHome);
    return null;
  }
  return managedHome(managedRoot, account.id) ?? canonical(legacySeedHome);
}

/** A managed binding is exact, not merely somewhere below the root. */
export function isManagedCodexHome(account, managedRoot) {
  if (!account || account.provider !== 'codex') return false;
  if (account.external?.kind !== 'codex-credential' || !account.external.home) return false;
  return canonical(account.external.home) === managedHome(managedRoot, account.id);
}

export async function refreshManagedCodexHome(home, {
  execFileImpl = execFileAsync,
} = {}) {
  await execFileImpl(process.execPath, [REFRESH_SCRIPT], {
    env: { ...process.env, CODEX_CRED_HOME: home },
    timeout: 5 * 60_000,
    maxBuffer: 1024 * 1024,
  });
  const current = JSON.parse(await readFile(join(home, 'public', 'current.json'), 'utf8'));
  const expiresAtMs = Date.parse(String(current?.expires_at ?? ''));
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error('managed Codex refresh produced no valid published expiry');
  }
  return { expiresAt: new Date(expiresAtMs).toISOString() };
}

/**
 * Refresh only credentials created below the managed root. Imported/legacy
 * homes keep their existing timers, which prevents enabling this scheduler from
 * ever racing the refresh process that already owns codex-shared-1.
 */
export class CodexManagedDomainRefresher {
  constructor({
    accounts,
    managedRoot,
    intervalMs = DEFAULT_REFRESH_INTERVAL_MS,
    refreshHome = refreshManagedCodexHome,
    recordExpiry = async () => {},
    log = () => {},
  }) {
    if (typeof accounts !== 'function') throw new Error('managed Codex accounts reader is required');
    this.accounts = accounts;
    this.managedRoot = canonical(managedRoot);
    this.intervalMs = Number.isFinite(intervalMs) && intervalMs > 0
      ? intervalMs
      : DEFAULT_REFRESH_INTERVAL_MS;
    this.refreshHome = refreshHome;
    this.recordExpiry = recordExpiry;
    this.log = log;
    this.timer = null;
    this.startupTimer = null;
    this.running = null;
  }

  start() {
    if (!this.managedRoot || this.timer) return;
    this.timer = setInterval(() => {
      this.runNow().catch(() => {});
    }, this.intervalMs);
    this.timer.unref?.();
    // A process that restarts more often than the interval must still make
    // progress. The refresh entrypoint is expiry-aware, so this early check does
    // not rotate a healthy token merely because the console restarted.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      this.runNow().catch(() => {});
    }, Math.min(60_000, this.intervalMs));
    this.startupTimer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.timer = null;
    this.startupTimer = null;
  }

  async runNow() {
    if (!this.managedRoot) return { refreshed: [], failed: [] };
    if (this.running) return this.running;
    this.running = this.#run();
    try {
      return await this.running;
    } finally {
      this.running = null;
    }
  }

  async #run() {
    const refreshed = [];
    const failed = [];
    const accounts = this.accounts();
    for (const account of Array.isArray(accounts) ? accounts : []) {
      if (!isManagedCodexHome(account, this.managedRoot)) continue;
      try {
        const result = await this.refreshHome(canonical(account.external.home), account);
        if (result?.expiresAt) await this.recordExpiry(account.id, result.expiresAt);
        refreshed.push(account.id);
        this.log('codex_managed_refresh_completed', { account_id: account.id });
      } catch (error) {
        failed.push(account.id);
        this.log('codex_managed_refresh_failed', {
          account_id: account.id,
          code: error?.code ?? error?.name ?? 'unknown',
        });
      }
    }
    return { refreshed, failed };
  }
}
