/**
 * Spending a Claude limit reset (the Fable launch resets).
 *
 * Anthropic grants subscribers a small number of free limit resets ("Settings >
 * Usage > Limit resets" on claude.ai). A reset gives back the Fable share of the
 * weekly limit and, on some grants, the whole five-hour window. Using one is
 * final: the help article says so, and there is no endpoint to undo it. Like the
 * Codex reset credit beside it, everything here is shaped by that -- one
 * eligibility rule shared by the button and the route, a request id recorded
 * before the call, and no retry on an ambiguous outcome.
 *
 * The protocol is the one Claude Code itself uses (its internal name for the
 * program is `cedar_ember`), read out of the published CLI:
 *
 *   GET  /api/oauth/usage?cedar_ember=1&skip_spend=1   -> body.cedar_ember
 *   POST /api/organizations/{org}/reset_rate_limits
 *        { program: "cedar_ember", grant_id, request_id }
 *
 * Both calls must carry a Claude Code CLI User-Agent. Without one the usage
 * response reports `eligible: false, ineligible_reason: "surface"` and lists no
 * grants at all, which is why the console's quota panel never saw them.
 */

export const CLAUDE_API_ORIGIN = 'https://api.anthropic.com';
export const CLAUDE_FABLE_RESET_PROGRAM = 'cedar_ember';
export const CLAUDE_FABLE_RESET_STATUS_URL = `${CLAUDE_API_ORIGIN}/api/oauth/usage?cedar_ember=1&skip_spend=1`;
export const CLAUDE_PROFILE_URL = `${CLAUDE_API_ORIGIN}/api/oauth/profile`;
/**
 * The upstream decides eligibility partly from the calling surface, and only a
 * Claude Code CLI identity qualifies. The version is the one the protocol was
 * read from; the upstream also accepted 2.1.296 when this was written.
 */
export const CLAUDE_CLI_USER_AGENT = 'claude-cli/2.1.321 (external, cli)';

// The same shapes the CLI enforces before it will post an id.
const GRANT_ID_PATTERN = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ClaudeFableResetError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'ClaudeFableResetError';
    this.code = code;
  }
}

export function claudeResetHeaders(oauthToken, { json = false } = {}) {
  return {
    Authorization: `Bearer ${oauthToken}`,
    'Anthropic-Beta': 'oauth-2025-04-20',
    'User-Agent': CLAUDE_CLI_USER_AGENT,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
  };
}

function percentOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

function isoOrNull(value) {
  if (typeof value !== 'string' || !value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/**
 * The parts of the upstream `cedar_ember` block the console needs, and nothing
 * else. Grant labels are kept (they are Anthropic's own wording and say which
 * offer a reset came from); event telemetry is dropped.
 *
 * Returns null for a missing or unreadable block, so the panel can omit the line
 * instead of claiming the account holds no resets.
 */
export function summarizeFableResets(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const grants = (Array.isArray(block.grants) ? block.grants : [])
    .filter((grant) => grant && typeof grant.id === 'string' && GRANT_ID_PATTERN.test(grant.id))
    .map((grant) => ({
      id: grant.id,
      label: typeof grant.label === 'string' ? grant.label.slice(0, 200) : '',
      resets_left: Number.isSafeInteger(grant.resets_left) && grant.resets_left > 0 ? grant.resets_left : 0,
      ends_at: isoOrNull(grant.ends_at),
      clears: (Array.isArray(grant.clears) ? grant.clears : []).filter((key) => typeof key === 'string'),
      percent_used: Object.fromEntries(Object.entries(grant.percent_used ?? {})
        .map(([key, value]) => [key, percentOrNull(value)])
        .filter(([, value]) => value !== null)),
      usable_now: grant.usable_now === true,
      paused: grant.paused === true,
      use_requires_limit: grant.use_requires_limit !== false,
      unavailable_reason: typeof grant.unavailable_reason === 'string' ? grant.unavailable_reason : null,
    }));
  const live = grants.filter((grant) => grant.resets_left > 0 && !grant.paused);
  const nextGrantId = typeof block.next_grant_id === 'string'
    && grants.some((grant) => grant.id === block.next_grant_id)
    ? block.next_grant_id
    : null;
  const expiries = live.map((grant) => grant.ends_at).filter(Boolean).sort();
  return {
    eligible: block.eligible === true,
    ineligible_reason: typeof block.ineligible_reason === 'string' ? block.ineligible_reason : null,
    at_limit: block.at_limit === true,
    available: live.reduce((sum, grant) => sum + grant.resets_left, 0),
    next_grant_id: nextGrantId,
    earliest_expiry: expiries[0] ?? null,
    weekly_resets_at: isoOrNull(block.weekly_resets_at),
    cooldown_until: isoOrNull(block.cooldown_until),
    grants,
  };
}

async function requestJson(url, { oauthToken, method = 'GET', body = null, fetchImpl, timeoutMs = 25_000 }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: claudeResetHeaders(oauthToken, { json: Boolean(body) }),
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Its own code: on the claim call a transport failure is the one outcome
    // where nobody can say whether a reset was used, so it must not be retried.
    throw new ClaudeFableResetError(
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
    const code = response.status === 401 || response.status === 403
      ? 'authentication_failed'
      : response.status === 429 ? 'rate_limited' : `upstream_${response.status}`;
    throw new ClaudeFableResetError(code, String(parsed?.error?.message ?? ''));
  }
  return parsed ?? {};
}

/** Live reset status plus the usage figures the decision rests on. */
export async function fetchFableResetStatus({ oauthToken, fetchImpl = fetch }) {
  const body = await requestJson(CLAUDE_FABLE_RESET_STATUS_URL, { oauthToken, fetchImpl, timeoutMs: 15_000 });
  const fable = Array.isArray(body.limits)
    ? body.limits.find((limit) => limit?.kind === 'weekly_scoped'
      && /^fable(?:\s|$)/i.test(String(limit?.scope?.model?.display_name ?? '').trim()))
    : null;
  return {
    resets: summarizeFableResets(body.cedar_ember),
    weekly_used: percentOrNull(body.seven_day?.utilization),
    five_hour_used: percentOrNull(body.five_hour?.utilization),
    fable_used: percentOrNull(fable?.percent),
  };
}

/** The organization the claim is filed under, from the token's own profile. */
export async function fetchClaudeOrganizationUuid({ oauthToken, fetchImpl = fetch }) {
  const body = await requestJson(CLAUDE_PROFILE_URL, { oauthToken, fetchImpl, timeoutMs: 15_000 });
  const uuid = body?.organization?.uuid;
  if (typeof uuid !== 'string' || !UUID_PATTERN.test(uuid)) {
    throw new ClaudeFableResetError('organization_unavailable');
  }
  return uuid;
}

/**
 * Use one reset. The caller must have recorded `requestId` before calling: if
 * the response never arrives, that record is the only thing to reconcile with.
 */
export async function claimFableReset({ oauthToken, organizationUuid, grantId, requestId, fetchImpl = fetch }) {
  if (typeof organizationUuid !== 'string' || !UUID_PATTERN.test(organizationUuid)) {
    throw new ClaudeFableResetError('organization_unavailable');
  }
  if (typeof grantId !== 'string' || !GRANT_ID_PATTERN.test(grantId)) {
    throw new ClaudeFableResetError('grant_id_invalid');
  }
  if (typeof requestId !== 'string' || !REQUEST_ID_PATTERN.test(requestId)) {
    throw new ClaudeFableResetError('request_id_invalid');
  }
  const body = await requestJson(
    `${CLAUDE_API_ORIGIN}/api/organizations/${organizationUuid}/reset_rate_limits`,
    {
      oauthToken,
      method: 'POST',
      body: { program: CLAUDE_FABLE_RESET_PROGRAM, grant_id: grantId, request_id: requestId },
      fetchImpl,
    },
  );
  return {
    result: typeof body.result === 'string' ? body.result : 'unavailable',
    reason: typeof body.reason === 'string' ? body.reason : null,
    resets_left: Number.isSafeInteger(body.resets_left) ? body.resets_left : null,
    cleared: Array.isArray(body.cleared) ? body.cleared.filter((key) => typeof key === 'string') : [],
  };
}

/**
 * The grant a click would spend: the one upstream recommends, if it is usable.
 * Falls back to the usable grant that expires first, so a reset about to lapse
 * is the one used.
 */
export function selectFableResetGrant(resets) {
  const usable = (resets?.grants ?? []).filter((grant) => (
    grant.resets_left > 0 && grant.usable_now && !grant.paused
    && (!grant.use_requires_limit || resets.at_limit)
  ));
  if (!usable.length) return null;
  return usable.find((grant) => grant.id === resets.next_grant_id)
    ?? [...usable].sort((left, right) => String(left.ends_at ?? '9').localeCompare(String(right.ends_at ?? '9')))[0];
}

/**
 * Highest usage across the windows a grant would clear. A reset that clears
 * windows standing at 0% gives nothing back and only burns the reset.
 */
export function fableResetGivesBack(grant) {
  const values = (grant?.clears ?? [])
    .map((key) => grant.percent_used?.[key])
    .filter((value) => Number.isFinite(value));
  return values.length ? Math.max(...values) : null;
}

/**
 * Whether a reset may be used on this account, and if not, why. One function
 * for the button and the route, as with the Codex reset credit.
 */
export function fableResetEligibility(account, resets) {
  if (!account || account.provider !== 'claude') return { eligible: false, reason: 'not_claude' };
  if (!resets) return { eligible: false, reason: 'status_unknown', available: 0 };
  const base = { available: resets.available, earliestExpiry: resets.earliest_expiry };
  if (!resets.eligible || resets.available <= 0) return { ...base, eligible: false, reason: 'no_resets' };
  if (resets.cooldown_until && Date.parse(resets.cooldown_until) > Date.now()) {
    return { ...base, eligible: false, reason: 'cooldown' };
  }
  const grant = selectFableResetGrant(resets);
  if (!grant) return { ...base, eligible: false, reason: 'not_usable_now' };
  const givesBack = fableResetGivesBack(grant);
  if (givesBack !== null && givesBack <= 0) return { ...base, grant, givesBack, eligible: false, reason: 'nothing_to_restore' };
  return { ...base, grant, givesBack, eligible: true, reason: null };
}
