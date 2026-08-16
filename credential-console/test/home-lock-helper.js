import { acquireHomeLock } from '../lib/home-lock.js';

const [home, holdMs] = process.argv.slice(2);

if (home) try {
  const lock = await acquireHomeLock(home, { role: 'test-holder' });
  await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
  await lock.release();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
