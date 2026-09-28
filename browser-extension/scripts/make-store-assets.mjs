#!/usr/bin/env node
/**
 * Renders the store listing images from the templates in store/assets/.
 *
 *   npm run store:assets
 *
 * Each template declares the exact size its store demands in `<html data-size="WxH">`, and this
 * script renders it at that size with Firefox's own screenshot mode, then checks the PNG that came
 * out really has those pixel dimensions. Nothing is drawn by hand: change the template, re-run, look
 * at the PNG.
 *
 * Firefox is used because it can screenshot a page at an exact window size from the command line,
 * with no dependencies at all. The images are committed, so this only needs running when the UI or
 * the copy changes.
 *
 * The captures the templates embed (`popup.png`, `options.png`) come from the extension itself:
 *   node scripts/smoke.mjs --screenshots   # writes dist/screenshots/*.png
 * and are copied here, so a UI change means refreshing them too.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const assetsDir = path.join(extensionRoot, 'store', 'assets');

/** Reads the width and height out of a PNG's IHDR chunk: the only honest way to check a screenshot. */
async function pngSize(file) {
  const bytes = await readFile(file);
  if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') throw new Error(`${file} is not a PNG`);
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function findFirefox() {
  if (process.env.QUIET_FIREFOX) return process.env.QUIET_FIREFOX;
  for (const name of ['firefox', 'firefox-esr']) {
    const result = spawnSync('which', [name], { encoding: 'utf8' });
    if (result.status === 0) return result.stdout.trim();
  }
  return null;
}

function render(firefox, template, output, size, profile) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      firefox,
      [
        '--headless',
        '--profile',
        profile,
        `--window-size=${size.width},${size.height}`,
        '--screenshot',
        output,
        `file://${template}`,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`firefox exited ${code}: ${stderr.slice(0, 300)}`))));
  });
}

async function main() {
  const firefox = findFirefox();
  if (!firefox) {
    throw new Error('no firefox on this machine; the committed images in store/assets/ are still usable');
  }

  const templates = (await readdir(assetsDir)).filter((name) => name.endsWith('.html')).sort();
  if (templates.length === 0) throw new Error('no templates in store/assets/');

  const profile = await mkdtemp(path.join(os.tmpdir(), 'quiet-store-'));
  const rendered = [];
  try {
    for (const template of templates) {
      const source = await readFile(path.join(assetsDir, template), 'utf8');
      const declared = source.match(/data-size="(\d+)x(\d+)"/);
      if (!declared) throw new Error(`${template} does not declare data-size="WxH"`);
      const size = { width: Number(declared[1]), height: Number(declared[2]) };

      const output = path.join(assetsDir, `${path.basename(template, '.html')}-${size.width}x${size.height}.png`);
      await render(firefox, path.join(assetsDir, template), output, size, profile);

      const actual = await pngSize(output);
      if (actual.width !== size.width || actual.height !== size.height) {
        throw new Error(`${path.basename(output)} came out ${actual.width}x${actual.height}, not ${size.width}x${size.height}`);
      }
      rendered.push({ file: path.basename(output), size: `${actual.width}x${actual.height}` });
    }
  } finally {
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => {});
  }

  for (const image of rendered) console.log(`  ${image.file}  ${image.size}`);
  console.log(`\n${rendered.length} images rendered into store/assets/`);

  // A reminder rather than a failure: the captures are committed, and only change with the UI.
  const captures = ['popup.png', 'options.png'];
  for (const capture of captures) {
    const file = path.join(assetsDir, capture);
    try {
      await readFile(file);
    } catch (_error) {
      console.log(`note: store/assets/${capture} is missing; copy it from dist/screenshots/ (see store/README.md)`);
    }
  }
}

main().catch((error) => {
  console.error(`\nRendering the store images failed: ${error.message}`);
  process.exitCode = 1;
});
