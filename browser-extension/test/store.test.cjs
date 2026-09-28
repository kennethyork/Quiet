/**
 * The store submission material, checked against the extension and against the stores' own rules.
 *
 * A listing is written once and read for years, so the things that rot quietly are the things worth
 * testing: a summary that creeps past a store's character limit, an image that is one pixel off the
 * size the store demands (which gets the submission rejected, silently, at upload time), a number in
 * a marketing screenshot that no longer matches the list it came from, or a credential named in the
 * runbook that the publishing script has never heard of.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawnSync } = require('node:child_process');
const zlib = require('node:zlib');

const Domains = require('../src/common/domains.js');

/** The build helpers are ES modules, so they are imported rather than required. */
let buildHelpers = null;
async function loadBuildHelpers() {
  buildHelpers = buildHelpers || (await import('../scripts/build.mjs'));
  return buildHelpers;
}

const extensionRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(extensionRoot, '..');
const storeDir = path.join(extensionRoot, 'store');
const assetsDir = path.join(storeDir, 'assets');

const listing = fs.readFileSync(path.join(storeDir, 'listing.md'), 'utf8');
const storeReadme = fs.readFileSync(path.join(storeDir, 'README.md'), 'utf8');
const appJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'app.json'), 'utf8'));

/** Pulls the first fenced block that follows a heading, which is how listing.md is laid out. */
function blockAfter(heading, occurrence = 1) {
  const parts = listing.split(heading);
  assert.ok(parts.length > occurrence, `listing.md has no "${heading}" block`);
  const body = parts[occurrence];
  const match = body.match(/```[a-z]*\n([\s\S]*?)```/);
  assert.ok(match, `"${heading}" has no fenced block`);
  return match[1].trim();
}

// ---------------------------------------------------------------------------------------------
// A PNG reader, because "the store rejects it at upload" is a bad way to learn about a wrong size
// ---------------------------------------------------------------------------------------------

function readPng(file) {
  const bytes = fs.readFileSync(file);
  assert.equal(bytes.toString('ascii', 1, 4), 'PNG', `${file} is not a PNG`);
  const header = { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bitDepth: bytes[24], colourType: bytes[25] };

  const idat = [];
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === 'IEND') break;
  }

  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[header.colourType];
  assert.ok(channels && header.bitDepth === 8, `unsupported PNG format in ${file}`);
  const stride = header.width * channels;
  const raw = zlib.inflateSync(Buffer.concat(idat));

  let alphaMin = 255;
  let alphaMax = 0;
  let previous = Buffer.alloc(stride);
  for (let row = 0; row < header.height; row += 1) {
    const filter = raw[row * (stride + 1)];
    const line = Buffer.from(raw.subarray(row * (stride + 1) + 1, (row + 1) * (stride + 1)));
    for (let index = 0; index < stride; index += 1) {
      const left = index >= channels ? line[index - channels] : 0;
      const up = previous[index];
      const upLeft = index >= channels ? previous[index - channels] : 0;
      if (filter === 1) line[index] = (line[index] + left) & 0xff;
      else if (filter === 2) line[index] = (line[index] + up) & 0xff;
      else if (filter === 3) line[index] = (line[index] + ((left + up) >> 1)) & 0xff;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const distances = [Math.abs(estimate - left), Math.abs(estimate - up), Math.abs(estimate - upLeft)];
        const nearest = distances[0] <= distances[1] && distances[0] <= distances[2] ? left : distances[1] <= distances[2] ? up : upLeft;
        line[index] = (line[index] + nearest) & 0xff;
      }
    }
    if (header.colourType === 6) {
      for (let index = 3; index < stride; index += 4) {
        alphaMin = Math.min(alphaMin, line[index]);
        alphaMax = Math.max(alphaMax, line[index]);
      }
    } else {
      alphaMin = 255;
      alphaMax = 255;
    }
    previous = line;
  }

  return { ...header, alphaMin, alphaMax };
}

// ---------------------------------------------------------------------------------------------
// The copy fits the stores' fields
// ---------------------------------------------------------------------------------------------

test('the listing copy fits every store field it is written for', async () => {
  const { manifestDescription } = await loadBuildHelpers();
  const name = blockAfter('## Name');
  const summaries = [...listing.matchAll(/## Summary[\s\S]*?(?=\n## )/g)][0][0];
  const chromeSummary = summaries.match(/Chrome, Edge and Opera:\n\n```\n([\s\S]*?)```/)[1].trim();
  const amoSummary = summaries.match(/AMO \([^)]*\):\n\n```\n([\s\S]*?)```/)[1].trim();
  const description = blockAfter('## Detailed description');

  assert.equal(name, appJson.expo.name + ' - adult content filter');
  assert.ok(name.length <= 45, `the name is ${name.length} characters, Chrome and Edge allow 45`);
  assert.ok(name.length <= 50, `the name is ${name.length} characters, AMO allows 50`);

  assert.ok(chromeSummary.length <= 132, `the Chromium summary is ${chromeSummary.length} characters, the limit is 132`);
  assert.ok(amoSummary.length <= 250, `the AMO summary is ${amoSummary.length} characters, the limit is 250`);

  // One description serves Chrome (16,000) and Edge (10,000), so the smaller limit governs.
  assert.ok(description.length <= 10000, `the description is ${description.length} characters, Edge allows 10,000`);
  assert.ok(description.length > 400, 'the description should say something');

  // Chrome's review checklist: the manifest's own description is limited to 132 characters.
  const manifestText = manifestDescription(appJson.expo.name);
  assert.ok(
    manifestText.length <= 132,
    `the manifest description is ${manifestText.length} characters, Chrome requires 132 or fewer`,
  );
});

test('the listing names every store, and the links it promises', () => {
  for (const store of ['Chrome', 'Edge', 'Opera', 'AMO']) {
    assert.match(listing, new RegExp(`## .*${store}`, 'i'), `listing.md says nothing about ${store}`);
  }
  for (const url of [
    'https://kennethyork.github.io/Quiet/',
    'https://kennethyork.github.io/Quiet/privacy.html',
    'https://github.com/kennethyork/Quiet',
  ]) {
    assert.ok(listing.includes(url), `listing.md does not mention ${url}`);
  }
  assert.ok(
    /permission/i.test(listing) && /declarativeNetRequest/.test(listing),
    'listing.md should justify the permissions for the reviewer',
  );
});

// ---------------------------------------------------------------------------------------------
// The images exist, at the size their own name claims, and are opaque
// ---------------------------------------------------------------------------------------------

test('every image the listing points at exists at the size its store demands', () => {
  const referenced = [...listing.matchAll(/`(store\/assets\/[^`]+\.png)`/g)].map((match) => match[1]);
  assert.ok(referenced.length >= 5, 'the listing should reference the screenshots and tiles');

  for (const reference of referenced) {
    // The listing writes paths relative to this extension, the way everything in it is written.
    const file = path.join(extensionRoot, reference);
    assert.ok(fs.existsSync(file), `${reference} is referenced in listing.md but does not exist`);
    const size = reference.match(/-(\d+)x(\d+)\.png$/);
    assert.ok(size, `${reference} should carry its size in the file name`);
    const png = readPng(file);
    assert.equal(png.width, Number(size[1]), `${reference} is ${png.width}px wide, not ${size[1]}`);
    assert.equal(png.height, Number(size[2]), `${reference} is ${png.height}px tall, not ${size[2]}`);
  }
});

test('the store images are fully opaque', () => {
  // Chrome rejects screenshots with transparency, and an icon with a transparent background renders
  // as a shape floating on whatever the store's theme is.
  const files = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.png') && name !== 'popup.png' && name !== 'options.png' && name !== 'icon-256.png');
  assert.ok(files.length >= 5, 'expected the generated store images');
  for (const name of files) {
    const png = readPng(path.join(assetsDir, name));
    assert.equal(png.alphaMin, 255, `${name} has transparent pixels (minimum alpha ${png.alphaMin})`);
  }
});

test('the store captures are the same images the site uses', () => {
  // Two copies of a UI capture drift; this makes refreshing one without the other fail loudly.
  const storePopup = fs.readFileSync(path.join(assetsDir, 'popup.png'));
  const sitePopup = fs.readFileSync(path.join(repoRoot, 'website', 'assets', 'popup.png'));
  assert.ok(storePopup.equals(sitePopup), 'store/assets/popup.png and website/assets/popup.png have drifted apart');
});

// ---------------------------------------------------------------------------------------------
// The numbers in the marketing images are the numbers in the repository
// ---------------------------------------------------------------------------------------------

test('the counts in the store images are the lists in the repository', () => {
  const adult = Domains.parseList(
    fs.readFileSync(path.join(repoRoot, 'modules', 'quiet-vpn', 'android', 'src', 'main', 'assets', 'blocklists', 'adult-core.txt'), 'utf8'),
  ).length;
  const doh = fs
    .readFileSync(path.join(repoRoot, 'modules', 'quiet-vpn', 'android', 'src', 'main', 'assets', 'blocklists', 'doh-providers.txt'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.startsWith('#')).length;

  const templates = fs.readdirSync(assetsDir).filter((name) => name.endsWith('.html'));
  assert.ok(templates.length >= 6, 'expected the image templates');

  for (const template of templates) {
    const source = fs.readFileSync(path.join(assetsDir, template), 'utf8');
    for (const [, claimed] of source.matchAll(/([\d,]{4,})\s*(?:adult )?domains/gi)) {
      assert.equal(Number(claimed.replace(/,/g, '')), adult, `${template} claims ${claimed} domains, the list holds ${adult}`);
    }
    for (const [, claimed] of source.matchAll(/(\d+)\s*encrypted-DNS/gi)) {
      assert.equal(Number(claimed), doh, `${template} claims ${claimed} encrypted-DNS endpoints, the list holds ${doh}`);
    }
    // The OISD lists are a build-time choice, so no template may put a number on them.
    assert.ok(
      !/OISD[^.]{0,40}\d{3}/i.test(source),
      `${template} puts a count on an OISD list, which this build does not include`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// The publishing script and its runbook agree
// ---------------------------------------------------------------------------------------------

test('the runbook names exactly the credentials the script reads', async () => {
  const { CREDENTIAL_FIELDS } = await import('../scripts/publish-store.mjs');

  const inScript = Object.values(CREDENTIAL_FIELDS)
    .flatMap((fields) => Object.values(fields))
    .flat()
    .filter((name) => name.startsWith('AMO_') || name.startsWith('CWS_') || name.startsWith('EDGE_'))
    .sort();
  const inReadme = [...storeReadme.matchAll(/`((?:AMO|CWS|EDGE)_[A-Z_]+)`/g)].map((match) => match[1]).sort();

  assert.deepEqual([...new Set(inReadme)], [...new Set(inScript)], 'store/README.md and publish-store.mjs disagree about the credentials');
  assert.ok(inScript.length >= 8, 'expected the credentials for all three stores');
});

test('a dry run needs no credentials and prints a plan for every store', () => {
  const env = { ...process.env };
  for (const name of ['AMO_JWT_ISSUER', 'AMO_JWT_SECRET', 'CWS_CLIENT_ID', 'CWS_CLIENT_SECRET', 'CWS_REFRESH_TOKEN', 'CWS_PUBLISHER_ID', 'CWS_ITEM_ID', 'EDGE_CLIENT_ID', 'EDGE_API_KEY', 'EDGE_PRODUCT_ID', 'WEB_EXT_API_KEY', 'WEB_EXT_API_SECRET']) {
    delete env[name];
  }

  const dryRun = spawnSync(process.execPath, ['scripts/publish-store.mjs', '--dry-run'], { cwd: extensionRoot, env, encoding: 'utf8' });
  assert.equal(dryRun.status, 0, dryRun.stderr);
  assert.match(dryRun.stdout, /addons\.mozilla\.org\/api\/v5\/addons\/upload\//, 'no Firefox plan');
  assert.match(dryRun.stdout, /chromewebstore\.googleapis\.com/, 'no Chrome plan');
  assert.match(dryRun.stdout, /api\.addons\.microsoftedge\.microsoft\.com/, 'no Edge plan');
  assert.match(dryRun.stdout, /\(dry run\)/);

  const skipped = spawnSync(process.execPath, ['scripts/publish-store.mjs'], { cwd: extensionRoot, env, encoding: 'utf8' });
  assert.equal(skipped.status, 0, 'a missing credential must be a skip, not a failure');
  assert.match(skipped.stdout, /skipped, no AMO_JWT_ISSUER/);

  const required = spawnSync(process.execPath, ['scripts/publish-store.mjs', '--store=firefox', '--require'], { cwd: extensionRoot, env, encoding: 'utf8' });
  assert.equal(required.status, 1, '--require must fail when the credentials are missing');
  assert.match(required.stderr, /needs AMO_JWT_ISSUER, AMO_JWT_SECRET/);
});

// ---------------------------------------------------------------------------------------------
// The package itself is fit to upload
// ---------------------------------------------------------------------------------------------

test('a built package carries nothing it should not', async (t) => {
  const candidates = (await fsp.readdir(path.join(extensionRoot, 'dist')).catch(() => [])).filter((name) => /^quiet-chromium-.*\.zip$/.test(name));
  if (candidates.length === 0) {
    t.diagnostic('no build in dist/, skipping the package hygiene check (run npm run build)');
    return;
  }
  const zip = await fsp.readFile(path.join(extensionRoot, 'dist', candidates[0]));
  const names = [];
  for (let offset = 0; offset + 30 < zip.length; offset += 1) {
    if (zip.readUInt32LE(offset) !== 0x04034b50) continue;
    const length = zip.readUInt16LE(offset + 26);
    names.push(zip.toString('utf8', offset + 30, offset + 30 + length));
  }
  assert.ok(names.includes('manifest.json'), 'the package must have its manifest at the root');
  for (const name of names) {
    assert.ok(!/\.md$/i.test(name), `${name} should not ship in the package`);
    assert.ok(!/^test\//.test(name), `${name} should not ship in the package`);
    assert.ok(!/node_modules/.test(name), `${name} should not ship in the package`);
  }
  assert.ok(names.some((name) => name.startsWith('rulesets/')), 'the package must carry its rulesets');
});
