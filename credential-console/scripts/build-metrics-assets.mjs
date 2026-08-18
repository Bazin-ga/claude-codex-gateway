#!/usr/bin/env node

import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const assetsDirectory = join(root, 'assets');
const entryPoint = join(root, 'web/metrics-echarts.entry.js');
const manifestPath = join(assetsDirectory, 'metrics-echarts-manifest.json');
const outputPrefix = 'metrics-echarts.';
const outputSuffix = '.js';
const maxBundleBytes = 700 * 1024;
const checkOnly = process.argv.includes('--check');

function digest(algorithm, body, encoding) {
  return createHash(algorithm).update(body).digest(encoding);
}

async function bundle() {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    write: false,
    minify: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2020'],
    legalComments: 'eof',
    charset: 'utf8',
    logLevel: 'silent',
    banner: {
      js: '/*! Apache ECharts 6.1.0 (Apache-2.0); bundled locally for Credential Console. See assets/licenses/. */',
    },
  });
  if (result.outputFiles.length !== 1) throw new Error('metrics bundle produced unexpected outputs');
  // Some upstream legal comments carry CRLF or spaces before a newline. Keep
  // the committed generated asset deterministic and git-diff clean without
  // changing executable tokens.
  const normalized = result.outputFiles[0].text
    .replaceAll('\r\n', '\n')
    .replace(/[ \t]+$/gm, '');
  return Buffer.from(normalized, 'utf8');
}

function manifestFor(body) {
  const sha256 = digest('sha256', body, 'hex');
  const file = `${outputPrefix}${sha256.slice(0, 12)}${outputSuffix}`;
  return {
    version: 1,
    echartsVersion: '6.1.0',
    file,
    url: `/assets/${file}`,
    sha256,
    integrity: `sha384-${digest('sha384', body, 'base64')}`,
    bytes: body.length,
  };
}

async function assertLicenses() {
  for (const relativePath of [
    'licenses/echarts-LICENSE.txt',
    'licenses/echarts-NOTICE.txt',
    'licenses/echarts-d3-LICENSE.txt',
    'licenses/zrender-LICENSE.txt',
    'licenses/tslib-LICENSE.txt',
  ]) {
    const body = await readFile(join(assetsDirectory, relativePath));
    if (body.length < 20) throw new Error(`missing or empty third-party notice: ${relativePath}`);
  }
}

async function check(body, expected) {
  const actual = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('metrics asset manifest is stale; run npm run build:metrics-assets');
  }
  const committed = await readFile(join(assetsDirectory, actual.file));
  if (!committed.equals(body)) {
    throw new Error('committed metrics bundle is stale; run npm run build:metrics-assets');
  }
  const generated = (await readdir(assetsDirectory))
    .filter((name) => name.startsWith(outputPrefix) && name.endsWith(outputSuffix));
  if (generated.length !== 1 || generated[0] !== actual.file) {
    throw new Error('metrics assets contain stale generated bundles');
  }
}

async function writeAtomic(path, body) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { flag: 'wx' });
  await rename(temporary, path);
}

async function generate(body, manifest) {
  await mkdir(assetsDirectory, { recursive: true });
  for (const name of await readdir(assetsDirectory)) {
    if (!name.startsWith(outputPrefix) || !name.endsWith(outputSuffix) || name === manifest.file) continue;
    await unlink(join(assetsDirectory, name));
  }
  await writeAtomic(join(assetsDirectory, manifest.file), body);
  await writeAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

const body = await bundle();
const manifest = manifestFor(body);
if (body.length > maxBundleBytes) {
  throw new Error(`metrics bundle exceeds ${maxBundleBytes} bytes (${body.length})`);
}
if (body.includes(Buffer.from('cdn.jsdelivr.net')) || body.includes(Buffer.from('unpkg.com'))) {
  throw new Error('metrics bundle contains a CDN dependency');
}
await assertLicenses();
if (checkOnly) await check(body, manifest);
else await generate(body, manifest);
console.log(`${checkOnly ? 'verified' : 'built'} ${manifest.file} (${manifest.bytes} bytes)`);
