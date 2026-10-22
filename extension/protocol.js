(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TalkCleanerProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const ORIGIN = 'https://drawer-api.kakao.com';
  const CHUNK = 100;
  const VERTICALS = ['MEDIA', 'FILE', 'LINK', 'RECORDING'];
  const KINDS = ['photo', 'gif', 'video', 'file', 'link', 'recording'];
  const LEFT_ROOMS = '__talkcloud_all_left_rooms__';
  const IMAGE_PREVIEW_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/bmp',
    'image/x-ms-bmp', 'image/avif', 'image/heic', 'image/heif', 'image/tiff'];
  const VIDEO_PREVIEW_TYPES = ['video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm',
    'video/3gpp', 'video/3gpp2', 'video/x-msvideo', 'video/x-matroska', 'video/mpeg',
    'video/mp2t', 'video/ogg', 'video/x-ms-wmv'];
  function cutoffMs(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new Error('기준일을 선택하세요.');
    const n = Date.parse(`${value}T00:00:00+09:00`);
    if (!Number.isFinite(n) || new Date(n + 32400000).toISOString().slice(0, 10) !== value)
      throw new Error('유효하지 않은 날짜입니다.');
    return n;
  }
  function id(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512)
      throw new Error('식별자 형식이 달라 중단했습니다.');
    return value;
  }
  function mime(value) { return String(value || '').split(';', 1)[0].trim().toLowerCase(); }
  function thumbnail(raw, verticalType, kind) {
    if (verticalType !== 'MEDIA' || !['photo', 'gif', 'video'].includes(kind) ||
        !(kind === 'video' ? VIDEO_PREVIEW_TYPES : IMAGE_PREVIEW_TYPES).includes(mime(raw.mimeType))) return null;
    const value = raw.thumbnailUrl;
    let parsed, pathname;
    try { parsed = new URL(value); pathname = decodeURIComponent(parsed.pathname); }
    catch { return null; }
    const trusted = ['kakao.com', 'kakaocdn.net'].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    if (typeof value !== 'string' || value.length > 16384 || value !== value.trim() || /[\\\u0000-\u001f\u007f]/.test(value) ||
        !/^https:\/\//i.test(value) || parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.port || parsed.hash || !trusted || /\.(?:svgz?|html?|xhtml|xml)$/i.test(pathname)) return null;
    return value;
  }
  function typeMismatch(raw, verticalType) {
    if (verticalType !== 'MEDIA' || raw.dimmed === true) return false;
    const value = mime(raw.mimeType);
    return Boolean(value && ((raw.contentType === 'IMAGE' && !value.startsWith('image/')) ||
      (raw.contentType === 'VIDEO' && !value.startsWith('video/'))));
  }
  function roomId(value) {
    return typeof value === 'string' && value.trim() && value.length <= 512 ? value : null;
  }
  function protectedRecord(record, filters) {
    if (filters.protectedFileIds?.includes(record.id)) return true;
    if (filters.protectedRoomIds?.includes(LEFT_ROOMS) && record.joined !== true) return true;
    const protectedRooms = (filters.protectedRoomIds || []).filter(value => value !== LEFT_ROOMS);
    return Boolean(protectedRooms.length && (!record.roomId || protectedRooms.includes(record.roomId)));
  }
  function normalize(raw, cutoff, includeGif, filters = {}) {
    if (!raw || typeof raw !== 'object') throw new Error('사진 목록 형식이 달라 중단했습니다.');
    const identity = id(raw.id);
    if (raw.dimmed === true) return null;
    const verticalType = filters.verticalType || 'MEDIA';
    if (!VERTICALS.includes(verticalType)) throw new Error('지원하지 않는 분류입니다.');
    if (verticalType === 'MEDIA' && !['IMAGE', 'VIDEO'].includes(raw.contentType)) return null;
    const stamp = Number(verticalType === 'RECORDING' ? raw.recordingStartedAt : raw.createdAt);
    if (!Number.isSafeInteger(stamp) || stamp < Date.UTC(2000, 0, 1))
      throw new Error('항목 날짜를 확인하지 못해 중단했습니다.');
    if (stamp >= cutoffMs(cutoff)) return null;
    if (typeMismatch(raw, verticalType)) return null;
    const gif = mime(raw.mimeType) === 'image/gif' || String(raw.extension || '').trim().toLowerCase().replace(/^\./, '') === 'gif';
    const kind = verticalType === 'FILE' ? 'file' : verticalType === 'LINK' ? 'link' : verticalType === 'RECORDING' ? 'recording' : raw.contentType === 'VIDEO' ? 'video' : gif ? 'gif' : 'photo';
    const kinds = filters.kinds || (includeGif ? ['photo', 'gif'] : ['photo']);
    if (!kinds.includes(kind)) return null;
    if (filters.protectStarred && kind !== 'recording' && raw.bookmarked !== false) return null;
    const chat = roomId(raw.hashedChatId);
    const joined = raw.chatType === 'LeaveChat' || raw.joined === false || filters.joined === false ? false : typeof raw.joined === 'boolean' ? raw.joined : verticalType !== 'RECORDING' && typeof filters.joined === 'boolean' ? filters.joined : null;
    if (protectedRecord({ id: identity, roomId: chat, joined }, filters)) return null;
    const rawSize = kind === 'link' ? null : kind === 'recording' ? raw.voiceSize : raw.size;
    const size = rawSize == null ? NaN : Number(rawSize);
    const minBytes = filters.minBytes ?? 0;
    if (!Number.isSafeInteger(minBytes) || minBytes < 0) throw new Error('크기 조건이 유효하지 않습니다.');
    if (kind !== 'link' && minBytes > 0 && (!Number.isSafeInteger(size) || size < minBytes)) return null;
    const name = kind === 'link' ? raw.title || raw.url : kind === 'recording' ? raw.displayName : raw.originalFilename || raw.originalFileName;
    return Object.freeze({ id: identity, createdAt: stamp,
      date: new Date(stamp + 32400000).toISOString().slice(0, 10),
      size: Number.isSafeInteger(size) && size >= 0 ? size : null,
      name: String(name || '').slice(0, 512), roomId: chat, joined,
      bookmarked: typeof raw.bookmarked === 'boolean' ? raw.bookmarked : null,
      verticalType, kind, thumbnailUrl: thumbnail(raw, verticalType, kind) });
  }
  function parsePage(data, options) {
    if (!data || !Array.isArray(data.items) || typeof data.hasMore !== 'boolean')
      throw new Error('서버 목록 응답이 예상과 다릅니다. 삭제 없이 중단했습니다.');
    const normalized = data.items.map(x => normalize(x, options.cutoff, options.includeGif, options));
    const records = normalized.filter(Boolean);
    const ineligibleIds = data.items.filter((_, index) => !normalized[index]).map(x => id(x.id));
    const recording = options.verticalType === 'RECORDING';
    const pageIndex = options.pageIndex ?? 1;
    if (recording && (!Number.isSafeInteger(pageIndex) || pageIndex < 1)) throw new Error('녹음 페이지 번호가 유효하지 않습니다.');
    if (data.hasMore && !data.items.length) throw new Error('빈 목록에서 다음 페이지가 반환되어 중단했습니다.');
    const next = data.hasMore ? recording ? pageIndex + 1 : id(data.items.at(-1)?.drawerId) : null;
    if (data.hasMore && next === options.offset) throw new Error('목록 커서가 진행되지 않습니다.');
    const typeMismatchIds = data.items.filter(x => typeMismatch(x, options.verticalType || 'MEDIA')).map(x => id(x.id));
    const protectNamedRooms = options.protectedRoomIds?.some(value => value !== LEFT_ROOMS);
    const protectLeft = options.protectedRoomIds?.includes(LEFT_ROOMS);
    const unknownRoomIds = data.items.filter(x => (protectNamedRooms && !roomId(x.hashedChatId)) || (protectLeft && recording && typeof x.joined !== 'boolean')).map(x => id(x.id));
    return { records, ids: data.items.map(x => id(x.id)), typeMismatchIds, unknownRoomIds, ineligibleIds, next, hasMore: data.hasMore, scanned: data.items.length };
  }
  function listUrl(options) {
    const to = cutoffMs(options.cutoff);
    const verticalType = options.verticalType || 'MEDIA';
    if (!VERTICALS.includes(verticalType)) throw new Error('지원하지 않는 분류입니다.');
    if (verticalType === 'RECORDING') {
      const pageIndex = options.pageIndex ?? 1;
      if (!Number.isSafeInteger(pageIndex) || pageIndex < 1) throw new Error('녹음 페이지 번호가 유효하지 않습니다.');
      return `${ORIGIN}/recording/search?${new URLSearchParams({ to: String(to), pageIndex: String(pageIndex), searchType: 'TIME' })}`;
    }
    const q = new URLSearchParams({ verticalType, fetchCount: '100',
      from: '0', to: String(to), joined: String(options.joined !== false), direction: 'ASC' });
    if (options.offset != null) q.set('offset', id(options.offset));
    return `${ORIGIN}/${verticalType === 'LINK' ? 'link/list' : 'v2/mediaFile/list'}?${q}`;
  }
  function roomsUrl(verticalType) {
    if (!VERTICALS.includes(verticalType)) throw new Error('지원하지 않는 분류입니다.');
    return `${ORIGIN}/chat/list?${new URLSearchParams({ verticalType })}`;
  }
  function parseRooms(data) {
    if (!data || !Array.isArray(data.items)) throw new Error('채팅방 목록 형식이 달라 중단했습니다.');
    const rooms = data.items.filter(raw => raw && (raw.chatType === 'LeaveChat' || raw.joined === false || roomId(raw.hashedChatId))).map(raw => ({
      id: raw.chatType === 'LeaveChat' || raw.joined === false ? LEFT_ROOMS : raw.hashedChatId,
      name: raw.chatType === 'LeaveChat' || raw.joined === false ? '나간 채팅방 전체' : String(raw.title || '이름 없는 채팅방').slice(0, 512), joined: raw.chatType === 'LeaveChat' ? false : raw.joined
    }));
    return { rooms, skipped: data.items.length - rooms.length };
  }
  function detailUrl(record) {
    if (record?.kind === 'recording' || record?.verticalType === 'RECORDING')
      throw new Error('보이스톡 통화 녹음은 공식 웹에서도 모바일 앱 확인을 안내합니다. 이 확장에서는 녹음을 저장할 수 없습니다.');
    if (!record || !(record.verticalType === 'MEDIA' && ['photo', 'gif', 'video'].includes(record.kind)) &&
        !(record.verticalType === 'FILE' && record.kind === 'file'))
      throw new Error('사진·GIF·동영상·파일만 원본 파일을 저장할 수 있습니다. 링크는 다운로드 대상이 아닙니다.');
    const identity = id(record.id);
    if (identity === '.' || identity === '..') throw new Error('파일 식별자 형식이 유효하지 않습니다.');
    return `${ORIGIN}/v2/mediaFile/${encodeURIComponent(identity)}`;
  }
  function validatedFileRecord(raw, record, criteria = {}) {
    detailUrl(record);
    const media = record.verticalType === 'MEDIA';
    const expectedType = record.kind === 'video' ? 'VIDEO' : 'IMAGE';
    if (!raw || typeof raw !== 'object' || (media && raw.contentType !== expectedType) ||
        (raw.verticalType != null && raw.verticalType !== record.verticalType) || raw.dimmed === true ||
        raw.expired === true || raw.isExpired === true)
      throw new Error('파일을 저장할 수 없는 상태입니다. 다시 조회해 주세요.');
    const options = { ...criteria, verticalType: record.verticalType,
      kinds: criteria.kinds || ['photo', 'gif', 'video', 'file'],
      joined: typeof criteria.joined === 'boolean' ? criteria.joined : record.joined };
    const current = normalize(raw, criteria.cutoff, true, options);
    const fields = ['id', 'createdAt', 'kind', 'verticalType', 'bookmarked', 'roomId', 'joined'];
    if (!current || fields.some(field => current[field] !== record[field]) ||
        (record.size !== null && record.size !== undefined && current.size !== record.size))
      throw new Error('파일 정보 또는 보호 조건이 조회할 때와 달라 저장을 중단했습니다. 다시 조회해 주세요.');
    return current;
  }
  function parseOriginalFile(raw, record, criteria = {}) {
    const current = validatedFileRecord(raw, record, criteria);
    const candidate = (record.verticalType === 'MEDIA' ? [raw.urlHq, raw.urlNormal, raw.url] : [raw.url]).find(value => typeof value === 'string' && value.trim());
    if (!candidate) throw new Error('파일의 저장 주소가 없습니다. 미리보기 이미지는 대신 저장하지 않습니다.');
    let parsed;
    try { parsed = new URL(candidate); } catch { throw new Error('파일 저장 주소의 형식이 유효하지 않습니다.'); }
    const trusted = ['kakao.com', 'kakaocdn.net'].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    if (candidate !== candidate.trim() || /[\u0000-\u001f\u007f]/.test(candidate) ||
        parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !trusted)
      throw new Error('지원하지 않는 파일 저장 주소입니다. 톡클라우드에서 직접 저장해 주세요.');
    return Object.freeze({ id: current.id, url: candidate, size: current.size, name: current.name || record.name || '',
      kind: current.kind, mimeType: mime(raw.mimeType) });
  }
  function photoDetailUrl(record) {
    if (!record || record.verticalType !== 'MEDIA' || !['photo', 'gif'].includes(record.kind))
      throw new Error('사진과 GIF만 원본 파일을 저장할 수 있습니다.');
    return detailUrl(record);
  }
  function parseOriginalPhoto(raw, record, criteria = {}) {
    photoDetailUrl(record);
    const { kind, mimeType, ...photo } = parseOriginalFile(raw, record, criteria);
    return Object.freeze(photo);
  }
  function parsePhotoPreview(raw, record, criteria = {}) {
    previewDetailUrl(record);
    const current = validatedFileRecord(raw, record, criteria);
    // Photos, GIFs and video posters share the official thumbnailUrl field.
    // Never substitute a full original or guess a conversion endpoint.
    if (!current.thumbnailUrl)
      throw new Error('이 항목에는 표시할 수 있는 미리보기 이미지가 없습니다. 필요한 파일은 원본 저장으로 확인해 주세요.');
    return Object.freeze({ id: current.id, url: current.thumbnailUrl, name: current.name || record.name || '',
      kind: current.kind, source: 'thumbnail' });
  }
  function previewDetailUrl(record) {
    if (!record || record.verticalType !== 'MEDIA' || !['photo', 'gif', 'video'].includes(record.kind))
      throw new Error('사진·GIF·동영상만 미리보기를 확인할 수 있습니다.');
    return detailUrl(record);
  }
  function trashBody(records, cutoff, filters = {}) {
    if (filters.minBytes != null && (!Number.isSafeInteger(filters.minBytes) || filters.minBytes < 0))
      throw new Error('크기 조건이 유효하지 않습니다.');
    if (!Array.isArray(records) || records.length < 1 || records.length > CHUNK)
      throw new Error('한 요청에는 항목 1~100개만 보낼 수 있습니다.');
    const unique = new Set();
    const bound = cutoffMs(cutoff);
    const trashContents = records.map(r => {
      const identity = id(r.id);
      if (unique.has(identity) || !KINDS.includes(r.kind) || !Number.isSafeInteger(r.createdAt) || r.createdAt < Date.UTC(2000, 0, 1) || r.createdAt >= bound)
        throw new Error('검토한 항목 목록과 삭제 조건이 일치하지 않습니다.');
      if (filters.kinds && !filters.kinds.includes(r.kind)) throw new Error('선택한 종류가 아닙니다.');
      if (filters.protectStarred && r.kind !== 'recording' && r.bookmarked !== false) throw new Error('중요 항목 보호 조건을 확인하지 못했습니다.');
      if (protectedRecord(r, filters)) throw new Error('보호한 항목 또는 채팅방이 포함되어 중단했습니다.');
      if (r.kind !== 'link' && filters.minBytes > 0 && (!Number.isSafeInteger(r.size) || r.size < filters.minBytes)) throw new Error('크기 조건과 일치하지 않습니다.');
      unique.add(identity);
      return { id: identity, source: 'TALK', type: r.kind === 'link' ? 'LINK' : r.kind === 'recording' ? 'RECORDING' : 'FILE' };
    });
    return { trashContents };
  }
  return Object.freeze({ ORIGIN, CHUNK, LEFT_ROOMS, VERTICALS: Object.freeze(VERTICALS), cutoffMs, normalize, parsePage, listUrl, roomsUrl, parseRooms, protectedRecord, detailUrl, parseOriginalFile, photoDetailUrl, parseOriginalPhoto, previewDetailUrl, parsePhotoPreview, trashBody });
});
