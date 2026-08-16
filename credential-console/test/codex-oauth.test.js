import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import {
  CODEX_OAUTH_DEFAULTS,
  buildCodexAuthJson,
  codexIdentityFrom,
  completeCodexAuthorization,
  createCodexAuthorizationRequest,
  parseCodexAuthorizationRedirect,
} from '../lib/codex-oauth.js';
import { syntheticCodexTokens, syntheticJwt } from './codex-token-fixture.js';

test('creates a PKCE authorization URL with the parameters the codex CLI itself sends', () => {
  const request = createCodexAuthorizationRequest();
  const url = new URL(request.url);
  // Literals, not the module's own constants: these were measured out of the
  // codex-cli binary, so a test that moves with the source pins nothing.
  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), 'app_EMoamEEZ73f0CkXaXp7hrann');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://localhost:1455/auth/callback');
  assert.equal(url.searchParams.get('scope'), 'openid profile email offline_access');
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(url.searchParams.get('state'), request.state);
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(
    url.searchParams.get('code_challenge'),
    createHash('sha256').update(request.verifier).digest('base64url'),
  );
  assert.ok(request.verifier.length > 40);
  assert.notEqual(createCodexAuthorizationRequest().verifier, request.verifier);
  assert.deepEqual(CODEX_OAUTH_DEFAULTS, {
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    revokeUrl: 'https://auth.openai.com/oauth/revoke',
    clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
    redirectUri: 'http://localhost:1455/auth/callback',
    scope: 'openid profile email offline_access',
    accountIdClaimPath: 'https://api.openai.com/auth.chatgpt_account_id',
  });
});

test('accepts a bare code, the failed localhost address, or the address without its origin', () => {
  assert.deepEqual(parseCodexAuthorizationRedirect('  bare-code-value  '), {
    code: 'bare-code-value',
    state: null,
  });
  assert.deepEqual(
    parseCodexAuthorizationRedirect('http://localhost:1455/auth/callback?code=abc123&state=xyz789'),
    { code: 'abc123', state: 'xyz789' },
  );
  assert.deepEqual(
    parseCodexAuthorizationRedirect('/auth/callback?state=xyz789&code=abc123#ignored'),
    { code: 'abc123', state: 'xyz789' },
  );
  assert.throws(() => parseCodexAuthorizationRedirect('   '), /paste the authorization code/);
  assert.throws(
    () => parseCodexAuthorizationRedirect('http://localhost:1455/auth/callback?state=xyz789'),
    /no code parameter/,
  );
  assert.throws(
    () => parseCodexAuthorizationRedirect('code with spaces'),
    /unexpected characters/,
  );
  assert.throws(
    () => parseCodexAuthorizationRedirect(
      'http://localhost:1455/auth/callback?error=access_denied&error_description=user+refused',
    ),
    /refused upstream: user refused/,
  );
});

test('exchanges the code as a form post and returns the token set', async () => {
  const requests = [];
  const tokens = syntheticCodexTokens();
  const exchanged = await completeCodexAuthorization({
    code: 'browser-code',
    verifier: 'pkce-verifier',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://auth.openai.com/oauth/token');
  assert.equal(requests[0].options.headers['Content-Type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(requests[0].options.body)),
    {
      grant_type: 'authorization_code',
      code: 'browser-code',
      redirect_uri: 'http://localhost:1455/auth/callback',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      code_verifier: 'pkce-verifier',
    },
  );
  assert.equal(exchanged.idToken, tokens.idToken);
  assert.equal(exchanged.accessToken, tokens.accessToken);
  assert.equal(exchanged.refreshToken, tokens.refreshToken);
});

test('refuses an exchange that cannot be rotated later or identified now', async () => {
  const tokens = syntheticCodexTokens();
  const respondWith = (payload, status = 200) => async () => new Response(
    JSON.stringify(payload),
    { status, headers: { 'Content-Type': 'application/json' } },
  );
  await assert.rejects(
    completeCodexAuthorization({
      code: 'c',
      verifier: 'v',
      fetchImpl: respondWith({ error: 'invalid_grant', error_description: 'code expired' }, 400),
    }),
    /Codex authorization exchange failed \(400\): code expired/,
  );
  await assert.rejects(
    completeCodexAuthorization({
      code: 'c',
      verifier: 'v',
      fetchImpl: respondWith({ access_token: tokens.accessToken, id_token: tokens.idToken }),
    }),
    /did not return a refresh token/,
  );
  await assert.rejects(
    completeCodexAuthorization({
      code: 'c',
      verifier: 'v',
      fetchImpl: respondWith({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      }),
    }),
    /did not return an id token/,
  );
});

test('names the endpoint it could not reach instead of surfacing a bare fetch failure', async () => {
  const unreachable = Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('getaddrinfo ENOTFOUND auth.openai.com'), { code: 'ENOTFOUND' }),
  });
  await assert.rejects(
    completeCodexAuthorization({
      code: 'c',
      verifier: 'v',
      fetchImpl: async () => { throw unreachable; },
    }),
    /could not reach https:\/\/auth\.openai\.com: ENOTFOUND/,
  );
});

test('assembles the auth.json the CLI and the refresh center read, with the account id from the id_token', () => {
  const tokens = syntheticCodexTokens();
  const now = new Date('2026-08-16T09:30:00.000Z');
  const credential = buildCodexAuthJson(tokens, { now });
  assert.deepEqual(credential, {
    OPENAI_API_KEY: null,
    auth_mode: 'chatgpt',
    tokens: {
      id_token: tokens.idToken,
      access_token: tokens.accessToken,
      refresh_token: tokens.refreshToken,
      account_id: tokens.accountId,
    },
    last_refresh: now.toISOString(),
  });
  assert.deepEqual(codexIdentityFrom(tokens.idToken), {
    accountId: tokens.accountId,
    email: tokens.email,
    planType: 'plus',
  });
});

test('refuses an id_token without a ChatGPT account id rather than inventing one', () => {
  assert.throws(
    () => codexIdentityFrom(syntheticJwt({ email: 'owner@example.com' })),
    /no ChatGPT account id/,
  );
  assert.throws(() => codexIdentityFrom('not-a-jwt'), /could not be decoded/);
});
