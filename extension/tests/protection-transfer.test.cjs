'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../protection-transfer.js');
const P = require('../protection.js');
const empty = () => ({ version: 1, files: [], rooms: [] });
const settings = (file = 'file-1', room = 'room-1') => ({ version: 1, files: [{ id: file, name: '원본 파일' }], rooms: [{ id: room, name: '원본 채팅방' }] });
const backup = (accounts = [{ account: 'account-one', protection: settings() }]) => ({ format: T.FORMAT, version: 1, createdAt: '2026-10-21T10:00:00.000Z', accounts });
function storage(initial = {}, hooks = {}) {
  const values = new Map(Object.entries(initial)), writes = [], removes = [], reads = [];
  return {
    values, writes, removes, reads,
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { reads.push(key); hooks.get?.(key, values, reads); return values.get(key) ?? null; },
    setItem(key, value) { hooks.set?.(key, value, values, writes); writes.push({ key, value }); values.set(key, value); },
    removeItem(key) { hooks.remove?.(key, values); removes.push(key); values.delete(key); }
  };
}
test('export includes all exact account scopes and excludes every unrelated storage key', () => {
  const s = storage({
    unrelated: 'private unrelated value', 'talkcloud-protection-v2:other': 'future format',
    [P.key('9223372036854775808')]: JSON.stringify(settings('second', 'second')),
    [P.key('9223372036854775807')]: JSON.stringify(settings())
  });
  const result = T.createBackup(s);
  assert.deepEqual(result.accounts.map(item => item.account), ['9223372036854775807', '9223372036854775808']);
  assert.deepEqual(T.summarize(result), { accounts: 2, files: 2, rooms: 2 });
  assert.equal(JSON.stringify(result).includes('private unrelated value'), false);
  assert.equal(s.reads.includes('unrelated'), false);
  assert.equal(s.writes.length, 0);
});
test('empty export and import are explicit no-op backups with valid metadata', () => {
  const s = storage({ unrelated: 'keep' }), b = T.createBackup(s);
  assert.deepEqual(T.summarize(b), { accounts: 0, files: 0, rooms: 0 });
  assert.equal(T.applyMerge(s, b).verified, true);
  assert.equal(s.writes.length, 0); assert.equal(s.removes.length, 0);
  assert.equal(s.values.get('unrelated'), 'keep');
});
test('canonical representation sorts accounts and IDs and excludes creation time', () => {
  const first = backup([{ account: 'z', protection: { version: 1, files: [{ id: 'z', name: '' }, { id: 'a', name: '' }], rooms: [] } }, { account: 'a', protection: empty() }]);
  const second = structuredClone(first);
  second.createdAt = '2026-10-22T00:00:00.000Z'; second.accounts.reverse(); second.accounts[1].protection.files.reverse();
  assert.equal(T.canonical(first), T.canonical(second));
  assert.equal(T.canonical(first).includes('createdAt'), false);
  assert.deepEqual(first.accounts.map(item => item.account), ['z', 'a']);
});
test('parse returns detached normalized data without truncation or extra fields', () => {
  const b = backup(); b.accounts[0].protection.files[0].name = '가'.repeat(512);
  const parsed = T.parseBackup(b);
  parsed.accounts[0].protection.files[0].name = 'changed';
  assert.equal(b.accounts[0].protection.files[0].name.length, 512);
  assert.equal(T.parseBackup(JSON.stringify(b)).accounts[0].protection.files[0].name.length, 512);
  b.accounts[0].protection.files[0].name += '나';
  assert.throws(() => T.parseBackup(b), /자르거나 누락하지 않고/);
});
test('wrong formats, versions, timestamps and selection-list exports fail before writes', () => {
  const invalid = ['', '{broken', 'null', '[]', JSON.stringify({ criteria: {}, records: [] }),
    { ...backup(), format: 'something-else' }, { ...backup(), version: 2 },
    { ...backup(), createdAt: 'today' }, { ...backup(), createdAt: '2026-10-21' },
    { ...backup(), createdAt: '2026-02-30T10:00:00.000Z' }, { ...backup(), createdAt: 42 },
    { ...backup(), unexpected: 'drop me' }, { ...backup(), accounts: null }];
  for (const value of invalid) {
    const s = storage(); assert.throws(() => T.parseBackup(value)); assert.throws(() => T.applyMerge(s, value));
    assert.equal(s.writes.length, 0);
  }
});
test('invalid account identifiers and duplicate accounts fail without coercion', () => {
  for (const account of ['', ' ', null, 123, [], {}, 'a'.repeat(513)])
    assert.throws(() => T.parseBackup(backup([{ account, protection: empty() }])));
  assert.throws(() => T.parseBackup(backup([{ account: 'same', protection: empty() }, { account: 'same', protection: empty() }])), /중복 계정/);
  const result = T.parseBackup(backup([{ account: ' exact ', protection: empty() }]));
  assert.equal(result.accounts[0].account, ' exact ');
});
test('invalid item shapes, IDs, names, extra fields and duplicates reject the complete backup', () => {
  const invalidItems = [null, {}, { id: 'a' }, { id: 2, name: '' }, { id: '', name: '' },
    { id: ' ', name: '' }, { id: 'x'.repeat(513), name: '' }, { id: 'a', name: null },
    { id: 'a', name: 'x'.repeat(513) }, { id: 'a', name: '', extra: 'no silent omission' }];
  for (const collection of ['files', 'rooms']) {
    for (const item of invalidItems) {
      const b = backup(); b.accounts[0].protection[collection].push(item);
      assert.throws(() => T.parseBackup(b));
    }
    const b = backup(); b.accounts[0].protection[collection].push({ ...b.accounts[0].protection[collection][0] });
    assert.throws(() => T.parseBackup(b), /중복 ID/);
  }
  for (const malformed of [{ version: 1, files: [], rooms: null }, { version: '1', files: [], rooms: [] }, { version: 2, files: [], rooms: [] }])
    assert.throws(() => T.parseBackup(backup([{ account: 'a', protection: malformed }])));
});
test('resource limits reject oversized text, account counts, entry counts and UTF-8 payloads', () => {
  assert.throws(() => T.parseBackup(' '.repeat(T.LIMITS.bytes + 1)), /10 MiB/);
  assert.throws(() => T.parseBackup(backup(Array.from({ length: T.LIMITS.accounts + 1 }, (_, index) => ({ account: String(index), protection: empty() })))), /한도/);
  const many = empty(); many.files = Array.from({ length: T.LIMITS.entries + 1 }, (_, index) => ({ id: String(index), name: '' }));
  assert.throws(() => T.parseBackup(backup([{ account: 'a', protection: many }])), /항목 수/);
  const wide = empty(); wide.files = Array.from({ length: 7100 }, (_, index) => ({ id: String(index), name: '가'.repeat(512) }));
  assert.throws(() => T.parseBackup(backup([{ account: 'a', protection: wide }])), /10 MiB/);
});
test('corrupt or noncanonical stored data cannot be silently exported or overwritten', () => {
  const bad = ['{broken', 'null', JSON.stringify({ version: 1, files: [], rooms: [], extra: true }), JSON.stringify({ version: 1, files: [{ id: 'a', name: 'x'.repeat(513) }], rooms: [] })];
  for (const raw of bad) {
    const s = storage({ [P.key('account-one')]: raw });
    assert.throws(() => T.createBackup(s)); assert.throws(() => T.previewMerge(s, backup())); assert.throws(() => T.applyMerge(s, backup()));
    assert.equal(s.values.get(P.key('account-one')), raw); assert.equal(s.writes.length, 0);
  }
});
test('export rejects an invalid known account key without omitting it', () => {
  const s = storage({ 'talkcloud-protection-v1:': JSON.stringify(empty()) });
  assert.throws(() => T.createBackup(s), /계정 ID/); assert.equal(s.writes.length, 0);
});
test('preview is read only; import unions IDs, preserves current names and unrelated data', () => {
  const current = settings(); current.files.push({ id: 'keep', name: '기존만 있음' });
  const s = storage({ [P.key('account-one')]: JSON.stringify(current), [P.key('unrelated-account')]: '{unknown preserve raw}', unrelated: 'do not touch' });
  const incoming = settings('file-1', 'new-room'); incoming.files[0].name = '백업의 다른 이름'; incoming.files.push({ id: 'new-file', name: '새 파일' });
  const b = backup([{ account: 'account-one', protection: incoming }, { account: 'second-account', protection: empty() }]);
  const p = T.previewMerge(s, b);
  assert.deepEqual(p, { before: { accounts: 1, files: 2, rooms: 1 }, incoming: { accounts: 2, files: 2, rooms: 1 }, after: { accounts: 2, files: 3, rooms: 2 }, addedFiles: 1, addedRooms: 1 });
  assert.equal(s.writes.length, 0);
  assert.deepEqual(T.applyMerge(s, b), { ...p, verified: true });
  const saved = P.read(s, 'account-one');
  assert.deepEqual(saved.files.map(item => item.id), ['file-1', 'keep', 'new-file']);
  assert.equal(saved.files.find(item => item.id === 'file-1').name, '원본 파일');
  assert.equal(s.values.get('unrelated'), 'do not touch');
  assert.equal(s.values.get(P.key('unrelated-account')), '{unknown preserve raw}');
});
test('file and room namespaces, opaque account IDs and prototype-like IDs stay independent', () => {
  const value = { version: 1, files: [{ id: '__proto__', name: 'file' }], rooms: [{ id: '__proto__', name: 'room' }] };
  const b = backup([{ account: '__proto__', protection: value }, { account: '9223372036854775808', protection: settings() }]);
  const s = storage(); T.applyMerge(s, b);
  assert.deepEqual(P.read(s, '__proto__'), value);
  assert.deepEqual(P.read(s, '9223372036854775807'), empty());
  assert.deepEqual(P.read(s, '9223372036854775808'), settings());
  assert.equal({}.polluted, undefined);
});
test('reimport is idempotent and does not rewrite an already normalized destination', () => {
  const s = storage(), b = backup(); T.applyMerge(s, b); const writes = s.writes.length;
  const result = T.applyMerge(s, b);
  assert.equal(result.addedFiles, 0); assert.equal(result.addedRooms, 0); assert.equal(s.writes.length, writes);
});
test('all included existing accounts validate before the first write', () => {
  const s = storage({ [P.key('z')]: '{broken' });
  const b = backup([{ account: 'a', protection: settings() }, { account: 'z', protection: settings() }]);
  assert.throws(() => T.applyMerge(s, b)); assert.equal(s.writes.length, 0); assert.equal(s.values.has(P.key('a')), false);
});
test('apply reads latest settings again after preview so new existing protections survive', () => {
  const s = storage(), b = backup(); T.previewMerge(s, b);
  const current = settings('concurrent-file', 'concurrent-room'); s.values.set(P.key('account-one'), JSON.stringify(current));
  T.applyMerge(s, b);
  assert.deepEqual(P.read(s, 'account-one').files.map(item => item.id), ['concurrent-file', 'file-1']);
  assert.deepEqual(P.read(s, 'account-one').rooms.map(item => item.id), ['concurrent-room', 'room-1']);
});
test('write failure rolls previous target bytes back exactly and preserves unrelated keys', () => {
  const raw = JSON.stringify(settings('original', 'original'), null, 2);
  const s = storage({ [P.key('a')]: raw, unrelated: 'keep' }, { set(key) { if (key === P.key('b')) throw new Error('quota'); } });
  const b = backup([{ account: 'a', protection: settings() }, { account: 'b', protection: settings() }]);
  assert.throws(() => T.applyMerge(s, b), error => error.code === 'TRANSFER_FAILED' && error.rollbackComplete === true);
  assert.equal(s.values.get(P.key('a')), raw); assert.equal(s.values.has(P.key('b')), false); assert.equal(s.values.get('unrelated'), 'keep');
});
test('rollback restores absent targets by removing only newly written account keys', () => {
  const s = storage({ unrelated: 'keep' }, { set(key) { if (key === P.key('b')) throw new Error('quota'); } });
  const b = backup([{ account: 'a', protection: settings() }, { account: 'b', protection: settings() }]);
  assert.throws(() => T.applyMerge(s, b), error => error.rollbackComplete === true);
  assert.deepEqual([...s.values.keys()], ['unrelated']); assert.deepEqual(s.removes, [P.key('a')]);
});
test('rollback failure is explicit and never reported as a verified import', () => {
  const s = storage({}, { set(key) { if (key === P.key('b')) throw new Error('quota'); }, remove() { throw new Error('blocked'); } });
  const b = backup([{ account: 'a', protection: settings() }, { account: 'b', protection: settings() }]);
  assert.throws(() => T.applyMerge(s, b), error => error.code === 'ROLLBACK_INCOMPLETE' && error.rollbackComplete === false && error.rollbackFailures === 1 && /기존 확장을 제거하지 말고/.test(error.message));
  assert.equal(s.values.has(P.key('a')), true); assert.equal(s.values.has(P.key('b')), false);
});
test('concurrent target changes are preserved and are not overwritten during rollback', () => {
  const concurrent = JSON.stringify(settings('external-new-file', 'external-new-room'));
  const s = storage({}, { set(key, value, values) { if (key === P.key('b')) { values.set(P.key('a'), concurrent); throw new Error('later failure'); } } });
  const b = backup([{ account: 'a', protection: settings() }, { account: 'b', protection: settings() }]);
  assert.throws(() => T.applyMerge(s, b), error => error.code === 'ROLLBACK_INCOMPLETE');
  assert.equal(s.values.get(P.key('a')), concurrent); assert.equal(s.removes.length, 0);
});
test('target changes between preflight and write stop before overwriting the new value', () => {
  const concurrent = JSON.stringify(settings('external-new-file', 'external-new-room'));
  const s = storage({}, { get(key, values, reads) { if (key === P.key('account-one') && reads.length === 2) values.set(key, concurrent); } });
  assert.throws(() => T.applyMerge(s, backup()), error => error.rollbackComplete === true);
  assert.equal(s.writes.length, 0); assert.equal(s.values.get(P.key('account-one')), concurrent);
});
test('readback mismatch is a failed migration and a concurrent value remains intact', () => {
  const concurrent = JSON.stringify(settings('new-value', 'new-value'));
  const s = storage({}, { get(key, values, reads) { if (reads.length === 3) values.set(key, concurrent); } });
  assert.throws(() => T.applyMerge(s, backup()), error => error.rollbackComplete === false);
  assert.equal(s.values.get(P.key('account-one')), concurrent);
});
test('export detects changed settings or an added account during its snapshot', () => {
  const key = P.key('account-one');
  const changed = storage({ [key]: JSON.stringify(settings()) }, { get(k, values, reads) { if (reads.length === 2) values.set(k, JSON.stringify(empty())); } });
  assert.throws(() => T.createBackup(changed), /바뀌었습니다/);
  const added = storage({ [key]: JSON.stringify(settings()) }, { get(k, values, reads) { if (reads.length === 2) values.set(P.key('new-account'), JSON.stringify(empty())); } });
  assert.throws(() => T.createBackup(added), /계정 목록이 바뀌었습니다/);
});
test('storage access errors are visible and never produce an empty successful backup', () => {
  assert.throws(() => T.createBackup({ get length() { throw new Error('denied'); } }), /저장소 목록/);
  assert.throws(() => T.createBackup({ length: 1, key() { return P.key('a'); }, getItem() { throw new Error('denied'); } }), /저장소를 읽을 수/);
  const s = storage({}, { get() { throw new Error('denied'); } });
  assert.throws(() => T.applyMerge(s, backup()), /저장소를 읽을 수/); assert.equal(s.writes.length, 0);
});
