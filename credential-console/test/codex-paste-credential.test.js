import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { parseCodexAuthJson } from '../lib/codex-oauth.js';

const CLAIM_NAMESPACE = 'https://api.openai.com/auth';

/** A structurally valid id_token; the signature is never checked by this path. */
function idToken({ accountId = 'acct-1234', email = 'owner@example.com', plan = 'pro' } = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({ email, [CLAIM_NAMESPACE]: { chatgpt_account_id: accountId, chatgpt_plan_type: plan } }),
    'signature',
  ].join('.');
}

function authJson(overrides = {}) {
  return JSON.stringify({
    OPENAI_API_KEY: null,
    tokens: {
      id_token: idToken(),
      access_token: 'ACCESS-TOKEN-VALUE',
      refresh_token: 'REFRESH-TOKEN-VALUE',
      account_id: 'acct-1234',
    },
    last_refresh: '2026-08-19T03:37:19.892Z',
    ...overrides,
  });
}

test('a real auth.json is normalised into what the refresh centre stores', () => {
  const { credential, identity } = parseCodexAuthJson(authJson());

  assert.equal(credential.auth_mode, 'chatgpt');
  assert.equal(credential.OPENAI_API_KEY, null);
  assert.equal(credential.tokens.access_token, 'ACCESS-TOKEN-VALUE');
  assert.equal(credential.tokens.refresh_token, 'REFRESH-TOKEN-VALUE');
  // Taken from the id_token, not from the pasted field, so a doctored
  // account_id cannot point the credential at another account.
  assert.equal(credential.tokens.account_id, 'acct-1234');
  assert.equal(identity.email, 'owner@example.com');
  assert.equal(identity.planType, 'pro');
  assert.ok(credential.last_refresh, 'stamped fresh rather than carried over');
});

test('the account id comes from the id_token even when the pasted one disagrees', () => {
  const { credential } = parseCodexAuthJson(JSON.stringify({
    tokens: {
      id_token: idToken({ accountId: 'real-account' }),
      access_token: 'A',
      refresh_token: 'R',
      account_id: 'attacker-supplied',
    },
  }));
  assert.equal(credential.tokens.account_id, 'real-account');
});

test('a credential taken off a client machine is refused, with the reason', () => {
  // The distributed shape carries a deliberately invalid refresh_token so that
  // no client can rotate the centre's token away. Seeding one back in would
  // leave the centre unable to refresh anything, permanently.
  assert.throws(
    () => parseCodexAuthJson(authJson({
      tokens: {
        id_token: idToken(),
        access_token: 'A',
        refresh_token: '',
        account_id: 'acct-1234',
      },
    })),
    /refresh_token is empty/,
  );
});

test('malformed input is rejected by shape, and the message never quotes it', () => {
  const secret = 'SUPER-SECRET-TOKEN-VALUE';
  const cases = [
    ['', /paste the contents/],
    ['not json at all', /not valid JSON/],
    ['[1,2,3]', /not an object/],
    [JSON.stringify({ nope: secret }), /no "tokens" object/],
    [JSON.stringify({ tokens: { access_token: secret } }), /id_token is missing/],
    [JSON.stringify({ tokens: { id_token: idToken(), refresh_token: secret } }), /access_token is missing/],
    [JSON.stringify({ tokens: { id_token: 'not-a-jwt', access_token: 'A', refresh_token: 'R' } }), /could not be decoded/],
  ];
  for (const [input, expected] of cases) {
    try {
      parseCodexAuthJson(input);
      assert.fail(`expected a rejection for ${input.slice(0, 40)}`);
    } catch (error) {
      assert.match(error.message, expected);
      // These messages are rendered straight back into the page, so anything
      // echoed from the input would be exposure.
      assert.equal(error.message.includes(secret), false, 'the message quotes the input');
    }
  }
});

test('an id_token without a Codex subscription is refused', () => {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const withoutCodex = [encode({ alg: 'none' }), encode({ email: 'a@b.c' }), 'sig'].join('.');
  assert.throws(
    () => parseCodexAuthJson(JSON.stringify({
      tokens: { id_token: withoutCodex, access_token: 'A', refresh_token: 'R' },
    })),
    /no ChatGPT account id/,
  );
});

test('whitespace around the pasted document and its fields is tolerated', () => {
  const { credential } = parseCodexAuthJson(`\n  ${JSON.stringify({
    tokens: {
      id_token: ` ${idToken()} `,
      access_token: '  ACCESS  ',
      refresh_token: '\tREFRESH\n',
    },
  })}  \n`);
  assert.equal(credential.tokens.access_token, 'ACCESS');
  assert.equal(credential.tokens.refresh_token, 'REFRESH');
});

test('the parser holds no reference to the raw text it was given', async () => {
  // A cheap guard against the credential leaking through a stray property.
  const { credential, identity } = parseCodexAuthJson(authJson());
  const serialised = JSON.stringify({ identity });
  assert.equal(serialised.includes('REFRESH-TOKEN-VALUE'), false);
  assert.equal(serialised.includes('ACCESS-TOKEN-VALUE'), false);
  assert.deepEqual(Object.keys(credential).sort(), ['OPENAI_API_KEY', 'auth_mode', 'last_refresh', 'tokens']);
});

test('the route logs the outcome without the credential', async () => {
  // The server logs `error.message` on failure and the identity on success.
  // Both are asserted above to be credential-free; this pins the route itself
  // to those two shapes so a later edit cannot start logging the body.
  const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
  const start = source.indexOf("routeMatch(path, '/accounts/:id/codex-authorization/paste')");
  assert.ok(start > 0, 'the paste route is still present');
  const block = source.slice(start, start + 3000);
  assert.equal(block.includes('credential_json,'), false, 'the raw body is not logged');
  assert.match(block, /log\('codex_credential_paste_failed'/);
  assert.match(block, /error: error\.message/);
  // The success page must not render the credential back.
  assert.equal(block.includes('authJson:'), false, 'the credential is not echoed to the page');
});
