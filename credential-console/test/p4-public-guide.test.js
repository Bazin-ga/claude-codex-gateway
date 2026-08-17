import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';
import { createCredentialConsole } from '../server.js';

const CONSOLE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = dirname(CONSOLE_ROOT);
const GUIDE_PATH = join(REPOSITORY_ROOT, 'AI-ONBOARDING.md');

async function readGuide() {
  return readFile(GUIDE_PATH, 'utf8');
}

function relativeLinks(markdown) {
  return [...markdown.matchAll(/\[[^\]]+\]\(([^)#?]+)(?:#[^)]+)?\)/g)]
    .map((match) => match[1]);
}

test('public AI guide is tailnet-first, generic, and actionable only through the console UI', async () => {
  const guide = await readGuide();
  const normalized = guide.replace(/\s+/g, ' ').trim();
  assert.match(guide, /^# AI onboarding guide$/m);
  assert.match(guide, /^guide_revision: 1$/m);
  assert.match(normalized, /public, generic edition/i);
  assert.match(normalized, /documentation from the repository, not a console page or an API/i);
  assert.match(normalized, /full private console link ending in `\/onboarding\.md`/i);
  assert.match(normalized, /Do not run the `codex login` command/i);

  const tailnet = guide.indexOf('## 1. Join the tailnet first');
  const privateInstructions = guide.indexOf('## 2. Read the private, live instructions');
  const claude = guide.indexOf('## 3. Claude Code path');
  const codex = guide.indexOf('## 4. Codex path');
  assert.ok(tailnet >= 0 && tailnet < privateInstructions);
  assert.ok(privateInstructions < claude && claude < codex);

  for (const phrase of [
    'no invitation, approval, or supported sign-in path, stop',
    'browser sign-in or device approval',
    'account owner must authorize',
    'human has not yet approved local execution',
    'Do not guess an account',
  ]) {
    assert.match(normalized, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  }

  const fencedBlocks = [...guide.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]).join('\n');
  assert.equal(fencedBlocks, '', 'the public guide must not ship copy-paste shell/API commands');
  assert.match(normalized, /After explicit approval, the AI may execute/i);
  assert.match(normalized, /must not print it, quote it, upload it, copy it into chat/i);
  assert.equal((guide.match(/https?:\/\//gi) ?? []).length, 0, 'deployment URLs must stay private');

  for (const forbidden of [
    'localhost',
    '127.0.0.1',
    '/var/',
    '100.64.',
    'Bearer',
    'cert pin',
    '/enroll',
    '/credential',
    'control/v1',
    'tailscale funnel',
    'set-enrollment-key',
    'gen-cert',
    'add-client',
    'seed.js',
    'CREDENTIAL_CONSOLE_',
    'CODEX_CRED_',
    'curl ',
    'POST ',
    'GET ',
  ]) {
    assert.equal(guide.toLowerCase().includes(forbidden.toLowerCase()), false, `forbidden public-guide text: ${forbidden}`);
  }
  assert.doesNotMatch(guide, /\b(?:\d{1,3}\.){3}\d{1,3}\b/, 'an IP literal must not enter the generic guide');
  assert.doesNotMatch(guide, /(?:sk-ant-|sk-[A-Za-z0-9_-]{12,}|eyJ[A-Za-z0-9_-]{20,})/i);
  assert.doesNotMatch(guide, /(?:^|[\s`])(?:[A-Za-z0-9_-]+\.)+[A-Za-z]{2,}(?:\s|[`),.;]|$)/m, 'concrete hostnames must not enter the guide');

  const links = relativeLinks(guide);
  assert.deepEqual(links.sort(), [
    'codex-credential/client-agent/README.md',
    'credential-console/README.md',
  ]);
  for (const link of links) {
    await assert.doesNotReject(readFile(join(REPOSITORY_ROOT, link)));
  }
});

test('root README entry points put the AI guide before the operator quickstart', async () => {
  const [english, chinese] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, 'README.md'), 'utf8'),
    readFile(join(REPOSITORY_ROOT, 'README.zh-CN.md'), 'utf8'),
  ]);
  for (const [document, label] of [[english, 'English'], [chinese, 'Chinese']]) {
    const guide = document.indexOf('AI-ONBOARDING.md');
    const quickstart = document.indexOf('QUICKSTART.md');
    assert.ok(guide >= 0, `${label} README must link the public AI guide`);
    assert.ok(quickstart >= 0 && guide < quickstart, `${label} README must put the AI guide first`);
  }
});

test('the console does not expose the public Markdown or common guide routes', async (t) => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-p4-guide-'));
  const store = await new CredentialStore(home, { allowKeyInit: true }).init();
  const created = await createCredentialConsole({
    store,
    adminAuth: 'open',
    publicBaseUrl: 'http://console-placeholder.invalid',
    requestMetrics: null,
    usageMonitor: { stop() {} },
  });
  await new Promise((resolve) => created.server.listen(0, '127.0.0.1', resolve));
  const { port } = created.server.address();
  t.after(async () => {
    await new Promise((resolve) => created.server.close(resolve));
    await rm(home, { recursive: true, force: true });
  });

  for (const path of [
    '/AI-ONBOARDING.md',
    '/ai-onboarding.md',
    '/guide',
    '/guide.md',
    '/.well-known/ai-onboarding',
  ]) {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    assert.equal(response.status, 404, `public guide route unexpectedly exists: ${path}`);
  }
});
