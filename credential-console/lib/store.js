import { createHmac, randomBytes } from 'node:crypto';
import {
  chmod,
  link,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import {
  decryptJson,
  encryptJson,
  randomToken,
  secretMatches,
  sha256,
} from './security.js';

const STATE_VERSION = 1;
const MAX_AUDIT_EVENTS = 2_000;

/**
 * The opaque handle a client reports for the machine it runs on.
 *
 * Same rule as the token dispenser's copy (token-dispenser/server.js), duplicated
 * rather than shared because the two are separate processes with separate trust
 * boundaries and neither should be able to widen the other's validation.
 *
 * It identifies a machine and nothing more. This deployment authenticates nobody
 * and the member label beside it is self-asserted, so the handle is the only
 * identifier here a user cannot trivially forge — which still says nothing about
 * who that user is.
 */
export const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

// Claude Code reports this value as a transport correlation handle.  It is
// accepted only as a strict ASCII token and is never persisted or emitted.
export const CLAUDE_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
export const THREAD_KEY_VERSION = 1;
export const CLAUDE_PROMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PROMPT_KEY_VERSION = 1;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function nowIso() {
  return new Date().toISOString();
}

function storeError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

// A state.json written before the administrator-password mode was removed still
// carries an `admin` record. Nothing reads it any more; it is left untouched
// rather than migrated away, so a rollback finds the file it wrote.
function newState() {
  return {
    version: STATE_VERSION,
    accounts: [],
    oauth_flows: [],
    enrollments: [],
    devices: [],
    audit: [],
  };
}

/**
 * Nothing, or a validated handle. An absent handle is the normal shape for every
 * row written before machines existed here and for every caller that has none to
 * offer, so it is not an error; a malformed one is, because it would be stored
 * verbatim and read later as if it meant something.
 */
function normalizedMachineId(machineId) {
  if (machineId === null || machineId === undefined || machineId === '') return null;
  if (typeof machineId !== 'string' || !MACHINE_ID_PATTERN.test(machineId)) {
    throw new Error('machine id must match [A-Za-z0-9_-]{16,64}');
  }
  return machineId;
}

function buildDevice({ account, memberLabel, deviceName, machineId = null }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(deviceName)) {
    throw new Error('device name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  }
  const machine = normalizedMachineId(machineId);
  const token = `sk-ant-api03-${randomToken(32)}`;
  return {
    token,
    device: {
      id: randomToken(12),
      account_id: account.id,
      // P3 policy fields are additive. Rows written before P3 have neither
      // field and are intentionally handled as legacy by the resolver.
      allowed_account_ids: [account.id],
      selected_account_id: account.id,
      member_label: String(memberLabel ?? '').slice(0, 160),
      name: deviceName,
      // Optional and written only when the caller has one. A row without it is
      // legacy: one credential issuance that cannot be attributed to a machine.
      // Absence is read as "unknown" at every point of use; no row is ever
      // rewritten to acquire one.
      ...(machine ? { machine_id: machine } : {}),
      token_sha256: sha256(token),
      created_at: nowIso(),
      last_seen_at: null,
      revoked_at: null,
    },
  };
}

async function writeAtomic(path, content, mode = 0o600) {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  let renamed = false;
  try {
    const handle = await open(tmp, 'wx', mode);
    created = true;
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    renamed = true;
    await chmod(path, mode);
    try {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  } finally {
    if (created && !renamed) await unlink(tmp).catch(() => {});
  }
}

async function writeExclusiveAtomic(path, content, mode = 0o600) {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  try {
    const handle = await open(tmp, 'wx', mode);
    created = true;
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(tmp, path);
    await chmod(path, mode);
    try {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
  } finally {
    if (created) await unlink(tmp).catch(() => {});
  }
}

export class CredentialStore {
  constructor(home, { allowKeyInit = false } = {}) {
    this.home = home;
    this.allowKeyInit = allowKeyInit;
    this.statePath = join(home, 'state.json');
    this.masterKeyPath = join(home, 'master.key');
    this.state = null;
    this.masterKey = null;
    this.queue = Promise.resolve();
    this.pendingDeviceAccountFields = new Map();
  }

  async init() {
    await mkdir(this.home, { recursive: true, mode: 0o700 });
    await chmod(this.home, 0o700);

    try {
      this.masterKey = Buffer.from((await readFile(this.masterKeyPath, 'utf8')).trim(), 'base64url');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!this.allowKeyInit) {
        throw new Error(
          `master key is missing at ${resolve(this.masterKeyPath)}; restore it from backup or run the explicit init-key command`,
        );
      }
      this.masterKey = randomBytes(32);
      await writeExclusiveAtomic(this.masterKeyPath, `${this.masterKey.toString('base64url')}\n`);
    }
    if (this.masterKey.length !== 32) throw new Error('master key must be exactly 32 bytes');

    try {
      this.state = JSON.parse(await readFile(this.statePath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      this.state = newState();
      await this.persist();
    }
    if (this.state.version !== STATE_VERSION) {
      throw new Error(`unsupported state version ${this.state.version}`);
    }
    if (!Array.isArray(this.state.oauth_flows)) this.state.oauth_flows = [];
    return this;
  }

  async serialized(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  async persist() {
    await writeAtomic(this.statePath, `${JSON.stringify(this.state, null, 2)}\n`);
  }

  audit(event, detail = {}) {
    this.state.audit.push({ at: nowIso(), event, ...detail });
    if (this.state.audit.length > MAX_AUDIT_EVENTS) {
      this.state.audit.splice(0, this.state.audit.length - MAX_AUDIT_EVENTS);
    }
  }

  publicAccounts() {
    return this.state.accounts.map((account) => ({
      id: account.id,
      provider: account.provider,
      alias: account.alias,
      email_label: account.email_label,
      status: account.status,
      created_at: account.created_at,
      expires_at: account.expires_at ?? null,
      last_success_at: account.last_success_at ?? null,
      last_failure_at: account.last_failure_at ?? null,
      last_failure: account.last_failure ?? null,
      external: account.external ? { kind: account.external.kind } : null,
      active_devices: this.state.devices.filter((device) => {
        if (device.revoked_at) return false;
        try {
          return this.#deviceAccountPolicy(device).selectedAccountId === account.id;
        } catch {
          // A malformed explicit policy has no trustworthy effective account;
          // the dashboard surfaces that row as invalid instead of counting it
          // under an account it may not use.
          return false;
        }
      }).length,
    }));
  }

  accountById(id) {
    return this.state.accounts.find((account) => account.id === id) ?? null;
  }

  accountCredential(id) {
    const account = this.accountById(id);
    if (!account?.credential) return null;
    return decryptJson(this.masterKey, account.credential, `account:${id}:credential:v1`);
  }

  /**
   * Derive a stable, non-reversible conversation thread handle.  The raw
   * Claude Code session id is deliberately never stored, audited, returned,
   * or included in an error message.  NUL separators are safe here because
   * both identifiers are restricted to the ASCII patterns above.
   */
  threadKeyForSession({
    version = THREAD_KEY_VERSION,
    deviceId,
    sessionId,
  } = {}) {
    if (!this.masterKey || this.masterKey.length !== 32) {
      throw new Error('master key is unavailable');
    }
    if (!Number.isSafeInteger(version) || version < 1 || version > 255) {
      throw new Error('thread key version is invalid');
    }
    if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
      throw new Error('thread key device id is invalid');
    }
    if (typeof sessionId !== 'string' || !CLAUDE_SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error('thread key session id is invalid');
    }
    return createHmac('sha256', this.masterKey)
      .update(`${version}\u0000${deviceId}\u0000${sessionId}`, 'utf8')
      .digest('hex');
  }

  // Descriptive alias for callers that use the conversation terminology.
  conversationThreadKey(input) {
    return this.threadKeyForSession(input);
  }

  /**
   * Derive a stable opaque hook-turn handle without persisting Claude Code's
   * raw prompt UUID. Device and session are included so UUID reuse cannot
   * merge turns across credential boundaries.
   */
  promptKeyForHook({
    version = PROMPT_KEY_VERSION,
    deviceId,
    sessionId,
    promptId,
  } = {}) {
    if (!this.masterKey || this.masterKey.length !== 32) {
      throw new Error('master key is unavailable');
    }
    if (!Number.isSafeInteger(version) || version < 1 || version > 255) {
      throw new Error('prompt key version is invalid');
    }
    if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
      throw new Error('prompt key device id is invalid');
    }
    if (typeof sessionId !== 'string' || !CLAUDE_SESSION_ID_PATTERN.test(sessionId)) {
      throw new Error('prompt key session id is invalid');
    }
    if (typeof promptId !== 'string' || !CLAUDE_PROMPT_ID_PATTERN.test(promptId)) {
      throw new Error('prompt key prompt id is invalid');
    }
    return createHmac('sha256', this.masterKey)
      .update(`${version}\u0000${deviceId}\u0000${sessionId}\u0000${promptId.toLowerCase()}`, 'utf8')
      .digest('hex');
  }

  #deviceRecord(deviceOrId) {
    const id = typeof deviceOrId === 'string' ? deviceOrId : deviceOrId?.id;
    if (typeof id !== 'string' || !id) {
      throw storeError('device id is required', 'DEVICE_CONFIGURATION_INVALID');
    }
    const device = this.state.devices.find((entry) => entry.id === id);
    if (!device) throw storeError('device not found', 'DEVICE_CONFIGURATION_INVALID');
    return device;
  }

  #deviceAccountPolicy(device) {
    const pending = this.pendingDeviceAccountFields.get(device.id);
    if (pending) {
      device = { ...device };
      if (pending.hasAllowed) device.allowed_account_ids = pending.allowedAccountIds;
      else delete device.allowed_account_ids;
      if (pending.hasSelected) device.selected_account_id = pending.selectedAccountId;
      else delete device.selected_account_id;
    }
    const hasAllowed = Object.hasOwn(device, 'allowed_account_ids');
    const hasSelected = Object.hasOwn(device, 'selected_account_id');
    if (!hasAllowed && !hasSelected) {
      return {
        legacy: true,
        allowedAccountIds: [device.account_id],
        selectedAccountId: device.account_id,
      };
    }
    if (!hasAllowed || !hasSelected) {
      throw storeError('device account policy is incomplete', 'DEVICE_CONFIGURATION_INVALID');
    }
    if (!Array.isArray(device.allowed_account_ids) || device.allowed_account_ids.length === 0) {
      throw storeError('device account policy allowlist is invalid', 'DEVICE_CONFIGURATION_INVALID');
    }
    const allowedAccountIds = device.allowed_account_ids.map((id) => {
      if (typeof id !== 'string' || !id || id.length > 128) {
        throw storeError(
          'device account policy contains an invalid account id',
          'DEVICE_CONFIGURATION_INVALID',
        );
      }
      const account = this.accountById(id);
      if (!account) {
        throw storeError(
          `device account policy account ${id} was not found`,
          'DEVICE_CONFIGURATION_INVALID',
        );
      }
      if (!['claude', 'codex'].includes(account.provider)) {
        throw storeError(
          `device account policy account ${id} is not a gateway account`,
          'DEVICE_CONFIGURATION_INVALID',
        );
      }
      return id;
    });
    // Homogeneous by provider. A device is configured for one client — Claude
    // Code reads ANTHROPIC_BASE_URL, the Codex CLI reads a model_providers
    // block — so an allowlist spanning both could only ever offer it an account
    // it cannot use. Previously this was enforced by admitting Claude alone;
    // the rule is now stated directly so a Codex-only device is equally valid.
    const providers = new Set(allowedAccountIds.map((id) => this.accountById(id).provider));
    if (providers.size > 1) {
      throw storeError(
        'device account policy mixes providers',
        'DEVICE_CONFIGURATION_INVALID',
      );
    }
    if (new Set(allowedAccountIds).size !== allowedAccountIds.length) {
      throw storeError(
        'device account policy allowlist contains duplicates',
        'DEVICE_CONFIGURATION_INVALID',
      );
    }
    if (!allowedAccountIds.includes(device.account_id)) {
      throw storeError(
        'device account policy must retain the original account',
        'DEVICE_CONFIGURATION_INVALID',
      );
    }
    if (typeof device.selected_account_id !== 'string' || !device.selected_account_id) {
      throw storeError(
        'device account policy selected account is invalid',
        'DEVICE_CONFIGURATION_INVALID',
      );
    }
    if (!allowedAccountIds.includes(device.selected_account_id)) {
      throw storeError(
        'device account policy selected account is not allowed',
        'DEVICE_CONFIGURATION_INVALID',
      );
    }
    return {
      legacy: false,
      allowedAccountIds,
      selectedAccountId: device.selected_account_id,
    };
  }

  #captureDeviceAccountFields(device) {
    return {
      hasAllowed: Object.hasOwn(device, 'allowed_account_ids'),
      hasSelected: Object.hasOwn(device, 'selected_account_id'),
      allowedAccountIds: Array.isArray(device.allowed_account_ids)
        ? [...device.allowed_account_ids]
        : device.allowed_account_ids,
      selectedAccountId: device.selected_account_id,
      audit: [...this.state.audit],
    };
  }

  #restoreDeviceAccountFields(device, before) {
    if (before.hasAllowed) device.allowed_account_ids = before.allowedAccountIds;
    else delete device.allowed_account_ids;
    if (before.hasSelected) device.selected_account_id = before.selectedAccountId;
    else delete device.selected_account_id;
    this.state.audit = before.audit;
  }

  #auditActor({ actor = null, actorType = 'console', actorDeviceId = null }) {
    const actorKind = actorType === 'device_token' ? 'device_token' : 'console';
    const fallback = actorKind === 'device_token'
      ? `device:${actorDeviceId ?? 'unknown'}`
      : 'administrator';
    return {
      actor_kind: actorKind,
      actor: String(actor ?? fallback).slice(0, 160),
      actor_device_id: actorDeviceId ?? null,
    };
  }

  #deviceAccountAudit({
    device = null,
    previousAccountId = null,
    nextAccountId = null,
    outcome,
    reason = null,
    allowedAdded = null,
    actor = null,
    actorType = 'console',
    actorDeviceId = null,
  }) {
    return {
      ...this.#auditActor({ actor, actorType, actorDeviceId }),
      device_id: device?.id ?? null,
      machine_id: device?.machine_id ?? null,
      previous_account_id: previousAccountId,
      next_account_id: nextAccountId,
      outcome,
      reason: reason ? String(reason).slice(0, 240) : null,
      allowed_added: allowedAdded ?? null,
    };
  }

  async #persistDeviceAccountFailure({
    device,
    previousAccountId,
    nextAccountId,
    error,
    event,
    actor,
    actorType,
    actorDeviceId,
  }) {
    const auditBefore = [...this.state.audit];
    this.audit(event, this.#deviceAccountAudit({
      device,
      previousAccountId,
      nextAccountId,
      outcome: 'failure',
      reason: error.message,
      actor,
      actorType,
      actorDeviceId,
    }));
    try {
      await this.persist();
    } catch {
      this.state.audit = auditBefore;
    }
  }

  #assertDeviceMutable(device) {
    if (device.revoked_at) throw storeError('device is revoked', 'DEVICE_CONFIGURATION_INVALID');
  }

  #assertSwitchableAccount(account) {
    if (!account) throw storeError('target account not found', 'DEVICE_CONFIGURATION_INVALID');
    if (account.provider !== 'claude') {
      throw storeError('target account is not a Claude account', 'DEVICE_CONFIGURATION_INVALID');
    }
    if (!account.credential) throw storeError('target account has no stored credential', 'ACCOUNT_UNAVAILABLE');
    if (account.status === 'disabled') throw storeError('target account is disabled', 'ACCOUNT_UNAVAILABLE');
    if (account.expires_at && Date.parse(account.expires_at) <= Date.now()) {
      throw storeError('target account credential is expired', 'ACCOUNT_UNAVAILABLE');
    }
    try {
      if (!this.accountCredential(account.id)?.oauth_token) {
        throw storeError('target account has no stored credential', 'ACCOUNT_UNAVAILABLE');
      }
    } catch (error) {
      if (error.code === 'ACCOUNT_UNAVAILABLE') throw error;
      throw storeError('target account credential is unavailable', 'ACCOUNT_UNAVAILABLE');
    }
  }

  /**
   * Resolve the exact device row's account policy. A legacy row is the only
   * case where missing fields fall back silently; partial or malformed P3
   * fields are explicit state errors so a bad migration cannot route traffic
   * to an arbitrary account.
   */
  resolveDeviceAccount(deviceOrId) {
    const device = this.#deviceRecord(deviceOrId);
    if (device.revoked_at) throw storeError('device is revoked', 'DEVICE_CONFIGURATION_INVALID');
    const policy = this.#deviceAccountPolicy(device);
    const account = this.accountById(policy.selectedAccountId);
    if (!account) {
      throw storeError(
        `selected account ${policy.selectedAccountId} was not found`,
        'DEVICE_CONFIGURATION_INVALID',
      );
    }
    return {
      device,
      account,
      original_account_id: device.account_id,
      allowed_account_ids: [...policy.allowedAccountIds],
      selected_account_id: policy.selectedAccountId,
      effective_account_id: account.id,
      source: policy.legacy ? 'legacy' : 'selected',
    };
  }

  deviceAccountSummary(deviceId) {
    const resolved = this.resolveDeviceAccount(deviceId);
    const { account } = resolved;
    return {
      device_id: resolved.device.id,
      machine_id: resolved.device.machine_id ?? null,
      member_label: resolved.device.member_label,
      device_name: resolved.device.name,
      original_account_id: resolved.original_account_id,
      allowed_account_ids: resolved.allowed_account_ids,
      selected_account_id: resolved.selected_account_id,
      effective_account_id: resolved.effective_account_id,
      source: resolved.source,
      account: {
        id: account.id,
        alias: account.alias,
        provider: account.provider,
        status: account.status,
        expires_at: account.expires_at ?? null,
        has_credential: Boolean(account.credential),
      },
    };
  }

  async configureDeviceAccount({
    deviceId,
    selectedAccountId,
    actor = null,
    actorType = 'console',
  }) {
    return this.serialized(async () => {
      let device = null;
      let before = null;
      try {
        device = this.#deviceRecord(deviceId);
        before = this.#captureDeviceAccountFields(device);
        this.pendingDeviceAccountFields.set(device.id, before);
        this.#assertDeviceMutable(device);
        if (actorType !== 'console') throw storeError('console policy is required', 'DEVICE_CONFIGURATION_INVALID');
        if (typeof selectedAccountId !== 'string' || !selectedAccountId) {
          throw storeError('selected account id is required', 'DEVICE_CONFIGURATION_INVALID');
        }
        const account = this.accountById(selectedAccountId);
        if (!account) throw storeError('target account not found', 'DEVICE_CONFIGURATION_INVALID');
        if (account.provider !== 'claude') {
          throw storeError('target account is not a Claude account', 'DEVICE_CONFIGURATION_INVALID');
        }
        const policy = this.#deviceAccountPolicy(device);
        const allowed = [...policy.allowedAccountIds];
        const allowedAdded = allowed.includes(selectedAccountId) ? [] : [selectedAccountId];
        allowed.push(...allowedAdded);
        device.allowed_account_ids = allowed;
        device.selected_account_id = selectedAccountId;
        const outcome = policy.selectedAccountId === selectedAccountId && allowedAdded.length === 0
          ? 'noop'
          : 'success';
        this.audit('device_account_configured', this.#deviceAccountAudit({
          device,
          previousAccountId: policy.selectedAccountId,
          nextAccountId: selectedAccountId,
          outcome,
          allowedAdded,
          actor,
          actorType,
        }));
        try {
          await this.persist();
        } catch (error) {
          this.#restoreDeviceAccountFields(device, before);
          throw error;
        }
        this.pendingDeviceAccountFields.delete(device.id);
        return this.deviceAccountSummary(device.id);
      } catch (error) {
        if (device && before) {
          this.#restoreDeviceAccountFields(device, before);
          this.pendingDeviceAccountFields.delete(device.id);
          await this.#persistDeviceAccountFailure({
            device,
            previousAccountId: typeof device.selected_account_id === 'string'
              ? device.selected_account_id
              : device.account_id,
            nextAccountId: selectedAccountId,
            error,
            event: 'device_account_configure_failed',
            actor,
            actorType,
          });
        }
        throw error;
      }
    });
  }

  async switchDeviceAccount({ deviceId, selectedAccountId, actorDeviceId }) {
    return this.serialized(async () => {
      let device = null;
      let before = null;
      try {
        device = this.#deviceRecord(deviceId);
        before = this.#captureDeviceAccountFields(device);
        this.pendingDeviceAccountFields.set(device.id, before);
        this.#assertDeviceMutable(device);
        if (actorDeviceId !== device.id) {
          throw storeError(
            'device token may only operate its own device',
            'DEVICE_SCOPE',
          );
        }
        if (typeof selectedAccountId !== 'string' || !selectedAccountId) {
          throw storeError('selected account id is required', 'DEVICE_CONFIGURATION_INVALID');
        }
        const policy = this.#deviceAccountPolicy(device);
        if (!policy.allowedAccountIds.includes(selectedAccountId)) {
          throw storeError('target account is not allowed for this device', 'ACCOUNT_NOT_ALLOWED');
        }
        const account = this.accountById(selectedAccountId);
        this.#assertSwitchableAccount(account);
        const outcome = policy.selectedAccountId === selectedAccountId ? 'noop' : 'success';
        device.allowed_account_ids = [...policy.allowedAccountIds];
        device.selected_account_id = selectedAccountId;
        this.audit('device_account_switched', this.#deviceAccountAudit({
          device,
          previousAccountId: policy.selectedAccountId,
          nextAccountId: selectedAccountId,
          outcome,
          allowedAdded: [],
          actor: `device:${actorDeviceId}`,
          actorType: 'device_token',
          actorDeviceId,
        }));
        try {
          await this.persist();
        } catch (error) {
          this.#restoreDeviceAccountFields(device, before);
          throw error;
        }
        this.pendingDeviceAccountFields.delete(device.id);
        return this.deviceAccountSummary(device.id);
      } catch (error) {
        if (device && before) {
          this.#restoreDeviceAccountFields(device, before);
          this.pendingDeviceAccountFields.delete(device.id);
          await this.#persistDeviceAccountFailure({
            device,
            previousAccountId: typeof device.selected_account_id === 'string'
              ? device.selected_account_id
              : device.account_id,
            nextAccountId: selectedAccountId,
            error,
            event: 'device_account_switch_failed',
            actor: `device:${actorDeviceId ?? 'unknown'}`,
            actorType: 'device_token',
            actorDeviceId,
          });
        }
        throw error;
      }
    });
  }

  async addAccount({
    provider,
    alias,
    emailLabel,
    credential = null,
    expiresAt = null,
    external = null,
  }) {
    return this.serialized(async () => {
      if (!['claude', 'codex'].includes(provider)) throw new Error('unsupported provider');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(alias)) {
        throw new Error('alias must match [A-Za-z0-9][A-Za-z0-9._-]{1,63}');
      }
      if (this.state.accounts.some((entry) => entry.alias === alias)) {
        throw new Error('account alias already exists');
      }
      const id = randomToken(12);
      const account = {
        id,
        provider,
        alias,
        email_label: String(emailLabel ?? '').slice(0, 160),
        status: credential || external ? 'stored' : 'login_required',
        created_at: nowIso(),
        expires_at: expiresAt || null,
        ...(credential
          ? { credential: encryptJson(this.masterKey, credential, `account:${id}:credential:v1`) }
          : {}),
        ...(external ? { external } : {}),
      };
      this.state.accounts.push(account);
      this.audit('account_added', { account_id: id, provider, alias });
      await this.persist();
      return account;
    });
  }

  /**
   * Remove an account that never finished authorizing — a typo in the alias or the
   * owner email, most often.
   *
   * Keyed off the stored credential, NOT off `status`. Status is derived and moves
   * with health checks, so a row that is `unhealthy` today may well be holding a
   * working credential; trusting it here would eventually delete something the
   * operator cannot recreate, because they do not hold the upstream login. An
   * imported codex home is refused for the same reason — the row is a pointer to
   * real credential material living outside this store.
   */
  async deleteAccount(id) {
    return this.serialized(async () => {
      const account = this.accountById(id);
      if (!account) throw new Error('account not found');
      if (account.credential) {
        throw new Error('account holds a stored credential and cannot be deleted');
      }
      if (account.external) {
        throw new Error('account is an imported credential home and cannot be deleted here');
      }
      const attached = this.state.devices.filter(
        (device) => device.account_id === id && !device.revoked_at,
      ).length;
      if (attached) {
        throw new Error(`account still has ${attached} active device(s)`);
      }
      const stateBefore = structuredClone(this.state);
      try {
        const prunedPolicies = [];
        for (const device of this.state.devices) {
          const hasAllowed = Object.hasOwn(device, 'allowed_account_ids');
          const hasSelected = Object.hasOwn(device, 'selected_account_id');
          if (!hasAllowed && !hasSelected) continue;
          if (device.selected_account_id === id) {
            if (!device.revoked_at) {
              throw new Error(`account is selected by active device ${device.id}; switch it before deleting`);
            }
            delete device.allowed_account_ids;
            delete device.selected_account_id;
            prunedPolicies.push(device.id);
            continue;
          }
          if (Array.isArray(device.allowed_account_ids)
            && device.allowed_account_ids.includes(id)) {
            const allowed = device.allowed_account_ids.filter((accountId) => accountId !== id);
            if (allowed.length > 0 && hasSelected) device.allowed_account_ids = allowed;
            else {
              delete device.allowed_account_ids;
              delete device.selected_account_id;
            }
            prunedPolicies.push(device.id);
          }
        }
        this.state.accounts = this.state.accounts.filter((entry) => entry.id !== id);
        // Half-finished authorization sessions and unredeemed enrollment links for a
        // deleted account are unusable; leaving them would let a stale link resolve
        // against a missing row.
        this.state.oauth_flows = this.state.oauth_flows.filter((flow) => flow.account_id !== id);
        this.state.enrollments = this.state.enrollments.filter((entry) => entry.account_id !== id);
        this.audit('account_deleted', {
          account_id: id,
          provider: account.provider,
          alias: account.alias,
          device_account_policies_pruned: prunedPolicies,
        });
        await this.persist();
        return account;
      } catch (error) {
        this.state = stateBefore;
        throw error;
      }
    });
  }

  async updateAccountHealth(id, { success, error = null }) {
    return this.serialized(async () => {
      const account = this.accountById(id);
      if (!account) return;
      if (success) {
        const previousSuccess = account.last_success_at ? Date.parse(account.last_success_at) : 0;
        if (account.status === 'healthy' && Date.now() - previousSuccess < 5 * 60_000) return;
        account.status = 'healthy';
        account.last_success_at = nowIso();
        delete account.last_failure;
      } else {
        account.status = 'unhealthy';
        account.last_failure_at = nowIso();
        account.last_failure = String(error ?? 'unknown failure').slice(0, 240);
      }
      await this.persist();
    });
  }

  async updateAccountEmailLabel(id, emailLabel) {
    return this.serialized(async () => {
      const account = this.accountById(id);
      if (!account) throw new Error('account not found');
      if (account.provider !== 'claude') throw new Error('account is not a Claude account');
      const normalized = String(emailLabel ?? '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
        throw new Error('a valid account owner email is required');
      }
      account.email_label = normalized.slice(0, 160);
      this.audit('account_email_updated', { account_id: id });
      await this.persist();
      return account;
    });
  }

  // Claude and Codex share one oauth_flows collection deliberately: one set of
  // rules for state digests, encrypted verifiers, supersession, and expiry.
  #openAuthorizationFlow({ account, verifier, state, initiatedBy, ttlMinutes, event }) {
    const now = Date.now();
    for (const flow of this.state.oauth_flows) {
      if (flow.account_id === account.id && !flow.used_at && Date.parse(flow.expires_at) > now) {
        flow.superseded_at = nowIso();
      }
    }
    const id = randomToken(12);
    const flow = {
      id,
      account_id: account.id,
      state_sha256: sha256(state),
      verifier: encryptJson(
        this.masterKey,
        { code_verifier: verifier },
        `oauth-flow:${id}:verifier:v1`,
      ),
      initiated_by: String(initiatedBy ?? '').slice(0, 160),
      created_at: nowIso(),
      expires_at: new Date(now + ttlMinutes * 60_000).toISOString(),
      used_at: null,
    };
    this.state.oauth_flows.push(flow);
    if (this.state.oauth_flows.length > 100) {
      this.state.oauth_flows.splice(0, this.state.oauth_flows.length - 100);
    }
    this.audit(event, {
      oauth_flow_id: id,
      account_id: account.id,
      initiated_by: flow.initiated_by,
    });
    return flow;
  }

  #decryptedFlow(flow) {
    const credential = decryptJson(
      this.masterKey,
      flow.verifier,
      `oauth-flow:${flow.id}:verifier:v1`,
    );
    return { ...flow, verifier: credential.code_verifier, state_sha256: undefined };
  }

  #liveFlowById(flowId) {
    const flow = this.state.oauth_flows.find((entry) => entry.id === flowId);
    if (!flow) throw new Error('authorization session was not found');
    if (flow.used_at) throw new Error('authorization session was already used');
    if (flow.superseded_at) throw new Error('authorization session was replaced');
    if (Date.parse(flow.expires_at) <= Date.now()) throw new Error('authorization session expired');
    return flow;
  }

  #flowByState({ accountId, state }) {
    const digest = sha256(state);
    const flow = [...this.state.oauth_flows].reverse().find((entry) => (
      entry.account_id === accountId && entry.state_sha256 === digest
    ));
    if (!flow) throw new Error('authorization session was not found; start again');
    if (flow.used_at) throw new Error('authorization session was already used');
    if (flow.superseded_at) throw new Error('authorization session was replaced; start again');
    if (Date.parse(flow.expires_at) <= Date.now()) {
      throw new Error('authorization session expired; start again');
    }
    return this.#decryptedFlow(flow);
  }

  async beginClaudeAuthorization({ accountId, verifier, state, initiatedBy, ttlMinutes = 15 }) {
    return this.serialized(async () => {
      const account = this.accountById(accountId);
      if (!account) throw new Error('account not found');
      if (account.provider !== 'claude') throw new Error('account is not a Claude account');
      if (!account.email_label) throw new Error('account owner email is required before authorization');
      const flow = this.#openAuthorizationFlow({
        account,
        verifier,
        state,
        initiatedBy,
        ttlMinutes,
        event: 'claude_authorization_started',
      });
      await this.persist();
      return { ...flow, verifier: undefined, state_sha256: undefined };
    });
  }

  async beginCodexAuthorization({ accountId, verifier, state, initiatedBy, ttlMinutes = 15 }) {
    return this.serialized(async () => {
      const account = this.accountById(accountId);
      if (!account) throw new Error('account not found');
      if (account.provider !== 'codex') throw new Error('account is not a Codex account');
      const flow = this.#openAuthorizationFlow({
        account,
        verifier,
        state,
        initiatedBy,
        ttlMinutes,
        event: 'codex_authorization_started',
      });
      await this.persist();
      return { ...flow, verifier: undefined, state_sha256: undefined };
    });
  }

  /**
   * A codex-credential home holds exactly one credential, so seeding it for a
   * second account overwrites the first account's — and the refresh token that
   * replaces is single-use, so the loss is permanent. Checked when a session
   * starts, where nothing is spent yet, and again before the write.
   */
  assertCodexSeedHome({ accountId, seedHome }) {
    if (!seedHome) return;
    // Canonicalized on both sides: `cli.js import-codex` stores `resolve(home)`,
    // so a trailing slash or a `/./` in the configured value would otherwise read
    // as a different home and wave through the overwrite this exists to stop.
    const target = resolve(seedHome);
    const account = this.accountById(accountId);
    const boundHome = account?.external?.home;
    if (boundHome && resolve(boundHome) !== target) {
      throw new Error(
        `${account.alias} holds its credential in ${boundHome}, not the configured seed home ${seedHome}`,
      );
    }
    const owner = this.state.accounts.find((entry) => (
      entry.id !== accountId && entry.external?.home && resolve(entry.external.home) === target
    ));
    if (owner) {
      throw new Error(
        `${owner.alias} already holds the credential in ${seedHome}; seeding this account would overwrite it`,
      );
    }
  }

  claudeAuthorizationByState({ accountId, state }) {
    return this.#flowByState({ accountId, state });
  }

  codexAuthorizationByState({ accountId, state }) {
    return this.#flowByState({ accountId, state });
  }

  #liveCodexFlow(accountId) {
    return [...this.state.oauth_flows].reverse().find((entry) => (
      entry.account_id === accountId
      && !entry.used_at
      && !entry.superseded_at
      && Date.parse(entry.expires_at) > Date.now()
    )) ?? null;
  }

  /**
   * Whether a pasted code can still be accepted, without decrypting the verifier.
   * The page uses this to keep the paste box on screen after a failed attempt, so
   * a mistyped paste does not force a fresh round trip through OpenAI.
   */
  pendingCodexAuthorization({ accountId }) {
    const flow = this.#liveCodexFlow(accountId);
    return flow ? { id: flow.id, expires_at: flow.expires_at } : null;
  }

  /**
   * A bare pasted code carries no state, so fall back to the account's single
   * live session. Starting a session supersedes the previous one, so there is
   * never more than one to choose between.
   */
  liveCodexAuthorization({ accountId }) {
    const flow = this.#liveCodexFlow(accountId);
    if (!flow) throw new Error('no authorization session is waiting for a code; start again');
    return this.#decryptedFlow(flow);
  }

  /**
   * Retire a completed Codex session. The credential itself is never passed in:
   * it belongs in a codex-credential home or in the operator's hands, never in
   * `state.json` or the audit log.
   */
  async completeCodexAuthorization({ flowId, seededHome = null, expiresAt = null }) {
    return this.serialized(async () => {
      const flow = this.#liveFlowById(flowId);
      const account = this.accountById(flow.account_id);
      if (!account || account.provider !== 'codex') throw new Error('Codex account was not found');
      flow.used_at = nowIso();
      delete flow.verifier;
      if (seededHome) {
        // Only where to read the credential's health, never the credential.
        account.external ??= { kind: 'codex-credential', home: seededHome };
        account.status = 'stored';
        account.expires_at = expiresAt;
        account.last_success_at = nowIso();
        delete account.last_failure;
        delete account.last_failure_at;
      }
      this.audit('codex_authorization_completed', {
        oauth_flow_id: flow.id,
        account_id: account.id,
        seeded_home: seededHome,
      });
      await this.persist();
      return account;
    });
  }

  async completeClaudeAuthorization({ flowId, accessToken, emailAddress, expiresAt, scope = null }) {
    return this.serialized(async () => {
      const flow = this.#liveFlowById(flowId);
      const account = this.accountById(flow.account_id);
      if (!account || account.provider !== 'claude') throw new Error('Claude account was not found');
      const expectedEmail = String(account.email_label ?? '').trim().toLowerCase();
      const actualEmail = String(emailAddress ?? '').trim().toLowerCase();
      if (!actualEmail) throw new Error('Claude did not return an account email; credential was not stored');
      if (actualEmail !== expectedEmail) {
        throw new Error(`authorized account email does not match ${expectedEmail}`);
      }
      if (typeof accessToken !== 'string' || !accessToken.startsWith('sk-ant-oat')) {
        throw new Error('Claude did not return a valid inference token');
      }
      account.credential = encryptJson(
        this.masterKey,
        {
          oauth_token: accessToken,
          ...(typeof scope === 'string' && scope ? { scope } : {}),
        },
        `account:${account.id}:credential:v1`,
      );
      account.status = 'healthy';
      account.expires_at = expiresAt;
      account.last_success_at = nowIso();
      delete account.last_failure;
      delete account.last_failure_at;
      flow.used_at = nowIso();
      delete flow.verifier;
      this.audit('claude_authorization_completed', {
        oauth_flow_id: flow.id,
        account_id: account.id,
        email: actualEmail,
      });
      await this.persist();
      return account;
    });
  }

  async createEnrollment({ accountId, memberLabel, ttlMinutes = 30 }) {
    return this.serialized(async () => {
      const account = this.accountById(accountId);
      if (!account) throw new Error('account not found');
      const code = randomToken(24);
      const record = {
        id: randomToken(12),
        code_sha256: sha256(code),
        account_id: accountId,
        member_label: String(memberLabel ?? '').slice(0, 160),
        created_at: nowIso(),
        expires_at: new Date(Date.now() + ttlMinutes * 60_000).toISOString(),
        used_at: null,
      };
      this.state.enrollments.push(record);
      this.audit('enrollment_created', {
        enrollment_id: record.id,
        account_id: accountId,
        member_label: record.member_label,
      });
      await this.persist();
      return { code, record };
    });
  }

  enrollmentByCode(code) {
    const digest = sha256(code);
    return this.state.enrollments.find((record) => record.code_sha256 === digest) ?? null;
  }

  async redeemEnrollment({ code, deviceName, machineId = null }) {
    return this.serialized(async () => {
      const enrollment = this.enrollmentByCode(code);
      if (!enrollment) throw new Error('enrollment code not found');
      if (enrollment.used_at) throw new Error('enrollment code was already used');
      if (Date.parse(enrollment.expires_at) <= Date.now()) throw new Error('enrollment code expired');
      const account = this.accountById(enrollment.account_id);
      if (!account) throw new Error('account no longer exists');

      const { token, device } = buildDevice({
        account,
        memberLabel: enrollment.member_label,
        deviceName,
        machineId,
      });
      enrollment.used_at = nowIso();
      enrollment.device_id = device.id;
      this.state.devices.push(device);
      this.audit('device_enrolled', {
        device_id: device.id,
        account_id: account.id,
        member_label: device.member_label,
        name: device.name,
        ...(device.machine_id ? { machine_id: device.machine_id } : {}),
      });
      await this.persist();
      return { account, device, token };
    });
  }

  async issueDeviceCredential({ accountId, memberLabel, deviceName, machineId = null }) {
    return this.serialized(async () => {
      const account = this.accountById(accountId);
      if (!account) throw new Error('account not found');
      // "Usable" means something different per provider, because the console
      // holds the two credentials in different places by design: a Claude
      // credential is stored here, encrypted, while a Codex account keeps only
      // a pointer to the home the refresh centre publishes into. Demanding
      // `credential` of both made Codex permanently unissuable, which is what
      // left the Codex gateway route unreachable in practice.
      const usable = account.provider === 'claude'
        ? Boolean(account.credential)
        : account.provider === 'codex' && account.external?.kind === 'codex-credential';
      if (!usable) {
        throw new Error('account is not available for gateway self-service');
      }
      if (account.expires_at && Date.parse(account.expires_at) <= Date.now()) {
        throw new Error('account credential is expired');
      }
      const normalizedMember = String(memberLabel ?? '').slice(0, 160);
      const duplicate = this.state.devices.some((device) => (
        !device.revoked_at
        && device.account_id === account.id
        && device.member_label === normalizedMember
        && device.name === deviceName
      ));
      if (duplicate) throw new Error('an active credential already exists for this device name');

      const { token, device } = buildDevice({
        account,
        memberLabel: normalizedMember,
        deviceName,
        machineId,
      });
      this.state.devices.push(device);
      this.audit('device_self_enrolled', {
        device_id: device.id,
        account_id: account.id,
        member_label: device.member_label,
        name: device.name,
        ...(device.machine_id ? { machine_id: device.machine_id } : {}),
      });
      await this.persist();
      return { account, device, token };
    });
  }

  deviceByToken(token) {
    return this.state.devices.find(
      (device) => !device.revoked_at && secretMatches(token, device.token_sha256),
    ) ?? null;
  }

  async markDeviceSeen(deviceId) {
    return this.serialized(async () => {
      const device = this.state.devices.find((entry) => entry.id === deviceId);
      if (!device || device.revoked_at) return;
      const previous = device.last_seen_at ? Date.parse(device.last_seen_at) : 0;
      if (Date.now() - previous < 60_000) return;
      device.last_seen_at = nowIso();
      await this.persist();
    });
  }

  publicDevices() {
    return this.state.devices.map((stored) => {
      const pending = this.pendingDeviceAccountFields.get(stored.id);
      const device = pending ? { ...stored } : stored;
      if (pending) {
        if (pending.hasAllowed) device.allowed_account_ids = pending.allowedAccountIds;
        else delete device.allowed_account_ids;
        if (pending.hasSelected) device.selected_account_id = pending.selectedAccountId;
        else delete device.selected_account_id;
      }
      const { token_sha256: _secret, ...publicDevice } = device;
      return { ...publicDevice };
    });
  }

  /**
   * The device list read as a machine inventory.
   *
   * A device row is one credential issuance, not a machine: it is identified by a
   * self-asserted member label plus a name somebody typed, revocation only marks
   * the row, and moving a machine between accounts appends another row. So the
   * flat list only grows and cannot answer "what machines are there". Grouping by
   * the reported handle can.
   *
   * Two rules keep this honest about what it does not know:
   *
   *   - a row with no `machine_id` predates the handle (or came from a caller
   *     without one) and is reported as its own `legacy: true` entry with
   *     `machine_id: null`. Merging such rows on name or member label would be a
   *     guess, and the whole point of the handle is to stop guessing;
   *   - `active_devices` / `revoked_devices` count every row of that machine;
   *     everything else — `devices`, the distinct lists, the timestamps —
   *     describes only the rows `includeRevoked` admits. An inventory should show
   *     what is live now without losing the fact that the machine has
   *     accumulated dead rows.
   *
   * Machines appear in the order they first issued a credential. By default a
   * machine whose rows are all revoked is omitted entirely — it is history, not
   * inventory — and `includeRevoked: true` brings it and its rows back.
   */
  publicMachines({ includeRevoked = false } = {}) {
    const machines = new Map();

    for (const device of this.publicDevices()) {
      const key = device.machine_id ? `machine:${device.machine_id}` : `device:${device.id}`;
      let machine = machines.get(key);
      if (!machine) {
        machine = {
          machine_id: device.machine_id ?? null,
          legacy: !device.machine_id,
          devices: [],
          account_ids: [],
          member_labels: [],
          names: [],
          active_devices: 0,
          revoked_devices: 0,
          first_created_at: null,
          last_seen_at: null,
        };
        machines.set(key, machine);
      }

      if (device.revoked_at) machine.revoked_devices += 1;
      else machine.active_devices += 1;
      if (!includeRevoked && device.revoked_at) continue;

      machine.devices.push(device);
      for (const [field, value] of [
        ['account_ids', device.account_id],
        ['member_labels', device.member_label],
        ['names', device.name],
      ]) {
        if (value !== null && value !== undefined && !machine[field].includes(value)) {
          machine[field].push(value);
        }
      }
      if (device.created_at
        && (machine.first_created_at === null || device.created_at < machine.first_created_at)) {
        machine.first_created_at = device.created_at;
      }
      if (device.last_seen_at
        && (machine.last_seen_at === null || device.last_seen_at > machine.last_seen_at)) {
        machine.last_seen_at = device.last_seen_at;
      }
    }

    return [...machines.values()].filter((machine) => machine.devices.length > 0);
  }

  /**
   * File a legacy issuance under a machine, by writing the handle it never had.
   *
   * This is the only way a row written before handles existed can join the
   * inventory: the Claude path has no client agent, so nothing on the member's
   * machine can report a handle at issuance time, and the operator is the only
   * one who knows that `alex`'s `work-laptop` row and that Codex machine are the
   * same box.
   *
   * Deliberately the narrowest possible write:
   *
   *   - it adds one absent field to one device row. No account is read or
   *     touched, no credential is re-encrypted, no other row moves;
   *   - a row that already carries the requested handle is already where it is
   *     being asked to go, so that is success with nothing written. Two clicks,
   *     a double submit, or a replayed form therefore cost one row change in
   *     total;
   *   - a row carrying a DIFFERENT handle is refused outright. Reassigning it
   *     would be rewriting a recorded fact on the strength of a form post, and
   *     the wrong answer silently merges two machines that are not one. An
   *     operator who really did mis-merge can revoke the credential; there is no
   *     un-merge, on purpose.
   *
   * @returns {Promise<{device: object, changed: boolean}>}
   */
  async mergeDeviceIntoMachine({ deviceId, machineId }) {
    return this.serialized(async () => {
      const machine = normalizedMachineId(machineId);
      if (!machine) throw new Error('a machine handle is required');
      const device = this.state.devices.find((entry) => entry.id === deviceId);
      if (!device) throw new Error('device not found');
      if (device.machine_id === machine) return { device, changed: false };
      if (device.machine_id) {
        throw new Error('device is already attributed to a different machine');
      }
      device.machine_id = machine;
      this.audit('device_machine_merged', {
        device_id: device.id,
        account_id: device.account_id,
        name: device.name,
        machine_id: machine,
      });
      await this.persist();
      return { device, changed: true };
    });
  }

  async revokeDevice(deviceId) {
    return this.serialized(async () => {
      const device = this.state.devices.find((entry) => entry.id === deviceId);
      if (!device) throw new Error('device not found');
      if (!device.revoked_at) {
        device.revoked_at = nowIso();
        this.audit('device_revoked', {
          device_id: device.id,
          account_id: device.account_id,
          name: device.name,
        });
        await this.persist();
      }
      return device;
    });
  }
}
