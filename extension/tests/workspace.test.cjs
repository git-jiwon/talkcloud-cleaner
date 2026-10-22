'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const W = require('../workspace.js');
const D = require('../download.js');
const NOW = Date.UTC(2026, 9, 22);
const DAY = 24 * 60 * 60 * 1000;
const mockWindowsPath = (...segments) => ['C:', ...segments].join('\\');
const mockUrl = 'https://example.test/?' + 'token=synthetic-secret';
const record = (overrides = {}) => ({ id: 'file-1', kind: 'photo', verticalType: 'MEDIA', createdAt: NOW - DAY, size: 10, name: '사진.jpg', ...overrides });
function storage(initial = {}) {
  const values = new Map(Object.entries(initial)), writes = [];
  return { values, writes, getItem: key => values.has(key) ? values.get(key) : null,
    setItem(key, value) { writes.push({ key, value }); values.set(key, value); } };
}
function state(overrides = {}) {
  return { version: 1, criteria: { cutoff: '2026-10-01', kinds: ['photo'], minBytes: 0, protectStarred: true, includeGif: false, includeLeft: false },
    selection: [{ id: record().id, fingerprint: W.fingerprint(record()) }], view: { search: '사진', room: 'room:example', minMB: '0.5', selectedOnly: true, sort: 'size-desc', mode: 'rooms' },
    downloads: [], outcomes: [], ...overrides };
}
function receipt(overrides = {}) {
  return { recordKey: D.receiptKey('account-a', record()), downloadId: 12, filename: mockWindowsPath('Users', 'Example', 'Downloads', 'photo.jpg'), bytes: 20, kind: 'photo', expectedMime: 'image/jpeg', expectedSize: null, ...overrides };
}
test('browser global and CommonJS expose the same small synchronous interface', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'workspace.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.TalkCleanerWorkspace), ['key', 'read', 'write', 'clear', 'fingerprint']);
});
test('account storage keys are isolated and account fields are never copied into the state', () => {
  const s = storage();
  W.write(s, 'account-a', state({ account: 'account-a' }), NOW);
  assert.equal(W.read(s, 'account-b', NOW), null);
  assert.equal(Object.hasOwn(W.read(s, 'account-a', NOW), 'account'), false);
  W.write(s, 'account-b', state({ selection: [] }), NOW);
  assert.equal(W.read(s, 'account-a', NOW).selection.length, 1);
  assert.equal(W.read(s, 'account-b', NOW).selection.length, 0);
});
test('invalid account identifiers never touch storage', () => {
  for (const account of [undefined, null, '', ' ', 1, {}, [], 'x'.repeat(513), 'a\nb']) {
    const s = storage();
    assert.throws(() => W.read(s, account, NOW), /계정/);
    assert.throws(() => W.write(s, account, state(), NOW), /계정/);
    assert.throws(() => W.clear(s, account), /계정/);
    assert.equal(s.writes.length, 0);
  }
});
test('fingerprints retain opaque IDs, exact metadata and no account, URL or unknown fields', () => {
  const value = record({ id: '9223372036854775808', sourceUrl: mockUrl, cookie: 'fake-session' });
  assert.equal(W.fingerprint(value), JSON.stringify([value.id, value.kind, value.createdAt, value.size, value.name, null, null, null, 'MEDIA']));
  assert.equal(W.fingerprint(record({ size: undefined, name: undefined })), JSON.stringify(['file-1', 'photo', NOW - DAY, null, '', null, null, null, 'MEDIA']));
});
test('saved state is a whitelist and strips credentials, protection data and raw errors at every level', () => {
  const sensitive = { url: mockUrl, cookie: 'fake-cookie', error: 'fake-raw-error', protectedFileIds: ['private'] };
  const s = storage(), input = state({ ...sensitive, criteria: { ...state().criteria, ...sensitive, account: 'private-account' },
    view: { ...state().view, ...sensitive }, selection: [{ ...state().selection[0], ...sensitive }],
    downloads: [{ ...receipt(), ...sensitive }], outcomes: [{ type: 'trash', startedAt: NOW - 1, finishedAt: null, ...sensitive, criteria: { ...state().criteria, ...sensitive },
      items: [{ ...record(), state: 'requested', ...sensitive }] }] });
  const result = W.write(s, 'account-a', input, NOW), raw = s.values.get(W.key('account-a'));
  for (const marker of ['synthetic-secret', 'fake-cookie', 'fake-raw-error', 'protectedFileIds', 'private-account', mockWindowsPath('')]) assert.equal(raw.includes(marker), false);
  assert.equal(result.downloads[0].filename, 'photo.jpg');
  assert.equal(result.outcomes[0].items[0].state, 'requested');
  assert.equal(result.outcomes[0].finishedAt, null);
  assert.deepEqual(result.outcomes[0].criteria, state().criteria);
});
test('download keys must belong to the current account and match the receipt kind', () => {
  for (const change of [{ recordKey: D.receiptKey('account-b', record()) }, { kind: 'video' }, { recordKey: 'bad' }, { recordKey: JSON.stringify(['account-a']) }]) {
    assert.throws(() => W.write(storage(), 'account-a', state({ downloads: [receipt(change)] }), NOW));
  }
});
test('download basename extraction accepts Windows/POSIX paths and retains browser duplicate suffixes', () => {
  for (const name of [mockWindowsPath('Users', 'Example', 'Downloads', 'photo (2).jpg'), ['', 'home', 'example', 'Downloads', 'photo (2).jpg'].join('/'), 'photo (2).jpg']) {
    const result = W.write(storage(), 'account-a', state({ downloads: [receipt({ filename: name })] }), NOW);
    assert.equal(result.downloads[0].filename, 'photo (2).jpg');
  }
  for (const filename of ['', '..', '.', mockWindowsPath('Downloads', ''), '/tmp/a?', 'https://example.test/file?' + 'token=secret', 'bad\0name', 'x'.repeat(513)]) {
    assert.throws(() => W.write(storage(), 'account-a', state({ downloads: [receipt({ filename })] }), NOW));
  }
});
test('download receipt validation covers IDs, kinds, size agreement and MIME', () => {
  for (const change of [{ downloadId: -1 }, { downloadId: 1.5 }, { bytes: -1 }, { bytes: 0 }, { bytes: 10, expectedSize: 11 }, { expectedMime: 'bad' }, { expectedMime: 'text/html; token=secret' }]) {
    assert.throws(() => W.write(storage(), 'account-a', state({ downloads: [receipt(change)] }), NOW));
  }
  const empty = record({ kind: 'file', verticalType: 'FILE', size: 0, name: 'empty.txt' });
  const result = W.write(storage(), 'account-a', state({ downloads: [receipt({ recordKey: D.receiptKey('account-a', empty), kind: 'file', bytes: 0, expectedSize: 0 })] }), NOW);
  assert.equal(result.downloads[0].bytes, 0);
});
test('TTL expiry returns null without clearing or rewriting the saved original', () => {
  const s = storage(); W.write(s, 'account-a', state(), NOW);
  const before = s.values.get(W.key('account-a'));
  assert.ok(W.read(s, 'account-a', NOW + 7 * DAY));
  assert.equal(W.read(s, 'account-a', NOW + 7 * DAY + 1), null);
  assert.equal(s.values.get(W.key('account-a')), before);
  assert.equal(s.writes.length, 1);
});
test('missing data and explicit clear markers read as null without writes', () => {
  const s = storage(); assert.equal(W.read(s, 'account-a', NOW), null); assert.equal(s.writes.length, 0);
  W.write(s, 'account-a', state(), NOW); W.clear(s, 'account-a');
  assert.equal(s.values.get(W.key('account-a')), ''); assert.equal(W.read(s, 'account-a', NOW), null);
  W.write(s, 'account-a', state(), NOW);
  s.removeItem = key => s.values.delete(key); W.clear(s, 'account-a'); assert.equal(s.values.has(W.key('account-a')), false);
});
test('corrupt and unknown-version data blocks reads and writes until an explicit clear', () => {
  for (const raw of ['broken', 'null', '[]', '42', JSON.stringify({ ...state(), version: 2, savedAt: NOW }), JSON.stringify(state({ version: undefined }))]) {
    const s = storage({ [W.key('account-a')]: raw });
    assert.throws(() => W.read(s, 'account-a', NOW), /원본 기록을 보존/);
    assert.throws(() => W.write(s, 'account-a', state(), NOW), /원본 기록을 보존/);
    assert.equal(s.writes.length, 0); assert.equal(s.values.get(W.key('account-a')), raw);
    W.clear(s, 'account-a'); assert.ok(W.write(s, 'account-a', state(), NOW));
  }
});
test('storage errors are friendly and never expose the underlying exception', () => {
  const failingRead = { getItem() { throw new Error('private-token'); }, setItem() {} };
  assert.throws(() => W.read(failingRead, 'account-a', NOW), error => error.code === 'WORKSPACE_READ_FAILED' && !error.message.includes('private-token'));
  assert.throws(() => W.write(failingRead, 'account-a', state(), NOW), /읽지 못했습니다/);
  const failingWrite = { getItem() { return null; }, setItem() { throw new Error('private-path'); } };
  assert.throws(() => W.write(failingWrite, 'account-a', state(), NOW), error => error.code === 'WORKSPACE_WRITE_FAILED' && !error.message.includes('private-path'));
  assert.throws(() => W.clear(failingWrite, 'account-a'), /지우지 못했습니다/);
});
test('future and inconsistent timestamps are rejected rather than made fresh', () => {
  for (const data of [{ ...state(), savedAt: NOW + 1 }, { ...state(), savedAt: -1 }]) {
    assert.throws(() => W.read(storage({ [W.key('account-a')]: JSON.stringify(data) }), 'account-a', NOW));
  }
  for (const outcome of [{ type: 'trash', startedAt: NOW + 1, finishedAt: null, items: [] }, { type: 'download', startedAt: NOW, finishedAt: NOW - 1, items: [] }]) {
    assert.throws(() => W.write(storage(), 'account-a', state({ outcomes: [outcome] }), NOW));
  }
  for (const now of [-1, NaN, Infinity, 'now']) assert.throws(() => W.write(storage(), 'account-a', state(), now), /시각/);
});
test('the last two outcome runs preserve unfinished states without claiming completion', () => {
  const outcomes = [0, 1, 2].map(index => ({ type: index % 2 ? 'download' : 'trash', startedAt: NOW - 10 + index, finishedAt: null,
    items: [{ ...record(), state: index % 2 ? 'pending' : 'requested' }] }));
  const s = storage(); W.write(s, 'account-a', state({ outcomes }), NOW);
  const result = W.read(s, 'account-a', NOW);
  assert.equal(result.outcomes.length, 2);
  assert.equal(result.outcomes[0].items[0].state, 'pending'); assert.equal(result.outcomes[1].items[0].state, 'requested');
});
test('outcome fingerprints are optional for older records and validated when present', () => {
  const base = { type: 'trash', startedAt: NOW, finishedAt: null, items: [{ ...record(), fingerprint: W.fingerprint(record()), state: 'uncertain' }] };
  const result = W.write(storage(), 'account-a', state({ outcomes: [base] }), NOW);
  assert.equal(result.outcomes[0].items[0].fingerprint, W.fingerprint(record()));
  const invalid = { ...base, items: [{ ...base.items[0], fingerprint: W.fingerprint(record({ id: 'other' })) }] };
  assert.throws(() => W.write(storage(), 'account-a', state({ outcomes: [invalid] }), NOW));
});
test('invalid selection fingerprints, duplicates and mismatched identities fail closed', () => {
  const base = JSON.parse(W.fingerprint(record()));
  const malformed = [[0, 'other'], [1, 'unknown'], [2, -1], [3, 1.5], [4, 'x'.repeat(513)], [5, 123], [6, 'true'], [7, 'false'], [8, 'FILE']]
    .map(([index, value]) => { const parts = [...base]; parts[index] = value; return JSON.stringify(parts); });
  for (const fp of ['bad', '[]', '{}', JSON.stringify(base.slice(0, 5)), ...malformed]) {
    assert.throws(() => W.write(storage(), 'account-a', state({ selection: [{ id: 'file-1', fingerprint: fp }] }), NOW));
  }
  assert.throws(() => W.write(storage(), 'account-a', state({ selection: [state().selection[0], state().selection[0]] }), NOW));
});
test('selection fingerprints change when a room, membership, bookmark or vertical metadata changes', () => {
  const original = record({ roomId: 'room-a', joined: true, bookmarked: false });
  for (const change of [{ roomId: 'room-b' }, { joined: false }, { bookmarked: true }, { name: '다른이름.jpg' }]) {
    assert.notEqual(W.fingerprint(original), W.fingerprint({ ...original, ...change }));
  }
  const encoded = W.fingerprint(original);
  assert.equal(W.write(storage(), 'account-a', state({ selection: [{ id: original.id, fingerprint: encoded }] }), NOW).selection[0].fingerprint, encoded);
  for (const change of [{ verticalType: 'FILE' }, { joined: 'true' }, { bookmarked: 'false' }, { roomId: 123 }]) assert.throws(() => W.fingerprint({ ...original, ...change }));
});
test('criteria and view bounds reject malformed filters without keeping stale defaults', () => {
  for (const change of [{ cutoff: '2026-02-30' }, { cutoff: '' }, { kinds: [] }, { kinds: ['photo', 'photo'] }, { kinds: ['team'] }, { minBytes: -1 }, { includeLeft: 'true' }]) {
    assert.throws(() => W.write(storage(), 'account-a', state({ criteria: { ...state().criteria, ...change } }), NOW));
  }
  for (const change of [{ sort: 'bad' }, { mode: 'bad' }, { minMB: '-1' }, { minMB: 'Infinity' }, { minMB: '9007199254740991' }, { search: 'x'.repeat(513) }, { selectedOnly: 1 }]) {
    assert.throws(() => W.write(storage(), 'account-a', state({ view: { ...state().view, ...change } }), NOW));
  }
});
test('collection count and total 4 MiB limits independently reject oversized workspaces', () => {
  const records = Array.from({ length: 20000 }, (_, index) => record({ id: String(index), name: '' }));
  const selection = records.map(value => ({ id: value.id, fingerprint: W.fingerprint(value) }));
  assert.equal(W.write(storage(), 'account-a', state({ selection }), NOW).selection.length, 20000);
  assert.throws(() => W.write(storage(), 'account-a', state({ selection: Array.from({ length: 50001 }, () => selection[0]) }), NOW));
  const tooLarge = selection.map(item => ({ id: item.id, fingerprint: W.fingerprint(record({ id: item.id, name: '가'.repeat(100) })) }));
  assert.throws(() => W.write(storage(), 'account-a', state({ selection: tooLarge }), NOW), error => error.code === 'WORKSPACE_TOO_LARGE');
  const raw = ' '.repeat(4 * 1024 * 1024 + 1), s = storage({ [W.key('account-a')]: raw });
  assert.throws(() => W.read(s, 'account-a', NOW)); assert.equal(s.writes.length, 0);
});
