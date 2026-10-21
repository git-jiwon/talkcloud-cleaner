'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const T = require('../protection-transfer.js');
const P = require('../protection.js');
const source = fs.readFileSync(path.join(__dirname, '../settings-transfer.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../settings-transfer.html'), 'utf8');
const settings = id => ({ version: 1, files: [{ id, name: '보호 파일' }], rooms: [{ id: 'room-one', name: '보호 채팅방' }] });
function store(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { values, get length() { return values.size; }, key(i) { return [...values.keys()][i] ?? null; },
    getItem(key) { return values.get(key) ?? null; }, setItem(key, value) { values.set(key, value); }, removeItem(key) { values.delete(key); } };
}
function harness(initial = {}, options = {}) {
  const elements = {}, windowListeners = new Map(), digests = [], saved = [];
  function element(id, tag = '') {
    return { id, disabled: /\bdisabled(?:\s|>|=)/.test(tag), hidden: /\bhidden(?:\s|>|=)/.test(tag), value: '', textContent: '', files: [],
      listeners: new Map(), addEventListener(name, callback) { this.listeners.set(name, callback); } };
  }
  for (const match of html.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) elements[match[1]] = element(match[1], match[0]);
  const localStorage = store(initial);
  const writableHandle = { async createWritable() { return { async write(value) { saved.push(value); }, async close() {} }; } };
  const context = { TalkCleanerProtectionTransfer: T, localStorage, location: { protocol: 'chrome-extension:', hostname: 'synthetic-extension' },
    document: { getElementById(id) { assert.ok(elements[id], `Missing element ${id}`); return elements[id]; } },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    crypto: { subtle: { digest(algorithm, data) { assert.equal(algorithm, 'SHA-256'); return new Promise(resolve => digests.push({ data: Buffer.from(data), resolve })); } } },
    TextEncoder, Uint8Array, Blob, setTimeout() {},
    showSaveFilePicker: options.picker || (async () => writableHandle)
  };
  context.window = context;
  vm.runInNewContext(source, context, { filename: 'settings-transfer.js' });
  return { elements, localStorage, digests, saved, writableHandle,
    dispatch(id, type = 'click') { const node = elements[id]; assert.equal(node.disabled, false, `${id} is disabled`); return node.listeners.get(type)({ target: node }); },
    storageChanged(key) { windowListeners.get('storage')({ key }); },
    finishHash(index) { const job = digests[index]; assert.ok(job, `Hash ${index} is not pending`); job.resolve(new Uint8Array(crypto.createHash('sha256').update(job.data).digest()).buffer); },
    async preview(backup) { elements.importText.value = JSON.stringify(backup); const task = elements.previewText.listeners.get('click')(); this.finishHash(digests.length - 1); await task; }
  };
}

test('a storage change during backup hashing cannot publish or save the old snapshot', async () => {
  const key = P.key('account-one'), h = harness({ [key]: JSON.stringify(settings('old-file')) });
  const pending = h.dispatch('backup');
  h.localStorage.setItem(key, JSON.stringify(settings('new-file'))); h.storageChanged(key);
  const warning = h.elements.status.textContent;
  h.finishHash(0); await pending;
  assert.equal(h.elements.saveBackup.disabled, true); assert.equal(h.elements.backupResult.hidden, true);
  assert.equal(h.elements.backupText.value, ''); assert.equal(h.elements.status.textContent, warning);
  assert.match(warning, /다른 탭에서 보호 설정이 바뀌었습니다/);
  assert.equal(h.saved.length, 0);
});

test('a completed export is invalidated when protection storage changes', async () => {
  const key = P.key('account-one'), h = harness({ [key]: JSON.stringify(settings('old-file')) });
  const task = h.dispatch('backup'); h.finishHash(0); await task;
  assert.equal(h.elements.saveBackup.disabled, false); assert.equal(h.elements.backupResult.hidden, false);
  h.localStorage.setItem(key, JSON.stringify(settings('new-file'))); h.storageChanged(key);
  assert.equal(h.elements.saveBackup.disabled, true); assert.equal(h.elements.backupResult.hidden, true);
  assert.equal(h.elements.backupText.value, '');
});

test('an older backup hash completing last cannot replace the latest backup', async () => {
  const key = P.key('account-one'), h = harness({ [key]: JSON.stringify(settings('old-file')) });
  const first = h.dispatch('backup');
  h.localStorage.setItem(key, JSON.stringify(settings('latest-file')));
  const second = h.dispatch('backup');
  h.finishHash(1); await second;
  const latestText = h.elements.backupText.value, latestFingerprint = h.elements.backupFingerprint.textContent;
  assert.equal(JSON.parse(latestText).accounts[0].protection.files[0].id, 'latest-file');
  h.finishHash(0); await first;
  assert.equal(h.elements.backupText.value, latestText); assert.equal(h.elements.backupFingerprint.textContent, latestFingerprint);
  assert.equal(h.elements.saveBackup.disabled, false);
});

test('a storage change during restore hashing cannot show stale verification success', async () => {
  const key = P.key('account-one'), h = harness();
  const incoming = T.createBackup(store({ [key]: JSON.stringify(settings('imported-file')) }));
  await h.preview(incoming);
  assert.equal(h.elements.restore.disabled, false);
  const pending = h.dispatch('restore');
  assert.equal(P.read(h.localStorage, 'account-one').files[0].id, 'imported-file');
  h.localStorage.setItem(key, JSON.stringify(settings('concurrently-changed-file'))); h.storageChanged(key);
  const warning = h.elements.status.textContent;
  h.finishHash(1); await pending;
  assert.equal(h.elements.verified.hidden, true); assert.equal(h.elements.restore.disabled, true);
  assert.equal(h.elements.status.textContent, warning); assert.match(warning, /다른 탭에서 보호 설정이 바뀌었습니다/);
  assert.equal(P.read(h.localStorage, 'account-one').files[0].id, 'concurrently-changed-file');
});

test('editing a new import while restore hashing is pending keeps old verification hidden', async () => {
  const key = P.key('account-one'), h = harness();
  await h.preview(T.createBackup(store({ [key]: JSON.stringify(settings('imported-file')) })));
  const pending = h.dispatch('restore');
  h.elements.importText.value = '{new pending input'; h.dispatch('importText', 'input');
  h.finishHash(1); await pending;
  assert.equal(h.elements.verified.hidden, true); assert.equal(h.elements.restore.disabled, true);
});

test('copied and saved backups use compact JSON accepted by the same parser size rule', async () => {
  const key = P.key('account-one'), h = harness({ [key]: JSON.stringify(settings('file-one')) });
  const task = h.dispatch('backup'); h.finishHash(0); await task;
  const text = h.elements.backupText.value;
  assert.equal(text, JSON.stringify(JSON.parse(text)));
  assert.equal(text, JSON.stringify(T.parseBackup(text)));
  await h.dispatch('saveBackup');
  assert.deepEqual(h.saved, [text]);
  assert.equal(Buffer.byteLength(text), Buffer.byteLength(JSON.stringify(T.parseBackup(text))));
  assert.equal(T.summarize(T.parseBackup(h.saved[0])).files, 1);
});

test('settings changed while a save dialog is pending produces an explicit stale-backup warning', async () => {
  let finishPicker;
  const key = P.key('account-one'), h = harness({ [key]: JSON.stringify(settings('old-file')) }, {
    picker: () => new Promise(resolve => { finishPicker = resolve; })
  });
  const backupTask = h.dispatch('backup'); h.finishHash(0); await backupTask;
  const saveTask = h.dispatch('saveBackup');
  h.localStorage.setItem(key, JSON.stringify(settings('new-file'))); h.storageChanged(key);
  finishPicker(h.writableHandle); await saveTask;
  assert.equal(h.saved.length, 1); assert.equal(T.parseBackup(h.saved[0]).accounts[0].protection.files[0].id, 'old-file');
  assert.match(h.elements.status.textContent, /그동안 보호 설정이 바뀌었습니다/);
  assert.match(h.elements.status.textContent, /최신 백업을 다시/);
  assert.equal(h.elements.saveBackup.disabled, true);
});
