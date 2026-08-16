#!/usr/bin/env node
/**
 * client-agent — fetches a short-lived Codex credential and installs it.
 *
 * Run on a timer (see install/). Idempotent: when the local credential still has
 * comfortable life left it does nothing, so running it more often is harmless.
 *
 * The credential it writes has `refresh_token` set to an empty string. Both
 * halves of that are load-bearing and both were measured against codex-cli 0.145.0:
 *
 *   - the field must be PRESENT — deleting it makes codex fail to parse the file
 *     ("missing field `refresh_token`");
 *   - the value must be INVALID — that is what makes this machine structurally
 *     unable to refresh, so it can never rotate the center's token away and
 *     silently kill every other machine's credential.
 *
 * Verified: a credential in this shape completed a real turn, and left auth.json
 * byte-identical afterwards.
 */

import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { homedir, hostname } from 'node:os';
import { mkdir, readFile, rename, chmod, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { pinnedRequest } from './lib/pinned-request.js';

const ENDPOINT = process.env.CODEX_CRED_ENDPOINT; // e.g. https://203.0.113.10:8443
const TOKEN = process.env.CODEX_CRED_TOKEN;
/** SHA-256 of the server certificate, hex. Required — see pinning note below. */
const PIN = process.env.CODEX_CRED_CERT_PIN;

const CODEX_HOME = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const AUTH_PATH = join(CODEX_HOME, 'auth.json');

/** Renew once less than this remains. Tokens live ~10 days; 4 days tolerates several missed runs. */
const RENEW_BELOW_DAYS = Number(process.env.CODEX_CRED_RENEW_BELOW_DAYS ?? 4);
const DAY_MS = 86_400_000;

const WINDOWS_ACL_SCRIPT = `
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
if ($Kind -eq 'directory') {
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $inherit = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $inherit = [System.Security.AccessControl.InheritanceFlags]::None
}
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object -TypeName System.Security.AccessControl.FileSystemAccessRule -ArgumentList @(
  $identity,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inherit,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
if ($Kind -eq 'directory') {
  [System.IO.Directory]::SetAccessControl($Target, $acl)
} else {
  [System.IO.File]::SetAccessControl($Target, $acl)
}
`;

function log(event, detail = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, host: hostname(), ...detail }));
}

/** Replace inherited Windows ACLs with one rule for the current identity. */
export async function hardenWindowsAcl(path, {
  directory = false,
  execFileImpl = execFile,
} = {}) {
  const targetBase64 = Buffer.from(path, 'utf8').toString('base64');
  const command = [
    `$Target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${targetBase64}'))`,
    `$Kind='${directory ? 'directory' : 'file'}'`,
    WINDOWS_ACL_SCRIPT,
  ].join(';');
  const encodedCommand = Buffer.from(command, 'utf16le').toString('base64');
  await new Promise((resolve, reject) => {
    execFileImpl(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedCommand],
      { windowsHide: true },
      (error) => error ? reject(error) : resolve(),
    );
  });
}

/** Read a JWT's `exp` without verifying it — we only need to know when to act. */
function expiryOf(jwt) {
  const segments = String(jwt ?? '').split('.');
  if (segments.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the credential over TLS with certificate pinning.
 *
 * The pinning itself lives in `lib/pinned-request.js`, shared with `enroll.js` —
 * see that file for why the bearer is attached only after the peer is verified.
 */
export async function fetchCredential({
  endpoint = ENDPOINT,
  token = TOKEN,
  pin = PIN,
} = {}) {
  const { statusCode, body } = await pinnedRequest({
    endpoint,
    path: '/credential',
    method: 'GET',
    pin,
    bearer: token,
  });

  if (statusCode !== 200) {
    throw new Error(`dispenser returned ${statusCode}: ${body.slice(0, 200)}`);
  }
  try {
    return JSON.parse(body);
  } catch (err) {
    throw new Error(`dispenser returned unparseable body: ${err.message}`);
  }
}

/** Same crash-safe write as the center: temp + fsync + rename. */
async function writeAtomic(path, data) {
  const tmp = `${path}.${randomBytes(6).toString('hex')}.tmp`;
  let created = false;
  let renamed = false;
  try {
    const handle = await open(tmp, 'wx', 0o600);
    created = true;
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(tmp, path);
    renamed = true;
    await chmod(path, 0o600);
    try {
      const directory = await open(dirname(path), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch (error) {
      // Windows cannot open directories as file handles. Rename remains atomic
      // there, but directory fsync is only available on Unix-like platforms.
      if (process.platform !== 'win32') throw error;
    }
  } finally {
    if (created && !renamed) await unlink(tmp).catch(() => {});
  }
}

async function currentExpiry() {
  try {
    const local = JSON.parse(await readFile(AUTH_PATH, 'utf8'));
    return expiryOf(local?.tokens?.access_token);
  } catch {
    return null; // absent or unreadable — treat as "needs a credential"
  }
}

async function main() {
  const missing = ['CODEX_CRED_ENDPOINT', 'CODEX_CRED_TOKEN', 'CODEX_CRED_CERT_PIN'].filter(
    (name) => !process.env[name],
  );
  if (missing.length) {
    log('misconfigured', { missing });
    process.exitCode = 2;
    return;
  }

  const force = process.argv.includes('--force');
  const expiry = await currentExpiry();
  const remainingDays = expiry ? (expiry.getTime() - Date.now()) / DAY_MS : null;

  if (!force && remainingDays !== null && remainingDays > RENEW_BELOW_DAYS) {
    log('still_fresh', {
      expires_at: expiry.toISOString(),
      remaining_days: Number(remainingDays.toFixed(2)),
    });
    return;
  }

  log('pulling', {
    reason: expiry ? `${remainingDays.toFixed(2)}d remaining` : 'no usable local credential',
  });

  let issued;
  try {
    issued = await fetchCredential();
  } catch (err) {
    // Fail closed and loudly. Leaving a stale credential in place silently is how
    // you get a Codex worker that starts fine and then dies mid-turn on an opaque
    // 451, hours away from the actual cause.
    log('pull_failed', {
      error: err.message,
      impact:
        expiry && remainingDays > 0
          ? `existing credential still valid for ${remainingDays.toFixed(2)} days`
          : 'NO VALID CREDENTIAL — codex will fail on this machine',
    });
    process.exitCode = 1;
    return;
  }

  await mkdir(CODEX_HOME, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') await hardenWindowsAcl(CODEX_HOME, { directory: true });
  await writeAtomic(
    AUTH_PATH,
    `${JSON.stringify(
      {
        auth_mode: 'chatgpt',
        OPENAI_API_KEY: null,
        tokens: {
          access_token: issued.access_token,
          id_token: issued.id_token,
          account_id: issued.account_id,
          // Present but deliberately invalid — see the module header.
          refresh_token: '',
        },
        last_refresh: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  if (process.platform === 'win32') await hardenWindowsAcl(AUTH_PATH);

  log('installed', { path: AUTH_PATH, expires_at: issued.expires_at });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log('unhandled_failure', { error: err.stack ?? String(err) });
    process.exitCode = 1;
  });
}
