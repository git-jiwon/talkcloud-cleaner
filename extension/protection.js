(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TalkCleanerProtection = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function validId(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 512; }
  function key(account) {
    if (!validId(account)) throw new Error('보호 설정을 불러올 계정을 확인하지 못했습니다.');
    return `talkcloud-protection-v1:${account}`;
  }
  function validate(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.files) || !Array.isArray(data.rooms))
      throw new Error('저장된 보호 설정을 읽을 수 없습니다. 삭제 없이 중단했습니다.');
    for (const items of [data.files, data.rooms]) {
      if (items.some(item => !item || !validId(item.id) || typeof item.name !== 'string'))
        throw new Error('저장된 보호 목록의 형식이 잘못되었습니다. 삭제 없이 중단했습니다.');
      if (new Set(items.map(item => item.id)).size !== items.length)
        throw new Error('저장된 보호 목록이 중복되어 중단했습니다.');
    }
    return { version: 1, files: data.files.map(x => ({ id: x.id, name: x.name.slice(0, 512) })),
      rooms: data.rooms.map(x => ({ id: x.id, name: x.name.slice(0, 512) })) };
  }
  function read(storage, account) {
    const value = storage.getItem(key(account));
    if (value === null) return { version: 1, files: [], rooms: [] };
    try { return validate(JSON.parse(value)); }
    catch { throw new Error('저장된 보호 설정을 읽을 수 없습니다. 삭제 없이 중단했습니다.'); }
  }
  function write(storage, account, value) {
    const data = validate(value);
    try { storage.setItem(key(account), JSON.stringify(data)); }
    catch { throw new Error('보호 설정을 저장하지 못했습니다. 보호가 적용되지 않았습니다.'); }
    return data;
  }
  function filters(data) {
    return { protectedFileIds: data.files.map(x => x.id).sort(), protectedRoomIds: data.rooms.map(x => x.id).sort() };
  }
  function signature(data) { return JSON.stringify(filters(data)); }
  return Object.freeze({ key, read, write, filters, signature });
});
