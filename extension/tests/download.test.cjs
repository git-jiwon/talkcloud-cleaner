'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const D = require('../download.js');
const URL_A = 'https://media.kakaocdn.net/original/secret?token=private';
const PATH = 'TalkCloud-Backup/20261021-123456/000001_photo.jpg';
const item = (values = {}) => ({ id: 7, state: 'complete', exists: true, url: URL_A, finalUrl: URL_A,
  mime: 'image/jpeg', fileSize: 100, bytesReceived: 100, filename: 'D:\\Downloads\\' + PATH.replaceAll('/', '\\'), ...values });
const photo = (values = {}) => ({ id: 'photo-id', verticalType: 'MEDIA', kind: 'photo', name: 'photo.jpg', createdAt: 1000, size: 100, ...values });
function mock(sequence = [item()]) {
  const calls = { downloads: [], searches: [], cancels: [] };
  let cursor = 0;
  const api = {
    download: async request => { calls.downloads.push(request); return 7; },
    search: async query => { calls.searches.push(query); return [sequence[Math.min(cursor++, sequence.length - 1)]]; },
    cancel: async id => { calls.cancels.push(id); },
    erase: () => { throw Error('Must never erase'); }, removeFile: () => { throw Error('Must never remove files'); },
    acceptDanger: () => { throw Error('Must never accept browser warnings'); }
  };
  return { api, calls };
}
const request = (values = {}) => ({ url: URL_A, filename: PATH, expectedSize: 100, ...values });

test('browser global exposes the same frozen API', () => {
  const context = {};
  vm.runInNewContext(fs.readFileSync(require.resolve('../download.js'), 'utf8'), context);
  assert.deepEqual(Object.keys(context.TalkCleanerDownload), Object.keys(D));
  assert.equal(Object.isFrozen(context.TalkCleanerDownload), true);
});
test('photos keeps its original subset while files includes only supported vertical and kind pairs', () => {
  const p = photo(), gif = photo({ id: 'g', kind: 'gif' });
  const video = photo({ kind: 'video' }), file = photo({ kind: 'file', verticalType: 'FILE' });
  const input = [p, gif, video, file, photo({ verticalType: 'FILE' }), photo({ kind: 'file' }),
    photo({ kind: 'link', verticalType: 'LINK' }), photo({ kind: 'recording', verticalType: 'RECORDING' }), null];
  assert.deepEqual(D.photos(input), [p, gif]);
  assert.deepEqual(D.files(input), [p, gif, video, file]);
});
test('receipt keys bind exact account and identity details without ambiguous concatenation', () => {
  const key = D.receiptKey('account-a', photo());
  assert.equal(key, D.receiptKey('account-a', { name: 'photo.jpg', size: 100, createdAt: 1000, kind: 'photo', verticalType: 'MEDIA', id: 'photo-id' }));
  for (const changes of [{ id: 'other' }, { kind: 'gif' }, { createdAt: 1001 }, { size: 101 }, { name: 'other.jpg' }]) assert.notEqual(key, D.receiptKey('account-a', photo(changes)));
  assert.notEqual(key, D.receiptKey('account-b', photo()));
  assert.throws(() => D.receiptKey('', photo()), { code: 'INVALID_RECORD' });
});
test('filenames stay relative, safe and unique with sensible image extensions', () => {
  const dir = D.folder(new Date(2026, 9, 21, 12, 34, 56));
  assert.equal(dir, 'TalkCloud-Backup/20261021-123456');
  const a = D.filename(photo({ name: '../../CON:<bad>?.exe' }), 0, dir);
  assert.match(a, /^TalkCloud-Backup\/20261021-123456\/000001_[^/\\<>:"|?*]+\.jpg$/);
  assert.equal(a.includes('..'), false);
  assert.notEqual(a, D.filename(photo({ name: '../../CON:<bad>?.exe' }), 1, dir));
  assert.match(D.filename(photo({ kind: 'gif', name: 'image.PNG' }), 0, dir), /image\.gif$/);
  assert.match(D.filename(photo({ name: '서울.HEIC' }), 0, dir), /서울\.heic$/);
  assert.throws(() => D.filename(photo(), 0, '../bad'), { code: 'INVALID_FILENAME' });
  assert.throws(() => D.filename(photo(), -1, dir), { code: 'INVALID_FILENAME' });
  assert.throws(() => D.folder('not-a-date'), { code: 'INVALID_DATE' });
});
test('document names preserve arbitrary extensions and videos keep their format or use mp4 fallback', () => {
  const dir = 'TalkCloud-Backup/20261021-123456';
  for (const name of ['보고서.pdf', 'Report.DOCX', '통계.xlsx', '한글.hwp', 'memo.txt', '압축.tar.gz', 'config.json', 'index.html', 'README', '도면.custom']) {
    assert.equal(D.filename(photo({ verticalType: 'FILE', kind: 'file', name }), 2, dir), `${dir}/000003_${name}`);
  }
  assert.equal(D.filename(photo({ verticalType: 'FILE', kind: 'file', name: '' }), 0, dir), `${dir}/000001_file.bin`);
  assert.equal(D.filename(photo({ kind: 'video', name: '여행.MOV' }), 0, dir), `${dir}/000001_여행.mov`);
  assert.equal(D.filename(photo({ kind: 'video', name: '여행영상' }), 0, dir), `${dir}/000001_여행영상.mp4`);
  const hostile = D.filename(photo({ verticalType: 'FILE', kind: 'file', name: '../../NUL:<x>?.pdf' }), 0, dir);
  assert.equal(hostile.includes('..'), false);
  assert.match(hostile, /^TalkCloud-Backup\/20261021-123456\/000001_[^/\\<>:"|?*]+\.pdf$/);
});
test('long Unicode filenames fit Windows component limits without splitting surrogate pairs', () => {
  const directory = 'TalkCloud-Backup/20261021-123456';
  const filename = D.filename(photo({ verticalType: 'FILE', kind: 'file', name: '😀'.repeat(120) + '.properties' }), 0, directory);
  const basename = filename.split('/').at(-1);
  assert.ok(basename.length <= 255, 'The complete name must fit a Windows filename component');
  assert.match(basename, /^000001_😀+\.properties$/u);
  assert.equal(basename.isWellFormed(), true);

  const boundary = D.filename(photo({ name: 'a'.repeat(119) + '😀.jpg' }), 1, directory);
  assert.equal(boundary, `${directory}/000002_${'a'.repeat(119)}.jpg`);
  assert.equal(boundary.isWellFormed(), true);
});

test('only HTTPS official host boundaries without credentials or custom ports pass', () => {
  assert.equal(D.validateUrl(URL_A), URL_A);
  assert.equal(D.validateUrl('https://talkcloud.kakao.com/photo?a=1'), 'https://talkcloud.kakao.com/photo?a=1');
  for (const value of ['http://media.kakaocdn.net/a', 'https://kakaocdn.net.evil.example/a', 'https://evil-kakao.com/a', 'https://user:password@media.kakaocdn.net/a', 'https://media.kakaocdn.net:444/a', 'https://media.kakaocdn.net/a#x', 'file:///x', 'javascript:alert(1)', null]) {
    assert.throws(() => D.validateUrl(value), { code: 'UNSAFE_URL' });
  }
});
test('saveOne waits for complete and returns no URL or authentication query', async () => {
  const { api, calls } = mock([item({ state: 'in_progress', fileSize: -1, bytesReceived: 50, totalBytes: 100 }), item()]);
  const progress = [];
  const receipt = await D.saveOne(api, request(), { sleep: async () => {}, onProgress: value => progress.push(value) });
  assert.deepEqual(calls.downloads, [{ url: URL_A, filename: PATH, conflictAction: 'uniquify', saveAs: false }]);
  assert.deepEqual(calls.searches, [{ id: 7 }, { id: 7 }]);
  assert.equal(progress[0].bytes, 50);
  assert.equal(receipt.bytes, 100);
  assert.equal(receipt.expectedSize, 100);
  assert.equal(JSON.stringify([receipt, progress]).includes('private'), false);
  assert.deepEqual(calls.cancels, []);
});
test('browser-uniquified full filename is used in the receipt', async () => {
  const { api } = mock([item({ filename: 'D:\\Downloads\\photo (1).jpg' })]);
  assert.equal((await D.saveOne(api, request())).filename, 'D:\\Downloads\\photo (1).jpg');
});
test('unknown original size accepts positive completed octet-stream transfer', async () => {
  const { api } = mock([item({ mime: 'application/octet-stream', fileSize: -1, bytesReceived: 100 })]);
  assert.equal((await D.saveOne(api, request({ expectedSize: null }))).bytes, 100);
});
test('videos accept video media or binary transport and persist the verification kind', async () => {
  for (const mime of ['video/mp4', 'video/quicktime', 'application/octet-stream']) {
    const { api } = mock([item({ mime, filename: 'D:\\Downloads\\video.mp4' })]);
    const receipt = await D.saveOne(api, request({ kind: 'video', filename: PATH.replace('.jpg', '.mp4'), expectedMime: 'video/mp4', expectedSize: null }));
    assert.equal(receipt.kind, 'video');
    assert.equal(receipt.expectedMime, 'video/mp4');
    assert.deepEqual(await D.checkReceipt(api, receipt), receipt);
  }
  await assert.rejects(D.saveOne(mock().api, request({ kind: 'video', filename: PATH.replace('.jpg', '.mp4') })), { code: 'INVALID_CONTENT' });
});
test('documents accept their formats and binary transport with exact metadata size', async () => {
  for (const [extension, mime] of [
    ['pdf', 'application/pdf'], ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'], ['hwp', 'application/x-hwp'],
    ['txt', 'text/plain'], ['zip', 'application/zip'], ['mp3', 'audio/mpeg'], ['png', 'image/png'], ['bin', 'application/octet-stream']
  ]) {
    const { api } = mock([item({ mime, filename: `D:\\Downloads\\document.${extension}` })]);
    const receipt = await D.saveOne(api, request({ kind: 'file', filename: PATH.replace('.jpg', `.${extension}`), expectedMime: mime }));
    assert.equal(receipt.kind, 'file');
    assert.equal(receipt.expectedMime, mime);
    assert.deepEqual(await D.checkReceipt(api, receipt), receipt);
  }
});
test('documents still reject missing MIME and mismatched original size', async () => {
  const values = { kind: 'file', filename: PATH.replace('.jpg', '.pdf'), expectedMime: 'application/pdf' };
  await assert.rejects(D.saveOne(mock([item({ mime: '' })]).api, request(values)), { code: 'INVALID_CONTENT' });
  await assert.rejects(D.saveOne(mock([item({ mime: 'application/pdf', fileSize: 99, bytesReceived: 99 })]).api, request(values)), { code: 'SIZE_MISMATCH' });
});
test('HTML and JSON error payloads are rejected for ordinary files even when byte count matches', async () => {
  for (const mime of ['text/html', 'application/xhtml+xml', 'application/json', 'text/json', 'application/problem+json']) {
    const { api } = mock([item({ mime, filename: 'D:\\Downloads\\document.pdf' })]);
    await assert.rejects(D.saveOne(api, request({ kind: 'file', filename: PATH.replace('.jpg', '.pdf'), expectedMime: 'application/pdf' })), { code: 'INVALID_CONTENT' });
  }
});
test('legitimate named HTML and JSON require matching original MIME and a known exact size', async () => {
  for (const [extension, mime] of [['html', 'text/html'], ['json', 'application/json']]) {
    const base = { kind: 'file', filename: PATH.replace('.jpg', `.${extension}`), expectedMime: mime };
    for (const downloadedMime of [mime, 'application/octet-stream']) {
      const { api } = mock([item({ mime: downloadedMime, filename: `D:\\Downloads\\document (1).${extension}` })]);
      const receipt = await D.saveOne(api, request(base));
      assert.equal(receipt.kind, 'file');
      assert.deepEqual(await D.checkReceipt(api, receipt), receipt);
      await assert.rejects(D.saveOne(api, request({ ...base, expectedSize: null })), { code: 'INVALID_CONTENT' });
    }
    const { api } = mock([item({ mime, filename: `D:\\Downloads\\document.${extension}` })]);
    await assert.rejects(D.saveOne(api, request({ ...base, expectedMime: '' })), { code: 'INVALID_CONTENT' });
    await assert.rejects(D.saveOne(api, request({ ...base, expectedSize: 99 })), { code: 'INVALID_CONTENT' });
    await assert.rejects(D.saveOne(mock([item({ mime, filename: 'D:\\Downloads\\document.pdf' })]).api, request(base)), { code: 'INVALID_CONTENT' });
  }
});
test('zero-byte ordinary files require known zero metadata while media and unknown sizes are rejected', async () => {
  const zero = item({ mime: 'text/plain', fileSize: 0, bytesReceived: 0, filename: 'D:\\Downloads\\empty.txt' });
  const { api } = mock([zero]);
  const values = { kind: 'file', filename: PATH.replace('.jpg', '.txt'), expectedMime: 'text/plain', expectedSize: 0 };
  const receipt = await D.saveOne(api, request(values));
  assert.equal(receipt.bytes, 0);
  assert.equal(receipt.expectedSize, 0);
  assert.deepEqual(await D.checkReceipt(api, receipt), receipt);
  await assert.rejects(D.saveOne(api, request({ ...values, expectedSize: null })), { code: 'EMPTY_FILE' });
  await assert.rejects(D.saveOne(api, request({ ...values, expectedSize: 10 })), { code: 'EMPTY_FILE' });
  for (const kind of ['photo', 'gif', 'video']) {
    await assert.rejects(D.saveOne(mock([item({ fileSize: 0, bytesReceived: 0 })]).api, request({ kind, expectedSize: 0, filename: PATH.replace('.jpg', kind === 'video' ? '.mp4' : '.jpg') })), { code: 'EMPTY_FILE' });
  }
});
test('receipt rechecks retain document MIME rules and reject later browser warnings', async () => {
  const html = item({ mime: 'text/html', filename: 'D:\\Downloads\\saved.html' });
  const values = { kind: 'file', filename: PATH.replace('.jpg', '.html'), expectedMime: 'text/html' };
  const receipt = await D.saveOne(mock([html]).api, request(values));
  await assert.rejects(D.checkReceipt(mock([html]).api, { ...receipt, expectedMime: 'application/pdf' }), { code: 'INVALID_CONTENT' });
  await assert.rejects(D.checkReceipt(mock([{ ...html, danger: 'content' }]).api, receipt), { code: 'DANGEROUS_DOWNLOAD' });
});
test('browser danger warnings, blocked states and unknown states never count as completed backups', async () => {
  const warnings = ['file', 'url', 'content', 'uncommon', 'host', 'unwanted', 'accepted', 'allowlistedByPolicy',
    'asyncScanning', 'asyncLocalPasswordScanning', 'passwordProtected', 'blockedTooLarge', 'sensitiveContentWarning',
    'sensitiveContentBlock', 'deepScannedFailed', 'deepScannedOpenedDangerous', 'promptForScanning',
    'promptForLocalPasswordScanning', 'accountCompromise', 'blockedScanFailed', 'forceSaveToGdrive', 'forceSaveToOnedrive', 'unknown-new-value', null, ''];
  for (const danger of warnings) {
    const { api, calls } = mock([item({ danger })]);
    await assert.rejects(D.saveOne(api, request()), { code: 'DANGEROUS_DOWNLOAD' }, String(danger));
    assert.deepEqual(calls.cancels, []);
  }
});
test('safe and successfully scanned downloads may count as completed backups', async () => {
  for (const danger of ['safe', 'deepScannedSafe', undefined]) {
    assert.equal((await D.saveOne(mock([item({ danger })]).api, request())).state, 'complete');
  }
});
test('pending browser scans may finish safely but explicit in-progress warnings are cancelled', async () => {
  const pending = mock([item({ state: 'in_progress', danger: 'asyncScanning' }), item({ danger: 'deepScannedSafe' })]);
  assert.equal((await D.saveOne(pending.api, request(), { sleep: async () => {} })).state, 'complete');
  const blocked = mock([item({ state: 'in_progress', danger: 'blockedTooLarge' })]);
  await assert.rejects(D.saveOne(blocked.api, request()), { code: 'DANGEROUS_DOWNLOAD' });
  assert.deepEqual(blocked.calls.cancels, [7]);
});
for (const [label, changes, code] of [
  ['HTML instead of a photo', { mime: 'text/html' }, 'INVALID_CONTENT'],
  ['error JSON', { mime: 'application/json' }, 'INVALID_CONTENT'],
  ['empty MIME', { mime: '' }, 'INVALID_CONTENT'],
  ['wrong size', { fileSize: 99, bytesReceived: 99 }, 'SIZE_MISMATCH'],
  ['inconsistent transfer size', { fileSize: 100, bytesReceived: 99 }, 'SIZE_MISMATCH'],
  ['empty file', { fileSize: 0, bytesReceived: 0 }, 'EMPTY_FILE'],
  ['missing file', { exists: false }, 'MISSING_FILE'],
  ['missing filename', { filename: '' }, 'MISSING_FILENAME'],
  ['external redirect', { finalUrl: 'https://evil.example/file.jpg' }, 'UNSAFE_URL'],
  ['missing final URL', { finalUrl: '' }, 'UNSAFE_URL'],
  ['interrupted transfer', { state: 'interrupted', error: 'SERVER_BAD_CONTENT' }, 'INTERRUPTED']
]) test(`saveOne rejects ${label} without claiming completion`, async () => {
  const { api } = mock([item(changes)]);
  await assert.rejects(D.saveOne(api, request()), { code });
});
test('invalid request never starts a browser download', async () => {
  const { api, calls } = mock();
  await assert.rejects(D.saveOne(api, request({ filename: '../escape.jpg' })), { code: 'INVALID_FILENAME' });
  await assert.rejects(D.saveOne(api, request({ filename: 'TalkCloud-Backup/20261021-123456/000001_photo.exe' })), { code: 'INVALID_FILENAME' });
  await assert.rejects(D.saveOne(api, request({ expectedSize: '100' })), { code: 'INVALID_SIZE' });
  await assert.rejects(D.saveOne(api, request({ kind: 'recording' })), { code: 'INVALID_KIND' });
  await assert.rejects(D.saveOne(api, request({ kind: 'link' })), { code: 'INVALID_KIND' });
  await assert.rejects(D.saveOne(api, request({ expectedMime: 'not a MIME' })), { code: 'INVALID_MIME' });
  await assert.rejects(D.saveOne(api, request({ url: 'https://evil.example' })), { code: 'UNSAFE_URL' });
  assert.equal(calls.downloads.length, 0);
});
test('stop before start creates no download', async () => {
  const { api, calls } = mock();
  await assert.rejects(D.saveOne(api, request(), { shouldStop: () => true }), { code: 'STOPPED' });
  assert.equal(calls.downloads.length, 0);
});
test('stop cancels only this owned in-progress download', async () => {
  const { api, calls } = mock([item({ state: 'in_progress' })]);
  let stop = false;
  await assert.rejects(D.saveOne(api, request(), { shouldStop: () => stop, sleep: async () => { stop = true; } }), { code: 'STOPPED' });
  assert.deepEqual(calls.cancels, [7]);
  assert.equal(calls.searches.every(query => query.id === 7), true);
});
test('stop racing with completion does not cancel or remove the completed file', async () => {
  const { api, calls } = mock([item({ state: 'in_progress' }), item()]);
  let stop = false;
  await assert.rejects(D.saveOne(api, request(), { shouldStop: () => stop, sleep: async () => { stop = true; } }), { code: 'STOPPED' });
  assert.deepEqual(calls.cancels, []);
});
test('timeout cancels only the owned in-progress download with no auto retry', async () => {
  const { api, calls } = mock([item({ state: 'in_progress' })]);
  let now = 0;
  await assert.rejects(D.saveOne(api, request(), { timeoutMs: 10, pollMs: 5, now: () => now, sleep: async delay => { now += delay; } }), { code: 'TIMEOUT' });
  assert.deepEqual(calls.cancels, [7]);
  assert.equal(calls.downloads.length, 1);
});
test('videos and files have a bounded thirty-minute default while photos keep ten minutes', async () => {
  for (const kind of ['video', 'file', 'photo']) {
    const path = kind === 'video' ? PATH.replace('.jpg', '.mp4') : kind === 'file' ? PATH.replace('.jpg', '.zip') : PATH;
    const mime = kind === 'video' ? 'video/mp4' : kind === 'file' ? 'application/zip' : 'image/jpeg';
    let now = 0;
    const completing = mock([item({ state: 'in_progress', mime }), item({ mime })]);
    const result = D.saveOne(completing.api, request({ kind, filename: path }), { now: () => now, sleep: async () => { now += 11 * 60 * 1000; } });
    if (kind === 'photo') await assert.rejects(result, { code: 'TIMEOUT' });
    else assert.equal((await result).state, 'complete');
    if (kind !== 'photo') {
      now = 0;
      const stalled = mock([item({ state: 'in_progress', mime })]);
      await assert.rejects(D.saveOne(stalled.api, request({ kind, filename: path }), { now: () => now, sleep: async () => { now += 30 * 60 * 1000; } }), { code: 'TIMEOUT' });
      assert.deepEqual(stalled.calls.cancels, [7]);
    }
  }
});
test('unsafe in-progress redirect is cancelled before it can count as a backup', async () => {
  const { api, calls } = mock([item({ state: 'in_progress', finalUrl: 'https://evil.example/error' })]);
  await assert.rejects(D.saveOne(api, request()), { code: 'UNSAFE_URL' });
  assert.deepEqual(calls.cancels, [7]);
});
test('a completion received after the deadline is not marked as a verified backup', async () => {
  const { api, calls } = mock();
  let now = 0;
  api.search = async () => { now = 11; return [item()]; };
  await assert.rejects(D.saveOne(api, request(), { timeoutMs: 10, now: () => now }), { code: 'TIMEOUT' });
  assert.deepEqual(calls.cancels, []);
});
test('Chrome API failures do not leak signed URLs', async () => {
  const { api } = mock();
  api.download = async () => { throw Error(URL_A); };
  await assert.rejects(D.saveOne(api, request()), error => error.code === 'START_FAILED' && !error.message.includes('private'));
  const { api: lookup } = mock();
  lookup.search = async () => { throw Error(URL_A); };
  await assert.rejects(D.saveOne(lookup, request()), error => error.code === 'LOOKUP_FAILED' && !error.message.includes('private'));
});
test('receipt verification checks current file metadata without redownloading', async () => {
  const { api, calls } = mock();
  const receipt = await D.saveOne(api, request());
  assert.deepEqual(await D.checkReceipt(api, receipt), receipt);
  assert.equal(calls.downloads.length, 1);
  assert.deepEqual(calls.cancels, []);
});
test('receipt verification rejects moved/deleted files, altered metadata and forgotten history', async () => {
  const receipt = await D.saveOne(mock().api, request());
  await assert.rejects(D.checkReceipt(mock([item({ exists: false })]).api, receipt), { code: 'MISSING_FILE' });
  await assert.rejects(D.checkReceipt(mock([item({ filename: 'another.jpg' })]).api, receipt), { code: 'CHANGED_FILE' });
  await assert.rejects(D.checkReceipt(mock([item({ state: 'in_progress' })]).api, receipt), { code: 'NOT_COMPLETE' });
  await assert.rejects(D.checkReceipt(mock([item({ danger: 'content' })]).api, receipt), { code: 'DANGEROUS_DOWNLOAD' });
  const { api } = mock();
  api.search = async () => [];
  await assert.rejects(D.checkReceipt(api, receipt), { code: 'MISSING_DOWNLOAD' });
  await assert.rejects(D.checkReceipt(api, { ...receipt, bytes: 0 }), { code: 'INVALID_RECEIPT' });
});
