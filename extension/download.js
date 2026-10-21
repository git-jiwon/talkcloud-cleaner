(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TalkCleanerDownload = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULT_TIMEOUT = 10 * 60 * 1000;
  const LARGE_FILE_TIMEOUT = 30 * 60 * 1000;
  const FOLDER = /^TalkCloud-Backup\/\d{8}-\d{6}$/;
  const IMAGE_EXTENSION = /\.(?:jpe?g|jpe|jfif|png|gif|webp|bmp|heic|heif|avif|tiff?)$/i;
  const VIDEO_EXTENSION = /\.(?:mp4|mov|m4v|avi|mkv|webm|3gp|3g2|wmv|mpeg|mpg|m2ts|mts|ts|vob|ogv|flv)$/i;
  const MIME = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
  const KINDS = ['photo', 'gif', 'video', 'file'];
  function fail(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  function eligible(record) {
    return !!record && ((record.verticalType === 'MEDIA' && ['photo', 'gif', 'video'].includes(record.kind)) ||
      (record.verticalType === 'FILE' && record.kind === 'file'));
  }
  function photos(records) { return (records || []).filter(record => eligible(record) && ['photo', 'gif'].includes(record.kind)); }
  function files(records) { return (records || []).filter(eligible); }
  function receiptKey(account, record) {
    if (typeof account !== 'string' || !account.trim() || !eligible(record) || typeof record.id !== 'string' || !record.id) {
      throw fail('INVALID_RECORD', '다운로드할 항목과 계정을 확인하지 못했습니다.');
    }
    return JSON.stringify([account, record.id, record.kind, record.createdAt, record.size ?? null, record.name ?? '']);
  }
  function folder(now = new Date()) {
    const date = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(date.getTime())) throw fail('INVALID_DATE', '저장 폴더의 날짜를 확인하지 못했습니다.');
    const pad = value => String(value).padStart(2, '0');
    return `TalkCloud-Backup/${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  }
  function filename(record, index, directory) {
    if (!eligible(record) || !Number.isSafeInteger(index) || index < 0 || !FOLDER.test(directory || '')) {
      throw fail('INVALID_FILENAME', '파일 저장 경로를 확인하지 못했습니다.');
    }
    const fallback = record.kind === 'file' ? 'file.bin' : record.kind === 'video' ? 'video.mp4' : 'photo';
    let name = String(record.name || fallback).normalize('NFC')
      .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/g, '_')
      .replace(/\.{2,}/g, '_').replace(/^[. ]+|[. ]+$/g, '');
    if (!name) name = fallback;
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) name = `_${name}`;
    const match = name.match(record.kind === 'file' ? /\.[^.]{1,24}$/ : record.kind === 'video' ? VIDEO_EXTENSION : IMAGE_EXTENSION);
    const extension = record.kind === 'file' ? match?.[0] || '' : record.kind === 'gif' ? '.gif' : match ? match[0].toLowerCase() : record.kind === 'video' ? '.mp4' : '.jpg';
    const stem = match ? name.slice(0, -match[0].length) : name;
    // Windows counts UTF-16 units in filename limits. Keep whole Unicode characters
    // while leaving room for the numbered prefix, extension and duplicate suffix.
    let shortened = '';
    for (const character of stem) {
      if (shortened.length + character.length > 120) break;
      shortened += character;
    }
    name = shortened.replace(/[. ]+$/g, '') || 'file';
    return `${directory}/${String(index + 1).padStart(6, '0')}_${name}${extension}`;
  }
  function validateUrl(value) {
    let url;
    try { url = new URL(value); } catch (_) { throw fail('UNSAFE_URL', '원본 파일 주소를 확인하지 못했습니다.'); }
    const hostname = url.hostname.toLowerCase();
    const trusted = ['kakaocdn.net', 'kakao.com'].some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
    if (typeof value !== 'string' || !trusted || url.protocol !== 'https:' || url.username || url.password || url.port || url.hash) {
      throw fail('UNSAFE_URL', '허용되지 않은 원본 파일 주소입니다. 다운로드를 중단했습니다.');
    }
    return url.href;
  }
  function expectedBytes(value) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value) || value < 0) throw fail('INVALID_SIZE', '원본 파일 크기를 확인하지 못했습니다.');
    return value;
  }
  function kindOf(value) {
    const kind = value === undefined ? 'photo' : value;
    if (!KINDS.includes(kind)) throw fail('INVALID_KIND', '사진·GIF·동영상·파일만 다운로드할 수 있습니다.');
    return kind;
  }
  function mimeOf(value, optional = false) {
    if (optional && (value == null || value === '')) return '';
    if (typeof value !== 'string') return '';
    const mime = value.split(';', 1)[0].trim().toLowerCase();
    return MIME.test(mime) ? mime : '';
  }
  function errorPageKind(mime) {
    if (['text/html', 'application/xhtml+xml'].includes(mime)) return 'html';
    if (mime === 'application/json' || mime === 'text/json' || mime.endsWith('+json')) return 'json';
    return '';
  }
  function validateContent(item, kind, expectedMime, size, bytes) {
    const mime = mimeOf(item.mime);
    const binary = mime === 'application/octet-stream';
    let valid = !!mime;
    if (kind === 'photo' || kind === 'gif') valid = valid && (mime.startsWith('image/') || binary);
    else if (kind === 'video') valid = valid && (mime.startsWith('video/') || binary);
    else {
      const page = errorPageKind(mime) || errorPageKind(expectedMime);
      if (page) {
        const named = page === 'html' ? /\.(?:html?|xhtml)$/i.test(item.filename || '') : /\.json$/i.test(item.filename || '');
        // HTML/JSON attachments are valid only when their original metadata, name and exact size all agree.
        valid = valid && named && errorPageKind(expectedMime) === page &&
          (binary || errorPageKind(mime) === page) && size !== null && size === bytes;
      }
    }
    if (!valid) throw fail('INVALID_CONTENT', '선택한 유형 대신 오류 페이지나 다른 형식이 저장되었습니다. 이 항목은 백업 완료로 처리하지 않습니다.');
  }
  function validApi(api) {
    if (!api || typeof api.search !== 'function') throw fail('UNAVAILABLE', '브라우저 다운로드 기능을 사용할 수 없습니다. 확장을 다시 로드해 주세요.');
  }
  function checkDanger(item, inProgress = false) {
    // Never bypass browser warnings (including a previously accepted dangerous file).
    // Some older/mock APIs omit danger. Pending scans may continue, but cannot qualify as a completed backup.
    const danger = item.danger;
    if (danger === undefined || danger === 'safe' || danger === 'deepScannedSafe') return;
    if (inProgress && ['asyncScanning', 'asyncLocalPasswordScanning'].includes(danger)) return;
    throw fail('DANGEROUS_DOWNLOAD', '브라우저가 파일 다운로드의 안전성을 확인하지 못했습니다. 이 항목은 백업 완료로 처리하지 않습니다.');
  }
  function completed(item, id, size, kind, expectedMime) {
    if (!item || item.id !== id || item.state !== 'complete') throw fail('NOT_COMPLETE', '파일 다운로드가 완료되지 않았습니다.');
    checkDanger(item);
    if (item.exists === false) throw fail('MISSING_FILE', '다운로드한 파일이 삭제되었거나 이동되었습니다.');
    validateUrl(item.url);
    if (!item.finalUrl) throw fail('UNSAFE_URL', '다운로드한 파일의 최종 주소를 확인하지 못했습니다.');
    validateUrl(item.finalUrl);
    const bytes = Number.isSafeInteger(item.fileSize) && item.fileSize >= 0 ? item.fileSize : item.bytesReceived;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || (bytes === 0 && !(kind === 'file' && size === 0))) throw fail('EMPTY_FILE', '저장된 파일의 크기를 확인하지 못했습니다.');
    validateContent(item, kind, expectedMime, size, bytes);
    if (Number.isSafeInteger(item.bytesReceived) && item.bytesReceived > 0 && item.bytesReceived !== bytes) {
      throw fail('SIZE_MISMATCH', '다운로드한 파일의 전송 크기가 일치하지 않습니다.');
    }
    if (size !== null && size !== bytes) throw fail('SIZE_MISMATCH', '다운로드한 파일의 크기가 원본 정보와 다릅니다. 이 항목은 백업 완료로 처리하지 않습니다.');
    if (typeof item.filename !== 'string' || !item.filename.trim()) throw fail('MISSING_FILENAME', '저장된 파일의 이름을 확인하지 못했습니다.');
    return { downloadId: id, filename: item.filename, bytes, state: 'complete', expectedSize: size, kind, expectedMime };
  }
  async function find(api, id) {
    let found;
    try { found = await api.search({ id }); }
    catch (_) { throw fail('LOOKUP_FAILED', '브라우저 다운로드 상태를 확인하지 못했습니다.'); }
    if (!Array.isArray(found) || found.length !== 1 || found[0].id !== id) {
      throw fail('MISSING_DOWNLOAD', '다운로드 기록을 찾지 못했습니다. 파일을 다시 백업해 주세요.');
    }
    return found[0];
  }
  async function cancelOwned(api, id) {
    if (!Number.isSafeInteger(id) || typeof api.cancel !== 'function') return;
    try {
      const found = await api.search({ id });
      if (Array.isArray(found) && found.length === 1 && found[0].id === id && found[0].state === 'in_progress') await api.cancel(id);
    } catch (_) { /* A cancellation failure is not a successful backup. The caller still reports the original failure. */ }
  }
  async function saveOne(api, request, options = {}) {
    validApi(api);
    if (typeof api.download !== 'function') throw fail('UNAVAILABLE', '브라우저 다운로드 기능을 사용할 수 없습니다.');
    const url = validateUrl(request && request.url);
    const name = request && request.filename;
    const kind = kindOf(request?.kind), expectedMime = mimeOf(request?.expectedMime, true);
    if (request?.expectedMime && !expectedMime) throw fail('INVALID_MIME', '원본 파일 형식을 확인하지 못했습니다.');
    const validExtension = kind === 'file' || (kind === 'video' ? VIDEO_EXTENSION : IMAGE_EXTENSION).test(name || '');
    if (typeof name !== 'string' || !/^TalkCloud-Backup\/\d{8}-\d{6}\/\d+_[^/\\]+$/.test(name) || !validExtension || /[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069<>:"|?*]/.test(name) || name.includes('..') || /[. ]$/.test(name)) {
      throw fail('INVALID_FILENAME', '파일 저장 경로를 확인하지 못했습니다.');
    }
    const size = expectedBytes(request.expectedSize);
    const shouldStop = typeof options.shouldStop === 'function' ? options.shouldStop : () => false;
    const sleep = typeof options.sleep === 'function' ? options.sleep : milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
    const now = typeof options.now === 'function' ? options.now : Date.now;
    const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : ['video', 'file'].includes(kind) ? LARGE_FILE_TIMEOUT : DEFAULT_TIMEOUT;
    const poll = Number.isFinite(options.pollMs) && options.pollMs > 0 ? options.pollMs : 500;
    if (shouldStop()) throw fail('STOPPED', '파일 다운로드를 중지했습니다.');
    let id;
    try { id = await api.download({ url, filename: name, conflictAction: 'uniquify', saveAs: false }); }
    catch (_) { throw fail('START_FAILED', '파일 다운로드를 시작하지 못했습니다. 브라우저 다운로드 설정을 확인해 주세요.'); }
    if (!Number.isSafeInteger(id) || id < 0) throw fail('START_FAILED', '브라우저 다운로드 번호를 확인하지 못했습니다.');
    const started = now();
    try {
      for (;;) {
        if (shouldStop()) throw fail('STOPPED', '파일 다운로드를 중지했습니다.');
        if (now() - started >= timeout) throw fail('TIMEOUT', '파일 다운로드 대기 시간이 지났습니다. 브라우저 다운로드 목록을 확인해 주세요.');
        const item = await find(api, id);
        if (shouldStop()) throw fail('STOPPED', '파일 다운로드를 중지했습니다.');
        if (now() - started >= timeout) throw fail('TIMEOUT', '파일 다운로드 대기 시간이 지났습니다. 브라우저 다운로드 목록을 확인해 주세요.');
        if (item.state === 'complete') return completed(item, id, size, kind, expectedMime);
        if (item.state !== 'in_progress') throw fail('INTERRUPTED', '파일 다운로드가 중단되었습니다. 브라우저 다운로드 목록을 확인해 주세요.');
        checkDanger(item, true);
        validateUrl(item.url);
        if (item.finalUrl) validateUrl(item.finalUrl);
        if (typeof options.onProgress === 'function') options.onProgress({ downloadId: id, bytes: Math.max(0, Number(item.bytesReceived) || 0), totalBytes: Math.max(0, Number(item.totalBytes) || 0), state: 'in_progress' });
        await sleep(Math.min(poll, Math.max(1, timeout - (now() - started))));
      }
    } catch (error) {
      await cancelOwned(api, id);
      throw error;
    }
  }
  async function checkReceipt(api, receipt) {
    validApi(api);
    if (!receipt || receipt.state !== 'complete' || !Number.isSafeInteger(receipt.downloadId) || receipt.downloadId < 0 ||
        typeof receipt.filename !== 'string' || !receipt.filename || !Number.isSafeInteger(receipt.bytes) || receipt.bytes < 0 ||
        (receipt.bytes === 0 && !(receipt.kind === 'file' && receipt.expectedSize === 0))) {
      throw fail('INVALID_RECEIPT', '파일 백업 완료 기록을 확인하지 못했습니다.');
    }
    const kind = kindOf(receipt.kind), expectedMime = mimeOf(receipt.expectedMime, true);
    if (receipt.expectedMime && !expectedMime) throw fail('INVALID_RECEIPT', '파일 백업 형식 기록을 확인하지 못했습니다.');
    const result = completed(await find(api, receipt.downloadId), receipt.downloadId, expectedBytes(receipt.expectedSize), kind, expectedMime);
    if (result.filename !== receipt.filename || result.bytes !== receipt.bytes) throw fail('CHANGED_FILE', '백업 완료 기록과 현재 다운로드 정보가 다릅니다.');
    return result;
  }
  return Object.freeze({ eligible, photos, files, receiptKey, folder, filename, validateUrl, saveOne, checkReceipt });
});
