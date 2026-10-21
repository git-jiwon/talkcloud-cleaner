'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../protocol.js');

// All responses are synthetic. No browser profiles, cookies, account data or server access.
const source = fs.readFileSync(path.join(__dirname, '../bridge.js'), 'utf8');
const accountId = 'synthetic-account';
const accountUrl = `${P.ORIGIN}/user/info`;
const criteria = { cutoff: '2020-01-01', kinds: ['photo', 'gif'], protectStarred: true, account: accountId };
const photo = (overrides = {}) => ({ id: '9223372036854775807', createdAt: '1546300800000',
  contentType: 'IMAGE', mimeType: 'image/jpeg', extension: 'jpg', size: '1234',
  bookmarked: false, hashedChatId: 'synthetic-room', joined: true, originalFilename: '사진.jpg',
  url: 'https://dn.talk.kakao.com/photo.jpg?signature=synthetic-private-value', ...overrides });
const record = raw => P.normalize(raw, criteria.cutoff, true, criteria);
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function bridgeWith({ detail = photo(), accounts = [accountId, accountId], detailHandler } = {}) {
  const calls = [];
  const timers = new Set();
  let accountIndex = 0;
  const context = { TalkCleanerProtocol: P, location: { origin: 'https://talkcloud.kakao.com' }, AbortController,
    setTimeout(fn, delay) { assert.equal(delay, 60000); timers.add(fn); return fn; },
    clearTimeout(timer) { timers.delete(timer); },
    async fetch(url, config) {
      calls.push({ url, config });
      if (url === accountUrl) return response({ fullHashedAccountId: accounts[accountIndex++] });
      assert.ok(url.startsWith(`${P.ORIGIN}/v2/mediaFile/`), `Unexpected request: ${url}`);
      return detailHandler ? detailHandler(url, config, context) : response(detail);
    }
  };
  Object.defineProperty(context, 'document', { get() { throw new Error('Document/cookie access is forbidden'); } });
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'bridge.js' });
  return { api: context.TalkCleanerBridge, calls, timers, context };
}

function assertReadOnly(h) {
  for (const { url, config } of h.calls) {
    assert.equal(config.method, undefined);
    assert.equal(config.body, undefined);
    assert.equal(config.credentials, 'include');
    assert.equal(config.redirect, 'error');
    assert.equal(config.headers.Accept, 'application/json+javascript');
    assert.equal(config.headers.Authorization, undefined);
    assert.equal(config.headers.Cookie, undefined);
    assert.equal(new URL(url).origin, P.ORIGIN);
    assert.doesNotMatch(url, /trashcan|\/download\/|signature=/);
  }
  assert.equal(h.timers.size, 0);
}

test('originalPhoto checks account before and after detail and only returns a validated media URL', async () => {
  const raw = photo();
  const h = bridgeWith({ detail: raw });
  const result = await h.api.originalPhoto({ record: record(raw), criteria });
  assert.deepEqual(result, { id: raw.id, url: raw.url, size: 1234, name: '사진.jpg' });
  assert.deepEqual(h.calls.map(c => c.url), [accountUrl, P.photoDetailUrl(record(raw)), accountUrl]);
  assertReadOnly(h);
});

test('originalPhoto preserves an opaque ID as one encoded endpoint segment', async () => {
  const raw = photo({ id: '../photo?token=#fragment' });
  const h = bridgeWith({ detail: raw });
  assert.equal((await h.api.originalPhoto({ record: record(raw), criteria })).id, raw.id);
  assert.equal(h.calls[1].url, `${P.ORIGIN}/v2/mediaFile/..%2Fphoto%3Ftoken%3D%23fragment`);
  assertReadOnly(h);
});

test('missing expected account stops originalPhoto without making any request', async () => {
  for (const options of [undefined, {}, { record: record(photo()), criteria: { ...criteria, account: '' } }]) {
    const h = bridgeWith();
    await assert.rejects(h.api.originalPhoto(options), /계정/);
    assert.equal(h.calls.length, 0);
    assertReadOnly(h);
  }
});

test('account mismatch before detail prevents requesting or returning a download URL', async () => {
  const h = bridgeWith({ accounts: ['other-account'] });
  await assert.rejects(h.api.originalPhoto({ record: record(photo()), criteria }), error => {
    assert.match(error.message, /계정/);
    assert.doesNotMatch(error.message, /signature|synthetic-private-value/);
    return true;
  });
  assert.deepEqual(h.calls.map(c => c.url), [accountUrl]);
  assertReadOnly(h);
});

test('account mismatch after detail discards the retrieved URL', async () => {
  const h = bridgeWith({ accounts: [accountId, 'other-account'] });
  let returned = false;
  await assert.rejects(h.api.originalPhoto({ record: record(photo()), criteria }).then(value => {
    returned = true;
    return value;
  }), error => {
    assert.match(error.message, /계정/);
    assert.doesNotMatch(error.message, /signature|synthetic-private-value/);
    return true;
  });
  assert.equal(returned, false);
  assert.equal(h.calls.length, 3);
  assertReadOnly(h);
});

test('changed detail or newly protected selection cannot return a media URL', async () => {
  for (const [detail, activeCriteria] of [[photo({ id: 'different' }), criteria],
    [photo({ bookmarked: true }), criteria], [photo({ size: '1235' }), criteria],
    [photo(), { ...criteria, protectedFileIds: [photo().id] }]]) {
    const h = bridgeWith({ detail });
    await assert.rejects(h.api.originalPhoto({ record: record(photo()), criteria: activeCriteria }));
    assert.equal(h.calls.length, 2);
    assertReadOnly(h);
  }
});

test('detail HTTP and network failures never retry or leak private response information', async () => {
  for (const handler of [() => response({ url: photo().url }, 403), () => response({ url: photo().url }, 429),
    () => { throw new Error(photo().url); }]) {
    const h = bridgeWith({ detailHandler: handler });
    await assert.rejects(h.api.originalPhoto({ record: record(photo()), criteria }), error => {
      assert.doesNotMatch(error.message, /signature|synthetic-private-value/);
      return true;
    });
    assert.equal(h.calls.length, 2);
    assertReadOnly(h);
  }
});

test('navigation away while fetching detail prevents post-detail account check and URL release', async () => {
  const h = bridgeWith({ detailHandler: (_url, _config, context) => {
    context.location.origin = 'https://unrelated.example';
    return response(photo());
  } });
  await assert.rejects(h.api.originalPhoto({ record: record(photo()), criteria }), /이동/);
  assert.equal(h.calls.length, 2);
  assertReadOnly(h);
});

const fileCriteria = { ...criteria, kinds: ['photo', 'gif', 'video', 'file'] };
const videoDetail = () => photo({ contentType: 'VIDEO', mimeType: 'video/mp4', originalFilename: '영상.mp4',
  urlHq: 'https://media.kakaocdn.net/video.mp4?signature=synthetic-private-value' });
const fileDetail = () => photo({ contentType: 'FILE', mimeType: 'application/pdf', originalFilename: '문서.pdf',
  url: 'https://dn.talk.kakao.com/document.pdf?signature=synthetic-private-value' });
const generalRecord = (raw, verticalType = 'MEDIA') => P.normalize(raw, criteria.cutoff, true, { ...fileCriteria, verticalType });

test('originalFile uses the shared detail route for videos and documents with account checks around it', async () => {
  for (const [raw, verticalType, kind] of [[videoDetail(), 'MEDIA', 'video'], [fileDetail(), 'FILE', 'file']]) {
    const selected = generalRecord(raw, verticalType), h = bridgeWith({ detail: raw });
    const result = await h.api.originalFile({ record: selected, criteria: fileCriteria });
    assert.equal(result.kind, kind);
    assert.equal(result.name, raw.originalFilename);
    assert.equal(result.mimeType, raw.mimeType);
    assert.equal(result.url, kind === 'video' ? raw.urlHq : raw.url);
    assert.deepEqual(h.calls.map(call => call.url), [accountUrl, P.detailUrl(selected), accountUrl]);
    assertReadOnly(h);
  }
});

test('originalFile refuses voice-call recordings and links before requesting account or file data', async () => {
  for (const [kind, verticalType] of [['recording', 'RECORDING'], ['link', 'LINK']]) {
    const h = bridgeWith();
    await assert.rejects(h.api.originalFile({ record: { ...record(photo()), kind, verticalType }, criteria: fileCriteria }),
      kind === 'recording' ? /모바일 앱/ : /다운로드 대상/);
    assert.equal(h.calls.length, 0);
  }
});

test('originalFile releases no document URL when the account changes or current protection blocks it', async () => {
  const raw = fileDetail(), selected = generalRecord(raw, 'FILE');
  const changed = bridgeWith({ detail: raw, accounts: [accountId, 'different-account'] });
  await assert.rejects(changed.api.originalFile({ record: selected, criteria: fileCriteria }), /계정/);
  assert.equal(changed.calls.length, 3);
  assertReadOnly(changed);
  const protectedItem = bridgeWith({ detail: raw });
  await assert.rejects(protectedItem.api.originalFile({ record: selected, criteria: { ...fileCriteria, protectedFileIds: [selected.id] } }));
  assert.equal(protectedItem.calls.length, 2);
  assertReadOnly(protectedItem);
});
