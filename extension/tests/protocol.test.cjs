'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../protocol.js');

const CUTOFF = '2020-01-01';
const BOUND = Date.parse('2020-01-01T00:00:00+09:00');
const OLD = BOUND - 1;
const PHOTO_ID = '9223372036854775807';
const CURSOR = '9223372036854775909';
const ACCOUNT = 'opaque-account-fingerprint';
const options = (overrides = {}) => ({ cutoff: CUTOFF, includeGif: false, joined: true, ...overrides });
const photo = (overrides = {}) => ({ id: PHOTO_ID, drawerId: CURSOR, contentType: 'IMAGE', createdAt: String(OLD), mimeType: 'image/jpeg', extension: 'jpg', size: '1234', ...overrides });
const record = (overrides = {}) => ({ id: PHOTO_ID, kind: 'photo', createdAt: OLD, ...overrides });
const clone = value => JSON.parse(JSON.stringify(value));

test('LeaveChat room markers map to whole-left-room protection even without joined', () => {
  const page = P.parseRooms({ items: [{ chatType: 'LeaveChat', hashedChatId: 'aggregate-room', title: '나간 방' }] });
  assert.deepEqual(page.rooms, [{ id: P.LEFT_ROOMS, name: '나간 채팅방 전체', joined: false }]);
  assert.equal(P.normalize(photo({ chatType: 'LeaveChat', hashedChatId: 'original-room' }), CUTOFF, false, { joined: true, protectedRoomIds: [P.LEFT_ROOMS] }), null);
});

test('cutoff is strict Seoul midnight, independent of host timezone', () => {
  assert.equal(P.cutoffMs(CUTOFF), Date.UTC(2019, 11, 31, 15));
  assert.equal(P.cutoffMs('2024-02-29'), Date.UTC(2024, 1, 28, 15));
  assert.equal(P.normalize(photo(), CUTOFF, false).date, '2019-12-31');
  assert.equal(P.normalize(photo({ createdAt: BOUND }), CUTOFF, false), null);
  assert.equal(P.normalize(photo({ createdAt: BOUND + 1 }), CUTOFF, false), null);
});

test('invalid dates are rejected rather than silently normalized', () => {
  for (const value of ['', '2023-02-29', '2024-02-30', '2020-13-01', '2020-00-01', '2020-01-00', '2020-1-01', ' 2020-01-01', '2020-01-01T00:00:00Z', null]) {
    assert.throws(() => P.cutoffMs(value));
  }
});

test('opaque IDs remain exact strings, including values beyond JS safe integer', () => {
  const value = P.normalize(photo(), CUTOFF, false);
  assert.equal(value.id, PHOTO_ID);
  assert.ok(Object.isFrozen(value));
  assert.deepEqual(P.trashBody([value], CUTOFF), { trashContents: [{ id: PHOTO_ID, source: 'TALK', type: 'FILE' }] });
});

test('numeric, empty, missing and oversized IDs fail closed', () => {
  for (const id of [123, Number.MAX_SAFE_INTEGER + 10, '', '  ', null, undefined, {}, 'a'.repeat(513)]) {
    assert.throws(() => P.normalize(photo({ id }), CUTOFF, false));
    assert.throws(() => P.trashBody([record({ id })], CUTOFF));
  }
});

test('default photo selection never promotes video or unknown data based on MIME alone', () => {
  for (const contentType of ['FILE', 'MEDIA', 'image', '', undefined, null]) {
    assert.equal(P.normalize(photo({ contentType, mimeType: 'image/jpeg' }), CUTOFF, false), null);
  }
  assert.equal(P.normalize(photo({ contentType: 'VIDEO', mimeType: 'video/mp4' }), CUTOFF, false), null);
});

test('conflicting MIME and content type are excluded without aborting; dimmed files cannot be selected', () => {
  for (const mimeType of ['video/mp4', 'application/pdf', 'text/plain']) {
    assert.equal(P.normalize(photo({ mimeType }), CUTOFF, false), null);
  }
  assert.equal(P.normalize(photo({ dimmed: true }), CUTOFF, false), null);
  assert.equal(P.parsePage({ items: [photo({ dimmed: true })], hasMore: false }, options()).records.length, 0);
});

test('GIF opt-in is honored for MIME and extension variants', () => {
  for (const field of [{ mimeType: 'image/gif' }, { mimeType: 'IMAGE/GIF' }, { extension: '.GIF' }]) {
    assert.equal(P.normalize(photo(field), CUTOFF, false), null);
    assert.equal(P.normalize(photo(field), CUTOFF, true).kind, 'gif');
  }
});

test('seconds, invalid timestamps and implausibly old timestamps cannot become deletion candidates', () => {
  for (const createdAt of [OLD / 1000, 'not-a-date', null, undefined, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Date.UTC(1999, 11, 31)]) {
    assert.throws(() => P.normalize(photo({ createdAt }), CUTOFF, false));
  }
});

test('missing size does not become a guessed storage recovery estimate', () => {
  assert.equal(P.normalize(photo({ size: undefined }), CUTOFF, false).size, null);
  assert.equal(P.normalize(photo({ size: null }), CUTOFF, false).size, null);
  assert.equal(P.normalize(photo({ size: 'bad' }), CUTOFF, false).size, null);
  assert.equal(P.normalize(photo({ size: '-1' }), CUTOFF, false).size, null);
  assert.equal(P.normalize(photo({ size: '1234' }), CUTOFF, false).size, 1234);
});

test('list request exactly uses the discovered media API and preserves cursor', () => {
  const url = new URL(P.listUrl(options({ offset: CURSOR })));
  assert.equal(url.origin, 'https://drawer-api.kakao.com');
  assert.equal(url.pathname, '/v2/mediaFile/list');
  assert.deepEqual(Object.fromEntries(url.searchParams), { verticalType: 'MEDIA', fetchCount: '100', from: '0', to: String(BOUND), joined: 'true', direction: 'ASC', offset: CURSOR });
  assert.equal(new URL(P.listUrl(options({ joined: false }))).searchParams.get('joined'), 'false');
  assert.equal(new URL(P.listUrl(options())).searchParams.has('offset'), false);
  assert.throws(() => P.listUrl(options({ offset: 1234 })));
});

test('page cursor comes from last raw item.drawerId even when the last item is a video', () => {
  const page = P.parsePage({ items: [photo(), photo({ id: 'video', drawerId: 'cursor-video', contentType: 'VIDEO', mimeType: 'video/mp4' })], hasMore: true }, options());
  assert.equal(page.next, 'cursor-video');
  assert.equal(page.scanned, 2);
  assert.deepEqual(page.records.map(x => x.id), [PHOTO_ID]);
  assert.deepEqual(page.ids, [PHOTO_ID, 'video']);
});

test('empty final pages terminate and missing/numeric/repeated cursors fail closed', () => {
  assert.deepEqual(P.parsePage({ items: [], hasMore: false }, options()), { records: [], ids: [], typeMismatchIds: [], unknownRoomIds: [], ineligibleIds: [], next: null, hasMore: false, scanned: 0 });
  assert.throws(() => P.parsePage({ items: [], hasMore: true }, options()));
  assert.throws(() => P.parsePage({ items: [photo({ drawerId: 123 })], hasMore: true }, options()));
  assert.throws(() => P.parsePage({ items: [photo()], hasMore: true }, options({ offset: CURSOR })));
});

test('unexpected list response shape never yields a deletion plan', () => {
  for (const response of [null, {}, { items: [], hasMore: 'false' }, { items: {}, hasMore: false }, { items: [null], hasMore: false }]) {
    assert.throws(() => P.parsePage(response, options()));
  }
});

test('trash request is TALK/FILE and max 100 items, never a permanent-delete API', () => {
  assert.equal(P.CHUNK, 100);
  const records = Array.from({ length: 100 }, (_, i) => record({ id: String(i) }));
  const body = P.trashBody(records, CUTOFF);
  assert.equal(body.trashContents.length, 100);
  assert.ok(body.trashContents.every(x => x.source === 'TALK' && x.type === 'FILE'));
  assert.throws(() => P.trashBody([], CUTOFF));
  assert.throws(() => P.trashBody([...records, record({ id: 'extra' })], CUTOFF));
});

test('duplicate IDs and conflicting deletion records are rejected', () => {
  assert.throws(() => P.trashBody([record(), record()], CUTOFF));
  assert.throws(() => P.trashBody([record(), record({ createdAt: OLD - 1000 })], CUTOFF));
  for (const kind of ['unknown', 'IMAGE', '', null]) assert.throws(() => P.trashBody([record({ kind })], CUTOFF));
  assert.throws(() => P.trashBody([record({ createdAt: BOUND })], CUTOFF));
  assert.throws(() => P.trashBody([record({ createdAt: '123' })], CUTOFF));
});

// Bridge runs entirely in a VM with a mock fetch. No live server, login, cookies or browser access.
const bridgeSource = fs.readFileSync(path.join(__dirname, '../bridge.js'), 'utf8');
function makeBridge(handler, origin = 'https://talkcloud.kakao.com', accountReply = { fullHashedAccountId: ACCOUNT }) {
  const calls = [];
  const timers = new Map();
  let timerId = 0;
  const context = { TalkCleanerProtocol: P, location: { origin }, AbortController,
    setTimeout(fn, delay) { assert.equal(delay, 60000); const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch(url, config) {
      calls.push({ url, config });
      if (url === 'https://drawer-api.kakao.com/user/info' && accountReply !== false) return Promise.resolve(response(accountReply));
      return handler(url, config);
    }
  };
  Object.defineProperty(context, 'document', { get() { throw new Error('Document/cookie access is forbidden in this test'); } });
  vm.createContext(context);
  vm.runInContext(bridgeSource, context, { filename: 'bridge.js' });
  return { context, bridge: context.TalkCleanerBridge, calls, timers,
    timeout() { for (const fn of [...timers.values()]) fn(); }
  };
}
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

test('bridge is unavailable outside exact official origin', () => {
  const h = makeBridge(() => { throw new Error('Must not fetch'); }, 'https://talkcloud.kakao.com.attacker.invalid');
  assert.equal(h.bridge, undefined);
  assert.equal(h.calls.length, 0);
});

test('bridge read uses browser credentials with no auth extraction and blocks redirects', async () => {
  const h = makeBridge(async () => response({ items: [photo()], hasMore: false }));
  const page = await h.bridge.readPage(options());
  assert.equal(page.records.length, 1);
  assert.equal(h.calls.length, 1);
  const { config } = h.calls[0];
  assert.equal(config.credentials, 'include');
  assert.equal(config.redirect, 'error');
  assert.deepEqual(clone(config.headers), { Accept: 'application/json+javascript' });
  assert.equal(h.timers.size, 0);
});

test('bridge trash sends one POST with exact payload and does not claim per-file success', async () => {
  const h = makeBridge(async () => ({ ...response(null, 204), json: async () => { throw new Error('POST body must not be assumed'); } }));
  const result = await h.bridge.trash({ records: [record()], cutoff: CUTOFF, account: ACCOUNT });
  assert.deepEqual(clone(result), { accepted: true });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[0].url, 'https://drawer-api.kakao.com/user/info');
  assert.equal(h.calls[1].url, 'https://drawer-api.kakao.com/trashcan');
  assert.equal(h.calls[1].config.method, 'POST');
  assert.equal(h.calls[1].config.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(h.calls[1].config.body), { trashContents: [{ id: PHOTO_ID, source: 'TALK', type: 'FILE' }] });
  assert.equal(h.timers.size, 0);
});

test('invalid deletion payload is rejected before fetch', async () => {
  const h = makeBridge(async () => response(null));
  await assert.rejects(h.bridge.trash({ records: [record({ id: 42 })], cutoff: CUTOFF, account: ACCOUNT }));
  assert.equal(h.calls.length, 0);
});

test('navigation during an open manager blocks all requests', async () => {
  const h = makeBridge(async () => response(null));
  h.context.location.origin = 'https://example.invalid';
  await assert.rejects(h.bridge.readPage(options()));
  await assert.rejects(h.bridge.trash({ records: [record()], cutoff: CUTOFF, account: ACCOUNT }));
  assert.equal(h.calls.length, 0);
});

for (const status of [401, 403, 404, 409, 429, 500]) {
  test(`HTTP ${status} has one attempt, no response-body disclosure and no automatic retry`, async () => {
    let bodyRead = 0;
    const h = makeBridge(async () => ({ ...response(null, status), json: async () => { bodyRead++; return { cookie: 'private-value' }; } }));
    await assert.rejects(h.bridge.trash({ records: [record()], cutoff: CUTOFF, account: ACCOUNT }), error => {
      assert.doesNotMatch(error.message, /private-value/);
      return true;
    });
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls.filter(c => c.config.method === 'POST').length, 1);
    assert.equal(bodyRead, 0);
    assert.equal(h.timers.size, 0);
  });
}

test('POST timeout aborts, reports uncertainty and never retries', async () => {
  const h = makeBridge((_url, config) => new Promise((_resolve, reject) => {
    config.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const pending = h.bridge.trash({ records: [record()], cutoff: CUTOFF, account: ACCOUNT });
  for (let i = 0; i < 10 && h.calls.length < 2; i++) await Promise.resolve();
  assert.equal(h.calls.length, 2);
  h.timeout();
  await assert.rejects(pending, error => {
    assert.match(error.message, /확정|확인|중단/);
    return true;
  });
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].config.signal.aborted, true);
  assert.equal(h.timers.size, 0);
});

test('network rejection never retries', async () => {
  const h = makeBridge(async () => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(h.bridge.readPage(options()));
  assert.equal(h.calls.length, 1);
  assert.equal(h.timers.size, 0);
});

test('unexpected fetch error details are not exposed to the manager', async () => {
  const secret = 'cookie=UNEXPECTED_PRIVATE_VALUE';
  const h = makeBridge(async () => { throw new Error(secret); });
  await assert.rejects(h.bridge.trash({ records: [record()], cutoff: CUTOFF, account: ACCOUNT }), error => {
    assert.doesNotMatch(error.message, /UNEXPECTED_PRIVATE_VALUE/);
    return true;
  });
  assert.equal(h.calls.length, 2);
});

test('invalid JSON response details are also hidden', async () => {
  const h = makeBridge(async () => ({ ...response(null), json: async () => { throw new SyntaxError('Unexpected token private-cookie-value'); } }));
  await assert.rejects(h.bridge.readPage(options()), error => {
    assert.doesNotMatch(error.message, /private-cookie-value/);
    return true;
  });
  assert.equal(h.calls.length, 1);
});

test('account fingerprint is read only from official user/info without auth extraction', async () => {
  const h = makeBridge(async () => { throw new Error('Unexpected endpoint'); });
  assert.equal(await h.bridge.account(), ACCOUNT);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://drawer-api.kakao.com/user/info');
  assert.equal(h.calls[0].config.method, undefined);
  assert.equal(h.calls[0].config.credentials, 'include');
});

test('changed account aborts before any POST', async () => {
  const h = makeBridge(async () => { throw new Error('POST must not happen'); }, undefined, { fullHashedAccountId: 'different-account' });
  await assert.rejects(h.bridge.trash({ records: [record()], cutoff: CUTOFF, account: ACCOUNT }));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls.filter(c => c.config.method === 'POST').length, 0);
});

test('missing expected account aborts before even making a request', async () => {
  const h = makeBridge(async () => { throw new Error('Must not fetch'); });
  await assert.rejects(h.bridge.trash({ records: [record()], cutoff: CUTOFF }));
  assert.equal(h.calls.length, 0);
});

test('malformed fingerprint cannot authorize a POST', async () => {
  for (const accountReply of [null, {}, { fullHashedAccountId: null }, { fullHashedAccountId: '' }, { fullHashedAccountId: 123 }]) {
    const h = makeBridge(async () => { throw new Error('POST must not happen'); }, undefined, accountReply);
    await assert.rejects(h.bridge.trash({ records: [record()], cutoff: CUTOFF, account: ACCOUNT }));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls.filter(c => c.config.method === 'POST').length, 0);
  }
});

test('account authentication failure blocks deletion without retrying', async () => {
  const h = makeBridge(async () => response(null, 401), undefined, false);
  await assert.rejects(h.bridge.trash({ records: [record()], cutoff: CUTOFF, account: ACCOUNT }));
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls.filter(c => c.config.method === 'POST').length, 0);
});

test('MEDIA can opt into videos while default remains photos only', () => {
  const raw = photo({ id: 'video-1', contentType: 'VIDEO', mimeType: 'video/mp4', extension: 'mp4' });
  assert.equal(P.normalize(raw, CUTOFF, false), null);
  const item = P.normalize(raw, CUTOFF, false, { kinds: ['video'] });
  assert.equal(item.kind, 'video');
  assert.equal(item.verticalType, 'MEDIA');
  assert.equal(P.normalize(photo(), CUTOFF, false, { kinds: ['video'] }), null);
  assert.equal(P.normalize(raw, CUTOFF, false, { kinds: [] }), null);
});

test('contradictory VIDEO metadata is excluded when selecting videos', () => {
  for (const mimeType of ['image/jpeg', 'application/pdf', 'text/plain']) {
    assert.equal(P.normalize(photo({ contentType: 'VIDEO', mimeType }), CUTOFF, false, { kinds: ['video'] }), null);
  }
});

test('FILE request classifies ordinary files even without contentType', () => {
  const item = P.normalize(photo({ id: 'document', contentType: undefined, mimeType: 'application/pdf', originalFilename: '보고서.pdf' }), CUTOFF, false, { verticalType: 'FILE', kinds: ['file'] });
  assert.equal(item.kind, 'file');
  assert.equal(item.verticalType, 'FILE');
  assert.equal(item.name, '보고서.pdf');
  assert.equal(P.normalize(photo({ contentType: undefined }), CUTOFF, false, { verticalType: 'FILE', kinds: ['photo'] }), null);
});

test('images and videos sent as general files remain in the file category', () => {
  for (const props of [
    { contentType: 'IMAGE', mimeType: 'image/jpeg', originalFilename: 'image.jpg' },
    { contentType: 'VIDEO', mimeType: 'video/mp4', originalFilename: 'movie.mp4' },
    { contentType: 'IMAGE', mimeType: 'image/gif', originalFilename: 'animation.gif' }
  ]) {
    assert.equal(P.normalize(photo(props), CUTOFF, false, { verticalType: 'FILE', kinds: ['file'] }).kind, 'file');
  }
});

test('file name honors official originalFilename then originalFileName fallback', () => {
  const filters = { verticalType: 'FILE', kinds: ['file'] };
  assert.equal(P.normalize(photo({ originalFilename: 'first.pdf', originalFileName: 'second.pdf', name: 'unofficial.pdf' }), CUTOFF, false, filters).name, 'first.pdf');
  assert.equal(P.normalize(photo({ originalFileName: 'fallback.txt' }), CUTOFF, false, filters).name, 'fallback.txt');
  assert.equal(P.normalize(photo({ name: 'not-supported' }), CUTOFF, false, filters).name, '');
  assert.equal(P.normalize(photo({ originalFilename: 'a'.repeat(900) }), CUTOFF, false, filters).name.length, 512);
});

test('star protection permits only an explicit boolean false, preserving unknown state', () => {
  const filters = { kinds: ['photo'], protectStarred: true };
  assert.equal(P.normalize(photo({ bookmarked: false }), CUTOFF, false, filters).bookmarked, false);
  for (const bookmarked of [true, undefined, null, 0, 'false', 'true']) {
    assert.equal(P.normalize(photo({ bookmarked }), CUTOFF, false, filters), null);
  }
  assert.equal(P.normalize(photo({ bookmarked: true }), CUTOFF, false, { protectStarred: false }).bookmarked, true);
  assert.equal(P.normalize(photo({ bookmarked: undefined }), CUTOFF, false).bookmarked, null);
});

test('minimum size includes exact threshold and excludes smaller or unknown sizes', () => {
  const filters = { minBytes: 1024 };
  assert.equal(P.normalize(photo({ size: '1024' }), CUTOFF, false, filters).size, 1024);
  for (const size of [1023, 0, -1, null, undefined, 'invalid', Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(P.normalize(photo({ size }), CUTOFF, false, filters), null);
  }
  assert.equal(P.normalize(photo({ size: null, sizeHq: '9999999' }), CUTOFF, false, filters), null);
});

test('size filters do not sum original and HQ variants or guess unavailable bytes', () => {
  assert.equal(P.normalize(photo({ size: '100', sizeHq: '200' }), CUTOFF, false).size, 100);
  assert.equal(P.normalize(photo({ size: undefined, sizeHq: '200' }), CUTOFF, false).size, null);
  for (const minBytes of [-1, 0.5, '1024', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => P.normalize(photo(), CUTOFF, false, { minBytes }));
    assert.throws(() => P.trashBody([record({ size: 4096 })], CUTOFF, { minBytes }));
  }
});

test('FILE listing uses the same discovered endpoint and exact FILE vertical type', () => {
  const url = new URL(P.listUrl(options({ verticalType: 'FILE', offset: CURSOR })));
  assert.equal(url.pathname, '/v2/mediaFile/list');
  assert.equal(url.searchParams.get('verticalType'), 'FILE');
  assert.equal(url.searchParams.get('offset'), CURSOR);
  assert.throws(() => P.listUrl(options({ verticalType: 'UNKNOWN' })));
  assert.throws(() => P.normalize(photo(), CUTOFF, false, { verticalType: 'UNKNOWN' }));
});

test('parsePage applies selected kinds, protection and size filters together', () => {
  const page = P.parsePage({ items: [
    photo({ id: 'eligible', bookmarked: false, size: '2048' }),
    photo({ id: 'starred', bookmarked: true, size: '2048' }),
    photo({ id: 'unknown-star', bookmarked: undefined, size: '2048' }),
    photo({ id: 'small', bookmarked: false, size: '1' }),
    photo({ id: 'video', bookmarked: false, size: '2048', contentType: 'VIDEO', mimeType: 'video/mp4' })
  ], hasMore: false }, options({ kinds: ['photo'], protectStarred: true, minBytes: 1024 }));
  assert.deepEqual(page.records.map(item => item.id), ['eligible']);
  assert.deepEqual(page.ids, ['eligible', 'starred', 'unknown-star', 'small', 'video']);
  assert.equal(page.scanned, 5);
});

test('verification IDs preserve present items after their selection eligibility changes', () => {
  const page = P.parsePage({ items: [
    photo({ id: 'became-starred', bookmarked: true }),
    photo({ id: 'became-small', bookmarked: false, size: 1 }),
    photo({ id: 'became-dimmed', dimmed: true }),
    photo({ id: 'at-cutoff', createdAt: BOUND, bookmarked: false }),
    photo({ id: 'unknown-kind', contentType: 'UNKNOWN' })
  ], hasMore: false }, options({ kinds: ['photo'], protectStarred: true, minBytes: 1024 }));
  assert.deepEqual(page.records, []);
  assert.deepEqual(page.ids, ['became-starred', 'became-small', 'became-dimmed', 'at-cutoff', 'unknown-kind']);
  assert.equal(page.scanned, 5);
});

test('mixed photo, GIF, video and ordinary-file batches still use TALK/FILE IDs', () => {
  const kinds = ['photo', 'gif', 'video', 'file'];
  const records = kinds.map((kind, i) => record({ id: String(i), kind, bookmarked: false, size: 2048 }));
  const body = P.trashBody(records, CUTOFF, { kinds, protectStarred: true, minBytes: 1024 });
  assert.equal(body.trashContents.length, 4);
  assert.ok(body.trashContents.every(item => item.source === 'TALK' && item.type === 'FILE'));
});

test('delete validation rechecks allowed kinds, star protection and minimum size', () => {
  const filters = { kinds: ['video'], protectStarred: true, minBytes: 1024 };
  assert.doesNotThrow(() => P.trashBody([record({ kind: 'video', bookmarked: false, size: 1024 })], CUTOFF, filters));
  for (const patch of [{ kind: 'photo' }, { bookmarked: true }, { bookmarked: null }, { bookmarked: undefined }, { size: 1023 }, { size: undefined }]) {
    assert.throws(() => P.trashBody([record({ kind: 'video', bookmarked: false, size: 1024, ...patch })], CUTOFF, filters));
  }
});

test('bridge enforces expanded selection filters before account lookup or POST', async () => {
  const h = makeBridge(async () => response(null));
  await assert.rejects(h.bridge.trash({ records: [record({ kind: 'video' })], cutoff: CUTOFF, account: ACCOUNT, kinds: ['photo'] }));
  await assert.rejects(h.bridge.trash({ records: [record({ bookmarked: true })], cutoff: CUTOFF, account: ACCOUNT, protectStarred: true }));
  await assert.rejects(h.bridge.trash({ records: [record({ size: 4 })], cutoff: CUTOFF, account: ACCOUNT, minBytes: 5 }));
  assert.equal(h.calls.length, 0);
});

test('MIME case, whitespace and parameters are normalized without promoting contradictory types', () => {
  for (const mimeType of [' IMAGE/JPEG ', 'image/jpeg; charset=binary', ' Image/Jpeg ; charset=binary ']) {
    assert.equal(P.normalize(photo({ mimeType }), CUTOFF, false).kind, 'photo');
  }
  for (const mimeType of [' IMAGE/GIF ', 'image/gif; charset=binary']) {
    assert.equal(P.normalize(photo({ mimeType }), CUTOFF, false), null);
    assert.equal(P.normalize(photo({ mimeType }), CUTOFF, true).kind, 'gif');
  }
  assert.equal(P.normalize(photo({ extension: ' .GIF ' }), CUTOFF, false), null);
  assert.equal(P.normalize(photo({ contentType: 'VIDEO', mimeType: ' Video/MP4 ; codecs=avc1' }), CUTOFF, false, { kinds: ['video'] }).kind, 'video');
  assert.equal(P.normalize(photo({ mimeType: ' VIDEO/MP4 ; codecs=avc1' }), CUTOFF, true), null);
});

test('mixed valid and mismatched media preserve raw IDs and last raw cursor for verification', () => {
  const items = [
    photo({ id: 'valid' }),
    photo({ id: 'bad-photo', mimeType: 'application/octet-stream' }),
    photo({ id: 'bad-video', contentType: 'VIDEO', mimeType: 'image/jpeg', drawerId: 'last-raw-cursor' })
  ];
  const page = P.parsePage({ items, hasMore: true }, options({ kinds: ['photo', 'video'] }));
  assert.deepEqual(page.records.map(item => item.id), ['valid']);
  assert.deepEqual(page.ids, ['valid', 'bad-photo', 'bad-video']);
  assert.deepEqual(page.typeMismatchIds, ['bad-photo', 'bad-video']);
  assert.equal(page.scanned, 3);
  assert.equal(page.next, 'last-raw-cursor');
  assert.equal(page.hasMore, true);
});

test('all-mismatched pages remain traversable and expose no deletion candidates', () => {
  const page = P.parsePage({ items: [photo({ mimeType: 'application/pdf' })], hasMore: true }, options());
  assert.deepEqual(page.records, []);
  assert.deepEqual(page.ids, [PHOTO_ID]);
  assert.deepEqual(page.typeMismatchIds, [PHOTO_ID]);
  assert.equal(page.next, CURSOR);
  const final = P.parsePage({ items: [photo({ id: 'next-photo' })], hasMore: false }, options({ offset: page.next }));
  assert.deepEqual(final.records.map(item => item.id), ['next-photo']);
});

test('MIME exclusion does not swallow invalid identifiers, dates, cursors or response structure', () => {
  for (const patch of [{ id: 123 }, { createdAt: 'invalid' }, { createdAt: OLD / 1000 }]) {
    assert.throws(() => P.parsePage({ items: [photo({ mimeType: 'application/pdf', ...patch })], hasMore: false }, options()));
  }
  assert.throws(() => P.parsePage({ items: [photo({ mimeType: 'application/pdf', drawerId: null })], hasMore: true }, options()));
  assert.throws(() => P.parsePage({ items: [photo({ mimeType: 'application/pdf' })], hasMore: true }, options({ offset: CURSOR })));
  assert.throws(() => P.parsePage({ items: [null], hasMore: false }, options()));
});

test('MIME warnings apply only to media and do not reclassify ordinary FILE objects', () => {
  const page = P.parsePage({ items: [photo({ mimeType: 'application/pdf' })], hasMore: false }, options({ verticalType: 'FILE', kinds: ['file'] }));
  assert.equal(page.records[0].kind, 'file');
  assert.deepEqual(page.typeMismatchIds, []);
  const dimmed = P.parsePage({ items: [photo({ mimeType: 'video/mp4', dimmed: true })], hasMore: false }, options());
  assert.deepEqual(dimmed.records, []);
  assert.deepEqual(dimmed.typeMismatchIds, []);
  assert.deepEqual(dimmed.ids, [PHOTO_ID]);
});

test('bridge returns mismatched raw IDs without mutation requests', async () => {
  const h = makeBridge(async () => response({ items: [photo({ mimeType: 'application/octet-stream' }), photo({ id: 'safe' })], hasMore: false }));
  const page = await h.bridge.readPage(options());
  assert.deepEqual(page.records.map(item => item.id), ['safe']);
  assert.deepEqual(page.ids, [PHOTO_ID, 'safe']);
  assert.deepEqual(page.typeMismatchIds, [PHOTO_ID]);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].config.method, undefined);
});

const linkRaw = (overrides = {}) => ({ id: 'link-id', drawerId: 'link-cursor', createdAt: String(OLD), title: '참고 문서', url: 'https://example.invalid/reference', bookmarked: false, hashedChatId: 'room-link', ...overrides });
const recordingRaw = (overrides = {}) => ({ id: 'recording-id', recordingStartedAt: String(OLD), voiceSize: '2048', displayName: '회의 녹음', hashedChatId: 'room-recording', ...overrides });

test('LINK uses createdAt and title or URL, never infers bytes, and ignores a positive minimum size', () => {
  const filters = { verticalType: 'LINK', kinds: ['link'], minBytes: 10 * 1024 * 1024, protectStarred: true };
  const item = P.normalize(linkRaw({ size: '999999999', mimeType: 'text/html' }), CUTOFF, false, filters);
  assert.equal(item.kind, 'link');
  assert.equal(item.createdAt, OLD);
  assert.equal(item.name, '참고 문서');
  assert.equal(item.size, null);
  assert.equal(item.roomId, 'room-link');
  assert.equal(P.normalize(linkRaw({ title: '' }), CUTOFF, false, filters).name, 'https://example.invalid/reference');
  assert.equal(P.normalize(linkRaw({ createdAt: BOUND }), CUTOFF, false, filters), null);
  assert.equal(P.normalize(linkRaw({ bookmarked: true }), CUTOFF, false, filters), null);
  assert.equal(P.normalize(linkRaw({ bookmarked: undefined }), CUTOFF, false, filters), null);
  assert.throws(() => P.normalize(linkRaw(), CUTOFF, false, { ...filters, minBytes: -1 }));
});

test('LINK listing uses its own endpoint with exact raw cursor and strict date boundary', () => {
  const url = new URL(P.listUrl(options({ verticalType: 'LINK', offset: 'link-cursor', joined: false })));
  assert.equal(url.origin, P.ORIGIN);
  assert.equal(url.pathname, '/link/list');
  assert.deepEqual(Object.fromEntries(url.searchParams), { verticalType: 'LINK', fetchCount: '100', from: '0', to: String(BOUND), joined: 'false', direction: 'ASC', offset: 'link-cursor' });
  const page = P.parsePage({ items: [linkRaw()], hasMore: true }, options({ verticalType: 'LINK', kinds: ['link'] }));
  assert.equal(page.next, 'link-cursor');
  assert.deepEqual(page.ids, ['link-id']);
  assert.deepEqual(page.typeMismatchIds, []);
});

test('RECORDING uses recording timestamp, voice size and display name with no bookmark requirement', () => {
  const filters = { verticalType: 'RECORDING', kinds: ['recording'], protectStarred: true, minBytes: 2048 };
  const item = P.normalize(recordingRaw({ createdAt: BOUND, size: 1, originalFilename: 'wrong.txt' }), CUTOFF, false, filters);
  assert.equal(item.kind, 'recording');
  assert.equal(item.createdAt, OLD);
  assert.equal(item.date, '2019-12-31');
  assert.equal(item.size, 2048);
  assert.equal(item.name, '회의 녹음');
  assert.equal(item.bookmarked, null);
  assert.equal(P.normalize(recordingRaw({ bookmarked: true }), CUTOFF, false, filters).kind, 'recording');
  assert.equal(P.normalize(recordingRaw({ recordingStartedAt: BOUND }), CUTOFF, false, filters), null);
  assert.equal(P.normalize(recordingRaw({ voiceSize: 2047 }), CUTOFF, false, filters), null);
  assert.equal(P.normalize(recordingRaw({ voiceSize: null, size: 999999 }), CUTOFF, false, filters), null);
  assert.throws(() => P.normalize(recordingRaw({ recordingStartedAt: undefined, createdAt: OLD }), CUTOFF, false, filters));
});

test('RECORDING search starts at page 1 and progresses by integer pages without drawer IDs', () => {
  const url = new URL(P.listUrl(options({ verticalType: 'RECORDING', offset: 'ignored', joined: false })));
  assert.equal(url.pathname, '/recording/search');
  assert.deepEqual(Object.fromEntries(url.searchParams), { to: String(BOUND), pageIndex: '1', searchType: 'TIME' });
  const page = P.parsePage({ items: [recordingRaw()], hasMore: true }, options({ verticalType: 'RECORDING', kinds: ['recording'] }));
  assert.equal(page.next, 2);
  assert.equal(typeof page.next, 'number');
  assert.equal(new URL(P.listUrl(options({ verticalType: 'RECORDING', pageIndex: page.next }))).searchParams.get('pageIndex'), '2');
  const last = P.parsePage({ items: [], hasMore: false }, options({ verticalType: 'RECORDING', pageIndex: 2 }));
  assert.equal(last.next, null);
  assert.throws(() => P.parsePage({ items: [], hasMore: true }, options({ verticalType: 'RECORDING' })));
  for (const pageIndex of [0, -1, 1.5, '2', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => P.listUrl(options({ verticalType: 'RECORDING', pageIndex })));
    assert.throws(() => P.parsePage({ items: [], hasMore: false }, options({ verticalType: 'RECORDING', pageIndex })));
  }
});

test('all six kinds use their correct trash types while keeping TALK as source', () => {
  const kinds = ['photo', 'gif', 'video', 'file', 'link', 'recording'];
  const records = kinds.map((kind, index) => record({ id: String(index), kind, bookmarked: kind === 'recording' ? null : false, size: kind === 'link' ? null : 2048 }));
  const body = P.trashBody(records, CUTOFF, { kinds, protectStarred: true, minBytes: 1024 });
  assert.deepEqual(body.trashContents.map(item => item.type), ['FILE', 'FILE', 'FILE', 'FILE', 'LINK', 'RECORDING']);
  assert.ok(body.trashContents.every(item => item.source === 'TALK'));
  assert.throws(() => P.trashBody([record({ kind: 'link', bookmarked: true })], CUTOFF, { protectStarred: true }));
  assert.throws(() => P.trashBody([record({ kind: 'recording', size: 1 })], CUTOFF, { minBytes: 1024 }));
  assert.throws(() => P.trashBody([record({ kind: 'link' })], CUTOFF, { kinds: ['file'] }));
});

test('protected file IDs and room IDs exclude records and are rechecked before deletion', () => {
  const filters = { kinds: ['photo'], protectedFileIds: ['keep-file'], protectedRoomIds: ['keep-room'] };
  for (const patch of [{ id: 'keep-file', hashedChatId: 'other-room' }, { id: 'other-file', hashedChatId: 'keep-room' }, { id: 'other-file', hashedChatId: null }]) {
    assert.equal(P.normalize(photo(patch), CUTOFF, false, filters), null);
    assert.throws(() => P.trashBody([record({ id: patch.id, roomId: patch.hashedChatId })], CUTOFF, filters));
  }
  const allowed = P.normalize(photo({ id: 'other-file', hashedChatId: 'other-room' }), CUTOFF, false, filters);
  assert.equal(allowed.roomId, 'other-room');
  assert.doesNotThrow(() => P.trashBody([allowed], CUTOFF, filters));
  assert.notEqual(P.normalize(photo({ hashedChatId: null }), CUTOFF, false, { protectedRoomIds: [] }), null);
});

test('unknown room IDs stay available for warnings and verification while safe room records remain selectable', () => {
  const items = [photo({ id: 'allowed', hashedChatId: 'other-room' }), photo({ id: 'protected', hashedChatId: 'keep-room' })];
  for (const [index, hashedChatId] of [undefined, null, '', ' ', 123, 'x'.repeat(513)].entries()) {
    items.push(photo({ id: `unknown-${index}`, hashedChatId }));
  }
  const page = P.parsePage({ items, hasMore: false }, options({ protectedRoomIds: ['keep-room'] }));
  assert.deepEqual(page.records.map(item => item.id), ['allowed']);
  assert.deepEqual(page.unknownRoomIds, items.slice(2).map(item => item.id));
  assert.deepEqual(page.ids, items.map(item => item.id));
  assert.equal(page.scanned, 8);
  const unprotected = P.parsePage({ items: [photo()], hasMore: false }, options());
  assert.deepEqual(unprotected.unknownRoomIds, []);
  assert.equal(unprotected.records.length, 1);
});

test('room and file protection also cover LINK and RECORDING irrespective of bookmark policy', () => {
  for (const [verticalType, kind, raw] of [['LINK', 'link', linkRaw()], ['RECORDING', 'recording', recordingRaw()]]) {
    const filters = { verticalType, kinds: [kind], protectStarred: true, protectedRoomIds: [raw.hashedChatId] };
    assert.equal(P.normalize(raw, CUTOFF, false, filters), null);
    assert.equal(P.normalize(raw, CUTOFF, false, { ...filters, protectedRoomIds: [], protectedFileIds: [raw.id] }), null);
    assert.equal(P.normalize({ ...raw, hashedChatId: undefined }, CUTOFF, false, filters), null);
    assert.throws(() => P.trashBody([record({ id: raw.id, kind, bookmarked: false, roomId: raw.hashedChatId })], CUTOFF, filters));
  }
});

test('room lists preserve opaque IDs, titles and joined state while counting unidentifiable rows', () => {
  const data = { items: [
    { hashedChatId: PHOTO_ID, title: '보호할 방', joined: true },
    { hashedChatId: 'left-room', title: '', joined: false },
    { hashedChatId: 'long-title', title: 'x'.repeat(600) },
    null, {}, { hashedChatId: 123 }, { hashedChatId: ' ' }, { hashedChatId: 'x'.repeat(513) }
  ] };
  const result = P.parseRooms(data);
  assert.equal(result.skipped, 5);
  assert.equal(result.rooms.length, 3);
  assert.deepEqual(result.rooms[0], { id: PHOTO_ID, name: '보호할 방', joined: true });
  assert.deepEqual(result.rooms[1], { id: P.LEFT_ROOMS, name: '나간 채팅방 전체', joined: false });
  assert.equal(result.rooms[2].name.length, 512);
  for (const value of [null, {}, { items: null }, { items: {} }]) assert.throws(() => P.parseRooms(value));
  assert.deepEqual(P.parseRooms({ items: [] }), { rooms: [], skipped: 0 });
});

test('room list endpoint supports every supported vertical and rejects unknown values', () => {
  for (const verticalType of ['MEDIA', 'FILE', 'LINK', 'RECORDING']) {
    const url = new URL(P.roomsUrl(verticalType));
    assert.equal(url.origin, P.ORIGIN);
    assert.equal(url.pathname, '/chat/list');
    assert.deepEqual(Object.fromEntries(url.searchParams), { verticalType });
  }
  for (const verticalType of ['', undefined, null, 'UNKNOWN']) assert.throws(() => P.roomsUrl(verticalType));
});

test('bridge readRooms uses credentialed GET and returns parsed room warnings without mutation', async () => {
  const h = makeBridge(async () => response({ items: [{ hashedChatId: 'room', title: '채팅방', joined: true }, null] }));
  const result = await h.bridge.readRooms({ verticalType: 'LINK' });
  assert.deepEqual(clone(result), { rooms: [{ id: 'room', name: '채팅방', joined: true }], skipped: 1 });
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, 'https://drawer-api.kakao.com/chat/list?verticalType=LINK');
  assert.equal(h.calls[0].config.method, undefined);
  assert.equal(h.calls[0].config.credentials, 'include');
  assert.equal(h.calls[0].config.redirect, 'error');
  assert.equal(h.timers.size, 0);
  await assert.rejects(h.bridge.readRooms({ verticalType: 'UNKNOWN' }));
  assert.equal(h.calls.length, 1);
  h.context.location.origin = 'https://example.invalid';
  await assert.rejects(h.bridge.readRooms({ verticalType: 'MEDIA' }));
  assert.equal(h.calls.length, 1);
});

test('bridge protected records are rejected before account lookup and LINK/RECORDING requests keep exact types', async () => {
  const h = makeBridge(async () => response(null, 204));
  await assert.rejects(h.bridge.trash({ records: [record({ id: 'protected', roomId: 'room' })], cutoff: CUTOFF, account: ACCOUNT, protectedFileIds: ['protected'] }));
  await assert.rejects(h.bridge.trash({ records: [record({ roomId: null })], cutoff: CUTOFF, account: ACCOUNT, protectedRoomIds: ['room'] }));
  assert.equal(h.calls.length, 0);
  await h.bridge.trash({ records: [record({ id: 'link', kind: 'link', bookmarked: false }), record({ id: 'recording', kind: 'recording', size: 4096 })], cutoff: CUTOFF, account: ACCOUNT, kinds: ['link', 'recording'], protectStarred: true, minBytes: 1024 });
  assert.equal(h.calls.length, 2);
  assert.deepEqual(JSON.parse(h.calls[1].config.body), { trashContents: [{ id: 'link', source: 'TALK', type: 'LINK' }, { id: 'recording', source: 'TALK', type: 'RECORDING' }] });
});

test('left-room protection covers aggregate rooms, arbitrary old hashes and recordings with unknown membership', () => {
  assert.equal(P.LEFT_ROOMS, '__talkcloud_all_left_rooms__');
  for (const raw of [{ joined: false }, { joined: false, hashedChatId: 'old-room-a', title: '기존 방' }, { joined: false, hashedChatId: 'old-room-b' }]) {
    assert.deepEqual(P.parseRooms({ items: [raw] }), { rooms: [{ id: P.LEFT_ROOMS, name: '나간 채팅방 전체', joined: false }], skipped: 0 });
  }
  const protection = { protectedRoomIds: [P.LEFT_ROOMS] };
  for (const [verticalType, kind, base] of [['MEDIA', 'photo', photo()], ['FILE', 'file', photo()], ['LINK', 'link', linkRaw()]]) {
    const filters = { ...protection, verticalType, kinds: [kind], joined: true };
    assert.equal(P.normalize({ ...base, hashedChatId: 'arbitrary-old-hash', joined: false }, CUTOFF, false, filters), null);
    assert.equal(P.normalize({ ...base, hashedChatId: 'different-old-hash', joined: undefined }, CUTOFF, false, { ...filters, joined: false }), null);
    const joined = P.normalize({ ...base, hashedChatId: undefined, joined: undefined }, CUTOFF, false, filters);
    assert.equal(joined.joined, true, 'non-recording query membership establishes that the room is still joined');
    assert.doesNotThrow(() => P.trashBody([joined], CUTOFF, filters));
    assert.throws(() => P.trashBody([record({ kind, roomId: 'any-original-hash', joined: false })], CUTOFF, filters));
  }
  const recordingOptions = options({ ...protection, verticalType: 'RECORDING', kinds: ['recording'], joined: true });
  const items = [
    recordingRaw({ id: 'unknown', hashedChatId: 'known-hash-but-unknown-membership' }),
    recordingRaw({ id: 'left', hashedChatId: 'another-hash', joined: false }),
    recordingRaw({ id: 'still-joined', joined: true })
  ];
  const page = P.parsePage({ items, hasMore: false }, recordingOptions);
  assert.deepEqual(page.records.map(item => item.id), ['still-joined']);
  assert.deepEqual(page.unknownRoomIds, ['unknown']);
  assert.deepEqual(page.ineligibleIds, ['unknown', 'left']);
  assert.deepEqual(page.ids, ['unknown', 'left', 'still-joined']);
  assert.throws(() => P.trashBody([record({ kind: 'recording', roomId: 'known-hash', joined: null })], CUTOFF, protection));
  assert.throws(() => P.trashBody([record({ kind: 'recording', roomId: 'known-hash' })], CUTOFF, protection));
});

test('every normalization rejection preserves its raw ID for cross-page eligibility and completion checks', () => {
  const items = [
    photo({ id: 'eligible', bookmarked: false, size: 2048, hashedChatId: 'safe-room' }),
    photo({ id: 'mime-conflict', mimeType: 'application/pdf', bookmarked: false }),
    photo({ id: 'starred', bookmarked: true }),
    photo({ id: 'unknown-star', bookmarked: undefined }),
    photo({ id: 'too-small', bookmarked: false, size: 1, hashedChatId: 'safe-room' }),
    photo({ id: 'at-cutoff', createdAt: BOUND, bookmarked: false }),
    photo({ id: 'dimmed', dimmed: true }),
    photo({ id: 'unselected-kind', contentType: 'VIDEO', mimeType: 'video/mp4' }),
    photo({ id: 'unknown-kind', contentType: 'UNKNOWN' }),
    photo({ id: 'protected-file', bookmarked: false, hashedChatId: 'safe-room' }),
    photo({ id: 'protected-room', bookmarked: false, hashedChatId: 'keep-room' }),
    photo({ id: 'unknown-room', bookmarked: false, drawerId: 'last-ineligible-cursor' })
  ];
  const filter = options({ kinds: ['photo'], minBytes: 1024, protectStarred: true, protectedFileIds: ['protected-file'], protectedRoomIds: ['keep-room'] });
  const page = P.parsePage({ items, hasMore: true }, filter);
  assert.deepEqual(page.records.map(item => item.id), ['eligible']);
  assert.deepEqual(page.ineligibleIds, items.slice(1).map(item => item.id));
  assert.deepEqual(page.ids, items.map(item => item.id));
  assert.equal(page.next, 'last-ineligible-cursor');
  assert.equal(page.scanned, items.length);
  const formerlyEligible = P.parsePage({ items: [photo({ id: 'eligible', bookmarked: true })], hasMore: false }, filter);
  assert.deepEqual(formerlyEligible.records, []);
  assert.deepEqual(formerlyEligible.ineligibleIds, ['eligible']);
  assert.deepEqual(formerlyEligible.ids, ['eligible']);
});
