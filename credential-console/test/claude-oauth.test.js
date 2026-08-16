import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CLAUDE_OAUTH_DEFAULTS,
  createClaudeAuthorizationRequest,
  exchangeClaudeAuthorization,
  parseClaudeAuthorizationCode,
} from '../lib/claude-oauth.js';

test('creates a PKCE authorization URL with the expected owner login hint', () => {
  const request = createClaudeAuthorizationRequest({ emailLabel: 'owner@example.com' });
  const url = new URL(request.url);
  assert.equal(url.origin + url.pathname, CLAUDE_OAUTH_DEFAULTS.authorizeUrl);
  assert.equal(url.searchParams.get('client_id'), CLAUDE_OAUTH_DEFAULTS.clientId);
  assert.equal(url.searchParams.get('redirect_uri'), CLAUDE_OAUTH_DEFAULTS.redirectUri);
  assert.equal(url.searchParams.get('scope'), 'user:inference user:profile');
  assert.equal(url.searchParams.get('state'), request.state);
  assert.equal(url.searchParams.get('login_hint'), 'owner@example.com');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('code_challenge').length > 40);
  assert.ok(request.verifier.length > 40);
});

test('parses only a complete manual authorization code', () => {
  assert.deepEqual(parseClaudeAuthorizationCode('code-value#state-value'), {
    code: 'code-value',
    state: 'state-value',
  });
  assert.throws(() => parseClaudeAuthorizationCode('missing-state'), /including #/);
  assert.throws(() => parseClaudeAuthorizationCode('code#bad state'), /unexpected characters/);
});

test('exchanges the code using Claude setup-token parameters without exposing input secrets', async () => {
  const requests = [];
  const exchanged = await exchangeClaudeAuthorization({
    code: 'browser-code',
    state: 'browser-state',
    verifier: 'pkce-verifier',
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        access_token: 'sk-ant-oat01-long-lived-token',
        expires_in: 31_536_000,
        scope: 'user:inference user:profile',
        account: { email_address: 'owner@example.com' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, CLAUDE_OAUTH_DEFAULTS.tokenUrl);
  const body = JSON.parse(requests[0].options.body);
  assert.deepEqual(body, {
    grant_type: 'authorization_code',
    code: 'browser-code',
    redirect_uri: CLAUDE_OAUTH_DEFAULTS.redirectUri,
    client_id: CLAUDE_OAUTH_DEFAULTS.clientId,
    code_verifier: 'pkce-verifier',
    state: 'browser-state',
    expires_in: 31_536_000,
  });
  assert.equal(exchanged.accessToken, 'sk-ant-oat01-long-lived-token');
  assert.equal(exchanged.emailAddress, 'owner@example.com');
  assert.equal(exchanged.scope, 'user:inference user:profile');
});

test('rejects failed exchanges and malformed access tokens', async () => {
  await assert.rejects(
    exchangeClaudeAuthorization({
      code: 'bad-code',
      state: 'state',
      verifier: 'verifier',
      fetchImpl: async () => new Response(JSON.stringify({
        error: 'invalid_grant',
      }), { status: 400, headers: { 'Content-Type': 'application/json' } }),
    }),
    /Claude authorization exchange failed \(400\): invalid_grant/,
  );
  await assert.rejects(
    exchangeClaudeAuthorization({
      code: 'code',
      state: 'state',
      verifier: 'verifier',
      fetchImpl: async () => new Response(JSON.stringify({
        access_token: 'not-an-oauth-token',
        expires_in: 100,
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    }),
    /valid inference token/,
  );
});
