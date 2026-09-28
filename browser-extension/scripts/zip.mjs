/**
 * A tiny ZIP writer (stored, no compression) so the build can produce the two artefacts the
 * browsers actually want without adding a dependency: an XPI for Firefox and a ZIP for the stores.
 *
 * A stored zip is what `web-ext sign` and the Chrome Web Store accept, and it keeps the build
 * reproducible: the same input files produce byte-identical output.
 */
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** CRC-32 (PKZIP), because `zlib.crc32` only exists from Node 20.15 and the build targets Node 18. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  const time = ((date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() / 2)) & 0xffff;
  const day = (((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()) & 0xffff;
  return { time, day };
}

async function collect(root, relative = '') {
  const entries = [];
  const dir = path.join(root, relative);
  for (const name of (await readdir(dir)).sort()) {
    const rel = relative ? `${relative}/${name}` : name;
    const full = path.join(root, rel);
    const info = await stat(full);
    if (info.isDirectory()) {
      entries.push(...(await collect(root, rel)));
    } else {
      entries.push({ name: rel, full });
    }
  }
  return entries;
}

export async function writeZip(rootDir, outFile, { modified = new Date('2026-01-01T00:00:00Z') } = {}) {
  const entries = await collect(rootDir);
  const { time, day } = dosDateTime(modified);

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const data = await readFile(entry.full);
    const nameBytes = Buffer.from(entry.name, 'utf8');
    const checksum = crc32(data) >>> 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBytes, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);

    offset += local.length + nameBytes.length + data.length;
  }

  const centralBuffer = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  await writeFile(outFile, Buffer.concat([...locals, centralBuffer, end]));
  return { entries: entries.length, bytes: offset + centralBuffer.length + end.length };
}
