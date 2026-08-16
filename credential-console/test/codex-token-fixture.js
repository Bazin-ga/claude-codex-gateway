import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Synthetic Codex tokens, minted fresh on every call.
 *
 * Nothing here is derived from a real credential and nothing is stable between
 * runs: a constant that looked like a token is one grep away from being handled
 * as one.
 */
export function syntheticJwt(claims) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return [
    encode({ alg: 'none', typ: 'JWT' }),
    encode(claims),
    randomBytes(16).toString('base64url'),
  ].join('.');
}

export function syntheticCodexTokens({
  email = 'owner@example.com',
  accountId = randomUUID(),
  lifetimeSeconds = 3_600,
} = {}) {
  const exp = Math.floor(Date.now() / 1000) + lifetimeSeconds;
  return {
    accountId,
    email,
    expiresAt: new Date(exp * 1000).toISOString(),
    idToken: syntheticJwt({
      email,
      exp,
      // The exact claim path the console reads the account id out of.
      'https://api.openai.com/auth': {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: 'plus',
      },
    }),
    accessToken: syntheticJwt({ exp, scope: 'openid profile email offline_access' }),
    refreshToken: `synthetic-refresh-${randomBytes(24).toString('base64url')}`,
  };
}
