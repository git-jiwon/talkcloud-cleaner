(() => {
  'use strict';
  if (location.origin !== 'https://talkcloud.kakao.com') return;
  const P = globalThis.TalkCleanerProtocol;
  function fault(message) { const error = new Error(message); error.safe = true; return error; }
  async function request(url, options = {}) {
    if (location.origin !== 'https://talkcloud.kakao.com') throw new Error('톡클라우드 탭이 이동했습니다.');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(url, {
        ...options, credentials: 'include', redirect: 'error', signal: controller.signal,
        headers: { Accept: 'application/json+javascript', ...(options.method ? { 'Content-Type': 'application/json' } : {}) }
      });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw fault('카카오 로그인 또는 추가 인증이 필요합니다. 톡클라우드 탭에서 인증한 뒤 다시 열어 주세요.');
        if (response.status === 429) throw fault('요청 제한(429)으로 중단했습니다. 잠시 후 다시 조회하세요.');
        throw fault(`서버 응답 ${response.status}. 자동으로 재시도하지 않았습니다.`);
      }
      if (options.method) return { accepted: true };
      return await response.json();
    } catch (error) {
      const message = error.safe ? error.message : '연결이 끊겼거나 응답을 읽지 못했습니다. 톡클라우드 로그인과 연결 상태를 확인하세요.';
      if (options.method) throw new Error(`삭제 요청 결과를 확정할 수 없습니다. 새로 조회해 확인하세요. ${message}`);
      throw new Error(`조회 실패: ${message}`);
    } finally { clearTimeout(timeout); }
  }
  async function account() {
    const data = await request(`${P.ORIGIN}/user/info`);
    if (typeof data?.fullHashedAccountId !== 'string' || !data.fullHashedAccountId)
      throw new Error('로그인한 계정을 확인하지 못해 중단했습니다.');
    return data.fullHashedAccountId;
  }
  globalThis.TalkCleanerBridge = Object.freeze({
    account,
    async readPage(options) {
      return P.parsePage(await request(P.listUrl(options)), options);
    },
    async readRooms(options) {
      return P.parseRooms(await request(P.roomsUrl(options.verticalType)));
    },
    async originalFile(options) {
      const { record, criteria } = options || {};
      if (!criteria?.account) throw new Error('조회할 때의 카카오 계정을 확인하지 못해 파일 저장을 중단했습니다.');
      const url = P.detailUrl(record);
      if (await account() !== criteria.account)
        throw new Error('조회할 때의 카카오 계정과 달라 파일 저장을 중단했습니다.');
      const detail = await request(url);
      const result = P.parseOriginalFile(detail, record, criteria);
      if (await account() !== criteria.account) throw new Error('파일 정보를 확인하는 동안 계정이 바뀌었습니다.');
      return result;
    },
    async originalPhoto(options) {
      const { record, criteria } = options || {};
      if (!criteria?.account || await account() !== criteria.account)
        throw new Error('조회할 때의 카카오 계정과 달라 사진 저장을 중단했습니다.');
      const detail = await request(P.photoDetailUrl(record));
      const result = P.parseOriginalPhoto(detail, record, criteria);
      if (await account() !== criteria.account) throw new Error('사진 정보를 확인하는 동안 계정이 바뀌었습니다.');
      return result;
    },
    async previewPhoto(options) {
      const { record, criteria } = options || {};
      if (!criteria?.account) throw new Error('조회할 때의 카카오 계정을 확인하지 못해 미리보기를 중단했습니다.');
      const url = P.photoDetailUrl(record);
      if (await account() !== criteria.account)
        throw new Error('조회할 때의 카카오 계정과 달라 미리보기를 중단했습니다.');
      const detail = await request(url);
      const result = P.parsePhotoPreview(detail, record, criteria);
      if (await account() !== criteria.account) throw new Error('사진 정보를 확인하는 동안 계정이 바뀌었습니다.');
      return result;
    },
    async trash(options) {
      const body = P.trashBody(options.records, options.cutoff, options);
      if (!options.account || await account() !== options.account)
        throw new Error('조회할 때의 카카오 계정과 달라 중단했습니다. 다시 조회하세요.');
      return request(`${P.ORIGIN}/trashcan`, { method: 'POST', body: JSON.stringify(body) });
    }
  });
})();
