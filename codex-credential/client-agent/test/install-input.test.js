import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL('./install-input.test.sh', import.meta.url));

test('installer keeps token-file and process-env credentials out of observable output', {
  timeout: 30_000,
}, async () => {
  const { stdout, stderr } = await execFileAsync('bash', [script], {
    maxBuffer: 1024 * 1024,
  });
  assert.match(stdout, /installer input and secret-output tests passed/);
  assert.equal(stderr, '');
});
