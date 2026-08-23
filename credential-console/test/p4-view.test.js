import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { dashboardView } from '../lib/views.js';

const CONSOLE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = dirname(CONSOLE_ROOT);

const BASE = {
  accounts: [],
  devices: [],
  machines: [],
  codexClients: [],
  csrf: 'p4-view-csrf',
  adminIdentity: 'member@example.test',
  onboardingUrl: 'https://private-console.example/onboarding.md',
};

test('dashboard renders a copyable private onboarding link with no public-guide route', () => {
  const html = dashboardView(BASE);
  assert.match(html, /data-i18n="ai-onboarding-guide"/);
  assert.match(html, /data-i18n="ai-onboarding-intro"/);
  assert.match(html, /id="onboarding-guide-link">https:\/\/private-console\.example\/onboarding\.md<\/pre>/);
  assert.match(html, /data-copy-target="onboarding-guide-link" data-i18n="copy-onboarding-link"/);
  assert.match(html, /href="https:\/\/private-console\.example\/onboarding\.md" target="_blank" rel="noopener noreferrer" data-i18n="open-onboarding-guide"/);
  assert.equal((html.match(/href="[^"]*AI-ONBOARDING\.md/g) ?? []).length, 0);
  assert.equal(html.includes('/enroll'), false);
  assert.equal(html.includes('/credential'), false);
  assert.equal(html.includes('/control/v1'), false);
});

test('open mode visibly warns that anyone reachable can read live onboarding metadata', () => {
  const html = dashboardView({ ...BASE, openMode: true, adminIdentity: null });
  const warning = html.match(/<div class="notice error tiny"[^>]*data-i18n="open-onboarding-warning"[\s\S]*?<\/div>/)?.[0] ?? '';
  assert.match(warning, /anyone who can reach this console can read this live guide/i);
  assert.match(warning, /member labels are unverified/i);
  assert.match(warning, /do not identify the actor/i);
  assert.match(html, /data-i18n="open-banner"/);
});

test('onboarding URL is escaped in both copy text and link attributes', () => {
  const html = dashboardView({
    ...BASE,
    onboardingUrl: 'https://private-console.example/onboarding.md?x="<script>alert(1)</script>',
  });
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.match(html, /&quot;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /onboarding\.md\?x="<script/);
});

test('Chinese app translations include the onboarding visibility and copy labels', async () => {
  // The client script and its translation dictionary live in lib/app-asset.js
  // so they can be content-addressed; the keys are still shipped from here.
  const serverSource = (await readFile(join(CONSOLE_ROOT, 'server.js'), 'utf8'))
    + (await readFile(join(CONSOLE_ROOT, 'web', 'console-client.js'), 'utf8'));
  for (const key of [
    'ai-onboarding-guide',
    'ai-onboarding-intro',
    'open-onboarding-warning',
    'copy-onboarding-link',
    'open-onboarding-guide',
  ]) {
    assert.match(serverSource, new RegExp(`'${key}':`), `missing translation key ${key}`);
  }
  assert.equal(serverSource.includes('private-console.example'), false);
  assert.equal(serverSource.includes('p4-view-csrf'), false);
  assert.match(serverSource, /navigator\.clipboard\?\.writeText/);
  assert.match(serverSource, /document\.execCommand\('copy'\)/);
  assert.equal(REPOSITORY_ROOT.endsWith('claude-codex-gateway'), true);
});

test('operator docs describe the private live guide, open-mode visibility, and version recovery', async () => {
  const [readme, deploy] = await Promise.all([
    readFile(join(CONSOLE_ROOT, 'README.md'), 'utf8'),
    readFile(join(CONSOLE_ROOT, 'DEPLOY.md'), 'utf8'),
  ]);
  for (const document of [readme, deploy]) {
    assert.match(document, /AI-ONBOARDING\.md/);
    assert.match(document, /\/onboarding\.md/);
    assert.match(document, /Copy guide link/);
    assert.match(document, /same reachability\/identity and session logic/i);
    assert.match(document, /open-mode GET[\s\S]{0,80}anonymous[\s\S]{0,30}session/i);
    assert.match(document, /open.*mode[\s\S]{0,260}anyone[\s\S]{0,120}read/i);
    assert.match(document, /client configuration version/i);
    assert.match(document, /exact\s+equality/i);
    assert.match(document, /mismatch[\s\S]{0,100}report both|mismatch reports both/i);
    assert.match(document, /never\s+automatically\s+replace\s+or\s+downgrade|neither[\s\S]{0,80}automatically\s+replaces\s+or\s+downgrades|without\s+automatically\s+replacing[\s\S]{0,30}or[\s\S]{0,30}downgrading/i);
    assert.match(document, /operator explicitly approves|after operator approval/i);
    assert.match(document, /explicitly authorize[\s\S]{0,180}secret-bearing/i);
    assert.match(document, /must\s+(?:not|never)[\s\S]{0,300}paste[\s\S]{0,300}conversation/i);
  }
});
