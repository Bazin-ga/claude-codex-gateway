import { createHash } from 'node:crypto';
import { randomToken } from './security.js';

/**
 * Google AI Pro / Ultra (the "Gemini subscription"), reached the way the
 * Antigravity Hub reaches it.
 *
 * Gemini CLI stopped serving consumer plans in June 2026; the Antigravity
 * client is now the only Google client a Pro or Ultra plan works in. So this
 * console signs in as Antigravity does and speaks to the same Cloud Code
 * backend (`v1internal`) it speaks to. None of this is published: the client
 * id, scopes, endpoint, headers and metadata below were read out of the open
 * source clients that carry this traffic (opencode-antigravity-auth,
 * antigravity-claude-proxy) and cross-checked between them. Treat them as
 * measurements, like the Codex constants.
 *
 * Google's terms do not allow a consumer plan to be used through a third-party
 * proxy, and accounts doing so have been suspended in waves (Feb 2026, Nov
 * 2026). This file makes the traffic look like the Hub's as far as it can; it
 * cannot make it the Hub's. The operator who signs an account in here has
 * accepted that risk for that account.
 */
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://www.googleapis.com/oauth2/v1/userinfo?alt=json';
/**
 * The Hub's OAuth client. Google ships its id and "installed application"
 * secret inside every desktop copy and does not treat them as confidential,
 * but the repository's secret scanning does, so they come from the
 * deployment's environment rather than from this file. Read on each use, so a
 * console started without them fails at sign-in with the reason instead of at
 * start-up.
 */
export function geminiOAuthClient(env = process.env) {
  const clientId = String(env.CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_ID ?? '').trim();
  const clientSecret = String(env.CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_SECRET ?? '').trim();
  if (!clientId || !clientSecret) {
    const error = new Error('Gemini sign-in is not configured on this console: set CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_ID and CREDENTIAL_CONSOLE_GEMINI_OAUTH_CLIENT_SECRET to the Antigravity client');
    error.code = 'GEMINI_OAUTH_UNCONFIGURED';
    throw error;
  }
  return { clientId, clientSecret };
}
/**
 * The Hub listens here during its own sign-in. The client id is registered
 * against this address, so — as with Codex — the browser is sent to a port
 * nothing is listening on, and the code is read out of the address bar.
 */
const REDIRECT_URI = 'http://localhost:51121/oauth-callback';
const SCOPES = [
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

/** The Hub's own host. The prod host also answers, but the Hub does not use it. */
export const GEMINI_UPSTREAM_BASE_URL = 'https://daily-cloudcode-pa.googleapis.com';

/**
 * The Hub publishes its current release in its auto-updater manifest, and
 * Cloud Code withholds newer models from a client that reports an old one. The
 * version is read from there; this is only the answer when it cannot be.
 */
const VERSION_MANIFEST_URL = 'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app/manifest/latest-arm64-mac.yml';
const FALLBACK_VERSION = '2.36.0';
const VERSION_TTL_MS = 6 * 60 * 60_000;
// The manifest is for arm64 macOS, so the client claims to be one.
const HUB_PLATFORM = 'os_type=darwin; arch=arm64';

let hubVersion = process.env.CREDENTIAL_CONSOLE_ANTIGRAVITY_VERSION || FALLBACK_VERSION;
let hubVersionCheckedAt = process.env.CREDENTIAL_CONSOLE_ANTIGRAVITY_VERSION ? Infinity : 0;
let hubVersionLookup = null;

/**
 * Refresh the reported Hub version at most every six hours. Never throws and
 * never blocks a request for long: a failed read keeps the last answer.
 */
export async function refreshHubVersion({ fetchImpl = fetch, now = Date.now } = {}) {
  if (now() - hubVersionCheckedAt < VERSION_TTL_MS) return hubVersion;
  hubVersionLookup ??= (async () => {
    try {
      const response = await fetchImpl(VERSION_MANIFEST_URL, { signal: AbortSignal.timeout(5_000) });
      const text = response.ok ? await response.text() : '';
      const match = /^version:\s*['"]?(\d+\.\d+\.\d+)/m.exec(text);
      if (match) hubVersion = match[1];
    } catch {
      // Keep the previous version.
    } finally {
      hubVersionCheckedAt = now();
      hubVersionLookup = null;
    }
    return hubVersion;
  })();
  return hubVersionLookup;
}

export function hubUserAgent(version = hubVersion) {
  return `antigravity/hub/${version} (aidev_client; ${HUB_PLATFORM})`;
}

/** The Hub sends its User-Agent and nothing else that identifies a client. */
export function geminiUpstreamHeaders(accessToken, { accept = 'application/json' } = {}) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    Accept: accept,
    'User-Agent': hubUserAgent(),
  };
}

export function createGeminiAuthorizationRequest({ emailLabel = '' } = {}) {
  const verifier = randomToken(64);
  const state = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const { clientId } = geminiOAuthClient();
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', SCOPES.join(' '));
  // Both are needed for a refresh token: offline asks for one, consent makes
  // Google issue it again for an account that has signed in before.
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  if (emailLabel) url.searchParams.set('login_hint', emailLabel);
  return { url: url.toString(), verifier, state };
}

async function tokenRequest(params, { fetchImpl, tokenUrl }) {
  const { clientId, clientSecret } = geminiOAuthClient();
  let response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    const reason = error.cause?.code ?? error.cause?.message ?? error.message;
    const wrapped = new Error(`could not reach ${new URL(tokenUrl).origin}: ${reason}`);
    wrapped.code = 'UNREACHABLE';
    throw wrapped;
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The status alone still makes a safe operator-facing error.
  }
  if (!response.ok) {
    const reason = body?.error_description ?? body?.error;
    const error = new Error(`Google token request failed (${response.status})${typeof reason === 'string' ? `: ${reason.slice(0, 200)}` : ''}`);
    // invalid_grant is Google's one answer for a refresh token that is gone for
    // good: revoked, expired by disuse, or the password changed.
    error.code = body?.error === 'invalid_grant' ? 'INVALID_GRANT' : 'TOKEN_REQUEST_FAILED';
    error.httpStatus = response.status;
    throw error;
  }
  return body ?? {};
}

function accessTokenFrom(body, now) {
  const accessToken = body?.access_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Google did not return an access token');
  }
  const expiresIn = Number(body.expires_in ?? 3600);
  return {
    accessToken,
    expiresAtMs: now() + (Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 3600) * 1000,
  };
}

export async function completeGeminiAuthorization({
  code,
  verifier,
  fetchImpl = fetch,
  tokenUrl = TOKEN_URL,
  now = Date.now,
}) {
  const body = await tokenRequest({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  }, { fetchImpl, tokenUrl });
  const refreshToken = body.refresh_token;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new Error('Google did not return a refresh token; start again and grant offline access');
  }
  return { refreshToken, ...accessTokenFrom(body, now) };
}

export async function refreshGeminiAccessToken({
  refreshToken,
  fetchImpl = fetch,
  tokenUrl = TOKEN_URL,
  now = Date.now,
}) {
  const body = await tokenRequest({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, { fetchImpl, tokenUrl });
  return accessTokenFrom(body, now);
}

export async function fetchGeminiUserEmail({ accessToken, fetchImpl = fetch, userinfoUrl = USERINFO_URL }) {
  const response = await fetchImpl(userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`Google account lookup failed (${response.status})`);
  const body = await response.json().catch(() => null);
  const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email) throw new Error('Google did not return the account email');
  return email;
}

function projectIdFrom(value) {
  if (typeof value === 'string' && value) return value;
  if (value && typeof value.id === 'string' && value.id) return value.id;
  return null;
}

/** `g1-ultra-tier` → `ultra`. Shown on the account card; nothing depends on it. */
export function geminiPlanFrom(loadCodeAssist) {
  const id = String(loadCodeAssist?.paidTier?.id ?? loadCodeAssist?.currentTier?.id ?? '').toLowerCase();
  if (!id) return null;
  if (id.includes('ultra')) return 'ultra';
  if (id.includes('pro') || id === 'standard-tier') return 'pro';
  if (id.includes('free')) return 'free';
  return id.slice(0, 40);
}

async function cloudCode(method, body, { accessToken, fetchImpl, baseUrl, headers = {}, timeoutMs = 20_000 }) {
  const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/v1internal:${method}`, {
    method: 'POST',
    headers: { ...geminiUpstreamHeaders(accessToken), ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await response.text().catch(() => '');
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    // Reported by status below.
  }
  if (!response.ok) {
    const message = parsed?.error?.message ?? text.slice(0, 200);
    const error = new Error(`Cloud Code ${method} failed (${response.status})${message ? `: ${String(message).slice(0, 300)}` : ''}`);
    error.httpStatus = response.status;
    error.code = isTermsOfServiceBan(response.status, message) ? 'ACCOUNT_SUSPENDED' : 'CLOUD_CODE_FAILED';
    throw error;
  }
  return parsed ?? {};
}

/**
 * The shape Google's suspension takes: a 403 whose message says the service
 * was disabled for a terms violation. Worth its own name on the account card,
 * because nothing an operator does on this side fixes it.
 */
export function isTermsOfServiceBan(status, message) {
  const text = String(message ?? '').toLowerCase();
  return status === 403 && text.includes('disabled') && text.includes('terms of service');
}

/**
 * The managed project Cloud Code bills this account's turns to. Every
 * generate call names it. A plan that has never been used has none yet, and
 * onboarding creates it; that can take a few polls.
 */
export async function discoverGeminiProject({
  accessToken,
  fetchImpl = fetch,
  baseUrl = GEMINI_UPSTREAM_BASE_URL,
  pollDelayMs = 3_000,
  attempts = 8,
}) {
  await refreshHubVersion({ fetchImpl });
  const loaded = await cloudCode('loadCodeAssist', { metadata: { ideType: 'ANTIGRAVITY' } }, {
    accessToken, fetchImpl, baseUrl,
  });
  const plan = geminiPlanFrom(loaded);
  const existing = projectIdFrom(loaded.cloudaicompanionProject);
  if (existing) return { projectId: existing, plan };
  const allowed = Array.isArray(loaded.allowedTiers) ? loaded.allowedTiers : [];
  const tierId = allowed.find((tier) => tier?.isDefault)?.id ?? allowed[0]?.id ?? loaded.currentTier?.id ?? 'free-tier';
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const onboarded = await cloudCode('onboardUser', {
      tier_id: tierId,
      metadata: { ide_type: 'ANTIGRAVITY', ide_version: hubVersion, ide_name: 'antigravity' },
    }, {
      accessToken,
      fetchImpl,
      baseUrl,
      headers: { 'User-Agent': `${hubUserAgent()} google-api-nodejs-client/10.3.0`, 'X-Goog-Api-Client': 'gl-node/22.21.1' },
    });
    const projectId = projectIdFrom(onboarded.response?.cloudaicompanionProject);
    if (onboarded.done && projectId) return { projectId, plan };
    if (attempt < attempts - 1) await new Promise((resolve) => setTimeout(resolve, pollDelayMs));
  }
  throw new Error('Google did not finish setting up this account for Antigravity; try again in a minute');
}

/**
 * The models this account may call, each with its remaining quota. One call
 * answers both questions, so the proxy's model list and the card's quota come
 * from the same reading.
 */
export async function fetchGeminiModels({
  accessToken,
  projectId,
  fetchImpl = fetch,
  baseUrl = GEMINI_UPSTREAM_BASE_URL,
}) {
  await refreshHubVersion({ fetchImpl });
  const body = await cloudCode('fetchAvailableModels', projectId ? { project: projectId } : {}, {
    accessToken, fetchImpl, baseUrl,
  });
  const models = body?.models && typeof body.models === 'object' ? body.models : {};
  return Object.entries(models).map(([id, info]) => {
    const quota = info?.quotaInfo ?? null;
    const fraction = Number(quota?.remainingFraction);
    return {
      id,
      displayName: typeof info?.displayName === 'string' ? info.displayName : id,
      inputTokenLimit: Number.isSafeInteger(info?.maxTokens) ? info.maxTokens : null,
      outputTokenLimit: Number.isSafeInteger(info?.maxOutputTokens) ? info.maxOutputTokens : null,
      // A reset time with no fraction is how an exhausted model is reported.
      remainingFraction: Number.isFinite(fraction)
        ? Math.min(1, Math.max(0, fraction))
        : quota?.resetTime ? 0 : null,
      resetTime: typeof quota?.resetTime === 'string' ? quota.resetTime : null,
    };
  });
}

/**
 * Short-lived access tokens, minted from the stored refresh token and held in
 * memory only. Google's refresh tokens do not rotate, so — unlike Codex — there
 * is no single-use chain to protect and no need for a separate refresh centre:
 * two processes refreshing the same token both get a valid answer.
 */
export class GeminiTokenCache {
  constructor({ store, fetchImpl = fetch, now = Date.now, refresh = refreshGeminiAccessToken } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.refresh = refresh;
    this.tokens = new Map();
    this.inFlight = new Map();
  }

  forget(accountId) {
    this.tokens.delete(accountId);
  }

  /** `{ accessToken, projectId }`, refreshed when under five minutes remain. */
  async credentialFor(accountId) {
    const stored = this.store.accountCredential(accountId);
    if (!stored?.refresh_token) {
      const error = new Error('account has no stored Gemini credential');
      error.code = 'LOGIN_REQUIRED';
      throw error;
    }
    const cached = this.tokens.get(accountId);
    if (cached && cached.refreshToken === stored.refresh_token && cached.expiresAtMs - this.now() > 5 * 60_000) {
      return { accessToken: cached.accessToken, projectId: stored.project_id ?? null };
    }
    let pending = this.inFlight.get(accountId);
    if (!pending) {
      pending = this.refresh({ refreshToken: stored.refresh_token, fetchImpl: this.fetchImpl, now: this.now })
        .then((minted) => {
          this.tokens.set(accountId, { ...minted, refreshToken: stored.refresh_token });
          return minted;
        })
        .finally(() => this.inFlight.delete(accountId));
      this.inFlight.set(accountId, pending);
    }
    const minted = await pending;
    return { accessToken: minted.accessToken, projectId: stored.project_id ?? null };
  }
}

export const GEMINI_OAUTH_DEFAULTS = Object.freeze({
  authorizeUrl: AUTHORIZE_URL,
  tokenUrl: TOKEN_URL,
  redirectUri: REDIRECT_URI,
  scopes: SCOPES,
});
