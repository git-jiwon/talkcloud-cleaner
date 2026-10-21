(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TalkCleanerReview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const UNKNOWN_ROOM = 'unknown:';
  const KIND_LABELS = Object.freeze({ photo: '사진', gif: 'GIF', video: '동영상', file: '파일', link: '링크', recording: '통화 녹음' });
  const compareId = (a, b) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
  const compareText = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'ko');
  const hasSize = record => record.kind !== 'link' && typeof record.size === 'number' && Number.isFinite(record.size) && record.size >= 0;
  const idSet = ids => ids && typeof ids.has === 'function' ? ids : new Set(ids || []);
  function roomKey(record) {
    return typeof record.roomId === 'string' && record.roomId.trim() ? `room:${record.roomId}` : UNKNOWN_ROOM;
  }
  function defaultRoomName(record) { return roomKey(record) === UNKNOWN_ROOM ? '채팅방 확인 불가' : record.roomId; }

  function filter(records, options = {}, selectedIds, roomName = defaultRoomName) {
    const { search = '', room = '', minBytes = 0, selectedOnly = false } = options;
    const query = String(search).trim().toLocaleLowerCase('ko');
    const ids = idSet(selectedIds);
    return records.filter(record => (!query || [record.name, roomName(record)].some(value => String(value || '').toLocaleLowerCase('ko').includes(query))) &&
      (!room || roomKey(record) === room) &&
      (!(minBytes > 0) || (hasSize(record) && record.size >= minBytes)) &&
      (!selectedOnly || ids.has(record.id)));
  }

  function sort(records, sortKey = 'date-asc', roomName = defaultRoomName) {
    const match = /^(size|name|room|date|kind)-(asc|desc)$/.exec(sortKey);
    const key = match ? match[1] : 'date';
    const direction = match && match[2] === 'desc' ? -1 : 1;
    return records.slice().sort((a, b) => {
      let compared = 0;
      if (key === 'size' || key === 'date') {
        const valid = key === 'size' ? hasSize : record => typeof record.createdAt === 'number' && Number.isFinite(record.createdAt);
        const aValid = valid(a), bValid = valid(b);
        // Unknown sizes (including links) stay last even when descending.
        if (aValid !== bValid) return aValid ? -1 : 1;
        if (aValid) compared = key === 'size' ? a.size - b.size : a.createdAt - b.createdAt;
      } else if (key === 'room') compared = compareText(roomName(a), roomName(b));
      else if (key === 'kind') compared = compareText(KIND_LABELS[a.kind] || a.kind, KIND_LABELS[b.kind] || b.kind);
      else compared = compareText(a[key], b[key]);
      return compared * direction || compareId(a.id, b.id);
    });
  }

  function stats(records) {
    let bytes = 0, unknownCount = 0, linkCount = 0;
    for (const record of records) {
      if (record.kind === 'link') linkCount++;
      else if (hasSize(record)) bytes += record.size;
      else unknownCount++;
    }
    return { count: records.length, bytes, unknownCount, linkCount };
  }

  function group(records, roomName = defaultRoomName) {
    const groups = new Map();
    for (const record of records) {
      const key = roomKey(record);
      if (!groups.has(key)) groups.set(key, { key, name: String(roomName(record) ?? ''), records: [] });
      groups.get(key).records.push(record);
    }
    return [...groups.values()].map(item => ({ ...item, ...stats(item.records) }))
      .sort((a, b) => compareText(a.name, b.name) || compareId(a.key, b.key));
  }

  function page(items, index = 0, pageSize = 100) {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw new RangeError('페이지 크기는 양의 정수여야 합니다.');
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const boundedIndex = Math.max(0, Math.min(totalPages - 1, Number.isFinite(index) ? Math.floor(index) : 0));
    return { items: items.slice(boundedIndex * pageSize, (boundedIndex + 1) * pageSize), index: boundedIndex, totalPages };
  }

  function selected(records, ids) {
    const selection = idSet(ids);
    return records.filter(record => selection.has(record.id));
  }
  function triState(records, ids) {
    const count = selected(records, ids).length, total = records.length;
    return { checked: total > 0 && count === total, indeterminate: count > 0 && count < total, count, total };
  }
  return Object.freeze({ filter, sort, stats, group, page, selected, triState, roomKey });
});
