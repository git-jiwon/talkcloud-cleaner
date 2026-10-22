'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('../protocol.js');
const V = require('../preview.js');

const criteria = { cutoff: '2020-01-01', kinds: ['photo', 'gif'], protectStarred: true };
const photo = (overrides = {}) => ({ id: 'synthetic-photo', createdAt: '1546300800000', contentType: 'IMAGE',
  mimeType: 'image/jpeg', extension: 'jpg', size: '1234', bookmarked: false,
  hashedChatId: 'synthetic-room', joined: true, originalFilename: '사진.jpg',
  thumbnailUrl: 'https://dn.talk.kakao.com/small.jpg?' + 'signature=synthetic%2Bvalue',
  url: 'https://dn.talk.kakao.com/original.jpg', urlHq: 'https://dn.talk.kakao.com/large.jpg', ...overrides });
const selected = raw => P.normalize(raw, criteria.cutoff, true, criteria);
const parsed = raw => P.parsePhotoPreview(raw, selected(raw), criteria);

test('only MEDIA photos and GIFs offer preview controls', () => {
  assert.equal(V.eligible(selected(photo())), true);
  assert.equal(V.eligible(selected(photo({ mimeType: 'image/gif', extension: 'gif' }))), true);
  for (const record of [null, undefined, {}, { kind: 'photo', verticalType: 'FILE' },
    ...['video', 'file', 'link', 'recording'].map(kind => ({ kind, verticalType: 'MEDIA' }))])
    assert.equal(V.eligible(record), false);
});

test('preview uses the official thumbnail without replacing signed queries or loading originals', () => {
  const raw = photo({ size: String(20 * 1024 ** 3), urlHq: 'https://untrusted.example/huge.jpg',
    ownerHashedAccountId: 'synthetic-private-account', arbitrary: 'synthetic-private-data' });
  const result = parsed(raw);
  assert.deepEqual(result, { id: raw.id, url: raw.thumbnailUrl, name: '사진.jpg', kind: 'photo', source: 'thumbnail' });
  assert.ok(Object.isFrozen(result));
  assert.equal(V.validateResult(result, selected(raw)).url, raw.thumbnailUrl);
  assert.doesNotMatch(JSON.stringify(result), /ownerHashedAccountId|arbitrary|original\.jpg|large\.jpg|untrusted/);
});

test('missing thumbnail never falls back to a full original or a guessed conversion URL', () => {
  for (const thumbnailUrl of [null, undefined, '', ' ', {}, 1])
    assert.throws(() => parsed(photo({ thumbnailUrl })), /미리보기/);
});

test('preview does not require an original download URL', () => {
  const raw = photo({ url: null, urlHq: null, urlNormal: null });
  assert.equal(parsed(raw).url, raw.thumbnailUrl);
});

test('GIF and HEIC photos can use their official static thumbnails', () => {
  for (const [mimeType, extension, kind] of [['image/gif', 'gif', 'gif'], ['image/heic', 'heic', 'photo']]) {
    const raw = photo({ mimeType, extension });
    const result = parsed(raw);
    assert.equal(result.kind, kind);
    assert.equal(result.source, 'thumbnail');
    assert.equal(result.url, raw.thumbnailUrl);
  }
});

test('SVG, HTML, unknown and missing image MIME values cannot be previewed', () => {
  for (const mimeType of ['image/svg+xml', 'image/svg', 'text/html', 'application/xhtml+xml', 'image/unknown', '', undefined])
    assert.throws(() => P.parsePhotoPreview(photo({ mimeType }), selected(photo()), criteria));
});

test('preview verifies identity, date, size, type, room and bookmark metadata again', () => {
  for (const change of [{ id: 'other' }, { createdAt: '1546300800001' }, { size: '1235' },
    { size: null }, { contentType: 'VIDEO' }, { mimeType: 'image/gif', extension: 'gif' },
    { bookmarked: true }, { bookmarked: undefined }, { hashedChatId: 'other-room' },
    { joined: false }, { dimmed: true }, { expired: true }, { isExpired: true }, { verticalType: 'FILE' }])
    assert.throws(() => P.parsePhotoPreview(photo(change), selected(photo()), criteria), JSON.stringify(change));
});

test('current protections and narrowed date/type/size conditions apply before preview release', () => {
  const raw = photo(), record = selected(raw);
  for (const change of [{ protectedFileIds: [record.id] }, { protectedRoomIds: [record.roomId] },
    { kinds: ['gif'] }, { cutoff: '2018-01-01' }, { minBytes: 2000 }])
    assert.throws(() => P.parsePhotoPreview(raw, record, { ...criteria, ...change }));
  const left = photo({ joined: false });
  assert.throws(() => P.parsePhotoPreview(left, selected(left), { ...criteria, protectedRoomIds: [P.LEFT_ROOMS] }));
});

test('both preview trust boundaries reject unsafe schemes, hostnames, credentials, ports, fragments and active extensions', () => {
  const urls = ['http://dn.talk.kakao.com/a.jpg', 'data:image/png;base64,AA', 'javascript:alert(1)',
    'https://kakao.com.evil.example/a.jpg', 'https://notkakao.com/a.jpg',
    'https://kakaocdn.net.evil.example/a.jpg', 'https://other.example/a.jpg',
    'https://user:secret' + '@dn.talk.kakao.com/a.jpg', 'https://dn.talk.kakao.com:8443/a.jpg',
    'https://dn.talk.kakao.com/a.jpg#secret', ' https://dn.talk.kakao.com/a.jpg',
    'https://dn.talk.kakao.com/a.jpg\n', 'https://dn.talk.kakao.com./a.jpg',
    'https:\\dn.talk.kakao.com/a.jpg', 'https://dn.talk.kakao.com/a.svg',
    'https://dn.talk.kakao.com/a.%73vg', 'https://dn.talk.kakao.com/a.SVGZ',
    'https://dn.talk.kakao.com/a.html', 'https://dn.talk.kakao.com/a.xhtml',
    'https://dn.talk.kakao.com/a.xml', 'https://dn.talk.kakao.com/%malformed'];
  for (const url of urls) {
    assert.throws(() => V.validateUrl(url), url);
    assert.throws(() => parsed(photo({ thumbnailUrl: url })), url);
  }
});

test('official HTTPS hosts and a default HTTPS port preserve opaque signed query strings', () => {
  for (const url of ['https://media.kakaocdn.net/small.jpg?' + 'signature=a%2Bb%3D&part=1&part=2',
    'https://dn.talk.kakao.com:443/small.jpg?' + 'signature=synthetic', 'https://t1.kakaocdn.net/image']) {
    assert.equal(V.validateUrl(url), url);
    assert.equal(parsed(photo({ thumbnailUrl: url })).url, url);
  }
});

test('manager boundary binds preview to the requested photo and omits extra response fields', () => {
  const raw = photo(), record = selected(raw), result = parsed(raw);
  for (const change of [{ id: 'other' }, { kind: 'gif' }, { source: 'original' },
    { source: undefined }, { name: {} }, { name: 'a'.repeat(513) }, { url: 'https://evil.example/a.jpg' }])
    assert.throws(() => V.validateResult({ ...result, ...change }, record));
  for (const id of [undefined, null, 123, '', ' ', 'a'.repeat(513)])
    assert.throws(() => V.validateResult({ ...result, id }, { ...record, id }));
  const clean = V.validateResult({ ...result, account: 'synthetic-private', internalMetadata: {} }, record);
  assert.deepEqual(clean, result);
  assert.ok(Object.isFrozen(clean));
  assert.doesNotMatch(JSON.stringify(clean), /account|internalMetadata/);
});

test('preview module is usable in a browser and never accesses storage, DOM or network', () => {
  const context = { URL };
  for (const key of ['localStorage', 'sessionStorage', 'document', 'fetch', 'chrome'])
    Object.defineProperty(context, key, { get() { throw new Error(`Forbidden access: ${key}`); } });
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../preview.js'), 'utf8'), context);
  const record = selected(photo());
  assert.equal(context.TalkCleanerPreview.eligible(record), true);
  assert.equal(context.TalkCleanerPreview.validateResult(parsed(photo()), record).url, photo().thumbnailUrl);
});
