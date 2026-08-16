import { createHash } from 'node:crypto';
import { randomToken } from './security.js';

const AUTHORIZE_URL = 'https://claude.com/cai/oauth/authorize';
const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';
const REQUIRED_SCOPES = 'user:inference user:profile';
const ONE_YEAR_SECONDS = 31_536_000;

export function createClaudeAuthorizationRequest({ emailLabel = '' } = {}) {
  const verifier = randomToken(64);
  const state = randomToken(32);
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set('code', 'true');
  url.searchParams.set('client_id', CLIENT_ID);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', REDIRECT_URI);
  url.searchParams.set('scope', REQUIRED_SCOPES);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  url.searchParams.set('state', state);
  if (emailLabel) url.searchParams.set('login_hint', emailLabel);
  return { url: url.toString(), verifier, state };
}

export function parseClaudeAuthorizationCode(value) {
  const input = String(value ?? '').trim();
  const separator = input.lastIndexOf('#');
  if (separator <= 0 || separator === input.length - 1) {
    throw new Error('paste the complete authorization code, including # and the state after it');
  }
  const code = input.slice(0, separator);
  const state = input.slice(separator + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(code) || !/^[A-Za-z0-9_-]+$/.test(state)) {
    throw new Error('authorization code contains unexpected characters');
  }
  return { code, state };
}

export async function exchangeClaudeAuthorization({
  code,
  state,
  verifier,
  fetchImpl = fetch,
  tokenUrl = TOKEN_URL,
}) {
  const response = await fetchImpl(tokenUrl, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: CLIENT_ID,
      code_verifier: verifier,
      state,
      expires_in: ONE_YEAR_SECONDS,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    // The status remains sufficient for a safe operator-facing error.
  }
  if (!response.ok) {
    const reason = body?.error_description ?? body?.error?.message ?? body?.error;
    const suffix = typeof reason === 'string' ? `: ${reason.slice(0, 200)}` : '';
    throw new Error(`Claude authorization exchange failed (${response.status})${suffix}`);
  }
  const accessToken = body?.access_token;
  if (typeof accessToken !== 'string' || !accessToken.startsWith('sk-ant-oat')) {
    throw new Error('Claude authorization did not return a valid inference token');
  }
  const expiresIn = Number(body?.expires_in ?? ONE_YEAR_SECONDS);
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new Error('Claude authorization returned an invalid expiry');
  }
  return {
    accessToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    emailAddress: body?.account?.email_address ?? body?.account?.email ?? null,
    scope: body?.scope ?? REQUIRED_SCOPES,
  };
}

export const CLAUDE_OAUTH_DEFAULTS = Object.freeze({
  authorizeUrl: AUTHORIZE_URL,
  tokenUrl: TOKEN_URL,
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  scope: REQUIRED_SCOPES,
  expiresIn: ONE_YEAR_SECONDS,
});
