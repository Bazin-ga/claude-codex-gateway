import { randomBytes } from 'node:crypto';
import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const CACHE_VERSION = 1;
const DEFAULT_REFRESH_MS = 60 * 60_000;
const MIN_REFRESH_MS = 60_000;
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

class UsageFetchError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function percent(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return null;
  return Math.round(Math.min(100, Math.max(0, numeric)) * 10) / 10;
}

function remainingPercent(used) {
  return Math.round((100 - used) * 10) / 10;
}

function resetIso(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value * 1000).toISOString();
  }
  if (typeof value === 'string' && Number.isFinite(Date.parse(value))) {
    return new Date(value).toISOString();
  }
  return null;
}

function windowKind(seconds, fallback) {
  const duration = Number(seconds);
  if (Number.isFinite(duration)) {
    if (duration >= 4 * 60 * 60 && duration <= 6 * 60 * 60) return 'five_hour';
    if (duration >= 6 * 24 * 60 * 60 && duration <= 8 * 24 * 60 * 60) return 'weekly';
  }
  return fallback;
}

function normalizedWindow(kind, used, resetsAt, durationSeconds = null) {
  const usedPercent = percent(used);
  if (usedPercent === null) return null;
  return {
    kind,
    used_percent: usedPercent,
    remaining_percent: remainingPercent(usedPercent),
    resets_at: resetIso(resetsAt),
    duration_seconds: Number.isFinite(Number(durationSeconds)) ? Number(durationSeconds) : null,
  };
}

async function responseJson(response, provider) {
  let body = null;
  try {
    body = await response.json();
  } catch {
    // Status and provider are sufficient for the safe cached error below.
  }
  if (response.ok) return body ?? {};
  const message = String(body?.error?.message ?? body?.error ?? '');
  if (provider === 'claude' && response.status === 403 && message.includes('user:profile')) {
    throw new UsageFetchError('reauthorization_required');
  }
  if (response.status === 401 || response.status === 403) {
    throw new UsageFetchError('authentication_failed');
  }
  throw new UsageFetchError(`upstream_${response.status}`);
}

export async function fetchClaudeUsage({ oauthToken, fetchImpl = fetch }) {
  const response = await fetchImpl(CLAUDE_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Anthropic-Beta': 'oauth-2025-04-20',
      'User-Agent': 'claude-code',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await responseJson(response, 'claude');
  const windows = [
    normalizedWindow('five_hour', body.five_hour?.utilization, body.five_hour?.resets_at),
    normalizedWindow('weekly', body.seven_day?.utilization, body.seven_day?.resets_at),
  ].filter(Boolean);
  if (!windows.length) throw new UsageFetchError('usage_not_reported');
  return {
    provider: 'claude',
    status: 'available',
    fetched_at: new Date().toISOString(),
    plan_type: null,
    windows,
  };
}

export async function fetchCodexUsage({ accessToken, accountId, fetchImpl = fetch }) {
  const response = await fetchImpl(CODEX_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'ChatGPT-Account-Id': accountId,
      'User-Agent': 'codex-cli',
    },
    signal: AbortSignal.timeout(15_000),
  });
  const body = await responseJson(response, 'codex');
  const rateLimit = body.rate_limit ?? {};
  const windows = [
    ['primary', rateLimit.primary_window],
    ['secondary', rateLimit.secondary_window],
  ].flatMap(([fallback, value]) => {
    if (!value) return [];
    const kind = windowKind(value.limit_window_seconds, fallback);
    const window = normalizedWindow(
      kind,
      value.used_percent,
      value.reset_at,
      value.limit_window_seconds,
    );
    return window ? [window] : [];
  });
  if (!windows.length) throw new UsageFetchError('usage_not_reported');
  return {
    provider: 'codex',
    status: 'available',
    fetched_at: new Date().toISOString(),
    plan_type: typeof body.plan_type === 'string' ? body.plan_type : null,
    windows,
  };
}

async function writeAtomic(path, content) {
  const temporary = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    created = true;
    await rename(temporary, path);
    await chmod(path, 0o600);
  } finally {
    if (created) await unlink(temporary).catch(() => {});
  }
}

function unavailableSnapshot(account, code, previous = null) {
  const keepPrevious = previous?.windows?.length > 0;
  return {
    ...(keepPrevious ? previous : { provider: account.provider, windows: [] }),
    status: keepPrevious ? 'stale' : code === 'reauthorization_required'
      ? 'reauthorization_required'
      : code === 'authorization_required'
        ? 'authorization_required'
        : 'unavailable',
    attempted_at: new Date().toISOString(),
    last_error: code,
  };
}

export class UsageMonitor {
  constructor({
    store,
    home,
    fetchImpl = fetch,
    refreshIntervalMs = DEFAULT_REFRESH_MS,
    log = () => {},
  }) {
    this.store = store;
    this.cachePath = join(home, 'usage.json');
    this.fetchImpl = fetchImpl;
    this.refreshIntervalMs = Number.isFinite(Number(refreshIntervalMs))
      ? Math.max(MIN_REFRESH_MS, Number(refreshIntervalMs))
      : DEFAULT_REFRESH_MS;
    this.log = log;
    this.snapshots = new Map();
    this.timer = null;
    this.inFlight = null;
  }

  async init() {
    try {
      const cached = JSON.parse(await readFile(this.cachePath, 'utf8'));
      if (cached.version === CACHE_VERSION && cached.accounts) {
        this.snapshots = new Map(Object.entries(cached.accounts));
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('usage_cache_read_failed', { code: error.code ?? 'invalid' });
    }
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, this.refreshIntervalMs);
    this.timer.unref();
    this.refresh().catch(() => {});
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  snapshotForAccount(accountId) {
    return this.snapshots.get(accountId) ?? null;
  }

  async refresh() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      const accounts = this.store.publicAccounts();
      await Promise.all(accounts.map((account) => this.#refreshAccount(account)));
      const currentIds = new Set(accounts.map((account) => account.id));
      for (const accountId of this.snapshots.keys()) {
        if (!currentIds.has(accountId)) this.snapshots.delete(accountId);
      }
      await this.#persist();
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  async refreshAccount(accountId) {
    const account = this.store.publicAccounts().find((entry) => entry.id === accountId);
    if (!account) return null;
    await this.#refreshAccount(account);
    await this.#persist();
    return this.snapshotForAccount(accountId);
  }

  async #refreshAccount(account) {
    const previous = this.snapshots.get(account.id) ?? null;
    try {
      let snapshot;
      if (account.provider === 'claude') {
        const credential = this.store.accountCredential(account.id);
        if (!credential?.oauth_token) throw new UsageFetchError('login_required');
        snapshot = await fetchClaudeUsage({
          oauthToken: credential.oauth_token,
          fetchImpl: this.fetchImpl,
        });
      } else if (account.provider === 'codex') {
        const internal = this.store.accountById(account.id);
        if (internal?.external?.kind !== 'codex-credential') {
          // Registered but never authorized. That is the expected state of a row
          // the dashboard just created, not a failure to report in red.
          throw new UsageFetchError('authorization_required');
        }
        const current = JSON.parse(
          await readFile(`${internal.external.home}/public/current.json`, 'utf8'),
        );
        if (!current.access_token || !current.account_id) {
          throw new UsageFetchError('credential_unavailable');
        }
        snapshot = await fetchCodexUsage({
          accessToken: current.access_token,
          accountId: current.account_id,
          fetchImpl: this.fetchImpl,
        });
      } else {
        throw new UsageFetchError('unsupported_provider');
      }
      this.snapshots.set(account.id, snapshot);
      this.log('account_usage_refreshed', {
        account_id: account.id,
        provider: account.provider,
        windows: snapshot.windows.map((window) => window.kind),
      });
    } catch (error) {
      const code = error instanceof UsageFetchError
        ? error.code
        : error.name === 'TimeoutError' || error.name === 'AbortError'
          ? 'timeout'
          : 'fetch_failed';
      this.snapshots.set(account.id, unavailableSnapshot(account, code, previous));
      this.log('account_usage_refresh_failed', {
        account_id: account.id,
        provider: account.provider,
        code,
      });
    }
  }

  async #persist() {
    const payload = {
      version: CACHE_VERSION,
      accounts: Object.fromEntries(this.snapshots),
    };
    await writeAtomic(this.cachePath, `${JSON.stringify(payload, null, 2)}\n`);
  }
}

export const USAGE_DEFAULTS = Object.freeze({
  claudeUrl: CLAUDE_USAGE_URL,
  codexUrl: CODEX_USAGE_URL,
  refreshIntervalMs: DEFAULT_REFRESH_MS,
});
