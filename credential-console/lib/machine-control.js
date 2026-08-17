import { TextDecoder } from 'node:util';
import { sendJson } from './http.js';
import {
  assertDeviceScope,
  authenticateDevice,
  DeviceAuthError,
} from './device-auth.js';

export const MACHINE_STATUS_PATH = '/claude/control/v1/status';
export const MACHINE_ACCOUNT_PATH = '/claude/control/v1/account';
export const MACHINE_CONTROL_PREFIX = '/claude/control/v1/';
export const MACHINE_CONTROL_BODY_LIMIT = 16 * 1024;

const ACCOUNT_ID_LIMIT = 256;
const AUTH_FAILURE_LIMIT = { windowMs: 60_000, max: 30 };
const DEVICE_REQUEST_LIMIT = { windowMs: 60_000, max: 120 };
const authFailures = new Map();
const deviceRequests = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of authFailures) {
    if (now - record.since > AUTH_FAILURE_LIMIT.windowMs) authFailures.delete(key);
  }
  for (const [key, record] of deviceRequests) {
    if (now - record.since > DEVICE_REQUEST_LIMIT.windowMs) deviceRequests.delete(key);
  }
}, 60_000).unref();

class MachineControlError extends Error {
  constructor(code) {
    super(code);
    this.name = 'MachineControlError';
    this.code = code;
  }
}

function bodyError() {
  return new MachineControlError('BODY_INVALID');
}

function bodyTooLarge() {
  return new MachineControlError('BODY_TOO_LARGE');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sourceIp(req) {
  const peer = req?.socket?.remoteAddress ?? 'unknown';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  if (!loopback) return peer;
  return String(req?.headers?.['x-forwarded-for'] ?? peer).split(',')[0].trim();
}

function authenticationRateLimited(ip) {
  const now = Date.now();
  const record = authFailures.get(ip);
  if (!record || now - record.since > AUTH_FAILURE_LIMIT.windowMs) {
    authFailures.set(ip, { since: now, count: 1 });
    return false;
  }
  record.count += 1;
  return record.count > AUTH_FAILURE_LIMIT.max;
}

function deviceRateLimited(deviceId) {
  const now = Date.now();
  const record = deviceRequests.get(deviceId);
  if (!record || now - record.since > DEVICE_REQUEST_LIMIT.windowMs) {
    deviceRequests.set(deviceId, { since: now, count: 1 });
    return false;
  }
  record.count += 1;
  return record.count > DEVICE_REQUEST_LIMIT.max;
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string') ?? null;
}

function stringList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((entry) => typeof entry === 'string').slice(0, 128);
}

/**
 * Whitelist the device/account fields that a machine may see. In particular,
 * never spread a store object: it can contain token_sha256, credentials, or
 * audit data depending on the caller and state schema version.
 */
export function safeDeviceAccountSummary(summary, fallbackDeviceId = null) {
  if (!isObject(summary)) throw new MachineControlError('DEVICE_CONFIGURATION_INVALID');
  const nestedDevice = isObject(summary.device) ? summary.device : {};
  const nestedAccount = isObject(summary.account) ? summary.account : {};
  const deviceId = firstString(
    summary.device_id,
    summary.deviceId,
    nestedDevice.device_id,
    nestedDevice.id,
    fallbackDeviceId,
  );
  if (!deviceId) throw new MachineControlError('DEVICE_CONFIGURATION_INVALID');

  return {
    device_id: deviceId,
    machine_id: firstString(summary.machine_id, summary.machineId, nestedDevice.machine_id),
    member_label: firstString(summary.member_label, summary.memberLabel, nestedDevice.member_label),
    device_name: firstString(
      summary.device_name,
      summary.deviceName,
      summary.name,
      nestedDevice.device_name,
      nestedDevice.name,
    ),
    account_id: firstString(summary.account_id, summary.accountId, nestedAccount.account_id, nestedAccount.id),
    account_alias: firstString(
      summary.account_alias,
      summary.accountAlias,
      nestedAccount.account_alias,
      nestedAccount.alias,
    ),
    account_status: firstString(
      summary.account_status,
      summary.accountStatus,
      nestedAccount.account_status,
      nestedAccount.status,
      summary.status,
    ),
    original_account_id: firstString(
      summary.original_account_id,
      summary.originalAccountId,
    ),
    selected_account_id: firstString(
      summary.selected_account_id,
      summary.selectedAccountId,
    ),
    allowed_account_ids: stringList(
      summary.allowed_account_ids ?? summary.allowedAccountIds,
    ),
  };
}

function errorResponse(res, error, req = null) {
  const code = error?.code;
  const definition = {
    AUTHENTICATION_REQUIRED: [401, 'authentication_error', 'unauthorized'],
    DEVICE_AUTHENTICATION_FAILED: [401, 'authentication_error', 'unauthorized'],
    AUTHENTICATION_RATE_LIMITED: [429, 'rate_limit_error', 'too many authentication failures'],
    DEVICE_RATE_LIMITED: [429, 'rate_limit_error', 'device control request limit exceeded'],
    BODY_INVALID: [400, 'invalid_request_error', 'invalid machine control request body'],
    BODY_TOO_LARGE: [400, 'invalid_request_error', 'machine control request body too large'],
    ACCOUNT_NOT_ALLOWED: [403, 'permission_error', 'account is not allowed for this device'],
    DEVICE_SCOPE: [403, 'permission_error', 'device is outside the authenticated scope'],
    ACCOUNT_UNAVAILABLE: [409, 'conflict_error', 'account is unavailable'],
    DEVICE_CONFIGURATION_INVALID: [409, 'conflict_error', 'device account configuration is invalid'],
    METHOD_NOT_ALLOWED: [405, 'invalid_request_error', 'method not allowed'],
    NOT_FOUND: [404, 'not_found_error', 'machine control endpoint not found'],
  }[code] ?? [500, 'api_error', 'machine control unavailable'];
  if (!res.headersSent) {
    const headers = {
      ...(code === 'BODY_TOO_LARGE' ? { Connection: 'close' } : {}),
      ...(code === 'AUTHENTICATION_RATE_LIMITED' ? { 'Retry-After': '60' } : {}),
      ...(code === 'DEVICE_RATE_LIMITED' ? { 'Retry-After': '60' } : {}),
    };
    if (code === 'BODY_TOO_LARGE' && req) {
      res.once('finish', () => req.destroy?.());
    }
    sendJson(res, definition[0], {
      type: 'error',
      error: { type: definition[1], message: definition[2] },
    }, headers);
  } else {
    res.destroy?.();
  }
  return definition[0];
}

function declaredBodyTooLarge(req) {
  const value = req?.headers?.['content-length'];
  const length = Number(value);
  return Number.isFinite(length) && length > MACHINE_CONTROL_BODY_LIMIT;
}

function readJsonBody(req) {
  if (declaredBodyTooLarge(req)) return Promise.reject(bodyTooLarge());
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks = [];
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      req.pause?.();
      reject(error);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MACHINE_CONTROL_BODY_LIMIT) {
        fail(bodyTooLarge());
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    req.once('aborted', () => fail(bodyError()));
    req.once('error', () => fail(bodyError()));
    req.once('end', () => {
      if (settled) return;
      settled = true;
      try {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
        const parsed = JSON.parse(text);
        if (!isObject(parsed)) throw bodyError();
        resolve(parsed);
      } catch (error) {
        reject(error instanceof MachineControlError ? error : bodyError());
      }
    });
  });
}

function accountBody(body) {
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'account_id') throw bodyError();
  if (typeof body.account_id !== 'string'
    || body.account_id.length === 0
    || body.account_id.length > ACCOUNT_ID_LIMIT) {
    throw bodyError();
  }
  return body.account_id;
}

function methodError() {
  const error = new MachineControlError('METHOD_NOT_ALLOWED');
  return error;
}

/**
 * Handle exactly the machine-control endpoints. Returns false for an unrelated
 * route so server.js can continue its normal routing; any path below the
 * reserved control prefix is answered here, including /enroll (404).
 */
export async function handleMachineControl(req, res, { store, log = () => {} } = {}) {
  const url = new URL(req.url, 'https://credential-console.invalid');
  const path = url.pathname;
  const recognized = path === MACHINE_STATUS_PATH || path === MACHINE_ACCOUNT_PATH;
  if (!recognized && !path.startsWith(MACHINE_CONTROL_PREFIX)) return false;
  if (path !== MACHINE_STATUS_PATH && path !== MACHINE_ACCOUNT_PATH) {
    errorResponse(res, new MachineControlError('NOT_FOUND'));
    return true;
  }

  try {
    let device;
    try {
      ({ device } = authenticateDevice(req, store));
    } catch (error) {
      const ip = sourceIp(req);
      const limited = authenticationRateLimited(ip);
      try {
        log(limited ? 'machine_control_auth_rate_limited' : 'machine_control_auth_failed', { ip });
      } catch {}
      if (limited) throw new MachineControlError('AUTHENTICATION_RATE_LIMITED');
      throw error;
    }
    if (deviceRateLimited(device.id)) {
      try {
        log('machine_control_device_rate_limited', { device_id: device.id });
      } catch {}
      throw new MachineControlError('DEVICE_RATE_LIMITED');
    }
    if (path === MACHINE_STATUS_PATH) {
      if (req.method !== 'GET') throw methodError();
      if (typeof store.deviceAccountSummary !== 'function') {
        throw new MachineControlError('DEVICE_CONFIGURATION_INVALID');
      }
      const summary = await store.deviceAccountSummary(device.id);
      sendJson(res, 200, safeDeviceAccountSummary(summary, device.id));
      return true;
    }

    if (req.method !== 'POST') throw methodError();
    const accountId = accountBody(await readJsonBody(req));
    if (typeof store.switchDeviceAccount !== 'function') {
      throw new MachineControlError('DEVICE_CONFIGURATION_INVALID');
    }
    // The API has no target-device parameter. Supplying both values makes the
    // Store enforce the same self-only invariant even if another caller later
    // reuses this method.
    const switched = await store.switchDeviceAccount({
      deviceId: device.id,
      selectedAccountId: accountId,
      actorDeviceId: device.id,
    });
    sendJson(res, 200, safeDeviceAccountSummary(switched, device.id));
    return true;
  } catch (error) {
    if (error instanceof DeviceAuthError && error.code === 'DEVICE_SCOPE') {
      errorResponse(res, error, req);
    } else {
      errorResponse(res, error, req);
    }
    return true;
  }
}
