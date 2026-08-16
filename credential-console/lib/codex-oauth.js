import { createHash } from 'node:crypto';
import { randomToken } from './security.js';

/**
 * The Codex (ChatGPT subscription) authorization-code flow.
 *
 * These parameters were read out of the codex-cli 0.138.0 binary and confirmed
 * against a real credential — `aud` in its id_token is the client_id below. They
 * are not published anywhere, so treat them as measurements rather than defaults
 * that can be tidied up.
 */
const AUTHORIZE_URL = 'https://auth.openai.com/oauth/authorize';
const TOKEN_URL = 'https://auth.openai.com/oauth/token';
const REVOKE_URL = 'https://auth.openai.com/oauth/revoke';
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/**
 * The CLI listens on this port during its own login. The client_id is registered
 * against exactly this value, so it cannot be pointed at the console — the
 * operator's browser will fail to connect and the code is read out of the address
 * bar instead. That is the whole reason this flow is paste-based.
 */
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const REQUIRED_SCOPES = 'openid profile email offline_access';

/** The subscription claims are namespaced; `account_id` is one key inside it. */
const CLAIM_NAMESPACE = 'https://api.openai.com/auth';

export function createCodexAuthorizationRequest() {
  const verifier = randomToken(64);
  const state = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', REQUIRED_SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Both flags come from the binary. Without the first one the id_token omits the
  // organization/subscription claims that carry the account id.
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('state', state);
  return { url: url.toString(), verifier, state };
}

/**
 * Accept whatever the operator actually has in front of them: the whole failed
 * `http://localhost:1455/...` address, the path and query alone, or a bare code
 * copied out of it. A pasted address carries the state and is verified against
 * the issued session; a bare code has none and resolves the account's one live
 * session instead.
 *
 * @returns {{ code: string, state: string | null }}
 */
export function parseCodexAuthorizationRedirect(value) {
  const input = String(value ?? '').trim().replace(/#.*$/, '');
  if (!input) {
    throw new Error('paste the authorization code, or the whole localhost address the browser failed to open');
  }
  const query = input.indexOf('?');
  if (query < 0) return { code: assertCodeShape(input), state: null };

  const params = new URLSearchParams(input.slice(query + 1));
  const refusal = params.get('error');
  if (refusal) {
    const description = params.get('error_description');
    throw new Error(`the sign-in was refused upstream: ${String(description || refusal).slice(0, 200)}`);
  }
  const code = params.get('code');
  if (!code) {
    throw new Error('that address has no code parameter; copy the complete address including everything after the ?');
  }
  const state = params.get('state');
  if (state !== null && !/^[A-Za-z0-9._~-]+$/.test(state)) {
    throw new Error('the state in that address contains unexpected characters');
  }
  return { code: assertCodeShape(code), state };
}

function assertCodeShape(code) {
  if (!/^[A-Za-z0-9._~-]+$/.test(code)) {
    throw new Error('authorization code contains unexpected characters');
  }
  return code;
}

export async function completeCodexAuthorization({
  code,
  verifier,
  fetchImpl = fetch,
  tokenUrl = TOKEN_URL,
}) {
  let response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        // RFC 6749 requires form encoding at the token endpoint, and this is what
        // the CLI sends for the authorization_code grant. The refresh grant in
        // refresh-center accepts JSON at the same URL; do not generalize from that.
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (error) {
    // Node reports a blocked or unroutable host as a bare "fetch failed", which on
    // an overlay network with no egress is the first thing an operator hits and the
    // least useful thing to show them. The cause carries the only actionable detail.
    const reason = error.cause?.code ?? error.cause?.message ?? error.message;
    throw new Error(`could not reach ${new URL(tokenUrl).origin}: ${reason}`);
  }
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The status alone still makes a safe operator-facing error.
  }
  if (!response.ok) {
    const reason = body?.error_description ?? body?.error?.message ?? body?.error;
    const suffix = typeof reason === 'string' ? `: ${reason.slice(0, 200)}` : '';
    throw new Error(`Codex authorization exchange failed (${response.status})${suffix}`);
  }
  const idToken = body?.id_token;
  const accessToken = body?.access_token;
  const refreshToken = body?.refresh_token;
  if (typeof accessToken !== 'string' || !accessToken) {
    throw new Error('Codex authorization did not return an access token');
  }
  if (typeof idToken !== 'string' || !idToken) {
    throw new Error('Codex authorization did not return an id token; the account id cannot be derived');
  }
  // Without this the credential cannot be rotated, and a center seeded from it
  // dies at the first expiry with no way back. Refuse before anything is written.
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new Error('Codex authorization did not return a refresh token; retry with offline_access granted');
  }
  return { idToken, accessToken, refreshToken };
}

/**
 * Read the subscription identity out of an id_token without verifying it.
 * Verification is the provider's job; the exchange already proved the token came
 * from it over TLS.
 */
export function codexIdentityFrom(idToken) {
  const segments = String(idToken ?? '').split('.');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(segments.at(1) ?? '', 'base64url').toString('utf8'));
  } catch {
    throw new Error('Codex id_token could not be decoded');
  }
  const accountId = claims?.[CLAIM_NAMESPACE]?.chatgpt_account_id;
  if (typeof accountId !== 'string' || !accountId) {
    throw new Error('Codex id_token carries no ChatGPT account id; that login may have no Codex subscription');
  }
  return {
    accountId,
    email: typeof claims.email === 'string' ? claims.email : null,
    planType: claims?.[CLAIM_NAMESPACE]?.chatgpt_plan_type ?? null,
  };
}

/** Assemble the exact `auth.json` the codex CLI and the refresh center both read. */
export function buildCodexAuthJson({ idToken, accessToken, refreshToken }, { now = new Date() } = {}) {
  const { accountId } = codexIdentityFrom(idToken);
  return {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: idToken,
      access_token: accessToken,
      refresh_token: refreshToken,
      account_id: accountId,
    },
    last_refresh: now.toISOString(),
  };
}

export const CODEX_OAUTH_DEFAULTS = Object.freeze({
  authorizeUrl: AUTHORIZE_URL,
  tokenUrl: TOKEN_URL,
  revokeUrl: REVOKE_URL,
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  scope: REQUIRED_SCOPES,
  accountIdClaimPath: `${CLAIM_NAMESPACE}.chatgpt_account_id`,
});
