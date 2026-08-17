import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CONSOLE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const REPOSITORY_ROOT = dirname(CONSOLE_ROOT);

test('P3 account switching and self-only machine API are documented without an enroll endpoint', async () => {
  const [rootEnglish, rootChinese, consoleReadme, deploy] = await Promise.all([
    readFile(join(REPOSITORY_ROOT, 'README.md'), 'utf8'),
    readFile(join(REPOSITORY_ROOT, 'README.zh-CN.md'), 'utf8'),
    readFile(join(CONSOLE_ROOT, 'README.md'), 'utf8'),
    readFile(join(CONSOLE_ROOT, 'DEPLOY.md'), 'utf8'),
  ]);

  assert.match(rootEnglish, /switch among accounts an administrator has allowed/i);
  assert.match(rootEnglish, /cannot inspect or switch another device/i);
  assert.match(rootChinese, /管理员已允许的账号之间/);
  assert.match(rootChinese, /不能查看或修改其他设备/);

  for (const document of [consoleReadme, deploy]) {
    assert.match(document, /\/claude\/control\/v1\/status/);
    assert.match(document, /\/claude\/control\/v1\/account/);
    assert.match(document, /device's existing|existing token/i);
    assert.match(document, /no .*enroll|no control-API enroll/i);
    assert.doesNotMatch(document, /\/claude\/control\/v1\/enroll/);
  }
  assert.match(consoleReadme, /next request/i);
  assert.match(consoleReadme, /never accepts a device ID/i);
  assert.match(consoleReadme, /older deployments|written before this feature/i);
  assert.match(deploy, /cannot read or modify any other device/i);
});
