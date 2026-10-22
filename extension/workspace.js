(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TalkCleanerWorkspace = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const VERSION = 1;
  const TTL = 7 * 24 * 60 * 60 * 1000;
  const MAX_BYTES = 4 * 1024 * 1024;
  const MAX_ITEMS = 50000;
  const KINDS = ['photo', 'gif', 'video', 'file', 'link', 'recording'];
  const STATES = ['pending', 'requested', 'verified', 'failed', 'not-started', 'uncertain'];
  const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
  function fail(code, message) { const error = new Error(message); error.code = code; return error; }
  function invalid() { throw fail('INVALID_WORKSPACE', '저장된 작업 기록을 읽을 수 없습니다. 원본 기록을 보존하고 중단했습니다. 기록 지우기 후 다시 조회해 주세요.'); }
  function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
  function id(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) invalid();
    return value;
  }
  function text(value, limit = 512) { if (typeof value !== 'string' || value.length > limit) invalid(); return value; }
  function integer(value, nullable = false) {
    if (nullable && value == null) return null;
    if (!Number.isSafeInteger(value) || value < 0) invalid();
    return value;
  }
  function bool(value, fallback) { if (value === undefined) return fallback; if (typeof value !== 'boolean') invalid(); return value; }
  function list(value, fallback = []) {
    if (value === undefined) return fallback;
    if (!Array.isArray(value) || value.length > MAX_ITEMS) invalid();
    return value;
  }
  function unique(items, getKey) {
    const keys = new Set();
    for (const item of items) { const value = getKey(item); if (keys.has(value)) invalid(); keys.add(value); }
    return items;
  }
  function kind(value) { if (!KINDS.includes(value)) invalid(); return value; }
  function stamp(value, now) { integer(value); if (value > now) invalid(); return value; }
  function validNow(now) { if (!Number.isSafeInteger(now) || now < 0) throw fail('INVALID_TIME', '현재 시각을 확인하지 못했습니다. 시스템 시각을 확인해 주세요.'); return now; }
  function key(account) {
    try { return `talkcloud-workspace-v1:${id(account)}`; }
    catch (_) { throw fail('INVALID_ACCOUNT', '작업 기록을 불러올 카카오 계정을 확인하지 못했습니다.'); }
  }
  function recordParts(record) {
    if (!object(record)) invalid();
    const createdAt = integer(record.createdAt);
    if (createdAt > 8640000000000000) invalid();
    return [id(record.id), kind(record.kind), createdAt, integer(record.size, true), text(record.name ?? '')];
  }
  function fingerprintParts(record) {
    const parts = recordParts(record);
    const vertical = ['photo', 'gif', 'video'].includes(parts[1]) ? 'MEDIA' : parts[1] === 'file' ? 'FILE' : parts[1] === 'link' ? 'LINK' : 'RECORDING';
    if (record.verticalType !== vertical) invalid();
    const roomId = record.roomId == null ? null : id(record.roomId);
    const joined = record.joined == null ? null : bool(record.joined);
    const bookmarked = record.bookmarked == null ? null : bool(record.bookmarked);
    return [...parts, roomId, joined, bookmarked, vertical];
  }
  function fingerprint(record) { return JSON.stringify(fingerprintParts(record)); }
  function parseFingerprint(value, identity) {
    if (typeof value !== 'string' || value.length > 4096) invalid();
    let parts;
    try { parts = JSON.parse(value); } catch (_) { invalid(); }
    if (!Array.isArray(parts) || parts.length !== 9) invalid();
    const checked = fingerprintParts({ id: parts[0], kind: parts[1], createdAt: parts[2], size: parts[3], name: parts[4],
      roomId: parts[5], joined: parts[6], bookmarked: parts[7], verticalType: parts[8] });
    if (checked[0] !== identity) invalid();
    return JSON.stringify(checked);
  }
  function criteria(value) {
    if (!object(value) || typeof value.cutoff !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.cutoff)) invalid();
    const date = Date.parse(`${value.cutoff}T00:00:00Z`);
    if (!Number.isFinite(date) || new Date(date).toISOString().slice(0, 10) !== value.cutoff) invalid();
    const kinds = list(value.kinds, ['photo']);
    if (!kinds.length || kinds.length > KINDS.length) invalid();
    return { cutoff: value.cutoff, kinds: unique(kinds.map(kind), item => item), minBytes: integer(value.minBytes ?? 0),
      protectStarred: bool(value.protectStarred, true), includeGif: bool(value.includeGif, false), includeLeft: bool(value.includeLeft, false) };
  }
  function view(value) {
    if (value === undefined) value = {};
    if (!object(value)) invalid();
    const minMB = value.minMB === undefined ? '' : typeof value.minMB === 'number' ? String(value.minMB) : value.minMB;
    if (typeof minMB !== 'string' || minMB.length > 32 || (minMB !== '' && (!/^\d+(?:\.\d+)?$/.test(minMB) || !Number.isFinite(Number(minMB)) || Number(minMB) > Number.MAX_SAFE_INTEGER / (1024 * 1024)))) invalid();
    const sort = value.sort ?? 'date-asc', mode = value.mode ?? 'flat';
    if (!/^(?:size|name|room|date|kind)-(?:asc|desc)$/.test(sort) || !['flat', 'rooms'].includes(mode)) invalid();
    return { search: text(value.search ?? ''), room: text(value.room ?? '', 1024), minMB,
      selectedOnly: bool(value.selectedOnly, false), sort, mode };
  }
  function basename(value) {
    if (typeof value !== 'string' || value.length > 32768) invalid();
    const name = value.split(/[\\/]/).at(-1);
    if (!name || name.length > 512 || name === '.' || name === '..' || /[\x00-\x1f\x7f<>:"|?*]/.test(name) || /[. ]$/.test(name)) invalid();
    return name;
  }
  function receipt(value, account) {
    if (!object(value) || typeof value.recordKey !== 'string' || value.recordKey.length > 8192) invalid();
    let parts;
    try { parts = JSON.parse(value.recordKey); } catch (_) { invalid(); }
    if (!Array.isArray(parts) || parts.length !== 6 || parts[0] !== account) invalid();
    const checked = recordParts({ id: parts[1], kind: parts[2], createdAt: parts[3], size: parts[4], name: parts[5] });
    if (!['photo', 'gif', 'video', 'file'].includes(checked[1]) || value.kind !== checked[1]) invalid();
    const expectedSize = integer(value.expectedSize, true), bytes = integer(value.bytes);
    if ((bytes === 0 && !(value.kind === 'file' && expectedSize === 0)) || (expectedSize !== null && expectedSize !== bytes)) invalid();
    const expectedMime = value.expectedMime ?? '';
    if (typeof expectedMime !== 'string' || expectedMime.length > 255 || (expectedMime !== '' && !MIME.test(expectedMime))) invalid();
    return { recordKey: JSON.stringify([account, ...checked]), downloadId: integer(value.downloadId), filename: basename(value.filename),
      bytes, kind: value.kind, expectedMime, expectedSize };
  }
  function outcome(value, now) {
    if (!object(value) || !['trash', 'download'].includes(value.type)) invalid();
    const startedAt = stamp(value.startedAt, now), finishedAt = value.finishedAt == null ? null : stamp(value.finishedAt, now);
    if (finishedAt !== null && finishedAt < startedAt) invalid();
    const items = list(value.items).map(item => {
      if (!object(item) || !STATES.includes(item.state)) invalid();
      const result = { id: id(item.id), name: text(item.name ?? ''), kind: kind(item.kind), size: integer(item.size, true), state: item.state };
      if (item.fingerprint !== undefined) result.fingerprint = parseFingerprint(item.fingerprint, result.id);
      return result;
    });
    const result = { type: value.type, startedAt, finishedAt, items: unique(items, item => item.id) };
    if (value.criteria !== undefined) result.criteria = criteria(value.criteria);
    return result;
  }
  function validate(value, account, now, writing = false) {
    if (!object(value) || (value.version !== VERSION && !(writing && value.version === undefined))) invalid();
    const savedAt = writing ? now : stamp(value.savedAt, now);
    const selection = list(value.selection).map(item => {
      if (!object(item)) invalid();
      const identity = id(item.id);
      return { id: identity, fingerprint: parseFingerprint(item.fingerprint, identity) };
    });
    const downloads = list(value.downloads).map(item => receipt(item, account));
    const outcomes = list(value.outcomes).slice(-2).map(item => outcome(item, now));
    return { version: VERSION, savedAt, criteria: criteria(value.criteria), selection: unique(selection, item => item.id),
      view: view(value.view), downloads: unique(downloads, item => item.recordKey), outcomes };
  }
  function bytes(value) {
    let size = 0;
    for (const character of value) { const code = character.codePointAt(0); size += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4; }
    return size;
  }
  function serialized(value) {
    const result = JSON.stringify(value);
    if (bytes(result) > MAX_BYTES) throw fail('WORKSPACE_TOO_LARGE', '작업 기록이 저장 가능한 크기를 넘었습니다. 선택 항목을 줄인 뒤 다시 시도해 주세요.');
    return result;
  }
  function read(storage, account, now = Date.now()) {
    const storageKey = key(account); validNow(now);
    let raw;
    try { raw = storage.getItem(storageKey); }
    catch (_) { throw fail('WORKSPACE_READ_FAILED', '브라우저의 작업 기록을 읽지 못했습니다. 기록을 보존하고 중단했습니다.'); }
    if (raw === null || raw === '') return null;
    if (typeof raw !== 'string' || bytes(raw) > MAX_BYTES) invalid();
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { invalid(); }
    const data = validate(parsed, account, now);
    return now - data.savedAt > TTL ? null : data;
  }
  function write(storage, account, state, now = Date.now()) {
    const storageKey = key(account); validNow(now);
    const data = validate(state, account, now, true), raw = serialized(data);
    // Reading before writing protects corrupt or newer-version records from a silent reset.
    read(storage, account, now);
    try { storage.setItem(storageKey, raw); }
    catch (_) { throw fail('WORKSPACE_WRITE_FAILED', '작업 기록을 저장하지 못했습니다. 브라우저 저장 공간과 개인정보 설정을 확인해 주세요.'); }
    return data;
  }
  function clear(storage, account) {
    const storageKey = key(account);
    try {
      if (typeof storage.removeItem === 'function') storage.removeItem(storageKey);
      else storage.setItem(storageKey, '');
    } catch (_) { throw fail('WORKSPACE_CLEAR_FAILED', '작업 기록을 지우지 못했습니다. 브라우저 저장 공간 설정을 확인해 주세요.'); }
  }
  return Object.freeze({ key, read, write, clear, fingerprint });
});
