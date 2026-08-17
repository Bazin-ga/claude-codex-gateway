import { bearerToken } from './http.js';

export const DEVICE_AUTHENTICATION_ERROR = 'AUTHENTICATION_REQUIRED';
export const DEVICE_SCOPE_ERROR = 'DEVICE_SCOPE';

export class DeviceAuthError extends Error {
  constructor(code = DEVICE_AUTHENTICATION_ERROR) {
    super(code);
    this.name = 'DeviceAuthError';
    this.code = code;
  }
}

/**
 * Read the same two device-token headers as the Claude data proxy. Cookies,
 * CSRF fields, query parameters, and request bodies are deliberately ignored.
 */
export function deviceToken(req) {
  const bearer = bearerToken(req);
  const apiKeyHeader = req?.headers?.['x-api-key'];
  const apiKey = typeof apiKeyHeader === 'string' && apiKeyHeader.length > 0
    ? apiKeyHeader
    : null;
  if (bearer && apiKey && bearer !== apiKey) return null;
  return bearer || apiKey;
}

/**
 * Authenticate every request afresh. `deviceByToken` is the revocation check;
 * callers must not cache its result between machine-control requests.
 */
export function authenticateDevice(req, store) {
  const token = deviceToken(req);
  if (!token || !store || typeof store.deviceByToken !== 'function') {
    throw new DeviceAuthError();
  }
  let device;
  try {
    device = store.deviceByToken(token);
  } catch {
    throw new DeviceAuthError('DEVICE_AUTHENTICATION_FAILED');
  }
  if (!device || typeof device.id !== 'string' || device.id.length === 0) {
    throw new DeviceAuthError();
  }
  return { device };
}

export function assertDeviceScope(deviceId, actorDeviceId) {
  if (typeof deviceId !== 'string' || deviceId.length === 0
    || deviceId !== actorDeviceId) {
    throw new DeviceAuthError(DEVICE_SCOPE_ERROR);
  }
}
