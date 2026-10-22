(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TalkCleanerPreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function eligible(record) {
    return Boolean(record && record.verticalType === 'MEDIA' && ['photo', 'gif', 'video'].includes(record.kind));
  }
  function validateUrl(value) {
    let parsed, pathname;
    try { parsed = new URL(value); pathname = decodeURIComponent(parsed.pathname); }
    catch { throw new Error('미리보기 주소를 확인하지 못했습니다.'); }
    const trusted = ['kakao.com', 'kakaocdn.net'].some(host => parsed.hostname === host || parsed.hostname.endsWith(`.${host}`));
    if (typeof value !== 'string' || value.length > 16384 || value !== value.trim() || /[\\\u0000-\u001f\u007f]/.test(value) ||
        !/^https:\/\//i.test(value) || parsed.protocol !== 'https:' || parsed.username || parsed.password ||
        parsed.port || parsed.hash || !trusted || /\.(?:svgz?|html?|xhtml|xml)$/i.test(pathname))
      throw new Error('허용되지 않은 미리보기 주소입니다.');
    return value;
  }
  function validateResult(result, record) {
    if (!eligible(record) || typeof record.id !== 'string' || !record.id.trim() || record.id.length > 512 ||
        !result || result.id !== record.id || result.kind !== record.kind ||
        result.source !== 'thumbnail' || typeof result.name !== 'string' || result.name.length > 512)
      throw new Error('선택한 항목의 미리보기 정보를 확인하지 못했습니다. 다시 조회해 주세요.');
    return Object.freeze({ id: record.id, url: validateUrl(result.url), name: result.name,
      kind: record.kind, source: 'thumbnail' });
  }
  function fromRecord(record) {
    if (!eligible(record) || !record.thumbnailUrl) return null;
    try {
      return validateResult({ id: record.id, url: record.thumbnailUrl,
        name: record.name, kind: record.kind, source: 'thumbnail' }, record);
    } catch { return null; }
  }
  return Object.freeze({ eligible, validateUrl, validateResult, fromRecord });
});
