#!/usr/bin/env node
/**
 * Publishes the built extension to the browser stores.
 *
 *   node scripts/publish-store.mjs --dry-run                    # say what it would do, touch nothing
 *   node scripts/publish-store.mjs --store=firefox
 *   node scripts/publish-store.mjs --store=chrome --store=edge
 *
 * What each store needs before this can do anything (all documented in store/README.md):
 *
 *   firefox  AMO_JWT_ISSUER + AMO_JWT_SECRET       free, and the only one of the three that can
 *                                                  create the listing from scratch, which turns the
 *                                                  .xpi into a permanent install instead of a
 *                                                  temporary add-on
 *   chrome   CWS_CLIENT_ID, CWS_CLIENT_SECRET, CWS_REFRESH_TOKEN, CWS_PUBLISHER_ID, CWS_ITEM_ID
 *                                                  needs a $5 developer account, and the item has to
 *                                                  exist once - the store API cannot create one
 *   edge     EDGE_CLIENT_ID, EDGE_API_KEY, EDGE_PRODUCT_ID
 *                                                  same shape: the first submission is manual
 *
 * A missing credential is a skip, not a failure: the script says which variable is missing and
 * exits 0, so a release can run it without pretending to publish anything. With `--require` it
 * fails instead, which is what CI uses when the secrets are expected to be there.
 *
 * No dependencies: the JWT is signed here, the multipart body is built here, and the only network
 * traffic is to the store being published to.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { packageName } from './build.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(here, '..');
const repoRoot = path.resolve(extensionRoot, '..');

const AMO_API = 'https://addons.mozilla.org/api/v5';
const CWS_API = 'https://chromewebstore.googleapis.com';
const EDGE_API = 'https://api.addons.microsoftedge.microsoft.com';
const POLL_INTERVAL_MS = 10000;
const POLL_TIMEOUT_MS = 10 * 60 * 1000;

// -----------------------------------------------------------------------------------------------
// Arguments and the packages to upload
// -----------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const options = { stores: [], dryRun: false, channel: 'unlisted', require: false };
  for (const arg of argv) {
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--require') options.require = true;
    else if (arg.startsWith('--store=')) options.stores.push(...arg.slice('--store='.length).split(',').map((v) => v.trim()));
    else if (arg.startsWith('--channel=')) options.channel = arg.slice('--channel='.length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (options.stores.length === 0) options.stores = ['firefox', 'chrome', 'edge'];
  for (const store of options.stores) {
    if (!['firefox', 'chrome', 'edge'].includes(store)) throw new Error(`Unknown store: ${store}`);
  }
  if (!['listed', 'unlisted'].includes(options.channel)) throw new Error(`Unknown channel: ${options.channel}`);
  return options;
}

async function identity() {
  const appJson = JSON.parse(await readFile(path.join(repoRoot, 'app.json'), 'utf8'));
  return { name: appJson.expo.name, version: appJson.expo.version };
}

/**
 * Uploading takes the package, not a directory, and everything except Firefox takes the Chromium
 * build: Edge, Brave, Opera and Vivaldi all run the same engine and the same `dist/chromium`
 * output, which is why that target is the one the stores get.
 */
/**
 * The package to upload. A dry run only needs the name, so it tolerates an unbuilt tree: the whole
 * point of a dry run is to be the first thing you can do.
 */
async function packageFor(store, identity, { allowMissing = false } = {}) {
  const target = store === 'firefox' ? 'firefox' : 'chromium';
  const file = path.join(extensionRoot, 'dist', packageName(identity, target));
  try {
    return { file, bytes: await readFile(file) };
  } catch (error) {
    if (allowMissing) return { file, bytes: null };
    throw new Error(`${path.relative(extensionRoot, file)} is missing; run npm run build first`);
  }
}

// -----------------------------------------------------------------------------------------------
// Credentials
// -----------------------------------------------------------------------------------------------

/**
 * Field -> environment variable, and the only place a store's credentials are named.
 * `test/store.test.cjs` compares this against the table in store/README.md.
 */
export const CREDENTIAL_FIELDS = {
  firefox: { issuer: ['AMO_JWT_ISSUER', 'WEB_EXT_API_KEY'], secret: ['AMO_JWT_SECRET', 'WEB_EXT_API_SECRET'] },
  chrome: {
    clientId: ['CWS_CLIENT_ID'],
    clientSecret: ['CWS_CLIENT_SECRET'],
    refreshToken: ['CWS_REFRESH_TOKEN'],
    publisherId: ['CWS_PUBLISHER_ID'],
    itemId: ['CWS_ITEM_ID'],
  },
  edge: { clientId: ['EDGE_CLIENT_ID'], apiKey: ['EDGE_API_KEY'], productId: ['EDGE_PRODUCT_ID'] },
};

function credentials(env = process.env, stores = Object.keys(CREDENTIAL_FIELDS)) {
  const out = {};
  for (const store of stores) {
    out[store] = {};
    for (const [field, names] of Object.entries(CREDENTIAL_FIELDS[store])) {
      out[store][field] = names.map((name) => env[name]).find(Boolean);
    }
  }
  return out;
}

function missingFor(store, all) {
  return Object.keys(CREDENTIAL_FIELDS[store])
    .filter((field) => !all[store][field])
    .map((field) => CREDENTIAL_FIELDS[store][field][0]);
}

// -----------------------------------------------------------------------------------------------
// Firefox: addons.mozilla.org, API v5
// -----------------------------------------------------------------------------------------------

/** base64url, the only encoding a JWT uses. */
function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The AMO JWT: HS256 over `{iss, jti, iat, exp}`, in an `Authorization: JWT <token>` header.
 * Exported so the tests can check it against a token signed independently.
 */
export function createAmoJwt({ issuer, secret, now = Date.now(), jti = randomBytes(8).toString('hex') }) {
  const issuedAt = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iss: issuer, jti, iat: issuedAt, exp: issuedAt + 60 }));
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${header}.${payload}.${signature}`;
}

/** multipart/form-data, built by hand so the script needs no dependencies. */
function multipart(fields, files) {
  const boundary = `----quiet${randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  for (const file of files) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\n` +
          `Content-Type: ${file.type}\r\n\r\n`,
      ),
      file.bytes,
      Buffer.from('\r\n'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function amoFetch(url, options, jwt) {
  const response = await fetch(url, {
    ...options,
    headers: { Authorization: `JWT ${jwt}`, ...(options?.headers || {}) },
  });
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch (error) {
    payload = { raw: text.slice(0, 400) };
  }
  if (!response.ok) {
    throw new Error(`${options?.method || 'GET'} ${url} failed: ${response.status} ${JSON.stringify(payload).slice(0, 400)}`);
  }
  return payload;
}

async function poll(label, check) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function publishFirefox({ dryRun, channel, log }) {
  const { issuer, secret } = credentials().firefox;
  const identityNow = await identity();
  const { file, bytes } = await packageFor('firefox', identityNow, { allowMissing: dryRun });

  if (dryRun) {
    log(`    upload ${path.relative(extensionRoot, file)} to ${AMO_API}/addons/upload/ (channel: ${channel})`);
    log('    poll the upload until it validates, then attach it as a version of the add-on');
    log('    download the signed .xpi back into dist/ as the file Firefox installs for good');
    return { skipped: true, reason: 'dry run' };
  }

  const jwt = createAmoJwt({ issuer, secret });

  // 1. Upload the file for validation.
  const upload = multipart({ channel }, [{ name: 'upload', filename: path.basename(file), type: 'application/x-xpinstall', bytes }]);
  const created = await amoFetch(
    `${AMO_API}/addons/upload/`,
    { method: 'POST', headers: { 'Content-Type': upload.contentType }, body: upload.body },
    jwt,
  );
  log(`    uploaded, validation id ${created.uuid}`);

  // 2. Wait for validation.
  const validated = await poll('the upload to validate', async () => {
    const detail = await amoFetch(`${AMO_API}/addons/upload/${created.uuid}/`, { method: 'GET' }, jwt);
    if (!detail.processed) return null;
    if (!detail.valid) {
      throw new Error(`the store rejected the package: ${JSON.stringify(detail.validation || {}).slice(0, 600)}`);
    }
    return detail;
  });
  log('    validated');

  // 3. Attach the upload to the add-on, creating it if this is the first release.
  const addonId = 'browser-extension@quiet.app';
  let version;
  try {
    version = await amoFetch(
      `${AMO_API}/addons/addon/${addonId}/versions/`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          upload: validated.uuid,
          license: 'GPL-3.0-or-later',
          release_notes: { 'en-US': `Quiet ${identityNow.version}. See ${'https://github.com/kennethyork/Quiet/releases'}.` },
        }),
      },
      jwt,
    );
  } catch (error) {
    if (!/404|not found/i.test(error.message)) throw error;
    log('    no add-on with that id yet, creating it as an unlisted (self-distributed) add-on');
    version = await amoFetch(
      `${AMO_API}/addons/addon/`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          slug: 'quiet',
          name: { 'en-US': identityNow.name },
          summary: { 'en-US': 'Adult domains, filtered locally with no account, no server and no telemetry.' },
          version: { upload: validated.uuid, license: 'GPL-3.0-or-later' },
        }),
      },
      jwt,
    );
  }
  log(`    version ${version.version} accepted`);

  // 4. Wait for the signature, then take the signed file.
  const signed = await poll('the version to be signed', async () => {
    const detail = await amoFetch(`${AMO_API}/addons/addon/${addonId}/versions/${version.version}/`, { method: 'GET' }, jwt);
    const file_ = (detail.files || []).find((candidate) => candidate.signed);
    return file_ || null;
  });

  const response = await fetch(signed.download_url, { headers: { Authorization: `JWT ${jwt}` } });
  if (!response.ok) throw new Error(`could not download the signed package: ${response.status}`);
  const signedBytes = Buffer.from(await response.arrayBuffer());
  const outFile = path.join(extensionRoot, 'dist', packageName(identityNow, 'firefox').replace(/\.xpi$/, '-signed.xpi'));
  await writeFile(outFile, signedBytes);
  log(`    signed: ${path.relative(extensionRoot, outFile)} (${(signedBytes.length / 1048576).toFixed(2)} MB)`);

  return { addonId, version: version.version, file: outFile, bytes: signedBytes.length };
}

// -----------------------------------------------------------------------------------------------
// Chrome Web Store, API v2
// -----------------------------------------------------------------------------------------------

async function accessToken({ clientId, clientSecret, refreshToken }) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.access_token) {
    throw new Error(`Google refused the refresh token: ${response.status} ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return payload.access_token;
}

async function publishChrome({ dryRun, log }) {
  const { publisherId, itemId } = credentials().chrome;
  const identityNow = await identity();
  const { file, bytes } = await packageFor('chrome', identityNow, { allowMissing: dryRun });
  // Placeholders keep the dry run readable before the credentials exist.
  const publisher = publisherId || '{CWS_PUBLISHER_ID}';
  const item = itemId || '{CWS_ITEM_ID}';
  const base = `${CWS_API}/v2/publishers/${publisher}/items/${item}`;

  if (dryRun) {
    log(`    exchange the refresh token for an access token (scope chromewebstore)`);
    log(`    GET  ${base}:fetchStatus  (refuses while a review is running)`);
    log(`    POST ${CWS_API}/upload/v2/publishers/${publisher}/items/${item}:upload with ${path.relative(extensionRoot, file)}`);
    log(`    POST ${base}:publish`);
    return { skipped: true, reason: 'dry run' };
  }

  const token = await accessToken(credentials().chrome);
  const authorized = { Authorization: `Bearer ${token}` };

  const status = await fetch(`${base}:fetchStatus`, { headers: authorized });
  if (!status.ok) throw new Error(`the store would not report the item status: ${status.status} ${(await status.text()).slice(0, 300)}`);
  const state = await status.json();
  log(`    item state: ${JSON.stringify(state).slice(0, 200)}`);
  if (/REVIEW|IN_REVIEW|PENDING/i.test(JSON.stringify(state))) {
    throw new Error('the store is reviewing the item; wait for that to finish before uploading again');
  }

  const upload = await fetch(`${CWS_API}/upload/v2/publishers/${publisherId}/items/${itemId}:upload`, {
    method: 'POST',
    headers: { ...authorized, 'Content-Type': 'application/zip' },
    body: bytes,
  });
  const uploaded = await upload.json().catch(() => ({}));
  if (!upload.ok) throw new Error(`upload failed: ${upload.status} ${JSON.stringify(uploaded).slice(0, 300)}`);
  log(`    uploaded: ${JSON.stringify(uploaded).slice(0, 200)}`);

  const published = await fetch(`${base}:publish`, { method: 'POST', headers: authorized });
  const result = await published.json().catch(() => ({}));
  if (!published.ok) throw new Error(`publish failed: ${published.status} ${JSON.stringify(result).slice(0, 300)}`);
  log(`    submitted for review: ${JSON.stringify(result).slice(0, 200)}`);

  return { itemId, version: identityNow.version };
}

// -----------------------------------------------------------------------------------------------
// Microsoft Edge Add-ons, API v1.1
// -----------------------------------------------------------------------------------------------

async function publishEdge({ dryRun, log }) {
  const { clientId, apiKey, productId } = credentials().edge;
  const identityNow = await identity();
  const { file, bytes } = await packageFor('edge', identityNow, { allowMissing: dryRun });
  const product = `${EDGE_API}/v1/products/${productId || '{EDGE_PRODUCT_ID}'}`;
  const headers = { Authorization: `ApiKey ${apiKey}`, 'X-ClientID': clientId };

  if (dryRun) {
    log(`    POST ${product}/submissions/draft/package with ${path.relative(extensionRoot, file)}`);
    log('    poll the operation until it succeeds');
    log(`    POST ${product}/submissions`);
    return { skipped: true, reason: 'dry run' };
  }

  const upload = await fetch(`${product}/submissions/draft/package`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/zip' },
    body: bytes,
  });
  if (!upload.ok) throw new Error(`upload failed: ${upload.status} ${(await upload.text()).slice(0, 300)}`);
  const operationId = upload.headers.get('location');
  if (!operationId) throw new Error('the upload was accepted but no operation id came back');
  log(`    uploaded, operation ${operationId}`);

  await poll('the package to be processed', async () => {
    const status = await fetch(`${product}/submissions/draft/package/operations/${operationId}`, { headers });
    const payload = await status.json().catch(() => ({}));
    if (!status.ok) throw new Error(`status failed: ${status.status} ${JSON.stringify(payload).slice(0, 200)}`);
    if (payload.status === 'Failed') throw new Error(`the store rejected the package: ${JSON.stringify(payload).slice(0, 400)}`);
    return payload.status === 'Succeeded' ? payload : null;
  });
  log('    processed');

  const publish = await fetch(`${product}/submissions`, { method: 'POST', headers });
  if (!publish.ok) throw new Error(`publish failed: ${publish.status} ${(await publish.text()).slice(0, 300)}`);
  log('    submitted for review');
  return { productId, version: identityNow.version };
}

// -----------------------------------------------------------------------------------------------

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const all = credentials();
  const identityNow = await identity();

  console.log(`${identityNow.name} ${identityNow.version} -> ${options.stores.join(', ')}${options.dryRun ? ' (dry run)' : ''}`);

  let published = 0;
  let skipped = 0;
  for (const store of options.stores) {
    console.log(`  ${store}:`);
    const missing = missingFor(store, all);
    // A dry run needs no credentials: its whole job is to say what would happen, and saying that
    // should not depend on having the keys yet.
    if (missing.length > 0 && !options.dryRun) {
      if (options.require) throw new Error(`${store} needs ${missing.join(', ')}, which are not set`);
      console.log(`    skipped, no ${missing.join(', ')} - see browser-extension/store/README.md`);
      skipped += 1;
      continue;
    }
    const result =
      store === 'firefox'
        ? await publishFirefox({ ...options, log: console.log })
        : store === 'chrome'
          ? await publishChrome({ ...options, log: console.log })
          : await publishEdge({ ...options, log: console.log });
    if (result && result.skipped) skipped += 1;
    else published += 1;
  }

  console.log(`\n${published} published, ${skipped} skipped`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    console.error(`\nPublishing failed: ${error.message}`);
    process.exitCode = 1;
  });
}
