(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.TalkCleanerOnboarding = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const KEY = 'talkcleaner.onboarding';
  const VERSION = 1;
  const steps = Object.freeze([
    Object.freeze({ title: '1. 찾을 항목 정하기', message: '기준 날짜와 사진·동영상·파일 등 종류를 선택하고 ‘목록 찾기’를 누르세요. 조회만으로 항목이 삭제되지는 않습니다.' }),
    Object.freeze({ title: '2. 목록을 보고 선택하기', message: '크기순 정렬이나 채팅방별 보기를 사용해 항목을 체크하세요. 남길 파일과 채팅방은 보호할 수 있습니다.' }),
    Object.freeze({ title: '3. 필요하면 저장하고 정리하기', message: 'PC 저장은 선택사항입니다. 선택한 항목과 개수를 확인한 뒤 휴지통으로 이동하세요. 휴지통 확인과 복원은 톡클라우드에서 진행합니다.' })
  ]);
  function fault(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }
  function validVersion(value) {
    return typeof value === 'string' && value.length <= 64 && /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(value);
  }
  function read(storage) {
    let value;
    try { value = storage.getItem(KEY); }
    catch { throw fault('ONBOARDING_UNAVAILABLE', '사용 안내 확인 상태를 읽을 수 없습니다. 브라우저의 확장 저장 공간을 확인하세요.'); }
    if (value === null) return null;
    try {
      const data = JSON.parse(value);
      if (!data || typeof data !== 'object' || Array.isArray(data) || data.version !== VERSION || !validVersion(data.seenVersion) || Object.keys(data).some(key => !['version', 'seenVersion'].includes(key))) throw new Error();
      return data;
    } catch { throw fault('ONBOARDING_INVALID', '저장된 사용 안내 상태의 형식이 다릅니다. 기존 기록을 유지했습니다. 사용 안내를 다시 확인해 주세요.'); }
  }
  function inspect(storage, version) {
    if (!validVersion(version)) throw fault('ONBOARDING_INVALID', '확장 버전 정보를 확인하지 못했습니다. 사용 안내를 열어 설치 상태를 확인하세요.');
    const data = read(storage);
    return Object.freeze({ firstRun: data === null, updated: data !== null && data.seenVersion !== version, previousVersion: data?.seenVersion || null });
  }
  function acknowledge(storage, version) {
    inspect(storage, version);
    try { storage.setItem(KEY, JSON.stringify({ version: VERSION, seenVersion: version })); }
    catch { throw fault('ONBOARDING_UNAVAILABLE', '사용 안내 확인 상태를 저장하지 못했습니다. 다음에 안내가 다시 표시될 수 있습니다.'); }
    return inspect(storage, version);
  }
  function help(title, message, action, actionLabel) { return Object.freeze({ title, message, action, actionLabel }); }
  function describe(error, context = {}) {
    if (context.informational === true) return help('', '', 'none', '');
    const message = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
    const code = typeof error?.code === 'string' ? error.code : '';
    if (context.sourceClosed === true || code === 'SOURCE_CLOSED' || /No tab with id|Invalid tab ID|탭.*닫|탭.*이동|탭과 연결이 끊|Cannot access contents|Extension manifest must request permission/.test(message))
      return help('톡클라우드 탭을 다시 연결하세요', '톡클라우드 탭을 열고 로그인한 뒤, 그 탭에서 확장 아이콘을 눌러 주세요. 남은 작업은 현재 목록을 다시 확인한 뒤 계속할 수 있습니다.', 'source', '톡클라우드 열기');
    if (code === 'AUTH_REQUIRED' || /추가 인증|인증이 필요|인증.*만료/.test(message))
      return help('카카오 인증을 완료해 주세요', '톡클라우드 탭으로 돌아가 로그인과 추가 인증을 완료한 뒤 목록을 다시 찾으세요. 비밀번호나 인증 코드를 확장에 입력할 필요는 없습니다.', 'source', '톡클라우드에서 인증하기');
    if (code === 'LOGIN_REQUIRED' || /로그인/.test(message))
      return help('톡클라우드에 로그인해 주세요', '톡클라우드 탭에서 카카오 계정으로 로그인한 뒤 목록을 다시 찾으세요.', 'source', '톡클라우드에서 로그인하기');
    if (code === 'PLAN_EXPIRED' || /1시간|유효기간|조회.*만료|최신 목록/.test(message))
      return help('현재 목록을 다시 확인하세요', '조회한 지 시간이 지나 현재 상태를 확인해야 합니다. 같은 조건으로 목록을 다시 찾고 정리할 항목을 검토하세요.', 'scan', '목록 다시 찾기');
    if (code === 'UNSUPPORTED_TYPE' || /지원하지 않는 분류|지원하지 않는.*유형|녹음을 저장할 수|다운로드 대상이 아닙니다|사진·GIF·동영상·파일만/.test(message))
      return help('이 항목은 저장을 지원하지 않습니다', '사진·GIF·동영상·파일은 원본 저장을 지원합니다. 통화 녹음은 공식 모바일 앱에서 확인하고, 링크는 목록 정보로 남길 수 있습니다.', 'guide', '저장 지원 범위 보기');
    if (code === 'ONBOARDING_INVALID' || code === 'ONBOARDING_UNAVAILABLE')
      return help('사용 안내 상태를 확인해 주세요', '사용 안내 확인 기록을 읽거나 저장하지 못했습니다. 기존 기록은 유지되며, 보호 설정과 백업에는 영향을 주지 않습니다.', 'guide', '사용 안내 보기');
    if (/보호 설정.*바뀌|보호한 항목|보호.*채팅방/.test(message))
      return help('보호 조건을 다시 확인하세요', '보호 항목과 채팅방을 확인한 뒤 목록을 다시 찾으세요. 보호 조건이 달라진 목록으로는 정리를 계속하지 않습니다.', 'scan', '목록 다시 찾기');
    if (/계정.*바뀌|계정과 달라/.test(message))
      return help('연결한 계정이 달라졌습니다', '톡클라우드에서 정리할 계정을 확인한 뒤 목록을 다시 찾으세요. 이전 계정의 목록은 다시 사용하지 않습니다.', 'source', '톡클라우드 계정 확인하기');
    if (code === 'OUTCOME_UNKNOWN' || /결과를 확정할 수|새로 조회해 확인|대상.*남아/.test(message))
      return help('현재 처리 결과를 확인하세요', '일부 요청의 완료 여부를 확인하지 못했습니다. 같은 항목을 바로 다시 정리하지 말고 현재 목록을 다시 찾아 남은 항목을 확인하세요.', 'scan', '현재 목록 확인하기');
    return help('다음 단계를 확인해 주세요', '진행 상태에 표시된 내용을 확인하세요. 문제가 계속되면 톡클라우드 연결과 조회 조건을 확인한 뒤 목록을 다시 찾으세요.', 'guide', '사용 안내 보기');
  }
  return Object.freeze({ KEY, VERSION, steps, inspect, acknowledge, describe });
});
