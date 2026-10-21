'use strict';

// The publication boundary is this explicit list, not a recursive folder copy.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const RUNTIME_FILES = Object.freeze([
  'background.js', 'bridge.js', 'download.js', 'guide.html', 'manager.css',
  'manager.html', 'manager.js', 'manifest.json', 'protection-transfer.js',
  'protection.js', 'protocol.js', 'review.js', 'settings-transfer.html',
  'settings-transfer.js'
]);
const TEST_FILES = Object.freeze([
  'bridge-download.test.cjs', 'download-protocol.test.cjs', 'download.test.cjs',
  'manager.test.cjs', 'protection-transfer.test.cjs', 'protection.test.cjs',
  'protocol.test.cjs', 'review.test.cjs', 'settings-transfer.test.cjs'
]);
const SOURCE_FILES = Object.freeze([
  '.gitattributes', '.gitignore', 'README.md', 'docs/PRIVACY.md',
  'docs/RELEASE_NOTES.md', 'docs/PUBLISHING.md',
  ...RUNTIME_FILES.map(name => `extension/${name}`),
  ...TEST_FILES.map(name => `extension/tests/${name}`),
  'tools/build-public.cjs', 'tools/check-public.cjs', 'tools/tests/public-package.test.cjs'
].sort());
const OPTIONAL_FILES = Object.freeze(['LICENSE']);

function safeRelative(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') ||
      name.includes('\0') || name.startsWith('/') || name.split('/').some(part => !part || part === '.' || part === '..')) {
    throw new Error('Unsafe package-relative path.');
  }
  return name;
}

function readSafe(root, relative, io = fs) {
  safeRelative(relative);
  const base = path.resolve(root);
  if (io.lstatSync(base).isSymbolicLink()) throw new Error('Project root must not be a link.');
  let current = base;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    const info = io.lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Linked publication path rejected: ${relative}`);
    if (current === path.join(base, ...relative.split('/')) && !info.isFile()) {
      throw new Error(`Publication item is not a regular file: ${relative}`);
    }
  }
  const data = io.readFileSync(current);
  if (data.includes(0)) throw new Error(`Unexpected binary content: ${relative}`);
  if (!Buffer.from(data.toString('utf8'), 'utf8').equals(data)) throw new Error(`Invalid UTF-8 content: ${relative}`);
  return data;
}

function gitignoreText() {
  const files = [...SOURCE_FILES, ...OPTIONAL_FILES].sort();
  const dirs = new Set();
  for (const file of files) {
    const pieces = file.split('/');
    for (let i = 1; i < pieces.length; i++) dirs.add(pieces.slice(0, i).join('/'));
  }
  return '# Public files only. Review and update tools/check-public.cjs before adding a file.\n*\n' +
    [...dirs].sort().map(dir => `!/${dir}/\n`).join('') + files.map(file => `!/${file}\n`).join('');
}

const EMAIL = /\b[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)+[A-Z]{2,}\b/gi;
function exampleEmail(value) {
  const domain = value.slice(value.lastIndexOf('@') + 1).toLowerCase();
  return /(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test)$/.test(domain);
}

function findingsFor(relative, source) {
  const findings = [];
  const fixture = relative.startsWith('extension/tests/') || relative === 'tools/tests/public-package.test.cjs';
  const lines = source.split(/\r?\n/);
  const add = (line, rule) => findings.push({ file: relative, line: line + 1, rule });
  for (let i = 0; i < lines.length; i++) {
    let text = lines[i];
    // Existing browser-download fixtures use these generic, non-user directories.
    if (relative === 'extension/tests/download.test.cjs') text = text.replace(new RegExp('D:' + String.raw`\\{1,2}Downloads\\{1,2}`, 'g'), '<mock-downloads>/').replace(/file:\/\/\/x/g, '<invalid-file-url>');
    if (relative === 'extension/tests/manager.test.cjs') {
      text = text.replace(new RegExp('D:' + String.raw`\\{1,2}MockDownloads\\{1,2}`, 'g'), '<mock-downloads>/')
        .replace(new RegExp('C:' + String.raw`\\{1,2}Users\\{1,2}(?:synthetic-private-user\\{1,2}PrivateFolder|private-report-user)\\{1,2}`, 'g'), '<mock-private-fixture>/');
    }
    if (/\b[A-Za-z]:[\\/]|file:\/\/\//.test(text)) add(i, 'absolute-local-path');
    if (/\/(?:Users|home)\/[^/\s"'`<>]+\//i.test(text)) add(i, 'home-directory');
    if (/\b[a-p]{32}\b/.test(text)) add(i, 'fixed-extension-id');
    const emails = (text.match(EMAIL) || []).filter(email =>
      !(relative === 'extension/tests/download-protocol.test.cjs' && email === ['secret', 'dn.talk.kakao.com'].join('@')) &&
      !(relative === 'extension/tests/download.test.cjs' && email === ['password', 'media.kakaocdn.net'].join('@')));
    if (emails.some(email => !exampleEmail(email))) add(i, 'personal-email');
    if (/-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/.test(text)) add(i, 'private-key');
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[A-Z0-9]{16}|sk-[A-Za-z0-9_-]{24,})\b/.test(text)) add(i, 'credential-signature');
    if (/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/.test(text)) add(i, 'jwt');
    if (/\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|authorization)\s*[=:]\s*['"][^'"]{12,}['"]/i.test(text)) add(i, 'assigned-credential');
    if (/\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(text)) add(i, 'bearer-token');
    for (const match of text.matchAll(/[?&](?:token|signature|sig|auth|access_token)=([^\s"'`<>\]\)}&]+)/gi)) {
      const synthetic = fixture && /^(?:a%2Bb|ab%2B%3D|preserve%2Bme|preserve%3D|private|synthetic-private-value|synthetic-token|synthetic-private-url|private-report-token)$/.test(match[1]);
      const opaqueIdFixture = relative === 'extension/tests/bridge-download.test.cjs' && match[1] === '#fragment';
      if (!synthetic && !opaqueIdFixture) {
        add(i, 'signed-url');
      }
    }
  }
  return findings;
}

function checkProject(root) {
  const base = path.resolve(root);
  const files = [...SOURCE_FILES];
  for (const relative of OPTIONAL_FILES) if (fs.existsSync(path.join(base, relative))) files.push(relative);
  files.sort();
  const contents = new Map();
  const findings = [];
  for (const relative of files) {
    let data;
    try { data = readSafe(base, relative); }
    catch (error) { throw new Error(`Public file check failed (${relative}): ${error.code || error.message}`); }
    contents.set(relative, data);
    findings.push(...findingsFor(relative, data.toString('utf8')));
  }
  if (findings.length) {
    const error = new Error('Publication content check failed. Only file, line and rule are reported.');
    error.findings = findings;
    throw error;
  }
  if (contents.get('.gitignore').toString('utf8').replaceAll('\r\n', '\n') !== gitignoreText()) {
    throw new Error('.gitignore differs from the explicit publication allowlist.');
  }
  let manifest;
  try { manifest = JSON.parse(contents.get('extension/manifest.json')); }
  catch { throw new Error('Invalid extension/manifest.json.'); }
  const version = manifest.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:\.\d+)?$/.test(version)) throw new Error('Invalid release version.');
  for (const relative of ['extension/manager.html', 'extension/guide.html']) {
    const versions = [...contents.get(relative).toString('utf8').matchAll(/class="version"[^>]*>\s*([^<\s]+)\s*</g)].map(match => match[1]);
    if (!versions.length || versions.some(value => value !== version)) throw new Error(`Visible version mismatch: ${relative}`);
  }
  for (const relative of ['README.md', 'docs/RELEASE_NOTES.md']) {
    if (!contents.get(relative).toString('utf8').includes(version)) throw new Error(`Release version missing: ${relative}`);
  }
  const manifestFiles = files.map(relative => ({ path: relative, bytes: contents.get(relative).length,
    sha256: crypto.createHash('sha256').update(contents.get(relative)).digest('hex') }));
  return { version, files, contents, manifestFiles, runtimeFiles: RUNTIME_FILES.map(name => `extension/${name}`) };
}

function reportError(error) {
  // Never print matched content, stack traces or machine paths.
  if (error.findings) {
    for (const finding of error.findings) console.error(`${finding.file}:${finding.line} ${finding.rule}`);
  } else console.error(error.code ? `File operation failed (${error.code}).` : error.message);
}

if (require.main === module) {
  if (process.argv.length !== 2) {
    console.error('Usage: node tools/check-public.cjs');
    process.exitCode = 1;
  } else {
    try {
      const result = checkProject(path.resolve(__dirname, '..'));
      console.log(`Public check passed: ${result.files.length} files; version ${result.version}.`);
      console.log('Only allowlisted files were checked. Private local files remain outside the publication boundary.');
    } catch (error) { reportError(error); process.exitCode = 1; }
  }
}

module.exports = { RUNTIME_FILES, TEST_FILES, SOURCE_FILES, OPTIONAL_FILES, safeRelative, readSafe,
  gitignoreText, findingsFor, checkProject, reportError };
