'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../protection.js');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const reads = [], writes = [];
  return {
    values, reads, writes,
    getItem(key) { reads.push(key); return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { writes.push({ key, value }); values.set(key, value); }
  };
}
const empty = () => ({ version: 1, files: [], rooms: [] });
const settings = () => ({ version: 1, files: [{ id: 'file-1', name: '보관할 사진' }], rooms: [{ id: 'room-1', name: '보호할 채팅방' }] });

test('storage keys isolate accounts and preserve exact opaque account IDs', () => {
  const a = '9223372036854775807', b = '9223372036854775808';
  const s = storage();
  P.write(s, a, settings());
  assert.notEqual(P.key(a), P.key(b));
  assert.equal(P.key(a), `talkcloud-protection-v1:${a}`);
  assert.deepEqual(P.read(s, a), settings());
  assert.deepEqual(P.read(s, b), empty());
  const second = { version: 1, files: [{ id: 'file-2', name: '다른 계정 파일' }], rooms: [] };
  P.write(s, b, second);
  assert.deepEqual(P.read(s, a), settings());
  assert.deepEqual(P.read(s, b), second);
  assert.equal(s.values.size, 2);
});

test('invalid account IDs cannot read or write any storage key', () => {
  for (const account of [undefined, null, '', ' ', 123, {}, [], 'x'.repeat(513)]) {
    const s = storage();
    assert.throws(() => P.key(account));
    assert.throws(() => P.read(s, account));
    assert.throws(() => P.write(s, account, settings()));
    assert.equal(s.reads.length, 0);
    assert.equal(s.writes.length, 0);
  }
});

test('missing account settings return independent empty lists without writing defaults', () => {
  const s = storage();
  const first = P.read(s, 'account');
  const second = P.read(s, 'account');
  assert.deepEqual(first, empty());
  first.files.push({ id: 'local-only', name: '로컬 변경' });
  assert.deepEqual(second, empty());
  assert.deepEqual(P.read(s, 'account'), empty());
  assert.equal(s.writes.length, 0);
});

test('corrupt JSON never silently resets protections or overwrites storage', () => {
  for (const raw of ['', '{broken', 'undefined', 'null', '[]', 'true', '42']) {
    const key = P.key('account');
    const s = storage({ [key]: raw });
    assert.throws(() => P.read(s, 'account'), /삭제 없이 중단/);
    assert.equal(s.values.get(key), raw);
    assert.equal(s.writes.length, 0);
  }
});

test('unsupported versions and malformed collection shapes fail closed on read and write', () => {
  const invalid = [
    {}, { files: [], rooms: [] }, { version: 0, files: [], rooms: [] },
    { version: 2, files: [], rooms: [] }, { version: '1', files: [], rooms: [] },
    { version: 1, files: {}, rooms: [] }, { version: 1, files: [], rooms: null },
    { version: 1, files: [], rooms: undefined }
  ];
  for (const data of invalid) {
    const key = P.key('account');
    const raw = JSON.stringify(data);
    const s = storage({ [key]: raw });
    assert.throws(() => P.read(s, 'account'), /삭제 없이 중단/);
    assert.throws(() => P.write(s, 'account', data));
    assert.equal(s.writes.length, 0);
    assert.equal(s.values.get(key), raw);
  }
});

test('invalid item IDs or names invalidate the entire stored protection set', () => {
  const invalidItems = [null, {}, { id: 123, name: 'name' }, { id: '', name: 'name' },
    { id: ' ', name: 'name' }, { id: 'x'.repeat(513), name: 'name' },
    { id: 'id' }, { id: 'id', name: null }, { id: 'id', name: 123 }];
  for (const collection of ['files', 'rooms']) {
    for (const item of invalidItems) {
      const data = settings();
      data[collection].push(item);
      const s = storage({ [P.key('account')]: JSON.stringify(data) });
      assert.throws(() => P.read(s, 'account'), /삭제 없이 중단/);
      assert.throws(() => P.write(s, 'account', data), /삭제 없이 중단/);
      assert.equal(s.writes.length, 0);
    }
  }
});

test('duplicates in either protection collection reject the entire update and preserve prior settings', () => {
  for (const collection of ['files', 'rooms']) {
    const original = JSON.stringify(settings());
    const s = storage({ [P.key('account')]: original });
    const next = settings();
    next[collection].push({ ...next[collection][0], name: '같은 ID의 다른 이름' });
    assert.throws(() => P.write(s, 'account', next), /중복/);
    assert.equal(s.writes.length, 0);
    assert.equal(s.values.get(P.key('account')), original);
    const corrupt = storage({ [P.key('account')]: JSON.stringify(next) });
    assert.throws(() => P.read(corrupt, 'account'), /삭제 없이 중단/);
    assert.equal(corrupt.writes.length, 0);
  }
});

test('file and room ID namespaces remain independent even when their strings match', () => {
  const value = { version: 1, files: [{ id: 'same', name: '파일' }], rooms: [{ id: 'same', name: '채팅방' }] };
  const s = storage();
  assert.deepEqual(P.write(s, 'account', value), value);
  assert.deepEqual(P.filters(P.read(s, 'account')), { protectedFileIds: ['same'], protectedRoomIds: ['same'] });
});

test('read and write produce detached records, bound names and discard unrelated fields', () => {
  const input = settings();
  input.extra = 'discard';
  input.files[0].name = 'x'.repeat(700);
  input.files[0].extra = 'discard';
  const s = storage();
  const saved = P.write(s, 'account', input);
  assert.equal(saved.files[0].name.length, 512);
  assert.equal(input.files[0].name.length, 700);
  assert.equal(Object.hasOwn(saved, 'extra'), false);
  assert.equal(Object.hasOwn(saved.files[0], 'extra'), false);
  assert.notEqual(saved.files, input.files);
  assert.notEqual(saved.files[0], input.files[0]);
  const stored = s.values.get(P.key('account'));
  input.files[0].id = 'changed-input';
  saved.files[0].id = 'changed-return';
  assert.equal(s.values.get(P.key('account')), stored);
  const read = P.read(s, 'account');
  assert.equal(read.files[0].id, 'file-1');
  read.files[0].id = 'changed-read';
  assert.equal(P.read(s, 'account').files[0].id, 'file-1');
});

test('storage read failures propagate rather than granting an unprotected empty state', () => {
  let calls = 0;
  const s = { getItem() { calls++; throw new Error('storage unavailable'); }, setItem() { throw new Error('must not write'); } };
  assert.throws(() => P.read(s, 'account'), /storage unavailable/);
  assert.equal(calls, 1);
});

test('storage write failure reports unapplied protection and does not retry or return success', () => {
  const key = P.key('account');
  const original = JSON.stringify(settings());
  const values = new Map([[key, original]]);
  let calls = 0;
  const s = {
    getItem(k) { return values.get(k) ?? null; },
    setItem() { calls++; throw new Error('QuotaExceededError: private storage detail'); }
  };
  assert.throws(() => P.write(s, 'account', empty()), error => {
    assert.match(error.message, /보호가 적용되지 않았습니다/);
    assert.doesNotMatch(error.message, /private storage detail/);
    return true;
  });
  assert.equal(calls, 1);
  assert.equal(values.get(key), original);
  assert.deepEqual(P.read(s, 'account'), settings());
});

test('signature is stable across row order and label changes while preserving collection membership', () => {
  const first = { version: 1, files: [{ id: 'z', name: 'Z' }, { id: 'a', name: 'A' }], rooms: [{ id: 'r2', name: 'R2' }, { id: 'r1', name: 'R1' }] };
  const second = { version: 1, files: [...first.files].reverse().map(x => ({ ...x, name: '새 이름' })), rooms: [...first.rooms].reverse() };
  assert.equal(P.signature(first), P.signature(second));
  assert.deepEqual(JSON.parse(P.signature(first)), { protectedFileIds: ['a', 'z'], protectedRoomIds: ['r1', 'r2'] });
  assert.deepEqual(first.files.map(x => x.id), ['z', 'a']);
  assert.deepEqual(first.rooms.map(x => x.id), ['r2', 'r1']);
  const moved = { version: 1, files: [{ id: 'r1', name: '' }, { id: 'z', name: '' }], rooms: [{ id: 'a', name: '' }, { id: 'r2', name: '' }] };
  assert.notEqual(P.signature(first), P.signature(moved));
});

test('signature detects adding, removing and changing an opaque protected ID', () => {
  const initial = settings();
  const base = P.signature(initial);
  const added = settings();
  added.files.push({ id: '9223372036854775807', name: '' });
  assert.notEqual(P.signature(added), base);
  const removed = settings();
  removed.rooms = [];
  assert.notEqual(P.signature(removed), base);
  const changed = settings();
  changed.files[0].id = 'file-2';
  assert.notEqual(P.signature(changed), base);
  assert.notEqual(P.signature({ ...empty(), files: [{ id: '9223372036854775807', name: '' }] }), P.signature({ ...empty(), files: [{ id: '9223372036854775808', name: '' }] }));
});

test('filters are independent sorted ID arrays and do not mutate validated protection lists', () => {
  const value = { version: 1, files: [{ id: 'b', name: '' }, { id: 'a', name: '' }], rooms: [{ id: 'y', name: '' }, { id: 'x', name: '' }] };
  const result = P.filters(value);
  assert.deepEqual(result, { protectedFileIds: ['a', 'b'], protectedRoomIds: ['x', 'y'] });
  result.protectedFileIds.push('new');
  result.protectedRoomIds[0] = 'different';
  assert.deepEqual(value.files.map(x => x.id), ['b', 'a']);
  assert.deepEqual(value.rooms.map(x => x.id), ['y', 'x']);
  assert.deepEqual(P.filters(value), { protectedFileIds: ['a', 'b'], protectedRoomIds: ['x', 'y'] });
});
