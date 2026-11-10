// Claude account reserve: keep the last part of an account's weekly allowance
// for its owner.
//
// A subscription account shared through the gateway is still somebody's own
// account, and they use it directly as well. Left alone, the gateway spends the
// week's allowance to the last percent and the owner finds it gone. With a
// reserve set, the account stops serving gateway devices once the weekly
// allowance remaining falls below the threshold: devices move along the
// account's failover chain as if it had run out, no other chain picks it as a
// backup, and a device with nowhere to go is told so instead of being
// forwarded. It serves again when the weekly window resets or the setting is
// changed.
//
// What it cannot do: a client that logs in to the account directly never
// passes the gateway, so nothing here applies to it. That is the point — the
// reserve is what is left for those clients.
//
// Devices can be exempted, by machine handle or, for a credential issued
// before handles existed, by device id. An exempt device keeps using the
// account below the threshold, down to whatever the upstream allows.

/** Mirrors the pattern account-restriction.js accepts for a machine handle. */
const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** The colleague's own example: "stop at 20% left". */
export const CLAUDE_RESERVE_DEFAULT_THRESHOLD_PERCENT = 20;
export const CLAUDE_RESERVE_MIN_THRESHOLD_PERCENT = 1;
/** Above this the account would almost never serve; disable it instead. */
export const CLAUDE_RESERVE_MAX_THRESHOLD_PERCENT = 95;
/** Machines and legacy devices together. */
export const CLAUDE_RESERVE_MAX_EXEMPTIONS = 64;

function usableThreshold(value) {
  return Number.isInteger(value)
    && value >= CLAUDE_RESERVE_MIN_THRESHOLD_PERCENT
    && value <= CLAUDE_RESERVE_MAX_THRESHOLD_PERCENT;
}

function distinctIds(values, pattern) {
  const ids = [];
  for (const id of Array.isArray(values) ? values : []) {
    if (typeof id === 'string' && pattern.test(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * The stored setting, normalized. A record that cannot be understood reads as
 * off: a reserve nobody can explain must not be able to stop an account.
 */
export function normalizeClaudeReserve(value) {
  const usable = usableThreshold(value?.threshold_percent);
  return {
    enabled: value?.enabled === true && usable,
    threshold_percent: usable ? value.threshold_percent : CLAUDE_RESERVE_DEFAULT_THRESHOLD_PERCENT,
    exempt_machine_ids: distinctIds(value?.exempt_machine_ids, MACHINE_ID_PATTERN),
    exempt_device_ids: distinctIds(value?.exempt_device_ids, DEVICE_ID_PATTERN),
  };
}

/**
 * A setting as submitted from the console, validated. Throws on anything the
 * form's own attributes would have refused: an input attribute is a hint, not
 * a check.
 */
export function parseClaudeReserveInput({
  enabled,
  thresholdPercent,
  exemptMachineIds = [],
  exemptDeviceIds = [],
}) {
  const text = String(thresholdPercent ?? '').trim();
  const threshold = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
  if (!usableThreshold(threshold)) {
    throw new Error(`reserve threshold must be a whole number from ${CLAUDE_RESERVE_MIN_THRESHOLD_PERCENT} to ${CLAUDE_RESERVE_MAX_THRESHOLD_PERCENT}`);
  }
  const machineIds = Array.isArray(exemptMachineIds) ? exemptMachineIds : [];
  const deviceIds = Array.isArray(exemptDeviceIds) ? exemptDeviceIds : [];
  if (machineIds.some((id) => typeof id !== 'string' || !MACHINE_ID_PATTERN.test(id))
    || deviceIds.some((id) => typeof id !== 'string' || !DEVICE_ID_PATTERN.test(id))) {
    throw new Error('unknown exempt device');
  }
  const exemptMachines = distinctIds(machineIds, MACHINE_ID_PATTERN);
  const exemptDevices = distinctIds(deviceIds, DEVICE_ID_PATTERN);
  if (exemptMachines.length + exemptDevices.length > CLAUDE_RESERVE_MAX_EXEMPTIONS) {
    throw new Error(`at most ${CLAUDE_RESERVE_MAX_EXEMPTIONS} exempt devices`);
  }
  return {
    enabled: enabled === true,
    threshold_percent: threshold,
    exempt_machine_ids: exemptMachines,
    exempt_device_ids: exemptDevices,
  };
}

/** Whether `device` keeps the account below the threshold. */
export function reserveExempts(reserve, device) {
  if (!device) return false;
  if (typeof device.machine_id === 'string' && reserve.exempt_machine_ids.includes(device.machine_id)) {
    return true;
  }
  return typeof device.id === 'string' && reserve.exempt_device_ids.includes(device.id);
}

/**
 * Whether the reserve holds the account back at this reading. A missing
 * reading is not a low one: an account whose quota cannot be read keeps
 * serving, as it did before the reserve existed.
 */
export function reserveRestricts(reserve, remainingPercent) {
  return reserve.enabled
    && Number.isFinite(remainingPercent)
    && remainingPercent < reserve.threshold_percent;
}

/**
 * The refusal a device gets when its account is held in reserve and nothing
 * else can take the request. Written for the person reading it in Claude Code,
 * which prints the message as is; in both languages the console speaks.
 */
export function claudeReserveMessage({ alias, thresholdPercent, remainingPercent, resetsAtMs }) {
  const reset = Number.isFinite(resetsAtMs)
    ? `${new Date(resetsAtMs).toISOString().slice(0, 16).replace('T', ' ')} UTC`
    : null;
  const remaining = Number.isFinite(remainingPercent) ? Math.max(0, Math.floor(remainingPercent)) : null;
  const english = `Gateway: account ${alias} is held in reserve for its owner`
    + `${remaining === null ? '' : ` (weekly quota left ${remaining}%, reserve line ${thresholdPercent}%)`}`
    + ' and no backup account can take this request.'
    + `${reset ? ` It serves again after the weekly reset at ${reset}.` : ''}`
    + ' Ask an administrator to move this device or add a backup account.';
  const chinese = `网关：账号 ${alias} 已进入保留额度`
    + `${remaining === null ? '' : `（周额度剩余 ${remaining}%，保留线 ${thresholdPercent}%）`}`
    + '，且没有可用的备用账号。'
    + `${reset ? `周额度将在 ${reset} 重置，届时自动恢复。` : ''}`
    + '可请管理员把这台设备换到别的账号，或给该账号加备用账号。';
  return `${english} / ${chinese}`;
}

/**
 * What holds `account` back from `device` right now, or null when nothing
 * does: the reserve is on, the device is not exempt, and the freshest weekly
 * reading is below the threshold. `quotaSignal` is where the reading comes
 * from (see claude-quota-signal.js).
 */
export function claudeReserveHold({ account, device, quotaSignal, snapshot = null, now = Date.now() }) {
  if (account?.provider !== 'claude') return null;
  const reserve = normalizeClaudeReserve(account.claude_reserve);
  if (!reserve.enabled || reserveExempts(reserve, device)) return null;
  const reading = quotaSignal.weeklyReading(account.id, snapshot, now);
  if (!reading || !reserveRestricts(reserve, reading.remaining_percent)) return null;
  return {
    until: reading.resets_at_ms,
    remainingPercent: reading.remaining_percent,
    thresholdPercent: reserve.threshold_percent,
  };
}
