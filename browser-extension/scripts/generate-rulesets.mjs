/**
 * Turns the app's blocklist files into declarativeNetRequest rulesets.
 *
 * The lists are the ones the Android module ships, parsed by the same port of `DomainRules.kt` that
 * the extension uses at runtime, so a domain is blocked in the browser exactly when the app would
 * have answered the DNS lookup with a block.
 *
 * Rules use `condition.requestDomains` (a list of domains, matching each domain and its
 * sub-domains) rather than one `urlFilter` per domain: 156,000 domains become a few hundred rules
 * instead of 156,000, which keeps the package and the browser's index small.
 */
import { createRequire } from 'node:module';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const Domains = require('../src/common/domains.js');
const { QUIET_LISTS } = require('../src/common/lists.js');

/** Domains per rule. Large enough to keep the rule count tiny, small enough to stay readable. */
export const DOMAIN_CHUNK = 1000;

function chunk(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function isAsciiDomain(domain) {
  for (let index = 0; index < domain.length; index += 1) {
    const code = domain.charCodeAt(index);
    if (code > 127) return false;
  }
  return true;
}

export function buildRuleset(domains, options = {}) {
  const priority = options.priority ?? 1;
  const rules = [];
  for (const group of chunk(domains, options.chunkSize ?? DOMAIN_CHUNK)) {
    rules.push({
      id: rules.length + 1,
      priority,
      action: { type: 'block' },
      condition: { requestDomains: group },
    });
  }
  return rules;
}

/** Reads a bundled list file, or fetches an optional one when the build allows the network. */
async function readListSource(list, blocklistDir, options) {
  if (list.bundled) {
    const file = path.join(blocklistDir, `${list.id}.txt`);
    return { text: await readFile(file, 'utf8'), origin: path.relative(process.cwd(), file) };
  }
  if (!options.fetchOptional) return null;
  const response = await fetch(list.source);
  if (!response.ok) throw new Error(`${list.source} answered ${response.status}`);
  return { text: await response.text(), origin: list.source };
}

/**
 * Writes `rulesets/<id>.json` for every list it can, plus `rulesets/index.json` describing what
 * shipped. Optional lists are skipped (with a message) when the build is offline, and the UI says
 * so rather than silently blocking less than the user asked for.
 */
export async function generateRulesets({ blocklistDir, outDir, fetchOptional = false, log = console.log }) {
  const rulesetDir = path.join(outDir, 'rulesets');
  await mkdir(rulesetDir, { recursive: true });

  const index = {
    generatedAt: new Date().toISOString().slice(0, 10),
    chunkSize: DOMAIN_CHUNK,
    rulesets: [],
  };

  for (const list of QUIET_LISTS) {
    let source;
    try {
      source = await readListSource(list, blocklistDir, { fetchOptional });
    } catch (error) {
      log(`  ! ${list.id}: ${error.message}`);
      continue;
    }
    if (!source) {
      log(`  - ${list.id}: optional list skipped (build with --fetch-optional to include it)`);
      continue;
    }

    const domains = Domains.parseList(source.text).filter(isAsciiDomain).sort();
    if (domains.length === 0) {
      log(`  ! ${list.id}: no usable domains, skipped`);
      continue;
    }

    const rules = buildRuleset(domains, { priority: 1 });
    const file = path.join(rulesetDir, `${list.id}.json`);
    const body = JSON.stringify(rules);
    await writeFile(file, body);

    index.rulesets.push({
      id: list.id,
      path: `rulesets/${list.id}.json`,
      domains: domains.length,
      rules: rules.length,
      bytes: Buffer.byteLength(body),
      origin: source.origin,
    });
    log(`  + ${list.id}: ${domains.length.toLocaleString()} domains in ${rules.length} rules`);
  }

  await writeFile(path.join(rulesetDir, 'index.json'), JSON.stringify(index, null, 2) + '\n');
  return index;
}

/**
 * The same domains as Safari content-blocker rules, for the route that does not use a web
 * extension at all. Apple allows 150,000 rules per blocker, so the set is split to fit.
 */
export function buildContentBlockers(domains, { maxRules = 150000 } = {}) {
  const files = [];
  for (let start = 0; start < domains.length; start += maxRules) {
    const slice = domains.slice(start, start + maxRules);
    files.push(
      slice.map((domain) => ({
        trigger: { 'url-filter': '.*', 'if-domain': [domain] },
        action: { type: 'block' },
      })),
    );
  }
  return files;
}
