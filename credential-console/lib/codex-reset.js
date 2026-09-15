/**
 * Spending a Codex rate-limit reset credit.
 *
 * This is the one operation in the console that destroys something the operator
 * cannot get back: a credit is granted, not bought, and consuming one is final.
 * Everything here is shaped by that. The eligibility rule lives in this file so
 * the button and the route cannot disagree about it, the redeem request carries
 * an idempotency key so a retried call cannot spend a second credit, and the
 * route that calls `consumeCodexResetCredit` re-reads usage from upstream first
 * rather than trusting the console's hourly snapshot.
 */

const RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits';

export const CODEX_RESET_CREDITS_URL = RESET_CREDITS_URL;
export const CODEX_RESET_CONSUME_URL = `${RESET_CREDITS_URL}/consume`;

/** The only kind of credit this console will spend. */
export const CODEX_RESET_TYPE = 'codex_rate_limits';

/**
 * Below this much remaining quota, a reset is worth a credit.
 *
 * A ceiling rather than "limit reached" on purpose: an account at 2% is about to
 * stop working and resetting it wastes almost nothing, while an account at 40%
 * would throw away most of a window along with the credit.
 */
export const CODEX_RESET_QUOTA_CEILING = 5;

export class CodexResetError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'CodexResetError';
    this.code = code;
  }
}

async function requestJson(url, { accessToken, accountId, method = 'GET', body = null, fetchImpl }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'ChatGPT-Account-Id': accountId,
        'User-Agent': 'codex-cli',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    // Deliberately its own code. A transport failure on the consume call is the
    // one outcome where nobody can say whether a credit was spent, so the caller
    // must be able to tell it apart from a clean refusal and must not retry.
    throw new CodexResetError(
      error?.name === 'TimeoutError' ? 'upstream_timeout' : 'upstream_unreachable',
      error?.message,
    );
  }
  let parsed = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new CodexResetError(`upstream_${response.status}`, String(parsed?.detail ?? parsed?.message ?? ''));
  }
  return parsed ?? {};
}

export async function listCodexResetCredits({ accessToken, accountId, fetchImpl = fetch }) {
  const body = await requestJson(RESET_CREDITS_URL, { accessToken, accountId, fetchImpl });
  const credits = Array.isArray(body?.credits) ? body.credits : [];
  return {
    credits,
    availableCount: Number.isSafeInteger(body?.available_count) ? body.available_count : null,
  };
}

/**
 * The first credit that is actually spendable on Codex limits.
 *
 * `status` and `reset_type` are both checked because the list also carries
 * credits that are already redeemed, expired, or meant for something else; the
 * console must never post an id it has not confirmed is both.
 */
export function usableResetCredit(credits) {
  return (Array.isArray(credits) ? credits : []).find((credit) => (
    credit
    && typeof credit.id === 'string'
    && credit.id.length > 0
    && credit.status === 'available'
    && credit.reset_type === CODEX_RESET_TYPE
    && !credit.redeemed_at
  )) ?? null;
}

export async function consumeCodexResetCredit({
  accessToken,
  accountId,
  creditId,
  redeemRequestId,
  fetchImpl = fetch,
}) {
  if (typeof creditId !== 'string' || !creditId) throw new CodexResetError('credit_id_required');
  if (typeof redeemRequestId !== 'string' || !redeemRequestId) {
    // Refused rather than generated here: the caller has to record the id
    // before the call, or an ambiguous failure leaves nothing to reconcile with.
    throw new CodexResetError('redeem_request_id_required');
  }
  return requestJson(CODEX_RESET_CONSUME_URL, {
    accessToken,
    accountId,
    method: 'POST',
    body: { credit_id: creditId, redeem_request_id: redeemRequestId },
    fetchImpl,
  });
}

/** The lowest remaining percentage across every window the provider reported. */
export function lowestRemainingPercent(usage) {
  const windows = Array.isArray(usage?.windows) ? usage.windows : [];
  const values = windows
    .map((window) => Number(window?.remaining_percent))
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.min(...values) : null;
}

/**
 * Whether this account may have a credit spent on it, and if not, why.
 *
 * One function for the button and the route. A button offered on rules the
 * server does not share is a button that fails; a server rule the button does
 * not share is a button nobody knows is disabled.
 */
export function codexResetEligibility(account, usage) {
  if (!account || account.provider !== 'codex') {
    return { eligible: false, reason: 'not_codex' };
  }
  // Kind only, deliberately not `home`. This runs against both the internal
  // account row and the projection the dashboard receives, and that projection
  // carries `{ kind }` alone -- the home is a filesystem path and has no
  // business on a page. Requiring it here made the button judge every account
  // unusable while the route, which reads the real credential, was perfectly
  // able to proceed. The route still fails cleanly on a missing home, because
  // readPublishedCodexCredential refuses one.
  if (account.external?.kind !== 'codex-credential') {
    return { eligible: false, reason: 'no_credential_home' };
  }
  const resetCredits = Number.isSafeInteger(usage?.reset_credits) ? usage.reset_credits : 0;
  const remainingPercent = lowestRemainingPercent(usage);
  const base = { resetCredits, remainingPercent };
  if (resetCredits <= 0) return { ...base, eligible: false, reason: 'no_credits' };
  // A stale or failed reading is not evidence of anything. Refusing here keeps
  // a credit from being spent on an account whose quota nobody can currently see.
  if (usage?.status !== 'available' || remainingPercent === null) {
    return { ...base, eligible: false, reason: 'quota_unknown' };
  }
  if (remainingPercent >= CODEX_RESET_QUOTA_CEILING) {
    return { ...base, eligible: false, reason: 'quota_not_low' };
  }
  return { ...base, eligible: true, reason: null };
}
