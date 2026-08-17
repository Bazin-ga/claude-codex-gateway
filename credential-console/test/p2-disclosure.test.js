import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { CredentialStore } from '../lib/store.js';

const CONSOLE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = dirname(CONSOLE_ROOT);

async function readRepositoryFiles() {
  const paths = {
    readmeEn: join(REPOSITORY_ROOT, 'README.md'),
    readmeZh: join(REPOSITORY_ROOT, 'README.zh-CN.md'),
    consoleReadme: join(CONSOLE_ROOT, 'README.md'),
    deploy: join(CONSOLE_ROOT, 'DEPLOY.md'),
    packageJson: join(CONSOLE_ROOT, 'package.json'),
    service: join(CONSOLE_ROOT, 'install', 'credential-console.service'),
    gitignore: join(REPOSITORY_ROOT, '.gitignore'),
    contributing: join(REPOSITORY_ROOT, 'CONTRIBUTING.md'),
  };
  const contents = await Promise.all(Object.values(paths).map((path) => readFile(path, 'utf8')));
  return {
    ...Object.fromEntries(Object.keys(paths).map((key, index) => [key, contents[index]])),
    package: JSON.parse(contents[4]),
  };
}

function versionTuple(engine) {
  const match = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(engine));
  assert.ok(match, `unsupported Node engine expression: ${engine}`);
  return [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
}

function compareVersions(left, right) {
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function sectionBetween(text, startMarker, endMarker = null) {
  const start = text.indexOf(startMarker);
  assert.notEqual(start, -1, `missing documentation section: ${startMarker}`);
  const end = endMarker ? text.indexOf(endMarker, start + startMarker.length) : text.length;
  assert.notEqual(end, -1, `missing documentation section end: ${endMarker}`);
  return text.slice(start, end);
}

test('P6 disclosure is prominent, permanent, and explicit about the open audience', async () => {
  const files = await readRepositoryFiles();
  const englishTop = files.readmeEn.split('\n').slice(0, 14).join('\n');
  const chineseTop = files.readmeZh.split('\n').slice(0, 14).join('\n');
  const englishNotice = englishTop.replace(/^>\s?/gm, '');
  const chineseNotice = chineseTop.replace(/^>\s?/gm, '');
  const consoleNotice = files.consoleReadme.replace(/^>\s?/gm, '');

  assert.match(englishNotice, /Telemetry notice/i);
  assert.match(englishNotice, /records metadata for every proxied\s+Claude gateway\s+request/i);
  assert.match(englishNotice, /four provider-reported token counts/i);
  assert.match(englishNotice, /makes those metrics\s+visible to every\s+member who can reach the console/i);
  assert.match(englishNotice, /P6 permanently stores every captured\s+conversation turn from Claude/i);
  assert.match(englishNotice, /prompt\/reply text visible to everyone who can reach the console/i);
  assert.match(englishNotice, /open.*anyone on the tailnet.*no identity and no reading audit/is);
  assert.match(englishNotice, /Codex traffic is not covered by conversation capture/i);

  assert.match(chineseNotice, /遥测告知/);
  assert.match(chineseNotice, /记录每个经代理转发的 Claude 网关请求元数据/);
  assert.match(chineseNotice, /服务商报告的四类 token 数/);
  assert.match(chineseNotice, /这些指标向所有能够访问控制台的成员公开/);
  assert.match(chineseNotice, /P6[\s\S]*永久保存[\s\S]*已捕获[\s\S]*Claude 对话/);
  assert.match(chineseNotice, /open[\s\S]*tailnet[\s\S]*没有身份识别[\s\S]*阅读审计/i);
  assert.match(chineseNotice, /Codex 流量不在对话采集范围内/);

  assert.match(consoleNotice, /every proxied\s+Claude gateway request produces a persistent\s+metadata row/i);
  assert.match(consoleNotice, /four provider-reported token-count fields/i);
  assert.match(consoleNotice, /Member labels are\s+self-entered\s+and unverified/i);
  assert.match(consoleNotice, /must not be used for accountability or billing/i);

  for (const english of [files.readmeEn, files.consoleReadme, files.deploy]) {
    assert.match(english, /permanently\s+(?:stores|retains)[\s\S]{0,120}captured[\s\S]{0,80}conversation/i);
    assert.match(english, /open[\s\S]{0,220}(?:anyone|tailnet)[\s\S]{0,180}(?:no identity|no reading audit)/i);
    assert.match(english, /Codex[\s\S]{0,100}(?:not covered|outside|not captured)/i);
  }
  assert.match(files.readmeZh, /永久保存[\s\S]{0,100}已捕获[\s\S]{0,80}Claude 对话/);
  assert.match(files.readmeZh, /tailnet[\s\S]{0,120}(?:没有身份识别|无身份)[\s\S]{0,80}(?:阅读审计|审计)/i);
  assert.match(files.readmeZh, /Codex 流量不在对话采集范围内/);
});

test('console runtime and deployment docs pin Node, warning suppression, and metrics backup recovery', async () => {
  const files = await readRepositoryFiles();

  assert.ok(compareVersions(versionTuple(files.package.engines?.node), [22, 5, 0]) >= 0);
  assert.match(files.service, /^Environment=PATH=\/usr\/local\/bin:\/usr\/bin:\/bin$/m);
  assert.match(files.service, /^ExecStartPre=.*process\.versions\.node.*major<22/m);
  assert.match(files.service, /^ExecStart=.*node\s+--no-warnings\s+.*credential-console\/server\.js$/m);
  assert.match(files.gitignore, /^metrics\.sqlite$/m);
  assert.match(files.gitignore, /^metrics\.sqlite-wal$/m);
  assert.match(files.gitignore, /^metrics\.sqlite-shm$/m);
  assert.match(files.contributing, /Node ≥ 22\.5/);

  const snapshot = sectionBetween(
    files.deploy,
    '### Create and transfer a backup',
    '### Verify that the backup restores',
  );
  assert.match(snapshot, /checkpoint-metrics/);
  assert.match(snapshot, /files\+?=\(metrics\.sqlite\)/);
  assert.match(snapshot, /console_home\/metrics\.sqlite/);

  const restore = sectionBetween(files.deploy, '### Restore or roll back');
  assert.match(restore, /metrics\.sqlite/);
  assert.match(restore, /checkpoint-metrics/);
  assert.match(restore, /metrics\.sqlite-(?:wal|shm)/);
  assert.match(files.consoleReadme, /schema 2 to schema 3/i);
  assert.match(files.consoleReadme, /permanent sensitive content/i);
  assert.match(files.deploy, /schema 2 to schema 3/i);
  assert.match(files.deploy, /permanently retained conversation text/i);
  assert.match(files.deploy, /root-only\/encrypted/i);
});

function collectJsonLines(child, output) {
  let pending = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    output.raw += chunk;
    pending += chunk;
    const lines = pending.split('\n');
    pending = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        output.events.push(JSON.parse(line));
      } catch {
        output.nonJson.push(line);
      }
    }
  });
}

async function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
  ]);
  const result = await exited;
  if (result === null && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await once(child, 'exit');
  }
}

test('real server announces metadata and conversation disclosure before listening', { timeout: 15_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'credential-console-p2-disclosure-'));
  const testToken = 'p2-disclosure-test-token-never-log';
  const testBody = 'p2-disclosure-test-body-never-log';
  let child = null;
  const output = { raw: '', stderr: '', events: [], nonJson: [] };
  try {
    const store = await new CredentialStore(home, { allowKeyInit: true }).init();
    await store.addAccount({
      provider: 'claude',
      alias: testBody,
      credential: { oauth_token: testToken },
    });
    const env = {
      ...process.env,
      CREDENTIAL_CONSOLE_HOME: home,
      CREDENTIAL_CONSOLE_BIND: '127.0.0.1',
      CREDENTIAL_CONSOLE_PORT: '0',
      CREDENTIAL_CONSOLE_COOKIE_SECURE: '0',
      CREDENTIAL_CONSOLE_ADMIN_AUTH: 'open',
      CREDENTIAL_CONSOLE_USAGE_REFRESH_INTERVAL_MS: '60000',
    };
    for (const name of [
      'CREDENTIAL_CONSOLE_CODEX_ENDPOINT',
      'CREDENTIAL_CONSOLE_CODEX_CERT_PIN',
      'CREDENTIAL_CONSOLE_CODEX_ENROLLMENT_KEY_FILE',
      'CREDENTIAL_CONSOLE_CODEX_SEED_HOME',
    ]) delete env[name];

    child = spawn(process.execPath, ['--no-warnings', 'server.js'], {
      cwd: CONSOLE_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { output.stderr += chunk; });
    collectJsonLines(child, output);

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const privacyIndex = output.events.findIndex((event) => event.event === 'privacy_metadata_recording');
      const listeningIndex = output.events.findIndex((event) => event.event === 'credential_console_listening');
      if (privacyIndex !== -1 && listeningIndex !== -1) break;
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server exited before disclosure/listening events: ${output.stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const privacyIndex = output.events.findIndex((event) => event.event === 'privacy_metadata_recording');
    const listeningIndex = output.events.findIndex((event) => event.event === 'credential_console_listening');
    assert.notEqual(privacyIndex, -1, `privacy event missing; stderr: ${output.stderr}`);
    assert.notEqual(listeningIndex, -1, `listening event missing; stderr: ${output.stderr}`);
    assert.ok(privacyIndex < listeningIndex, 'disclosure must be logged before the listener is announced');

    const privacy = output.events[privacyIndex];
    assert.equal(privacy.enabled, true);
    assert.match(privacy.detail, /metadata/i);
    assert.match(privacy.detail, /four provider-reported token counts/i);
    assert.match(privacy.detail, /visible to every console member/i);
    assert.match(privacy.detail, /member labels are self-entered and unverified/i);
    assert.match(privacy.detail, /must not be used for accountability or billing/i);
    assert.match(privacy.detail, /eligible Claude human prompts and assistant replies are permanently stored/i);
    assert.match(privacy.detail, /visible to every console member/i);
    assert.match(privacy.detail, /open mode anyone (?:on the tailnet )?who can reach the console can read them/i);
    assert.match(privacy.detail, /no identity and no reading audit/i);
    assert.match(privacy.detail, /Codex traffic is not captured/i);
    assert.equal(output.nonJson.length, 0, `unexpected non-JSON startup output: ${output.nonJson.join('\n')}`);
    assert.doesNotMatch(output.stderr, /ExperimentalWarning/);

    assert.equal(output.raw.includes(testToken), false);
    assert.equal(output.raw.includes(testBody), false);
    assert.equal(output.stderr.includes(testToken), false);
    assert.equal(output.stderr.includes(testBody), false);
  } finally {
    if (child) await stopChild(child);
    await rm(home, { recursive: true, force: true });
  }
});
