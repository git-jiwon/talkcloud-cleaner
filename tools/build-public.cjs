'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { checkProject, safeRelative, reportError } = require('./check-public.cjs');

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// Deterministic ZIP: stored UTF-8 entries, fixed date, no local path/timestamp metadata.
function makeZip(entries) {
  if (!entries.length || entries.length > 65535) throw new Error('Unsupported ZIP entry count.');
  const bodies = [], directory = [], seen = new Set();
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(safeRelative(entry.path), 'utf8');
    if (seen.has(entry.path)) throw new Error('Duplicate ZIP entry.');
    seen.add(entry.path);
    const data = Buffer.from(entry.data);
    if (name.length > 65535 || data.length > 0xffffffff) throw new Error('ZIP entry too large.');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(33, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    bodies.push(local, name, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(33, 14); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
    if (offset > 0xffffffff) throw new Error('ZIP archive too large.');
  }
  const catalog = Buffer.concat(directory), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(catalog.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, catalog, end]);
}

function buildPublic(root) {
  const checked = checkProject(root);
  const output = path.join(path.resolve(root), 'releases');
  if (fs.existsSync(output)) {
    const info = fs.lstatSync(output);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Release directory must be an ordinary directory.');
  }
  const names = [`talkcloud-cleaner-v${checked.version}.zip`, `talkcloud-cleaner-source-v${checked.version}.zip`,
    `public-manifest-v${checked.version}.json`];
  for (const name of names) if (fs.existsSync(path.join(output, name))) throw new Error(`Release already exists; nothing overwritten: ${name}`);
  const runtime = makeZip(checked.runtimeFiles.map(relative => ({ path: relative.slice('extension/'.length), data: checked.contents.get(relative) })));
  const source = makeZip(checked.files.map(relative => ({ path: relative, data: checked.contents.get(relative) })));
  const archives = [runtime, source].map((data, index) => ({ file: names[index], bytes: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex') }));
  const manifest = { version: checked.version, archives,
    runtime: checked.manifestFiles.filter(file => checked.runtimeFiles.includes(file.path)).map(file => ({ ...file, path: file.path.slice('extension/'.length) })),
    source: checked.manifestFiles };
  if (!fs.existsSync(output)) fs.mkdirSync(output);
  // Exclusive creation also rejects a file appearing after the existence check.
  for (const [index, data] of [runtime, source, Buffer.from(JSON.stringify(manifest, null, 2) + '\n')].entries()) {
    fs.writeFileSync(path.join(output, names[index]), data, { flag: 'wx' });
  }
  return { names, manifest };
}

if (require.main === module) {
  if (process.argv.length !== 2) { console.error('Usage: node tools/build-public.cjs'); process.exitCode = 1; }
  else {
    try {
      const result = buildPublic(path.resolve(__dirname, '..'));
      for (const name of result.names) console.log(`Created releases/${name}`);
    } catch (error) { reportError(error); process.exitCode = 1; }
  }
}
module.exports = { crc32, makeZip, buildPublic };
