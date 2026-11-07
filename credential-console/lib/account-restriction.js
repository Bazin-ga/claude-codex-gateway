// Private accounts: an account an administrator has reserved for a list of
// machines. Every other device can neither be issued on it, switched to it,
// failed over to it, nor see it, and the gateway refuses to forward for it.
//
// The list is of machine handles, not devices, so a machine's next credential
// on the same account needs no second visit to the console. A handle is
// derived from the issuing member plus the machine name (see /self-service),
// which is why it is not something another member can reproduce.

const MACHINE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
export const RESTRICTION_MAX_MACHINES = 64;
export const ACCOUNT_RESTRICTED_MESSAGE = 'this account is reserved for other machines; ask an administrator to move this device';

export function normalizeAccountRestriction(value) {
  const machineIds = [];
  for (const id of Array.isArray(value?.machine_ids) ? value.machine_ids : []) {
    if (typeof id === 'string' && MACHINE_ID_PATTERN.test(id) && !machineIds.includes(id)) {
      machineIds.push(id);
    }
  }
  return { enabled: value?.enabled === true, machine_ids: machineIds };
}

export function isRestrictedAccount(account) {
  return normalizeAccountRestriction(account?.restriction).enabled;
}

/** Whether `device` may run on `account`. A public account takes everyone. */
export function accountUsableByDevice(account, device) {
  const restriction = normalizeAccountRestriction(account?.restriction);
  if (!restriction.enabled) return true;
  return typeof device?.machine_id === 'string'
    && restriction.machine_ids.includes(device.machine_id);
}
