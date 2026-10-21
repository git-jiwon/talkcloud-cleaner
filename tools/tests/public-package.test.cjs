'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { SOURCE_FILES, RUNTIME_FILES, safeRelative, readSafe, gitignoreText, findingsFor, checkProject } = require('../check-public.cjs');
const { crc32, makeZip, buildPublic } = require('../build-public.cjs');

// Generated fixtures are retained for inspection. Set PUBLIC_TEST_TMPDIR to choose their parent.
function fixture(version = '0.7.2') {
  const parent = process.env.PUBLIC_TEST_TMPDIR || os.tmpdir();
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'talkcloud-public-test-'));
  for (const relative of SOURCE_FILES) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    let content = 'Synthetic public fixture.\n';
    if (relative === 'extension/manifest.json') content = JSON.stringify({ manifest_version: 3, version });
    if (relative === 'extension/manager.html' || relative === 'extension/guide.html') content = `<span class="version">${version}</span>`;
    if (relative === 'README.md' || relative === 'docs/RELEASE_NOTES.md') content = `Release ${version}\n`;
    if (relative === '.gitignore') content = gitignoreText();
    fs.writeFileSync(path.join(root, relative), content, { flag: 'wx' });
  }
  return root;
}

function readStoredZip(data) {
  const result = new Map();
  let offset = 0;
  while (data.readUInt32LE(offset) === 0x04034b50) {
    assert.equal(data.readUInt16LE(offset + 6), 0x0800);
    assert.equal(data.readUInt16LE(offset + 8), 0);
    const size = data.readUInt32LE(offset + 18), length = data.readUInt16LE(offset + 26);
    const name = data.subarray(offset + 30, offset + 30 + length).toString('utf8');
    const contents = data.subarray(offset + 30 + length, offset + 30 + length + size);
    assert.equal(data.readUInt32LE(offset + 14), crc32(contents));
    assert.equal(result.has(name), false);
    result.set(name, { contents, offset });
    offset += 30 + length + size;
  }
  const centralOffset = offset;
  let entries = 0;
  while (data.readUInt32LE(offset) === 0x02014b50) {
    const length = data.readUInt16LE(offset + 28);
    const name = data.subarray(offset + 46, offset + 46 + length).toString('utf8');
    assert.equal(data.readUInt32LE(offset + 42), result.get(name).offset);
    entries++; offset += 46 + length;
  }
  assert.equal(data.readUInt32LE(offset), 0x06054b50);
  assert.equal(data.readUInt16LE(offset + 8), entries);
  assert.equal(data.readUInt16LE(offset + 10), result.size);
  assert.equal(data.readUInt32LE(offset + 12), offset - centralOffset);
  assert.equal(data.readUInt32LE(offset + 16), centralOffset);
  assert.equal(offset + 22, data.length);
  return new Map([...result].map(([name, value]) => [name, value.contents]));
}

test('public archives contain only exact allowlisted files, never sibling backups or private extras', () => {
  const root = fixture();
  const privateMarker = 'PRIVATE_FIXTURE_NOT_FOR_PUBLICATION';
  fs.writeFileSync(path.join(root, 'PROJECT.md'), privateMarker);
  fs.writeFileSync(path.join(root, 'extension', 'protection-backup.json'), privateMarker);
  fs.writeFileSync(path.join(root, 'extension', '.env'), privateMarker);
  fs.mkdirSync(path.join(root, 'reference'));
  fs.writeFileSync(path.join(root, 'reference', 'capture.har'), privateMarker);
  const result = buildPublic(root);
  const runtimeData = fs.readFileSync(path.join(root, 'releases', result.names[0]));
  const sourceData = fs.readFileSync(path.join(root, 'releases', result.names[1]));
  assert.deepEqual([...readStoredZip(runtimeData).keys()].sort(), [...RUNTIME_FILES].sort());
  assert.deepEqual([...readStoredZip(sourceData).keys()].sort(), [...SOURCE_FILES]);
  assert.equal(runtimeData.includes(Buffer.from(privateMarker)), false);
  assert.equal(sourceData.includes(Buffer.from(privateMarker)), false);
  assert.equal(JSON.stringify(result.manifest).includes(root), false);
});

test('release manifest verifies every archive and every included file by SHA-256', () => {
  const root = fixture(), result = buildPublic(root);
  for (const [index, archive] of result.manifest.archives.entries()) {
    const bytes = fs.readFileSync(path.join(root, 'releases', archive.file));
    assert.equal(bytes.length, archive.bytes);
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), archive.sha256);
    const entries = readStoredZip(bytes);
    for (const file of result.manifest[index === 0 ? 'runtime' : 'source']) {
      assert.equal(entries.get(file.path).length, file.bytes);
      assert.equal(crypto.createHash('sha256').update(entries.get(file.path)).digest('hex'), file.sha256);
    }
  }
});

test('missing required file prevents any release output', () => {
  const root = fixture();
  fs.renameSync(path.join(root, 'README.md'), path.join(root, 'README.saved.md'));
  assert.throws(() => buildPublic(root), /README\.md/);
  assert.equal(fs.existsSync(path.join(root, 'releases')), false);
});

test('content leaks inside an allowed file block publication without exposing the matched value', () => {
  const root = fixture();
  const privatePath = ['Q:', 'Users', 'SyntheticPrivatePerson', 'notes.txt'].join('\\');
  fs.appendFileSync(path.join(root, 'README.md'), privatePath);
  assert.throws(() => buildPublic(root), error => {
    assert.equal(error.message.includes(privatePath), false);
    assert.deepEqual(error.findings, [{ file: 'README.md', line: 2, rule: 'absolute-local-path' }]);
    return true;
  });
  assert.equal(fs.existsSync(path.join(root, 'releases')), false);
});

test('scanner catches identity and credential formats with redacted diagnostics', () => {
  const samples = [
    [['person', ['mail', 'company', 'org'].join('.')].join('@'), 'personal-email'],
    ['a'.repeat(32), 'fixed-extension-id'],
    [['-----BEGIN', 'PRIVATE KEY-----'].join(' '), 'private-key'],
    ['gh' + 'p_' + 'Z'.repeat(36), 'credential-signature'],
    ['Bearer' + ' ' + 'Z'.repeat(25), 'bearer-token'],
    ['apiKey' + ' = ' + JSON.stringify('Z'.repeat(25)), 'assigned-credential'],
    ['https://cdn.example/file?' + 'signature=' + 'actualSensitiveValue', 'signed-url'],
    [['', 'home', 'privateperson', 'project', 'notes'].join('/'), 'home-directory']
  ];
  for (const [value, rule] of samples) {
    const results = findingsFor('README.md', value);
    assert.ok(results.some(result => result.rule === rule), rule);
    assert.equal(JSON.stringify(results).includes(value), false);
  }
  assert.deepEqual(findingsFor('README.md', ['user', 'example.com'].join('@')), []);
});

test('synthetic URL exceptions are file-specific and do not allow new signed URLs', () => {
  const signed = 'https://cdn.example/file?' + 'signature=synthetic-token';
  assert.deepEqual(findingsFor('extension/tests/manager.test.cjs', signed), []);
  assert.equal(findingsFor('README.md', signed)[0].rule, 'signed-url');
  assert.equal(findingsFor('extension/tests/manager.test.cjs', signed + '-real-extra')[0].rule, 'signed-url');
});

test('linked source files and linked parent directories are rejected before reading', () => {
  const root = fixture();
  for (const relative of ['README.md', 'extension']) {
    let read = false;
    const target = path.join(root, relative);
    const io = { lstatSync(name) { return name === target ? { isSymbolicLink: () => true } : fs.lstatSync(name); },
      readFileSync() { read = true; throw new Error('Link target must never be read.'); } };
    assert.throws(() => readSafe(root, relative === 'extension' ? 'extension/manifest.json' : relative, io), /Linked publication path rejected/);
    assert.equal(read, false);
  }
});

test('unsafe relative paths and duplicate ZIP entries cannot escape the package boundary', () => {
  for (const name of ['../private', '/private', 'nested/../private', 'nested//private', 'nested\\private', 'X:' + '/private', './private']) {
    assert.throws(() => safeRelative(name), /Unsafe/);
    assert.throws(() => makeZip([{ path: name, data: 'text' }]), /Unsafe/);
  }
  assert.throws(() => makeZip([{ path: 'a', data: 'one' }, { path: 'a', data: 'two' }]), /Duplicate/);
});

test('version mismatch stops the build', () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'extension', 'manager.html'), '<span class="version">0.0.1</span>');
  assert.throws(() => buildPublic(root), /Visible version mismatch/);
  assert.equal(fs.existsSync(path.join(root, 'releases')), false);
});

test('changing ignore rules to expose extra files stops the build', () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, '.gitignore'), '!/private.json\n');
  assert.throws(() => buildPublic(root), /explicit publication allowlist/);
});

test('existing releases are preserved and no partial replacement files are created', () => {
  const root = fixture(), original = buildPublic(root);
  const before = original.names.map(name => fs.readFileSync(path.join(root, 'releases', name)));
  assert.throws(() => buildPublic(root), /Release already exists/);
  original.names.forEach((name, index) => assert.deepEqual(fs.readFileSync(path.join(root, 'releases', name)), before[index]));
  assert.deepEqual(fs.readdirSync(path.join(root, 'releases')).sort(), [...original.names].sort());
});

test('an optional license is included only when present and is scanned', () => {
  const root = fixture();
  assert.equal(checkProject(root).files.includes('LICENSE'), false);
  fs.writeFileSync(path.join(root, 'LICENSE'), 'Synthetic license fixture.\n');
  assert.equal(checkProject(root).files.includes('LICENSE'), true);
  fs.appendFileSync(path.join(root, 'LICENSE'), ['person', 'private-company.org'].join('@'));
  assert.throws(() => checkProject(root), /Publication content check failed/);
});

test('ZIP bytes are deterministic and use the standard CRC32 checksum', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
  const input = [{ path: 'folder/한글.txt', data: 'UTF-8 test' }];
  assert.deepEqual(makeZip(input), makeZip(input));
  assert.equal(readStoredZip(makeZip(input)).get('folder/한글.txt').toString(), 'UTF-8 test');
});
