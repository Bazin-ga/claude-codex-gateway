/**
 * The Codex OAuth refresh exchange.
 *
 * Values here were recovered by inspecting codex-cli 0.145.0 and probing the
 * endpoint, not from published documentation — see the notes on each constant.
 */

/**
 * The Codex CLI's OAuth client. Confirmed two ways: it is the `aud` claim of a
 * real `id_token`, and the same string is embedded in the codex binary.
 */
export const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';

/**
 * `/oauth/token` rather than `/oauth/refresh`: both exist, but `/oauth/refresh`
 * sits behind a Cloudflare interstitial that a plain HTTP client cannot clear,
 * while `/oauth/token` accepts the exchange directly. Probed with a deliberately
 * invalid token, it answers 401 `token_expired` — i.e. it parses the request and
 * rejects the credential, which is exactly the signal that the shape is right.
 */
export const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';

/** Refreshing is the one operation we cannot safely retry blindly (see below). */
const TIMEOUT_MS = 30_000;
const DEFINITELY_PRE_MINT_REJECTIONS = new Set([
  'invalid_request',
  'invalid_client',
  'unsupported_grant_type',
]);

export class RefreshError extends Error {
  /**
   * @param {string} message
   * @param {object} detail
   * @param {number} detail.status
   * @param {string} [detail.code] Provider error code, when the body carries one.
   * @param {boolean} detail.tokenLikelyConsumed Whether the stored refresh token
   *   may already have been spent upstream — see `refresh()`.
   */
  constructor(message, { status, code, tokenLikelyConsumed }) {
    super(message);
    this.name = 'RefreshError';
    this.status = status;
    this.code = code;
    this.tokenLikelyConsumed = tokenLikelyConsumed;
  }
}

/**
 * Exchange a refresh token for a fresh token set.
 *
 * IMPORTANT — why this must not be retried on an ambiguous failure: the provider
 * rotates refresh tokens single-use. If the request reached OpenAI and succeeded
 * but the response never made it back to us, the stored token is ALREADY dead;
 * retrying with it fails permanently and the credential is unrecoverable.
 *
 * So the outcome is classified rather than smoothed over:
 *   - only an explicit, parsed provider code known to reject before minting is
 *     safe; unknown 4xx responses remain quarantined;
 *   - a timeout or transport failure is AMBIGUOUS — the caller is told the token
 *     may have been consumed and must escalate to a human rather than loop.
 *
 * @param {string} refreshToken
 * @returns {Promise<{access_token: string, id_token?: string, refresh_token?: string, account_id?: string, expires_in?: number}>}
 */
export async function refresh(refreshToken, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`refresh deadline exceeded after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  let response;
  try {
    response = await Promise.race([fetchImpl(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: controller.signal,
    }), deadline]);
  } catch (err) {
    clearTimeout(timer);
    throw new RefreshError(`refresh request did not complete: ${err.message}`, {
      status: 0,
      tokenLikelyConsumed: true,
    });
  }

  let body;
  try {
    body = await Promise.race([response.text(), deadline]);
  } catch (error) {
    clearTimeout(timer);
    throw new RefreshError(`refresh response body could not be read: ${error.message}`, {
      status: response.status,
      tokenLikelyConsumed: true,
    });
  }
  clearTimeout(timer);

  if (!response.ok) {
    let code;
    let parsedProviderError = false;
    try {
      const providerError = JSON.parse(body)?.error;
      code = typeof providerError === 'string' ? providerError : providerError?.code;
      parsedProviderError = typeof code === 'string';
    } catch {
      // Non-JSON body (e.g. an HTML interstitial) — the status alone has to carry it.
    }
    throw new RefreshError(`refresh rejected with ${response.status}${code ? ` (${code})` : ''}`, {
      status: response.status,
      code,
      // Only explicit provider codes that reject the request before token minting
      // are safe to retry. Timeouts, HTML/interstitial bodies, `invalid_grant`,
      // token expiry, rate limits, and every unknown 4xx stay quarantined.
      tokenLikelyConsumed: !(
        response.status >= 400
        && response.status < 500
        && parsedProviderError
        && DEFINITELY_PRE_MINT_REJECTIONS.has(code)
      ),
    });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    // Succeeded upstream but we cannot read what came back — the old token is
    // almost certainly spent. This is the unrecoverable case; say so loudly.
    throw new RefreshError('refresh returned 200 with an unparseable body', {
      status: response.status,
      tokenLikelyConsumed: true,
    });
  }

  if (!payload.access_token) {
    throw new RefreshError('refresh returned 200 without an access_token', {
      status: response.status,
      tokenLikelyConsumed: true,
    });
  }

  return payload;
}

/**
 * Read the `exp` claim from a JWT without verifying it.
 *
 * Verification is the provider's job; we only need to know when to act. A token
 * we cannot parse returns null, and the caller treats that as "refresh now"
 * rather than assuming it is still good.
 *
 * @returns {Date | null}
 */
export function expiryOf(jwt) {
  const segments = String(jwt ?? '').split('.');
  if (segments.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}
