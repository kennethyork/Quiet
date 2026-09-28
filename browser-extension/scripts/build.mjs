/**
 * Builds the browser extension for every browser it supports.
 *
 *   node scripts/build.mjs                       # chromium, firefox, safari + zip/xpi
 *   node scripts/build.mjs --targets=chromium    # one target
 *   node scripts/build.mjs --fetch-optional      # also download the OISD lists
 *
 * One source tree, one manifest per target:
 *   chromium  Chrome, Edge, Brave, Opera, Vivaldi  (service worker)
 *   firefox   Firefox and its forks                (event page, since Gecko has no MV3 service worker)
 *   safari    Safari web extension (macOS/iOS packaging needs Xcode, see the README)
 * plus `safari-content-blocker`, the same domains as Apple content-blocker JSON for the route that
 * does not use a web extension at all.
 *
 * The name and version come from `expo.name` and `expo.version` in the app's app.json, so renaming
 * the app renames the extension with it.
 */
import { createRequire } from 'node:module';
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateRulesets, buildContentBlockers } from './generate-rulesets.mjs';
import { writeZip } from './zip.mjs';

const require = createRequire(import.meta.url);
const { QUIET_LISTS } = require('../src/common/lists.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const srcDir = path.join(extensionRoot, 'src');
const distDir = path.join(extensionRoot, 'dist');
const blocklistDir = path.join(repoRoot, 'modules', 'quiet-vpn', 'android', 'src', 'main', 'assets', 'blocklists');

const ALL_TARGETS = ['chromium', 'firefox', 'safari'];
const ICONS = { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };

function parseArgs(argv) {
  const options = { targets: ALL_TARGETS, fetchOptional: false };
  for (const arg of argv) {
    if (arg.startsWith('--targets=')) {
      options.targets = arg
        .slice('--targets='.length)
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
    } else if (arg === '--fetch-optional') {
      options.fetchOptional = true;
    }
  }
  for (const target of options.targets) {
    if (!ALL_TARGETS.includes(target)) throw new Error(`Unknown target: ${target}`);
  }
  return options;
}

/**
 * The manifest's description. Chrome's review checklist requires it to be 132 characters or fewer,
 * which `test/store.test.cjs` checks, so it lives in one function rather than inline.
 */
export function manifestDescription(name) {
  return `${name} filters adult content in this browser, using the same domain lists as the Android app and no server at all.`;
}

async function readAppIdentity() {
  const appJson = JSON.parse(await readFile(path.join(repoRoot, 'app.json'), 'utf8'));
  const expo = appJson.expo || {};
  const name = expo.name || 'Quiet';
  return {
    name,
    version: expo.version || '1.0.0',
    description: manifestDescription(name),
  };
}

/**
 * The Firefox add-on ID. It appears in the Firefox manifest, in the policy snippets people paste into
 * a managed browser, and in the publishing script, so it lives here rather than in three strings that
 * can drift apart.
 */
export const FIREFOX_ADDON_ID = 'browser-extension@quiet.app';

export function packageName(identity, target) {
  const extension = target === 'firefox' ? 'xpi' : 'zip';
  return `${identity.name.toLowerCase()}-${target}-${identity.version}.${extension}`;
}

function manifestFor(target, identity, rulesetIds) {
  const enabledByDefault = new Set(
    QUIET_LISTS.filter((list) => list.default).map((list) => list.id),
  );

  const manifest = {
    manifest_version: 3,
    name: identity.name,
    short_name: identity.name,
    version: identity.version,
    description: identity.description,
    icons: ICONS,
    action: {
      default_title: `${identity.name} - filtering this browser`,
      default_popup: 'popup/popup.html',
      default_icon: ICONS,
    },
    options_ui: { page: 'options/options.html', open_in_tab: true },
    permissions: ['declarativeNetRequest', 'storage', 'webNavigation', 'activeTab'],
    declarative_net_request: {
      rule_resources: rulesetIds.map((id) => ({
        id,
        enabled: enabledByDefault.has(id),
        path: `rulesets/${id}.json`,
      })),
    },
  };

  if (target === 'firefox') {
    // Gecko runs Manifest V3 backgrounds as event pages: `background.service_worker` is not
    // implemented, and Chrome refuses `background.scripts` on MV3 before Chrome 121, so the two
    // targets get the shape their engine actually supports.
    manifest.background = {
      scripts: ['background/target.js', 'common/domains.js', 'common/lists.js', 'common/settings.js', 'background/background.js'],
    };
    manifest.browser_specific_settings = {
      gecko: {
        id: FIREFOX_ADDON_ID,
        strict_min_version: '115.0',
      },
    };
  } else if (target === 'safari') {
    manifest.background = {
      scripts: ['background/target.js', 'common/domains.js', 'common/lists.js', 'common/settings.js', 'background/background.js'],
    };
    manifest.browser_specific_settings = { safari: { strict_min_version: '16.4' } };
  } else {
    manifest.background = { service_worker: 'background/background.js' };
    manifest.minimum_chrome_version = '102';
  }

  return manifest;
}

async function copySource(target) {
  const targetDir = path.join(distDir, target);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });
  await cp(srcDir, targetDir, { recursive: true });
  await writeFile(
    path.join(targetDir, 'background', 'target.js'),
    `// Written by scripts/build.mjs. The service worker and the event page both read it.\nvar QUIET_TARGET_NAME = '${target}';\n`,
  );
  return targetDir;
}

async function copyRulesets(rulesetDir, targetDir) {
  await cp(rulesetDir, path.join(targetDir, 'rulesets'), { recursive: true });
}

async function walk(dir, base = dir) {
  const out = [];
  for (const name of (await readdir(dir)).sort()) {
    const full = path.join(dir, name);
    const info = await stat(full);
    if (info.isDirectory()) out.push(...(await walk(full, base)));
    else out.push(path.relative(base, full));
  }
  return out;
}

/** Fails the build rather than shipping a ruleset a browser would reject or silently drop. */
async function validateTarget(target, targetDir, manifest) {
  const problems = [];
  const files = new Set(await walk(targetDir));

  for (const resource of manifest.declarative_net_request.rule_resources) {
    if (!files.has(resource.path)) {
      problems.push(`manifest references a missing ruleset: ${resource.path}`);
      continue;
    }
    const rules = JSON.parse(await readFile(path.join(targetDir, resource.path), 'utf8'));
    if (!Array.isArray(rules) || rules.length === 0) {
      problems.push(`${resource.path} is empty`);
      continue;
    }
    if (rules.length > 30000) problems.push(`${resource.path} has ${rules.length} rules, above the per-ruleset budget`);
    const ids = new Set();
    let domains = 0;
    for (const rule of rules) {
      if (!Number.isInteger(rule.id) || rule.id <= 0) problems.push(`${resource.path}: bad rule id`);
      if (ids.has(rule.id)) problems.push(`${resource.path}: duplicate rule id ${rule.id}`);
      ids.add(rule.id);
      if (rule.action?.type !== 'block') problems.push(`${resource.path}: rule ${rule.id} is not a block rule`);
      const list = rule.condition?.requestDomains;
      if (!Array.isArray(list) || list.length === 0) {
        problems.push(`${resource.path}: rule ${rule.id} has no requestDomains`);
        continue;
      }
      domains += list.length;
      for (const domain of list) {
        if (typeof domain !== 'string' || domain.length === 0 || domain.length > 253 || !/^[a-z0-9._-]+$/.test(domain)) {
          problems.push(`${resource.path}: rule ${rule.id} has an unusable domain: ${JSON.stringify(domain)}`);
          break;
        }
      }
    }
    const index = JSON.parse(await readFile(path.join(targetDir, 'rulesets', 'index.json'), 'utf8'));
    const entry = index.rulesets.find((item) => item.id === resource.id);
    if (!entry) problems.push(`${resource.path} is not described in rulesets/index.json`);
    else if (entry.domains !== domains) {
      problems.push(`${resource.path} holds ${domains} domains but the index claims ${entry.domains}`);
    }
  }

  for (const file of [manifest.action.default_popup, manifest.options_ui.page, manifest.icons[16], ...(manifest.background.scripts || [manifest.background.service_worker])]) {
    if (!files.has(file)) problems.push(`manifest references a missing file: ${file}`);
  }

  if (manifest.manifest_version !== 3) problems.push('manifest_version must be 3');
  if (new Set(manifest.permissions).size !== manifest.permissions.length) problems.push('duplicate permissions');
  if (manifest.declarative_net_request.rule_resources.length > 50) problems.push('more than 50 static rulesets');

  return problems;
}

export async function build(options = parseArgs([])) {
  const identity = await readAppIdentity();
  await mkdir(distDir, { recursive: true });

  console.log(`${identity.name} browser extension ${identity.version}`);
  console.log(`Lists: ${blocklistDir}`);
  const index = await generateRulesets({
    blocklistDir,
    outDir: path.join(distDir, '.shared'),
    fetchOptional: options.fetchOptional,
    log: (line) => console.log(line),
  });
  const rulesetIds = index.rulesets.filter((entry) => entry.rules > 0).map((entry) => entry.id);
  const rulesetDir = path.join(distDir, '.shared', 'rulesets');

  const built = [];
  for (const target of options.targets) {
    const targetDir = await copySource(target);
    await copyRulesets(rulesetDir, targetDir);
    const manifest = manifestFor(target, identity, rulesetIds);
    await writeFile(path.join(targetDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

    const problems = await validateTarget(target, targetDir, manifest);
    if (problems.length > 0) {
      throw new Error(`${target} failed validation:\n  - ${problems.join('\n  - ')}`);
    }

    const zipName = packageName(identity, target);
    const zipped = await writeZip(targetDir, path.join(distDir, zipName));
    built.push({ target: targetDir, zip: path.join(distDir, zipName), entries: zipped.entries });
    console.log(`  = ${target}: ${rulesetIds.length} rulesets, packaged ${path.relative(repoRoot, path.join(distDir, zipName))}`);
  }

  if (options.targets.includes('safari')) {
    await buildSafariContentBlockers(index, rulesetDir);
  }

  return { identity, index, built };
}

/**
 * Apple's content-blocker route: the same domains, in the format a Safari content blocker (or the
 * "Blockers" tab of an iOS app) loads directly. It has no allowlist screen of its own, so it is a
 * static export - documented in the README rather than pretended to be the full extension.
 */
async function buildSafariContentBlockers(index, rulesetDir) {
  const names = index.rulesets.map((entry) => entry.id);
  const domains = [];
  for (const id of names) {
    const rules = JSON.parse(await readFile(path.join(rulesetDir, `${id}.json`), 'utf8'));
    for (const rule of rules) domains.push(...rule.condition.requestDomains);
  }
  const unique = [...new Set(domains)].sort();
  const blockers = buildContentBlockers(unique, { maxRules: 150000 });

  const outDir = path.join(distDir, 'safari-content-blocker');
  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  for (let position = 0; position < blockers.length; position += 1) {
    await writeFile(
      path.join(outDir, `blocker-${position + 1}.json`),
      JSON.stringify(blockers[position]),
    );
  }
  await writeFile(
    path.join(outDir, 'README.md'),
    [
      '# Safari content blockers',
      '',
      `Generated from the extension's lists (${unique.length.toLocaleString()} domains).`,
      'Apple allows 150,000 rules per content blocker, so the set is split across',
      `${blockers.length} files; load them all.`,
      '',
      'These are the same domains the web extension blocks, in Apple\'s content-blocker format.',
      'They have no allowlist screen of their own: for the full experience (allowlist, PIN,',
      'statistics, commitment lock) build and load the Safari web extension instead - see',
      '`dist/safari` and `browser-extension/README.md`.',
      '',
    ].join('\n'),
  );
  console.log(`  = safari content blockers: ${blockers.length} files, ${unique.length.toLocaleString()} domains`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  build(parseArgs(process.argv.slice(2))).catch((error) => {
    console.error(`\nBuild failed: ${error.message}`);
    process.exitCode = 1;
  });
}
