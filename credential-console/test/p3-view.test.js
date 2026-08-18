import assert from 'node:assert/strict';
import test from 'node:test';
import { dashboardView } from '../lib/views.js';

const ACCOUNT_A = {
  id: 'account-a',
  provider: 'claude',
  alias: 'claude-a',
  status: 'healthy',
  email_label: 'a@example.test',
  active_devices: 3,
  expires_at: null,
};
const ACCOUNT_B = {
  id: 'account-b',
  provider: 'claude',
  alias: '<img src=x onerror=alert(1)>',
  status: 'login_required',
  email_label: 'b@example.test',
  active_devices: 0,
  expires_at: null,
};
const CODEX_ACCOUNT = {
  id: 'codex-account',
  provider: 'codex',
  alias: 'codex-a',
  status: 'healthy',
  email_label: '',
  active_devices: 0,
  expires_at: null,
};
const MACHINE_ID = 'machine-shared-1234567890';

function activeDevice({ id, name, memberLabel, machineId, extra = {} }) {
  return {
    id,
    account_id: ACCOUNT_A.id,
    name,
    member_label: memberLabel,
    ...(machineId === undefined ? {} : { machine_id: machineId }),
    created_at: '2026-08-17T00:00:00.000Z',
    last_seen_at: null,
    revoked_at: null,
    ...extra,
  };
}

const SHARED_SELECTED_B = activeDevice({
  id: 'device-shared-b',
  name: 'shared-b',
  memberLabel: 'member-b',
  machineId: MACHINE_ID,
  extra: {
    allowed_account_ids: [ACCOUNT_A.id, ACCOUNT_B.id],
    selected_account_id: ACCOUNT_B.id,
    token: 'secret-device-token',
    token_sha256: 'secret-device-digest',
  },
});
const SHARED_SELECTED_A = activeDevice({
  id: 'device-shared-a',
  name: 'shared-a',
  memberLabel: 'member-a',
  machineId: MACHINE_ID,
  extra: {
    allowed_account_ids: [ACCOUNT_A.id, ACCOUNT_B.id],
    selected_account_id: ACCOUNT_A.id,
  },
});
const REVOKED = activeDevice({
  id: 'device-revoked',
  name: 'revoked-device',
  memberLabel: 'retired',
  machineId: MACHINE_ID,
  extra: {
    allowed_account_ids: [ACCOUNT_A.id, ACCOUNT_B.id],
    selected_account_id: ACCOUNT_B.id,
    revoked_at: '2026-08-17T01:00:00.000Z',
  },
});
const LEGACY_UNATTRIBUTED = activeDevice({
  id: 'device-legacy',
  name: 'legacy-device',
  memberLabel: 'legacy-member',
  machineId: null,
});
const INVALID_UNATTRIBUTED = activeDevice({
  id: 'device-invalid',
  name: 'invalid-device',
  memberLabel: 'invalid-member',
  machineId: null,
  extra: {
    // Explicit P3 fields are malformed: the view must not silently fall back to
    // account_id or render a selector with an invented selected account.
    allowed_account_ids: [ACCOUNT_A.id, 'unknown-account'],
    selected_account_id: 'unknown-account',
  },
});

function render({ openMode = true, completedDraft = null } = {}) {
  return dashboardView({
    accounts: [ACCOUNT_A, ACCOUNT_B, CODEX_ACCOUNT],
    devices: [SHARED_SELECTED_B, SHARED_SELECTED_A, REVOKED, LEGACY_UNATTRIBUTED, INVALID_UNATTRIBUTED],
    machines: [
      {
        machine_id: MACHINE_ID,
        legacy: false,
        devices: [SHARED_SELECTED_B, SHARED_SELECTED_A, REVOKED],
        active_devices: 2,
        revoked_devices: 1,
      },
      {
        machine_id: null,
        legacy: true,
        devices: [LEGACY_UNATTRIBUTED],
        active_devices: 1,
        revoked_devices: 0,
      },
      {
        machine_id: null,
        legacy: true,
        devices: [INVALID_UNATTRIBUTED],
        active_devices: 1,
        revoked_devices: 0,
      },
    ],
    codexClients: [{
      account_id: CODEX_ACCOUNT.id,
      name: 'codex-machine',
      machine_id: MACHINE_ID,
      revoked: false,
      added_at: '2026-08-17T00:00:00.000Z',
    }],
    csrf: 'csrf-p3',
    adminIdentity: null,
    openMode,
    completedDraft,
  });
}

function deviceRow(html, deviceId) {
  const marker = `data-device-id="${deviceId}"`;
  const markerIndex = html.indexOf(marker);
  assert.notEqual(markerIndex, -1, `device row ${deviceId} should render`);
  const start = html.lastIndexOf('<tr ', markerIndex);
  const end = html.indexOf('</tr>', markerIndex);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  return html.slice(start, end + '</tr>'.length);
}

function accountActions(html) {
  return html.match(/action="\/devices\/[^"/]+\/account"/g) ?? [];
}

test('each valid active Claude credential gets its own selected-account form and metadata', () => {
  const html = render();
  const sharedB = deviceRow(html, SHARED_SELECTED_B.id);
  const sharedA = deviceRow(html, SHARED_SELECTED_A.id);
  const legacy = deviceRow(html, LEGACY_UNATTRIBUTED.id);

  for (const [row, id] of [[sharedB, SHARED_SELECTED_B.id], [sharedA, SHARED_SELECTED_A.id], [legacy, LEGACY_UNATTRIBUTED.id]]) {
    assert.match(row, new RegExp(`action="/devices/${id}/account"`));
    assert.match(row, /name="csrf" value="csrf-p3"/);
    assert.match(row, /name="selected_account_id"/);
    assert.match(row, /data-i18n="original-account"/);
    assert.match(row, /data-i18n="allowed-accounts"/);
    assert.match(row, /data-i18n="selected-account"/);
    assert.match(row, /data-i18n="switch-account"/);
    assert.match(row, /data-account-switch data-device-id=/);
    assert.match(row, /data-account-switch-status role="status" aria-live="polite"/);
    assert.match(row, /data-selected-account-cell/);
    assert.match(row, /value='account-a'/);
    assert.match(row, /value='account-b'/);
    assert.match(row, /data-account-status="login_required"/);
    assert.match(row, /login required/);
  }

  assert.match(sharedB, /value='account-b'[^>]* selected/);
  assert.match(sharedA, /value='account-a'[^>]* selected/);
  assert.match(legacy, /value='account-a'[^>]* selected/);
  assert.equal(accountActions(html).length, 3);
});

test('safe dashboard drafts are opt-in and never include credential or authorization fields', () => {
  const html = render();
  for (const key of [
    'claude-self-service',
    'register-claude-account',
    'register-codex-account',
  ]) {
    assert.match(html, new RegExp(`data-persist-draft="${key}"`));
  }
  assert.match(html, /name="account_id" required data-draft-field/);
  assert.match(html, /name="device_name"[^>]*data-draft-field/);
  assert.match(html, /name="alias"[^>]*data-draft-field/);
  assert.match(html, /name="email_label"[^>]*data-draft-field/);
  assert.doesNotMatch(html, /type="hidden"[^>]*data-draft-field/);
  assert.doesNotMatch(html, /name="(?:csrf|authorization|token)"[^>]*data-draft-field/);
  assert.match(
    render({ completedDraft: 'register-claude-account' }),
    /data-completed-draft="register-claude-account"/,
  );
});

test('same machine rows and null-machine rows keep independent switch targets', () => {
  const html = render();
  const sharedB = deviceRow(html, SHARED_SELECTED_B.id);
  const sharedA = deviceRow(html, SHARED_SELECTED_A.id);
  const legacy = deviceRow(html, LEGACY_UNATTRIBUTED.id);
  const invalid = deviceRow(html, INVALID_UNATTRIBUTED.id);

  assert.match(sharedB, /action="\/devices\/device-shared-b\/account"/);
  assert.doesNotMatch(sharedB, /device-shared-a\/account/);
  assert.match(sharedA, /action="\/devices\/device-shared-a\/account"/);
  assert.doesNotMatch(sharedA, /device-shared-b\/account/);
  assert.match(legacy, /action="\/devices\/device-legacy\/account"/);
  assert.doesNotMatch(legacy, /device-invalid\/account/);
  assert.doesNotMatch(invalid, /\/account"/);
  assert.match(invalid, /data-i18n="account-selection-invalid"/);
  assert.equal((invalid.match(/name="selected_account_id"/g) ?? []).length, 0);
});

test('explicit policy must retain the immutable original account', () => {
  const device = activeDevice({
    id: 'device-original-not-allowed',
    name: 'original-not-allowed',
    memberLabel: 'policy-member',
    machineId: null,
    extra: {
      allowed_account_ids: [ACCOUNT_B.id],
      selected_account_id: ACCOUNT_B.id,
    },
  });
  const html = dashboardView({
    accounts: [ACCOUNT_A, ACCOUNT_B],
    devices: [device],
    machines: [{
      machine_id: null,
      legacy: true,
      devices: [device],
      active_devices: 1,
      revoked_devices: 0,
    }],
    codexClients: [],
    csrf: 'csrf-original-policy',
    openMode: false,
  });
  const row = deviceRow(html, device.id);
  assert.match(row, /data-i18n="account-selection-invalid"/);
  assert.doesNotMatch(row, /name="selected_account_id"/);
  assert.doesNotMatch(row, /\/account"/);
});

test('revoked and Codex rows do not render account switching controls', () => {
  const html = render();
  const revoked = deviceRow(html, REVOKED.id);
  assert.doesNotMatch(revoked, /\/account"/);
  assert.doesNotMatch(revoked, /name="selected_account_id"/);

  const codexRow = [...html.matchAll(/<tr data-credential-state="active">[\s\S]*?<\/tr>/g)]
    .map((match) => match[0])
    .find((row) => row.includes('<td>Codex</td>'));
  assert.ok(codexRow, 'Codex row should render');
  assert.doesNotMatch(codexRow, /\/account"/);
  assert.doesNotMatch(codexRow, /name="selected_account_id"/);
});

test('open mode warns about anonymous actor and does not treat member label as actor', () => {
  const html = render({ openMode: true });
  assert.match(html, /data-i18n="open-account-switch-warning"/);
  assert.match(html, /anyone who can reach this console can switch any active device/i);
  assert.match(html, /actor is recorded as anonymous/i);
  assert.match(html, /a member label is not an actor/i);
});

test('account selection values and secrets are escaped or omitted', () => {
  const html = render();
  assert.equal((html.match(/<script/g) ?? []).length, 1, 'only the existing app.js script tag should remain');
  assert.equal(html.includes('<img src=x onerror=alert(1)>'), false);
  assert.doesNotMatch(html, /<(?:img|script)[^>]*\bonerror\s*=/i);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.equal(html.includes('secret-device-token'), false);
  assert.equal(html.includes('secret-device-digest'), false);
  assert.match(html, /data-account-option/);
  assert.match(html, /data-account-label/);
});
