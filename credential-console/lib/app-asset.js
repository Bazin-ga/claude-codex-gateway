import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * The console's client script, with a content-addressed URL.
 *
 * It used to be served from a fixed path under the default `no-store`, so every
 * full navigation re-downloaded 63 KB of unchanged JavaScript. Naming it by its
 * own digest lets it be cached permanently: a new build is a new URL, so there
 * is nothing to invalidate. This mirrors what the metrics bundle already does.
 *
 * Read from a real file, not embedded here as a template literal: that form ate
 * backslashes, so regular expressions in the client silently lost their escapes.
 */
export const APP_ASSET_SOURCE = readFileSync(
  new URL('../web/console-client.js', import.meta.url),
  'utf8',
);

export const APP_ASSET_SHA256 = createHash('sha256')
  .update(APP_ASSET_SOURCE, 'utf8')
  .digest('hex');

export const APP_ASSET_URL = `/assets/app.${APP_ASSET_SHA256.slice(0, 12)}.js`;
