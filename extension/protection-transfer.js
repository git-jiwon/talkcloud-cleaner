(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./protection.js'));
  else root.TalkCleanerProtectionTransfer = factory(root.TalkCleanerProtection);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Protection) {
  'use strict';
  const FORMAT = 'talkcloud-cleaner-protection-backup';
  const PREFIX = 'talkcloud-protection-v1:';
  const LIMITS = Object.freeze({ bytes: 10 * 1024 * 1024, accounts: 1000, entries: 100000 });
  const fail = message => { throw new Error(message); };
  const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
  const bytes = text => new TextEncoder().encode(text).length;
  function fields(value, expected, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
        Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key)))
      fail(`${label} 형식이 잘못되었습니다. 설정을 변경하지 않았습니다.`);
  }
  function validId(value) { return typeof value === 'string' && value.trim().length > 0 && value.length <= 512; }
  function strictProtection(value, budget) {
    fields(value, ['version', 'files', 'rooms'], '보호 목록');
    if (value.version !== 1 || !Array.isArray(value.files) || !Array.isArray(value.rooms))
      fail('지원하지 않거나 손상된 보호 목록입니다.');
    const result = { version: 1, files: [], rooms: [] };
    for (const collection of ['files', 'rooms']) {
      budget.entries += value[collection].length;
      if (budget.entries > LIMITS.entries) fail('보호 항목 수가 이전 도구의 한도를 초과합니다.');
      const seen = new Set();
      for (const item of value[collection]) {
        fields(item, ['id', 'name'], '보호 항목');
        if (!validId(item.id) || typeof item.name !== 'string' || item.name.length > 512)
          fail('보호 항목 ID 또는 이름이 잘못되었습니다. 값을 자르거나 누락하지 않고 중단합니다.');
        if (seen.has(item.id)) fail('보호 목록에 중복 ID가 있습니다.');
        seen.add(item.id); result[collection].push({ id: item.id, name: item.name });
      }
      result[collection].sort((a, b) => cmp(a.id, b.id));
    }
    return result;
  }
  function parseBackup(input) {
    let value = input;
    if (typeof value === 'string') {
      if (bytes(value) > LIMITS.bytes) fail('백업 파일이 10 MiB 한도를 초과합니다.');
      try { value = JSON.parse(value); } catch { fail('보호 설정 백업 JSON을 읽을 수 없습니다.'); }
    }
    fields(value, ['format', 'version', 'createdAt', 'accounts'], '백업');
    if (value.format !== FORMAT || value.version !== 1) fail('톡클라우드 보호 설정 백업 파일이 아니거나 지원하지 않는 버전입니다.');
    if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) ||
        new Date(value.createdAt).toISOString() !== value.createdAt) fail('백업 생성 시각이 잘못되었습니다.');
    if (!Array.isArray(value.accounts) || value.accounts.length > LIMITS.accounts) fail('백업 계정 목록이 잘못되었거나 한도를 초과합니다.');
    const seen = new Set(), budget = { entries: 0 };
    const accounts = value.accounts.map(entry => {
      fields(entry, ['account', 'protection'], '백업 계정');
      if (!validId(entry.account)) fail('백업 계정 ID가 잘못되었습니다.');
      if (seen.has(entry.account)) fail('백업에 중복 계정 ID가 있습니다.');
      seen.add(entry.account);
      return { account: entry.account, protection: strictProtection(entry.protection, budget) };
    }).sort((a, b) => cmp(a.account, b.account));
    const result = { format: FORMAT, version: 1, createdAt: value.createdAt, accounts };
    if (bytes(JSON.stringify(result)) > LIMITS.bytes) fail('백업 파일이 10 MiB 한도를 초과합니다.');
    return result;
  }
  function readRaw(storage, key) {
    let value;
    try { value = storage.getItem(key); } catch { fail('브라우저 보호 설정 저장소를 읽을 수 없습니다.'); }
    if (value !== null && typeof value !== 'string') fail('브라우저 보호 설정 저장소 응답이 잘못되었습니다.');
    return value;
  }
  function decodeProtection(raw, budget = { entries: 0 }) {
    if (raw === null) return { version: 1, files: [], rooms: [] };
    if (bytes(raw) > LIMITS.bytes) fail('저장된 보호 설정이 이전 도구의 한도를 초과합니다.');
    let value;
    try { value = JSON.parse(raw); } catch { fail('저장된 보호 설정이 손상되었습니다. 설정을 변경하지 않았습니다.'); }
    return strictProtection(value, budget);
  }
  function createBackup(storage) {
    let count, keys;
    try {
      count = storage.length;
      if (!Number.isSafeInteger(count) || count < 0) fail('저장소 목록을 확인하지 못했습니다.');
      keys = Array.from({ length: count }, (_, index) => storage.key(index));
    } catch { fail('브라우저 보호 설정 저장소 목록을 읽을 수 없습니다.'); }
    if (keys.some(key => typeof key !== 'string') || new Set(keys).size !== keys.length) fail('저장소 목록이 바뀌었습니다. 다시 백업하세요.');
    const relevant = keys.filter(key => key.startsWith(PREFIX));
    if (relevant.length > LIMITS.accounts) fail('보호 계정 수가 이전 도구의 한도를 초과합니다.');
    const snapshots = new Map(), budget = { entries: 0 };
    const accounts = relevant.map(key => {
      const account = key.slice(PREFIX.length);
      if (!validId(account) || Protection.key(account) !== key) fail('저장된 보호 계정 ID가 잘못되었습니다.');
      const raw = readRaw(storage, key);
      if (raw === null) fail('백업 중 보호 설정이 바뀌었습니다. 다시 백업하세요.');
      snapshots.set(key, raw);
      return { account, protection: decodeProtection(raw, budget) };
    });
    const result = parseBackup({ format: FORMAT, version: 1, createdAt: new Date().toISOString(), accounts });
    for (const [key, raw] of snapshots) if (readRaw(storage, key) !== raw) fail('백업 중 보호 설정이 바뀌었습니다. 다시 백업하세요.');
    let currentKeys;
    try { currentKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter(key => typeof key === 'string' && key.startsWith(PREFIX)).sort(cmp); }
    catch { fail('백업 중 저장소 목록을 확인하지 못했습니다.'); }
    if (JSON.stringify(currentKeys) !== JSON.stringify([...relevant].sort(cmp))) fail('백업 중 보호 계정 목록이 바뀌었습니다. 다시 백업하세요.');
    return result;
  }
  function summary(accounts) {
    return accounts.reduce((result, entry) => {
      result.accounts++; result.files += entry.protection.files.length; result.rooms += entry.protection.rooms.length;
      return result;
    }, { accounts: 0, files: 0, rooms: 0 });
  }
  function summarize(backup) { return summary(parseBackup(backup).accounts); }
  function prepare(storage, input) {
    const backup = parseBackup(input), before = [], after = [], targets = [], budget = { entries: 0 };
    let addedFiles = 0, addedRooms = 0;
    for (const entry of backup.accounts) {
      const key = Protection.key(entry.account), raw = readRaw(storage, key), current = decodeProtection(raw, budget);
      if (raw !== null) before.push({ account: entry.account, protection: current });
      const merged = { version: 1, files: [], rooms: [] };
      for (const collection of ['files', 'rooms']) {
        const values = new Map(current[collection].map(item => [item.id, item]));
        for (const item of entry.protection[collection]) if (!values.has(item.id)) values.set(item.id, item);
        merged[collection] = [...values.values()].sort((a, b) => cmp(a.id, b.id));
      }
      addedFiles += merged.files.length - current.files.length;
      addedRooms += merged.rooms.length - current.rooms.length;
      after.push({ account: entry.account, protection: merged });
      targets.push({ key, before: raw, written: JSON.stringify(merged) });
    }
    // Bound the merged result as well as the incoming backup, before any write.
    parseBackup({ ...backup, accounts: after });
    return { targets, result: { before: summary(before), incoming: summary(backup.accounts), after: summary(after), addedFiles, addedRooms } };
  }
  function previewMerge(storage, backup) { return prepare(storage, backup).result; }
  function applyMerge(storage, backup) {
    const { targets, result } = prepare(storage, backup), attempted = [];
    try {
      for (const target of targets) {
        if (readRaw(storage, target.key) !== target.before) fail('이전 중 보호 설정이 바뀌었습니다. 다시 미리보기 하세요.');
        if (target.before !== target.written) {
          attempted.push(target);
          storage.setItem(target.key, target.written);
        }
        if (readRaw(storage, target.key) !== target.written) fail('보호 설정 저장 결과가 일치하지 않습니다.');
      }
      for (const target of targets) if (readRaw(storage, target.key) !== target.written) fail('이전 검증 중 보호 설정이 바뀌었습니다.');
      return { ...result, verified: true };
    } catch (cause) {
      let rollbackFailures = 0;
      for (const target of attempted.reverse()) {
        try {
          const current = readRaw(storage, target.key);
          if (current === target.before) continue;
          // Never overwrite a concurrent change from another manager window.
          if (current !== target.written) throw new Error('Concurrent change');
          if (target.before === null) storage.removeItem(target.key);
          else storage.setItem(target.key, target.before);
          if (readRaw(storage, target.key) !== target.before) throw new Error('Rollback verification failed');
        } catch { rollbackFailures++; }
      }
      const error = new Error(rollbackFailures ?
        '보호 설정 이전에 실패했으며 일부 설정을 원래 상태로 복구하지 못했습니다. 기존 확장을 제거하지 말고 백업을 보관하세요.' :
        '보호 설정 이전에 실패했습니다. 변경한 설정을 원래 상태로 복구했습니다.');
      error.code = rollbackFailures ? 'ROLLBACK_INCOMPLETE' : 'TRANSFER_FAILED';
      error.rollbackComplete = rollbackFailures === 0;
      error.rollbackFailures = rollbackFailures;
      throw error;
    }
  }
  function canonical(backup) {
    const normalized = parseBackup(backup);
    return JSON.stringify({ format: normalized.format, version: normalized.version, accounts: normalized.accounts });
  }
  return Object.freeze({ FORMAT, LIMITS, createBackup, parseBackup, previewMerge, applyMerge, summarize, canonical });
});
