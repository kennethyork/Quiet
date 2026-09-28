/**
 * The rulesets the build produces, checked against the list files the app ships.
 *
 * These tests are what makes "the extension blocks what the app blocks" a statement instead of a
 * hope: the counts come from the app's own blocklist files, and every domain that goes in must
 * come out in exactly one rule.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');

const Domains = require('../src/common/domains.js');

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const blocklistDir = path.join(repoRoot, 'modules', 'quiet-vpn', 'android', 'src', 'main', 'assets', 'blocklists');

async function generate() {
  const { generateRulesets } = await import('../scripts/generate-rulesets.mjs');
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiet-rulesets-'));
  const index = await generateRulesets({ blocklistDir, outDir, fetchOptional: false, log: () => {} });
  return { outDir, index };
}

test('adult list becomes a small number of requestDomains rules', async () => {
  const { outDir, index } = await generate();
  try {
    const source = await fs.readFile(path.join(blocklistDir, 'adult-core.txt'), 'utf8');
    const expected = Domains.parseList(source);
    assert.ok(expected.length > 100000, 'the bundled list should be large');

    const entry = index.rulesets.find((item) => item.id === 'adult-core');
    assert.ok(entry, 'adult-core should be in the index');
    assert.equal(entry.domains, expected.length);
    assert.equal(entry.rules, Math.ceil(expected.length / index.chunkSize));

    const rules = JSON.parse(await fs.readFile(path.join(outDir, entry.path), 'utf8'));
    assert.equal(rules.length, entry.rules);

    const seen = new Set();
    const ids = new Set();
    for (const rule of rules) {
      assert.equal(rule.action.type, 'block');
      assert.equal(Number.isInteger(rule.priority), true);
      assert.equal(ids.has(rule.id), false, 'rule ids must be unique');
      ids.add(rule.id);
      assert.ok(rule.condition.requestDomains.length <= index.chunkSize);
      for (const domain of rule.condition.requestDomains) {
        assert.match(domain, /^[a-z0-9._-]+$/, `${domain} must be a plain ascii domain`);
        assert.equal(seen.has(domain), false, `${domain} appears in two rules`);
        seen.add(domain);
      }
    }
    assert.equal(seen.size, expected.length, 'every domain must appear exactly once');
    assert.deepEqual([...seen].sort(), expected.slice().sort());
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('the encrypted-DNS list ships too', async () => {
  const { outDir, index } = await generate();
  try {
    const entry = index.rulesets.find((item) => item.id === 'doh-providers');
    assert.ok(entry, 'doh-providers should be in the index');
    assert.ok(entry.domains > 10);
    const source = await fs.readFile(path.join(blocklistDir, 'doh-providers.txt'), 'utf8');
    assert.equal(entry.domains, Domains.parseList(source).length);
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('optional lists are skipped when the build may not use the network', async () => {
  const { outDir, index } = await generate();
  try {
    const optional = ['oisd-nsfw', 'oisd-nsfw-small'];
    for (const id of optional) {
      assert.equal(
        index.rulesets.some((entry) => entry.id === id),
        false,
        `${id} should only appear when the build was given --fetch-optional`,
      );
    }
  } finally {
    await fs.rm(outDir, { recursive: true, force: true });
  }
});

test('safari content blockers split at Apple\'s 150k rule limit', async () => {
  const { buildContentBlockers } = await import('../scripts/generate-rulesets.mjs');
  const domains = Array.from({ length: 150001 }, (unused, index) => `d${index}.example`);
  const files = buildContentBlockers(domains, { maxRules: 150000 });
  assert.equal(files.length, 2);
  assert.equal(files[0].length, 150000);
  assert.equal(files[1].length, 1);
  assert.deepEqual(files[0][0], {
    trigger: { 'url-filter': '.*', 'if-domain': ['d0.example'] },
    action: { type: 'block' },
  });
});
