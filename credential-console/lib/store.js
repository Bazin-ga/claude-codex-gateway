import { randomBytes } from 'node:crypto';
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
  hashPassword,
  randomToken,
  secretMatches,
  sha256,
  verifyPassword,
} from './security.js';

const STATE_VERSION = 1;
const MAX_AUDIT_EVENTS = 2_000;

function nowIso() {
  return new Date().toISOString();
}

function newState() {
  return {
    version: STATE_VERSION,
    admin: null,
    accounts: [],
    oauth_flows: [],
    enrollments: [],
    devices: [],
    audit: [],
  };
}

function buildDevice({ account, memberLabel, deviceName }) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(deviceName)) {
    throw new Error('device name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}');
  }
  const token = `sk-ant-api03-${randomToken(32)}`;
  return {
    token,
    device: {
      id: randomToken(12),
      account_id: account.id,
      member_label: String(memberLabel ?? '').slice(0, 160),
      name: deviceName,
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

  async setAdminPassword(password) {
    return this.serialized(async () => {
      this.state.admin = {
        password: await hashPassword(password),
        changed_at: nowIso(),
      };
      this.audit('admin_password_changed');
      await this.persist();
    });
  }

  hasAdmin() {
    return Boolean(this.state?.admin?.password);
  }

  verifyAdminPassword(password) {
    return verifyPassword(password, this.state?.admin?.password);
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
      active_devices: this.state.devices.filter(
        (device) => device.account_id === account.id && !device.revoked_at,
      ).length,
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

  async beginClaudeAuthorization({ accountId, verifier, state, initiatedBy, ttlMinutes = 15 }) {
    return this.serialized(async () => {
      const account = this.accountById(accountId);
      if (!account) throw new Error('account not found');
      if (account.provider !== 'claude') throw new Error('account is not a Claude account');
      if (!account.email_label) throw new Error('account owner email is required before authorization');
      const now = Date.now();
      for (const flow of this.state.oauth_flows) {
        if (flow.account_id === accountId && !flow.used_at && Date.parse(flow.expires_at) > now) {
          flow.superseded_at = nowIso();
        }
      }
      const id = randomToken(12);
      const flow = {
        id,
        account_id: accountId,
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
      this.audit('claude_authorization_started', {
        oauth_flow_id: id,
        account_id: accountId,
        initiated_by: flow.initiated_by,
      });
      await this.persist();
      return { ...flow, verifier: undefined, state_sha256: undefined };
    });
  }

  claudeAuthorizationByState({ accountId, state }) {
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
    const credential = decryptJson(
      this.masterKey,
      flow.verifier,
      `oauth-flow:${flow.id}:verifier:v1`,
    );
    return { ...flow, verifier: credential.code_verifier, state_sha256: undefined };
  }

  async completeClaudeAuthorization({ flowId, accessToken, emailAddress, expiresAt, scope = null }) {
    return this.serialized(async () => {
      const flow = this.state.oauth_flows.find((entry) => entry.id === flowId);
      if (!flow) throw new Error('authorization session was not found');
      if (flow.used_at) throw new Error('authorization session was already used');
      if (flow.superseded_at) throw new Error('authorization session was replaced');
      if (Date.parse(flow.expires_at) <= Date.now()) throw new Error('authorization session expired');
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

  async redeemEnrollment({ code, deviceName }) {
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
      });
      enrollment.used_at = nowIso();
      enrollment.device_id = device.id;
      this.state.devices.push(device);
      this.audit('device_enrolled', {
        device_id: device.id,
        account_id: account.id,
        member_label: device.member_label,
        name: device.name,
      });
      await this.persist();
      return { account, device, token };
    });
  }

  async issueDeviceCredential({ accountId, memberLabel, deviceName }) {
    return this.serialized(async () => {
      const account = this.accountById(accountId);
      if (!account) throw new Error('account not found');
      if (account.provider !== 'claude' || !account.credential) {
        throw new Error('account is not available for Claude Code self-service');
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
      });
      this.state.devices.push(device);
      this.audit('device_self_enrolled', {
        device_id: device.id,
        account_id: account.id,
        member_label: device.member_label,
        name: device.name,
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
    return this.state.devices.map(({ token_sha256: _secret, ...device }) => ({ ...device }));
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
