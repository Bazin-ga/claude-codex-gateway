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
import { credentialSwitchBlock, externalAccountStatus } from './external-account-status.js';
import { normalizeCodexGuard, parseCodexGuardInput } from './codex-model-guard.js';
import {
  MODEL_BLOCK_MAX_RULES,
  normalizeModelBlockRules,
  parseModelBlockRuleInput,
} from './model-block-rules.js';

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

/**
 * Every provider a device credential can be issued against.
 *
 * One list rather than the seven copies of `['claude', 'codex']` this replaces.
 * Those copies were spread over the store and the views, and each one is a
 * place where an unlisted provider silently becomes invisible rather than
 * loudly unsupported — a device whose account is not in the list is rendered as
 * misconfigured, and the remedy offered is the one action that would be
 * refused. Adding the third provider by editing seven literals was how that
 * would have happened.
 */
export const GATEWAY_PROVIDERS = Object.freeze(['claude', 'codex', 'bedrock']);

/**
 * A Bedrock account is pinned to exactly one region and one model.
 *
 * Not a convenience: the API key the console holds is an account-wide bearer,
 * so the pin is the only thing standing between a device token and every model
 * in the account. The proxy refuses any other model rather than forwarding it.
 */
const BEDROCK_REGION_PATTERN = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const BEDROCK_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

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
function auditActor(actor) {
  return typeof actor === 'string' && actor ? actor.slice(0, 160) : null;
}

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
      bedrock: account.bedrock ? { ...account.bedrock } : null,
      codex_guard: account.codex_guard ? { ...account.codex_guard } : null,
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
      if (!GATEWAY_PROVIDERS.includes(account.provider)) {
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
    if (!GATEWAY_PROVIDERS.includes(account.provider)) {
      throw storeError('target account is not a gateway account', 'DEVICE_CONFIGURATION_INVALID');
    }
    if (account.status === 'disabled') throw storeError('target account is disabled', 'ACCOUNT_UNAVAILABLE');
    if (account.expires_at && Date.parse(account.expires_at) <= Date.now()) {
      throw storeError('target account credential is expired', 'ACCOUNT_UNAVAILABLE');
    }
    if (account.provider === 'codex') {
      if (account.external?.kind !== 'codex-credential' || !account.external.home) {
        throw storeError('target account has no managed credential home', 'ACCOUNT_UNAVAILABLE');
      }
      return;
    }
    // Bedrock holds a static key here, like Claude, but under its own field and
    // with the region/model pin the proxy enforces. A row missing the pin is
    // unusable in a way the proxy could not report legibly, so it is refused
    // here instead.
    const credentialField = account.provider === 'bedrock' ? 'api_key' : 'oauth_token';
    if (account.provider === 'bedrock'
      && (!account.bedrock?.region || !account.bedrock?.model_id)) {
      throw storeError('target account has no region and model pin', 'ACCOUNT_UNAVAILABLE');
    }
    if (!account.credential) throw storeError('target account has no stored credential', 'ACCOUNT_UNAVAILABLE');
    try {
      if (!this.accountCredential(account.id)?.[credentialField]) {
        throw storeError('target account has no stored credential', 'ACCOUNT_UNAVAILABLE');
      }
    } catch (error) {
      if (error.code === 'ACCOUNT_UNAVAILABLE') throw error;
      throw storeError('target account credential is unavailable', 'ACCOUNT_UNAVAILABLE');
    }
  }

  /**
   * The half of the switch guard that has to touch the filesystem.
   *
   * `#assertSwitchableAccount` can only see the stored row, and the stored row
   * is a lagging indicator: `expires_at` says whether the credential has
   * already died, never whether anything is still able to renew it. A Codex
   * account whose refresh has been quarantined keeps a future `expires_at`
   * right up until the moment it lapses, so the synchronous guard waves it
   * through and the device it was just pointed at starts 503-ing a few hours
   * later, with nothing in the store to explain why.
   *
   * The refresh centre already publishes that missing fact in health.json, and
   * the dashboard already renders it. This reads the same file through the same
   * sanitizer so a switch cannot be made into a state the dashboard is
   * simultaneously flagging as critical.
   *
   * Read failures are deliberately not fatal: `externalAccountStatus` reports
   * them as categories rather than throwing, and `credentialSwitchBlock`
   * treats "cannot read" as "no opinion". A home the console cannot see must
   * stay switchable, because the alternative is an account nobody can select.
   */
  async #assertSwitchableCredentialHealth(account) {
    let block = null;
    try {
      block = credentialSwitchBlock(account, await externalAccountStatus(account));
    } catch {
      // Defence in depth. Neither call is expected to throw, and a fault in
      // observability code must not be able to freeze account switching.
      return;
    }
    if (!block) return;
    // `block.code` comes from the classifier's fixed vocabulary, so this
    // message can never carry a path, an exception, or a credential.
    throw storeError(
      `target account credential is not usable (${block.code})`,
      'ACCOUNT_UNAVAILABLE',
    );
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
        has_credential: account.provider === 'codex'
          ? account.external?.kind === 'codex-credential' && Boolean(account.external.home)
          : Boolean(account.credential),
      },
    };
  }

  /**
   * `deviceAccountSummary` plus the credential's real condition.
   *
   * The synchronous summary reports `account.status`, which the proxy only
   * updates on requests that actually reach upstream. A credential the gateway
   * rejects at the door never gets that far, so a device pointed at a dead
   * account is told `healthy` indefinitely — the machine-facing status endpoint
   * was the last place still saying so while every request 503'd.
   *
   * Kept separate from the synchronous method rather than replacing it: that
   * one is called from non-async paths and is part of the existing surface.
   * `account_status` is promoted to the top level because that is the first key
   * machine-control's projection reads.
   */
  async deviceAccountSummaryWithHealth(deviceId) {
    const summary = this.deviceAccountSummary(deviceId);
    const account = this.accountById(summary.account.id);
    if (!account) return summary;
    let external = {};
    try {
      external = await externalAccountStatus(account);
    } catch {
      // Observability must not be able to break a status read.
      return summary;
    }
    if (typeof external.status !== 'string') return summary;
    return {
      ...summary,
      account_status: external.status,
      account: {
        ...summary.account,
        status: external.status,
        cached_status: summary.account.status,
        expires_at: external.expires_at ?? summary.account.expires_at,
        refresh_health_status: external.refresh_health_status ?? null,
        quarantined: external.refresh_health?.quarantine?.present ?? null,
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
        if (!GATEWAY_PROVIDERS.includes(account.provider)) {
          throw storeError('target account is not a gateway account', 'DEVICE_CONFIGURATION_INVALID');
        }
        // Unlike Claude, an unbound Codex or Bedrock row has nothing in this
        // store that could become usable later on the same route. Selecting one
        // would cut the device over to a guaranteed 503, so refuse before the
        // policy changes. Claude keeps its historical pre-authorization policy
        // workflow unchanged.
        if (account.provider !== 'claude') {
          this.#assertSwitchableAccount(account);
          await this.#assertSwitchableCredentialHealth(account);
        }
        const policy = this.#deviceAccountPolicy(device);
        // Refuse before touching the row, not after. Appending another provider
        // to this device's allowlist makes it mixed, and the mutation below
        // is persisted before anything revalidates it: a crash between that
        // write and the rollback would leave a device that no longer resolves
        // and that this very method can no longer repair, since it reads the
        // policy on entry. Hand-editing state.json would be the only way back.
        const currentProvider = this.accountById(policy.selectedAccountId)?.provider;
        if (currentProvider && currentProvider !== account.provider) {
          throw storeError(
            'device is configured for a different provider',
            'DEVICE_CONFIGURATION_INVALID',
          );
        }
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
        await this.#assertSwitchableCredentialHealth(account);
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
    bedrock = null,
  }) {
    return this.serialized(async () => {
      if (!GATEWAY_PROVIDERS.includes(provider)) throw new Error('unsupported provider');
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(alias)) {
        throw new Error('alias must match [A-Za-z0-9][A-Za-z0-9._-]{1,63}');
      }
      if (this.state.accounts.some((entry) => entry.alias === alias)) {
        throw new Error('account alias already exists');
      }
      // Validated here rather than at the proxy: the pin is what bounds an
      // account-wide bearer key to one model, and a row that reaches the proxy
      // without it has already been offered to members as a usable account.
      let bedrockPin = null;
      if (provider === 'bedrock') {
        const region = String(bedrock?.region ?? '').trim();
        const modelId = String(bedrock?.modelId ?? bedrock?.model_id ?? '').trim();
        if (!BEDROCK_REGION_PATTERN.test(region)) throw new Error('a valid AWS region is required');
        if (!BEDROCK_MODEL_ID_PATTERN.test(modelId)) throw new Error('a valid Bedrock model id is required');
        if (!credential?.api_key) throw new Error('a Bedrock API key is required');
        bedrockPin = { region, model_id: modelId };
      } else if (bedrock) {
        throw new Error('region and model pin are only meaningful for a Bedrock account');
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
        // Region and model id are not secret and must stay readable without the
        // master key: the proxy compares the requested model against them on
        // every turn, and an operator has to be able to see what a row is
        // pinned to. Only the key itself goes through encryptJson above.
        ...(bedrockPin ? { bedrock: bedrockPin } : {}),
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
      // The rule above is about credentials the operator could not recreate: a
      // Claude OAuth token needs the account owner to sit down and authorize
      // again. A Bedrock key does not — the operator pasted it in from the AWS
      // console and can paste it again. Applying the Claude rule to it made a
      // mistyped region or model id permanent, since the row is `stored` from
      // the moment it exists and so never offers the delete control either.
      if (account.credential && account.provider !== 'bedrock') {
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

  /**
   * Append an audit entry for something that happened outside this store.
   *
   * Spending a reset credit changes nothing here — the credit lives upstream —
   * but it is irreversible and worth the same durable record as a credential
   * rotation. Written through `serialized` so it cannot interleave with a
   * mutation mid-persist.
   */
  async recordExternalAudit(event, detail = {}) {
    return this.serialized(async () => {
      this.audit(String(event), detail);
      await this.persist();
      return true;
    });
  }

  async updateExternalAccountExpiry(id, expiresAt) {
    return this.serialized(async () => {
      const account = this.accountById(id);
      if (!account || account.provider !== 'codex'
        || account.external?.kind !== 'codex-credential') {
        throw new Error('Codex external account was not found');
      }
      const parsed = Date.parse(String(expiresAt ?? ''));
      if (!Number.isFinite(parsed)) throw new Error('Codex external account expiry is invalid');
      const normalized = new Date(parsed).toISOString();
      if (account.expires_at === normalized) return false;
      account.expires_at = normalized;
      await this.persist();
      return true;
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

  /**
   * Turn the low-quota model guard on or off for one Codex account.
   *
   * Anyone who can reach the console can change this, which is the deployment's
   * own choice — so the audit records who, and what the setting was before. A
   * switch everybody shares is only manageable if turning it off leaves a
   * trace.
   */
  async setCodexModelGuard(id, { enabled, thresholdPercent, actor = null }) {
    return this.serialized(async () => {
      const account = this.accountById(id);
      if (!account) throw new Error('account not found');
      if (account.provider !== 'codex') throw new Error('account is not a Codex account');
      const guard = parseCodexGuardInput({ enabled, thresholdPercent });
      const previous = normalizeCodexGuard(account.codex_guard);
      account.codex_guard = {
        ...guard,
        updated_at: nowIso(),
        updated_by: typeof actor === 'string' && actor ? actor.slice(0, 160) : null,
      };
      this.audit('codex_model_guard_updated', {
        account_id: id,
        enabled: guard.enabled,
        threshold_percent: guard.threshold_percent,
        previous_enabled: previous.enabled,
        previous_threshold_percent: previous.threshold_percent,
        actor: account.codex_guard.updated_by,
      });
      await this.persist();
      return account;
    });
  }

  /**
   * The console-wide model block rules, normalized, in the order they are
   * checked. Read on every gated request, so it returns what is stored rather
   * than a copy built for editing.
   */
  modelBlockRules() {
    return normalizeModelBlockRules(this.state.model_block_rules);
  }

  /**
   * Add, change or remove a block rule. Like the low-quota guard, anyone who
   * can reach the console may do this, so every change is audited with who
   * made it and what the rule was before.
   */
  async addModelBlockRule({ patterns, messageZh, messageEn, enabled, actor = null }) {
    return this.serialized(async () => {
      const rule = parseModelBlockRuleInput({ patterns, messageZh, messageEn, enabled });
      const rules = normalizeModelBlockRules(this.state.model_block_rules);
      if (rules.length >= MODEL_BLOCK_MAX_RULES) {
        throw new Error(`the console holds at most ${MODEL_BLOCK_MAX_RULES} block rules`);
      }
      const at = nowIso();
      const stored = {
        id: randomToken(12),
        ...rule,
        created_at: at,
        updated_at: at,
        updated_by: auditActor(actor),
      };
      this.state.model_block_rules = [...rules, stored];
      this.audit('model_block_rule_added', {
        rule_id: stored.id,
        enabled: stored.enabled,
        patterns: stored.patterns,
        actor: stored.updated_by,
      });
      await this.persist();
      return stored;
    });
  }

  async updateModelBlockRule(id, { patterns, messageZh, messageEn, enabled, actor = null }) {
    return this.serialized(async () => {
      const rule = parseModelBlockRuleInput({ patterns, messageZh, messageEn, enabled });
      const rules = normalizeModelBlockRules(this.state.model_block_rules);
      const index = rules.findIndex((candidate) => candidate.id === id);
      if (index < 0) throw new Error('block rule not found');
      const previous = rules[index];
      rules[index] = {
        ...previous,
        ...rule,
        updated_at: nowIso(),
        updated_by: auditActor(actor),
      };
      this.state.model_block_rules = rules;
      this.audit('model_block_rule_updated', {
        rule_id: id,
        enabled: rule.enabled,
        patterns: rule.patterns,
        previous_enabled: previous.enabled,
        previous_patterns: previous.patterns,
        message_changed: previous.message_zh !== rule.message_zh
          || previous.message_en !== rule.message_en,
        actor: rules[index].updated_by,
      });
      await this.persist();
      return rules[index];
    });
  }

  async deleteModelBlockRule(id, { actor = null } = {}) {
    return this.serialized(async () => {
      const rules = normalizeModelBlockRules(this.state.model_block_rules);
      const previous = rules.find((candidate) => candidate.id === id);
      if (!previous) throw new Error('block rule not found');
      this.state.model_block_rules = rules.filter((candidate) => candidate.id !== id);
      this.audit('model_block_rule_deleted', {
        rule_id: id,
        previous_enabled: previous.enabled,
        previous_patterns: previous.patterns,
        actor: auditActor(actor),
      });
      await this.persist();
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

  async beginCodexAuthorization({
    accountId,
    verifier,
    state,
    initiatedBy,
    seedHome = null,
    ttlMinutes = 15,
  }) {
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
      // Pin the destination to this OAuth session. A service restart or config
      // change between Start and Complete must never redirect a single-use code
      // into a different account's credential home.
      flow.seed_home = seedHome ? resolve(seedHome) : null;
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
      if (seededHome) this.#bindCodexSeed(account, seededHome, expiresAt);
      this.audit('codex_authorization_completed', {
        oauth_flow_id: flow.id,
        account_id: account.id,
        seeded_home: seededHome,
      });
      await this.persist();
      return account;
    });
  }

  /**
   * Which provider's client a device row belongs to: the provider of the
   * account it has selected, or of the one it was issued against when the
   * selection no longer resolves. The same rule the dashboard uses to put a row
   * in its Claude or Codex section, so a count taken here and a count taken off
   * that section agree.
   */
  #deviceProvider(device) {
    return this.accountById(device.selected_account_id)?.provider
      ?? this.accountById(device.account_id)?.provider
      ?? null;
  }

  /**
   * Which active Claude devices currently answer to `accountId`.
   *
   * Rows whose policy will not resolve are excluded rather than guessed at: the
   * dashboard already shows them as invalid, and a bulk move must not silently
   * decide what a malformed row meant.
   */
  devicesMatching({ accountId = null, memberLabel = null, group = null, provider = null } = {}) {
    const wantAccount = typeof accountId === 'string' && accountId ? accountId : null;
    const wantMember = typeof memberLabel === 'string' && memberLabel ? memberLabel : null;
    const wantGroup = typeof group === 'string' && group ? group : null;
    const wantProvider = typeof provider === 'string' && provider ? provider : null;
    if (!wantAccount && !wantMember && !wantGroup) return [];
    return this.state.devices.filter((device) => {
      if (device.revoked_at) return false;
      if (wantProvider && this.#deviceProvider(device) !== wantProvider) return false;
      if (wantMember && device.member_label !== wantMember) return false;
      // A machine can be in several groups, so this asks whether it is in this
      // one — not whether this one is its group.
      if (wantGroup && !(Array.isArray(device.groups) && device.groups.includes(wantGroup))) return false;
      if (!wantAccount) return true;
      try {
        return this.#deviceAccountPolicy(device).selectedAccountId === wantAccount;
      } catch {
        return false;
      }
    });
  }

  /**
   * Machine groups.
   *
   * The label lives on the credential row for now, because that is the only
   * thing this console can actually identify: every device on the production
   * host reports no machine handle, so `machine_id` is null across the board and
   * grouping by it would ship a feature nobody could use. When agents do report
   * handles, these move to the machine and the credential rows inherit from it —
   * which is why the registry is kept separate from the assignments, so only the
   * assignment side has to change.
   *
   * The registry exists so a name is typed once. Assigning the tenth machine to
   * a group should be a choice from a list, not the tenth chance to misspell it.
   */
  #groupRegistry() {
    if (!Array.isArray(this.state.device_groups)) this.state.device_groups = [];
    return this.state.device_groups;
  }

  deviceGroups() {
    return [...this.#groupRegistry()].sort((a, b) => a.localeCompare(b));
  }

  #normalizedGroupName(name) {
    const normalized = String(name ?? '').trim();
    if (!normalized) throw new Error('a group name is required');
    if (!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,63}$/.test(normalized)) {
      throw new Error('a group name must start alphanumeric and use letters, digits, space, dot, dash or underscore');
    }
    return normalized;
  }

  async createDeviceGroup(name) {
    return this.serialized(async () => {
      const normalized = this.#normalizedGroupName(name);
      const registry = this.#groupRegistry();
      if (registry.includes(normalized)) throw new Error('that group already exists');
      registry.push(normalized);
      this.audit('device_group_created', { group: normalized });
      await this.persist();
      return normalized;
    });
  }

  async renameDeviceGroup(from, to) {
    return this.serialized(async () => {
      const previous = String(from ?? '').trim();
      const next = this.#normalizedGroupName(to);
      const registry = this.#groupRegistry();
      const index = registry.indexOf(previous);
      if (index === -1) throw new Error('that group does not exist');
      if (previous !== next && registry.includes(next)) throw new Error('that group already exists');
      registry[index] = next;
      // Assignments hold names, so a rename has to rewrite them. Doing it here,
      // in the same transaction, is what keeps a rename from orphaning members.
      for (const device of this.state.devices) {
        if (!Array.isArray(device.groups)) continue;
        device.groups = [...new Set(device.groups.map((g) => (g === previous ? next : g)))];
      }
      this.audit('device_group_renamed', { group: previous, renamed_to: next });
      await this.persist();
      return next;
    });
  }

  async deleteDeviceGroup(name) {
    return this.serialized(async () => {
      const target = String(name ?? '').trim();
      const registry = this.#groupRegistry();
      const index = registry.indexOf(target);
      if (index === -1) throw new Error('that group does not exist');
      registry.splice(index, 1);
      let removed = 0;
      for (const device of this.state.devices) {
        if (!Array.isArray(device.groups) || !device.groups.includes(target)) continue;
        device.groups = device.groups.filter((g) => g !== target);
        if (device.groups.length === 0) delete device.groups;
        removed += 1;
      }
      this.audit('device_group_deleted', { group: target, members_released: removed });
      await this.persist();
      return { group: target, membersReleased: removed };
    });
  }

  /** Replace a credential's groups outright; only registered names are accepted. */
  async setDeviceGroups(deviceId, names) {
    return this.serialized(async () => {
      const device = this.state.devices.find((entry) => entry.id === deviceId);
      if (!device) throw new Error('device not found');
      if (device.revoked_at) throw new Error('device is revoked');
      const registry = this.#groupRegistry();
      const wanted = [...new Set((Array.isArray(names) ? names : [names])
        .map((name) => String(name ?? '').trim())
        .filter(Boolean))];
      const unknown = wanted.filter((name) => !registry.includes(name));
      // Silently dropping an unknown name would look like the assignment worked.
      if (unknown.length) throw new Error(`no such group: ${unknown.join(', ')}`);
      if (wanted.length) device.groups = wanted;
      else delete device.groups;
      this.audit('device_groups_set', { device_id: device.id, groups: wanted });
      await this.persist();
      return wanted;
    });
  }

  /** The single-filter case, kept because it reads better where it is used. */
  devicesOnAccount(accountId) {
    return this.devicesMatching({ accountId });
  }

  /** Every member label currently attached to an active device, sorted. */
  activeMemberLabels() {
    const labels = new Set();
    for (const device of this.state.devices) {
      if (device.revoked_at) continue;
      if (typeof device.member_label === 'string' && device.member_label) {
        labels.add(device.member_label);
      }
    }
    return [...labels].sort((a, b) => a.localeCompare(b));
  }

  /**
   * Move every active device currently on `fromAccountId` to `selectedAccountId`.
   *
   * The device set is recomputed here rather than taken from the caller, so the
   * action is exactly "everything on A goes to B" and cannot be widened by a
   * tampered form. `expectedCount` is the guard against the set having changed
   * since the operator looked at it: switching thirty devices when the screen
   * said three is the mistake worth refusing outright.
   *
   * One `persist()` for the whole batch. Per-device persistence would be slow
   * and, worse, could leave half the fleet moved if it failed midway.
   */
  async bulkConfigureDeviceAccount({
    fromAccountId = null,
    memberLabel = null,
    group = null,
    selectedAccountId,
    expectedCount = null,
    actor = null,
    actorType = 'console',
  }) {
    return this.serialized(async () => {
      if (actorType !== 'console') {
        throw storeError('console policy is required', 'DEVICE_CONFIGURATION_INVALID');
      }
      if (typeof selectedAccountId !== 'string' || !selectedAccountId) {
        throw storeError('target account id is required', 'DEVICE_CONFIGURATION_INVALID');
      }
      if (fromAccountId && fromAccountId === selectedAccountId) {
        throw storeError('the target account is the one being moved from', 'DEVICE_CONFIGURATION_INVALID');
      }
      // Without a filter this would move the entire fleet. That is never what a
      // mis-click meant, so it is refused rather than guarded by the count alone.
      if (!fromAccountId && !memberLabel && !group) {
        throw storeError('a filter is required before moving anything', 'DEVICE_CONFIGURATION_INVALID');
      }
      const target = this.accountById(selectedAccountId);
      this.#assertSwitchableAccount(target);
      const source = fromAccountId ? this.accountById(fromAccountId) : null;
      if (source && source.provider !== target.provider) {
        throw storeError(
          'source and target accounts use different providers',
          'DEVICE_CONFIGURATION_INVALID',
        );
      }

      // Only devices of the target's provider. A machine group or a member can
      // hold both a Claude and a Codex credential, and the Codex one cannot move
      // to a Claude account — so it is not part of the set being moved, and
      // counting it would make every mixed group fail the count check below:
      // the dashboard counts one provider's section, and it would never match.
      const devices = this.devicesMatching({
        accountId: fromAccountId,
        memberLabel,
        group,
        provider: target.provider,
      });
      if (expectedCount !== null && devices.length !== expectedCount) {
        throw storeError(
          `the list changed: ${devices.length} devices match that selection now, not ${expectedCount}.`
          + ' Re-check the filter and try again.',
          'DEVICE_CONFIGURATION_STALE',
        );
      }
      if (devices.length === 0) {
        return { switched: [], skipped: [], targetAccountId: selectedAccountId };
      }

      const applied = [];
      const skipped = [];
      try {
        for (const device of devices) {
          const before = this.#captureDeviceAccountFields(device);
          this.pendingDeviceAccountFields.set(device.id, before);
          try {
            this.#assertDeviceMutable(device);
            const policy = this.#deviceAccountPolicy(device);
            if (policy.selectedAccountId === selectedAccountId) {
              // Already there. Filtering by member can catch devices spread over
              // several accounts, and counting a no-op as a move would overstate
              // what happened.
              throw storeError('already on the target account', 'DEVICE_CONFIGURATION_NOOP');
            }
            const currentProvider = this.accountById(policy.selectedAccountId)?.provider;
            if (currentProvider && currentProvider !== target.provider) {
              throw storeError(
                'device is configured for a different provider',
                'DEVICE_CONFIGURATION_INVALID',
              );
            }
            const allowed = [...policy.allowedAccountIds];
            const allowedAdded = allowed.includes(selectedAccountId) ? [] : [selectedAccountId];
            allowed.push(...allowedAdded);
            device.allowed_account_ids = allowed;
            device.selected_account_id = selectedAccountId;
            applied.push({ device, before, previousAccountId: policy.selectedAccountId, allowedAdded });
          } catch (error) {
            // One bad row must not sink the batch; it is reported instead.
            this.#restoreDeviceAccountFields(device, before);
            this.pendingDeviceAccountFields.delete(device.id);
            skipped.push({ deviceId: device.id, reason: error.message });
          }
        }

        for (const entry of applied) {
          this.audit('device_account_configured', this.#deviceAccountAudit({
            device: entry.device,
            previousAccountId: entry.previousAccountId,
            nextAccountId: selectedAccountId,
            outcome: 'success',
            reason: 'bulk',
            allowedAdded: entry.allowedAdded,
            actor,
            actorType,
          }));
        }
        await this.persist();
      } catch (error) {
        for (const entry of applied) {
          this.#restoreDeviceAccountFields(entry.device, entry.before);
        }
        for (const entry of applied) this.pendingDeviceAccountFields.delete(entry.device.id);
        throw error;
      }
      for (const entry of applied) this.pendingDeviceAccountFields.delete(entry.device.id);
      return {
        switched: applied.map((entry) => entry.device.id),
        skipped,
        targetAccountId: selectedAccountId,
      };
    });
  }

  /**
   * Record that a credential was written into `seededHome`, and mark the account
   * healthy again.
   *
   * Shared by the OAuth completion above and the pasted-credential route, so the
   * two cannot drift: however a credential arrives, the account records the same
   * thing — where to read its health, never the credential itself.
   */
  #bindCodexSeed(account, seededHome, expiresAt) {
    // Only where to read the credential's health, never the credential.
    account.external ??= { kind: 'codex-credential', home: seededHome };
    account.status = 'stored';
    account.expires_at = expiresAt;
    account.last_success_at = nowIso();
    delete account.last_failure;
    delete account.last_failure_at;
  }

  /**
   * The pasted-credential counterpart of `completeCodexAuthorization`: same
   * binding, no OAuth session, because there was no redirect to carry one.
   */
  async recordCodexSeed({ accountId, seededHome, expiresAt = null, actor = null }) {
    return this.serialized(async () => {
      const account = this.accountById(accountId);
      if (!account || account.provider !== 'codex') throw new Error('Codex account was not found');
      if (!seededHome) throw new Error('a seeded home is required');
      this.#bindCodexSeed(account, seededHome, expiresAt);
      // The credential is never an argument here, so it can never reach the log.
      this.audit('codex_credential_pasted', {
        account_id: account.id,
        seeded_home: seededHome,
        actor,
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
      const usable = account.provider === 'codex'
        ? account.external?.kind === 'codex-credential'
        : Boolean(account.credential)
          && (account.provider !== 'bedrock'
            || Boolean(account.bedrock?.region && account.bedrock?.model_id));
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
