'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const R = require('../review.js');

const record = (id, values = {}) => Object.freeze({ id, name: id, kind: 'photo', size: 10, createdAt: 1000, roomId: 'room-a', joined: true, ...values });
const ids = records => records.map(item => item.id);
const roomName = item => ({ 'room-a': '가족', 'room-b': '업무', 'room-c': '업무' })[item.roomId] || '채팅방 확인 불가';

test('the same pure API is available as a browser global', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../review.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.TalkCleanerReview), Object.keys(R));
  assert.equal(Object.isFrozen(context.TalkCleanerReview), true);
});

test('size sorting uses raw numbers and places every unknown and link last in both directions', () => {
  const input = Object.freeze([
    record('z-null', { size: null }), record('ten', { size: 10 }), record('two', { size: 2 }),
    record('a-link', { kind: 'link', size: 999999 }), record('b-nan', { size: NaN }),
    record('c-infinite', { size: Infinity }), record('d-string', { size: '11' }),
    record('e-negative', { size: -1 }), record('zero', { size: 0 })
  ]);
  const unknown = ['a-link', 'b-nan', 'c-infinite', 'd-string', 'e-negative', 'z-null'];
  assert.deepEqual(ids(R.sort(input, 'size-asc')), ['zero', 'two', 'ten', ...unknown]);
  assert.deepEqual(ids(R.sort(input, 'size-desc')), ['ten', 'two', 'zero', ...unknown]);
  assert.equal(input[0].id, 'z-null');
});

test('equal sort values always use ascending exact IDs independent of input order and direction', () => {
  const input = Object.freeze([record('z', { name: 'same' }), record('a', { name: 'same' }), record('m', { name: 'same' })]);
  for (const key of ['size', 'date', 'name', 'room', 'kind']) {
    for (const direction of ['asc', 'desc']) assert.deepEqual(ids(R.sort(input, `${key}-${direction}`, roomName)), ['a', 'm', 'z']);
  }
});

test('name, room and date sort in both directions without changing records', () => {
  const a = record('a', { name: 'Alpha', roomId: 'room-a', kind: 'file', createdAt: 100 });
  const b = record('b', { name: 'Beta', roomId: 'room-b', kind: 'video', createdAt: 200 });
  const input = Object.freeze([b, a]);
  for (const key of ['name', 'room', 'date']) {
    assert.deepEqual(ids(R.sort(input, `${key}-asc`, roomName)), ['a', 'b']);
    assert.deepEqual(ids(R.sort(input, `${key}-desc`, roomName)), ['b', 'a']);
  }
  assert.strictEqual(R.sort(input)[0], a);
  assert.deepEqual(ids(input), ['b', 'a']);
});

test('filters combine trimmed case-insensitive filename search, exact room, minimum bytes and selection', () => {
  const input = Object.freeze([
    record('a', { name: 'Holiday.JPG', size: 20 }),
    record('b', { name: 'holiday.png', size: 5 }),
    record('c', { name: 'HOLIDAY.jpg', roomId: 'room-b', size: 20 }),
    record('d', { name: 'holiday.jpg', size: 20 }), record('e', { name: 'work.jpg', size: 20 })
  ]);
  const selection = new Set(['a', 'b', 'c', 'e']);
  assert.deepEqual(ids(R.filter(input, { search: '  HOLIDAY  ', room: 'room:room-a', minBytes: 10, selectedOnly: true }, selection)), ['a']);
  assert.deepEqual([...selection], ['a', 'b', 'c', 'e']);
  assert.deepEqual(ids(input), ['a', 'b', 'c', 'd', 'e']);
  assert.notStrictEqual(R.filter(input), input);
  assert.equal(R.filter(input, { room: 'room' }).length, 0);
});

test('positive size filters exclude links and all unknown sizes, but zero does not', () => {
  const input = Object.freeze([record('null', { size: null }), record('link', { kind: 'link', size: 100 }),
    record('infinite', { size: Infinity }), record('zero', { size: 0 }), record('one', { size: 1 })]);
  assert.deepEqual(ids(R.filter(input, { minBytes: 0 })), ids(input));
  assert.deepEqual(ids(R.filter(input, { minBytes: 1 })), ['one']);
});

test('search matches either names or displayed room names, trimmed and case-insensitive', () => {
  const input = Object.freeze([record('a', { name: 'Daily.JPG' }), record('b', { name: 'Meeting.pdf', roomId: 'room-b' }), record('c', { name: 'daily-room.txt', roomId: null })]);
  const names = item => item.roomId === 'room-b' ? 'DAILY Team' : roomName(item);
  assert.deepEqual(ids(R.filter(input, { search: '  dAiLy  ' }, [], names)), ['a', 'b', 'c']);
  assert.deepEqual(ids(R.filter(input, { search: '가족' }, [], names)), ['a']);
  assert.deepEqual(ids(R.filter(input, { search: 'daily', room: 'room:room-b', selectedOnly: true }, new Set(['b']), names)), ['b']);
});

test('kind sorting follows displayed Korean labels rather than internal kind codes', () => {
  const input = Object.freeze(['gif', 'video', 'file', 'photo', 'link', 'recording'].map(kind => record(kind, { kind })));
  const ascending = ['video', 'link', 'photo', 'recording', 'file', 'gif'];
  assert.deepEqual(ids(R.sort(input, 'kind-asc')), ascending);
  assert.deepEqual(ids(R.sort(input, 'kind-desc')), [...ascending].reverse());
});

test('room keys preserve opaque IDs and combine missing rooms without merging by display name', () => {
  assert.equal(R.roomKey(record('a', { roomId: null })), 'unknown:');
  assert.equal(R.roomKey(record('b', { roomId: '' })), 'unknown:');
  assert.equal(R.roomKey(record('c', { roomId: 'room-a', joined: false })), 'room:room-a');
  const input = [record('a', { roomId: null }), record('b', { roomId: '' }), record('c', { roomId: 'room-b' }), record('d', { roomId: 'room-c' })];
  assert.deepEqual(ids(R.filter(input, { room: 'unknown:' })), ['a', 'b']);
  assert.equal(R.group(input, roomName).length, 3);
});

test('stats separates unknown sizes and links while counting valid zero-byte items', () => {
  const input = [record('a', { size: 10 }), record('b', { size: 2 }), record('zero', { size: 0 }),
    record('unknown', { size: null }), record('nan', { size: NaN }), record('negative', { size: -1 }),
    record('link', { kind: 'link', size: 1000 })];
  assert.deepEqual(R.stats(input), { count: 7, bytes: 12, unknownCount: 3, linkCount: 1 });
  assert.deepEqual(R.stats([]), { count: 0, bytes: 0, unknownCount: 0, linkCount: 0 });
});

test('namespaced room keys cannot collide with opaque IDs resembling unknown or prefixed keys', () => {
  const input = Object.freeze([record('missing', { roomId: null }), record('literal', { roomId: 'unknown:' }), record('prefixed', { roomId: 'room:unknown:' }), record('old', { roomId: '__unknown__' })]);
  assert.deepEqual(input.map(R.roomKey), ['unknown:', 'room:unknown:', 'room:room:unknown:', 'room:__unknown__']);
  assert.equal(R.group(input, () => '같은 표시 이름').length, 4);
  assert.deepEqual(ids(R.filter(input, { room: 'unknown:' })), ['missing']);
  assert.deepEqual(ids(R.filter(input, { room: 'room:unknown:' })), ['literal']);
  assert.equal(input[1].roomId, 'unknown:');
});

test('groups have stable name/key order, preserve passed record order and include accurate stats', () => {
  const input = Object.freeze([record('b2', { roomId: 'room-b', size: 30 }),
    record('c1', { roomId: 'room-c', kind: 'link', size: 500 }),
    record('a1', { size: 20 }), record('b1', { roomId: 'room-b', size: null }),
    record('a2', { size: 10, joined: false })]);
  const groups = R.group(input, roomName);
  assert.deepEqual(groups.map(item => item.key), ['room:room-a', 'room:room-b', 'room:room-c']);
  assert.deepEqual(groups.map(item => ids(item.records)), [['a1', 'a2'], ['b2', 'b1'], ['c1']]);
  assert.deepEqual(groups.map(({ count, bytes, unknownCount, linkCount }) => ({ count, bytes, unknownCount, linkCount })), [
    { count: 2, bytes: 30, unknownCount: 0, linkCount: 0 },
    { count: 2, bytes: 30, unknownCount: 1, linkCount: 0 },
    { count: 1, bytes: 0, unknownCount: 0, linkCount: 1 }
  ]);
  assert.equal(groups.reduce((sum, item) => sum + item.bytes, 0), R.stats(input).bytes);
  assert.deepEqual(R.group([], roomName), []);
});

test('filtered totals and group totals describe only the shown subset, without altering global selection', () => {
  const input = Object.freeze([record('a', { name: 'photo.jpg', size: 10 }),
    record('b', { name: 'document.pdf', size: 100, roomId: 'room-b' }),
    record('c', { name: 'photo.png', size: 20, roomId: 'room-b' })]);
  const selection = new Set(['a', 'b']);
  const visible = R.filter(input, { search: 'photo' }, selection);
  assert.deepEqual(R.stats(visible), { count: 2, bytes: 30, unknownCount: 0, linkCount: 0 });
  assert.equal(R.group(visible, roomName).reduce((sum, item) => sum + item.bytes, 0), 30);
  assert.deepEqual(ids(R.selected(input, selection)), ['a', 'b']);
  assert.deepEqual(R.triState(visible, selection), { checked: false, indeterminate: true, count: 1, total: 2 });
});

test('selection and tri-state handle empty, partial and full sets and ignore stale IDs', () => {
  const input = Object.freeze([record('a'), record('b')]);
  assert.deepEqual(R.triState([], new Set(['a'])), { checked: false, indeterminate: false, count: 0, total: 0 });
  assert.deepEqual(R.triState(input, []), { checked: false, indeterminate: false, count: 0, total: 2 });
  assert.deepEqual(R.triState(input, ['b', 'missing']), { checked: false, indeterminate: true, count: 1, total: 2 });
  assert.deepEqual(R.triState(input, new Set(['a', 'b', 'missing'])), { checked: true, indeterminate: false, count: 2, total: 2 });
  assert.deepEqual(ids(R.selected(input, ['b', 'a'])), ['a', 'b']);
  assert.deepEqual(R.selected(input), []);
});

test('paging clamps stale or negative indexes and keeps input intact', () => {
  const input = Object.freeze(Array.from({ length: 205 }, (_, i) => i));
  assert.deepEqual(R.page(input, 0), { items: input.slice(0, 100), index: 0, totalPages: 3 });
  assert.deepEqual(R.page(input, 999), { items: [200, 201, 202, 203, 204], index: 2, totalPages: 3 });
  assert.equal(R.page(input, -3).index, 0);
  assert.equal(R.page(input, NaN).index, 0);
  assert.equal(R.page(input, 1.9).index, 1);
  assert.deepEqual(R.page([], 999), { items: [], index: 0, totalPages: 1 });
  assert.deepEqual(R.page([1, 2, 3], 1, 2), { items: [3], index: 1, totalPages: 2 });
  for (const size of [0, -1, 0.5, NaN, Infinity]) assert.throws(() => R.page(input, 0, size), RangeError);
});
