'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../protocol.js');

const criteria = { cutoff: '2020-01-01', kinds: ['photo', 'gif'], protectStarred: true };
const photo = (overrides = {}) => ({ id: 'photo-1', createdAt: '1546300800000', contentType: 'IMAGE',
  mimeType: 'image/jpeg', extension: 'jpg', size: '1234', bookmarked: false,
  hashedChatId: 'room-1', joined: true, originalFilename: '사진.jpg',
  url: 'https://dn.talk.kakao.com/photo.jpg?token=a%2Bb&other=x%3Dy', ...overrides });
const selected = (raw = photo()) => P.normalize(raw, criteria.cutoff, true, criteria);

test('photo detail URL accepts selected MEDIA images and encodes the complete opaque ID', () => {
  assert.equal(P.photoDetailUrl(selected()), `${P.ORIGIN}/v2/mediaFile/photo-1`);
  const record = { ...selected(), id: '../other?x=#fragment' };
  assert.equal(P.photoDetailUrl(record), `${P.ORIGIN}/v2/mediaFile/..%2Fother%3Fx%3D%23fragment`);
  for (const id of ['.', '..', '', 123, null]) assert.throws(() => P.photoDetailUrl({ ...record, id }));
  for (const override of [{ kind: 'video' }, { kind: 'file' }, { verticalType: 'FILE' }, { verticalType: 'LINK' }])
    assert.throws(() => P.photoDetailUrl({ ...selected(), ...override }));
});

test('original photo uses the official URL priority and preserves its signed query exactly', () => {
  const urlHq = 'https://media.kakaocdn.net/high.jpg?token=ab%2B%3D&part=1&part=2';
  const raw = photo({ urlHq, urlNormal: 'https://dn.talk.kakao.com/normal.jpg' });
  const result = P.parseOriginalPhoto(raw, selected(), criteria);
  assert.deepEqual(result, { id: raw.id, url: urlHq, size: 1234, name: '사진.jpg' });
  assert.ok(Object.isFrozen(result));
  assert.equal(P.parseOriginalPhoto({ ...raw, urlHq: '' }, selected(), criteria).url, raw.urlNormal);
  assert.equal(P.parseOriginalPhoto({ ...raw, urlHq: {}, urlNormal: ' ' }, selected(), criteria).url, raw.url);
});

test('thumbnail-only records do not become original downloads', () => {
  assert.throws(() => P.parseOriginalPhoto(photo({ url: null, thumbnailUrl: 'https://dn.talk.kakao.com/thumbnail.jpg' }), selected(), criteria), /저장 주소/);
});

test('download detail rejects changed identity, timestamp, kind, size and protection metadata', () => {
  for (const override of [{ id: 'different' }, { createdAt: '1546300800001' }, { size: '1235' },
    { size: null }, { mimeType: 'image/gif', extension: 'gif' }, { bookmarked: true },
    { bookmarked: undefined }, { hashedChatId: 'different-room' }, { hashedChatId: null },
    { joined: false }, { chatType: 'LeaveChat' }]) {
    assert.throws(() => P.parseOriginalPhoto(photo(override), selected(), criteria), JSON.stringify(override));
  }
});

test('download detail rejects unavailable or non-image files and current protected entries', () => {
  for (const override of [{ dimmed: true }, { expired: true }, { isExpired: true },
    { contentType: 'VIDEO', mimeType: 'video/mp4' }, { contentType: 'FILE' }, { mimeType: 'text/html' }])
    assert.throws(() => P.parseOriginalPhoto(photo(override), selected(), criteria));
  assert.throws(() => P.parseOriginalPhoto(photo(), selected(), { ...criteria, protectedFileIds: ['photo-1'] }));
  assert.throws(() => P.parseOriginalPhoto(photo(), selected(), { ...criteria, protectedRoomIds: ['room-1'] }));
  assert.throws(() => P.parseOriginalPhoto(photo(), selected(), { ...criteria, kinds: ['gif'] }));
});

test('download URL boundary rejects unsafe schemes, credentials, ports and lookalike hosts', () => {
  for (const url of ['http://dn.talk.kakao.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AA',
    'https://kakao.com.evil.example/a.jpg', 'https://notkakao.com/a.jpg', 'https://kakaocdn.net.evil.example/a.jpg',
    'https://other.example/a.jpg', 'https://name:secret@dn.talk.kakao.com/a.jpg',
    'https://dn.talk.kakao.com:8443/a.jpg', ' https://dn.talk.kakao.com/a.jpg',
    'https://dn.talk.kakao.com/a.jpg\n', 'https://dn.talk.kakao.com./a.jpg'])
    assert.throws(() => P.parseOriginalPhoto(photo({ url }), selected(), criteria), url);
  assert.equal(P.parseOriginalPhoto(photo({ url: 'https://dn.talk.kakao.com:443/a.jpg' }), selected(), criteria).url, 'https://dn.talk.kakao.com:443/a.jpg');
});

test('an invalid high-quality URL is not silently replaced by a lower-quality URL', () => {
  assert.throws(() => P.parseOriginalPhoto(photo({ urlHq: 'https://unknown.example/hq.jpg' }), selected(), criteria));
});

test('detail may enrich an unknown size and filename while joined query context is retained', () => {
  const original = selected(photo({ size: null, originalFilename: '' }));
  const result = P.parseOriginalPhoto(photo({ joined: undefined }), original, criteria);
  assert.equal(result.size, 1234);
  assert.equal(result.name, '사진.jpg');
});

test('GIF detail keeps GIF identity and current category inclusion', () => {
  const raw = photo({ extension: 'gif', mimeType: 'image/gif', originalFilename: '사진.gif' });
  assert.equal(P.parseOriginalPhoto(raw, selected(raw), criteria).name, '사진.gif');
  assert.throws(() => P.parseOriginalPhoto(raw, selected(raw), { ...criteria, kinds: ['photo'] }));
});

const fileCriteria = { ...criteria, kinds: ['photo', 'gif', 'video', 'file'] };
const selectedFile = raw => P.normalize(raw, fileCriteria.cutoff, true, { ...fileCriteria, verticalType: 'FILE' });
const selectedVideo = raw => P.normalize(raw, fileCriteria.cutoff, true, fileCriteria);
const documentFile = (overrides = {}) => photo({ contentType: 'FILE', originalFilename: '계약서.pdf',
  mimeType: 'application/pdf', extension: 'pdf', url: 'https://dn.talk.kakao.com/document.pdf?token=preserve%2Bme', ...overrides });
const video = (overrides = {}) => photo({ contentType: 'VIDEO', originalFilename: '동영상.mp4',
  mimeType: 'video/mp4', extension: 'mp4', url: 'https://dn.talk.kakao.com/video.mp4', ...overrides });

test('general file detail accepts exact MEDIA video and FILE file pairs but rejects recordings and links', () => {
  assert.equal(P.detailUrl(selectedVideo(video())), `${P.ORIGIN}/v2/mediaFile/photo-1`);
  assert.equal(P.detailUrl(selectedFile(documentFile())), `${P.ORIGIN}/v2/mediaFile/photo-1`);
  for (const record of [{ ...selected(), kind: 'file' }, { ...selected(), verticalType: 'FILE' },
    { ...selected(), verticalType: 'LINK', kind: 'link' }]) assert.throws(() => P.detailUrl(record));
  const recording = { ...selected(), verticalType: 'RECORDING', kind: 'recording' };
  assert.throws(() => P.detailUrl(recording), /모바일 앱/);
  assert.throws(() => P.parseOriginalFile({ voiceUrl: photo().url }, recording, fileCriteria), /모바일 앱/);
});

test('video uses official HQ priority and returns video MIME without equating HQ bytes to list size', () => {
  const raw = video({ urlHq: 'https://video.kakaocdn.net/movie.mov?sig=preserve%3D', sizeHq: '5678' });
  const result = P.parseOriginalFile(raw, selectedVideo(raw), fileCriteria);
  assert.deepEqual(result, { id: raw.id, url: raw.urlHq, size: 1234, name: '동영상.mp4', kind: 'video', mimeType: 'video/mp4' });
  assert.ok(Object.isFrozen(result));
  assert.throws(() => P.parseOriginalFile({ ...raw, contentType: 'IMAGE', mimeType: 'image/jpeg' }, selectedVideo(raw), fileCriteria));
  assert.throws(() => P.parseOriginalFile({ ...raw, mimeType: 'application/pdf' }, selectedVideo(raw), fileCriteria));
});

test('ordinary files use only the direct URL and retain the original filename and normalized MIME', () => {
  const raw = documentFile({ urlHq: 'https://other.example/unused.jpg', urlNormal: 'https://dn.talk.kakao.com/preview.jpg', mimeType: ' Application/PDF; charset=binary ' });
  assert.deepEqual(P.parseOriginalFile(raw, selectedFile(raw), fileCriteria), {
    id: raw.id, url: raw.url, size: 1234, name: '계약서.pdf', kind: 'file', mimeType: 'application/pdf'
  });
  assert.throws(() => P.parseOriginalFile({ ...raw, url: null }, selectedFile(raw), fileCriteria), /저장 주소/);
});

test('general-file metadata, protection and trusted-host checks still apply to documents', () => {
  const raw = documentFile(), record = selectedFile(raw);
  for (const override of [{ id: 'changed' }, { size: '999' }, { createdAt: '1546300800001' },
    { bookmarked: true }, { hashedChatId: 'other-room' }, { joined: false }, { expired: true },
    { verticalType: 'RECORDING' }, { url: 'https://other.example/document.pdf' }])
    assert.throws(() => P.parseOriginalFile({ ...raw, ...override }, record, fileCriteria));
  assert.throws(() => P.parseOriginalFile(raw, record, { ...fileCriteria, protectedFileIds: [raw.id] }));
  assert.throws(() => P.parseOriginalFile(raw, record, { ...fileCriteria, protectedRoomIds: [record.roomId] }));
});

test('an audio attachment in the file category is downloadable without treating it as a voice-call recording', () => {
  const raw = documentFile({ contentType: undefined, originalFilename: '회의 녹음.m4a', mimeType: 'audio/mp4', url: 'https://dn.talk.kakao.com/audio.m4a' });
  assert.equal(P.parseOriginalFile(raw, selectedFile(raw), fileCriteria).kind, 'file');
  assert.equal(P.parseOriginalFile(raw, selectedFile(raw), fileCriteria).name, '회의 녹음.m4a');
});

test('FILE attachment eligibility comes from its vertical category rather than an invented contentType list', () => {
  for (const contentType of ['AUDIO', 'DOCUMENT', 'UNKNOWN_FUTURE_TYPE', undefined]) {
    const raw = documentFile({ contentType, verticalType: 'FILE' });
    const result = P.parseOriginalFile(raw, selectedFile(raw), fileCriteria);
    assert.equal(result.kind, 'file');
    assert.equal(result.url, raw.url);
  }
});

test('an explicit detail verticalType must match the selected category while absent values remain supported', () => {
  const raw = documentFile(), fileRecord = selectedFile(raw);
  for (const verticalType of ['MEDIA', 'RECORDING', 'LINK', 'unknown', ''])
    assert.throws(() => P.parseOriginalFile({ ...raw, verticalType }, fileRecord, fileCriteria));
  assert.equal(P.parseOriginalFile({ ...raw, verticalType: 'FILE' }, fileRecord, fileCriteria).kind, 'file');
  assert.equal(P.parseOriginalFile({ ...raw, verticalType: null }, fileRecord, fileCriteria).kind, 'file');
  const media = video(), mediaRecord = selectedVideo(media);
  assert.throws(() => P.parseOriginalFile({ ...media, verticalType: 'FILE' }, mediaRecord, fileCriteria));
  assert.equal(P.parseOriginalFile({ ...media, verticalType: 'MEDIA' }, mediaRecord, fileCriteria).kind, 'video');
});

test('general download supports default criteria while explicitly narrowed kinds stay enforced', () => {
  const raw = documentFile(), record = selectedFile(raw);
  const { kinds, ...defaultCriteria } = fileCriteria;
  assert.equal(P.parseOriginalFile(raw, record, defaultCriteria).kind, 'file');
  assert.throws(() => P.parseOriginalFile(raw, record, { ...fileCriteria, kinds: ['video'] }));
});
