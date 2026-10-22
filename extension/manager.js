(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const P = globalThis.TalkCleanerProtocol;
  const S = globalThis.TalkCleanerProtection;
  const R = globalThis.TalkCleanerReview;
  const D = globalThis.TalkCleanerDownload;
  const W = globalThis.TalkCleanerWorkspace;
  const O = globalThis.TalkCleanerOnboarding;
  const V = globalThis.TalkCleanerPreview;
  const tabId = Number(new URLSearchParams(location.search).get('tabId'));
  let busy = false, stopped = false, ready = false, plan = null, logLines = [], pageIndex = 0;
  let jobKind = null, downloadRun = null, lastTrashSummary = '', reviewNeedsRefresh = false;
  const savedFiles = new Map();
  const selectedIds = new Set(), expandedRooms = new Set(), roomPages = new Map();
  let reviewView = 'flat', filteredRecords = [], visibleRecords = [], reviewPages = 1;
  const reviewFields = ['reviewSearch', 'reviewRoom', 'reviewMinMB', 'reviewSelectedOnly', 'reviewSort'];
  const reviewButtons = ['viewFlat', 'viewRooms', 'selectPage', 'selectFiltered', 'clearSelection', 'largeFiles', 'resetReview', 'expandRooms', 'collapseRooms', 'sortName', 'sortRoom', 'sortDate', 'sortSize', 'sortKind'];
  const filterFields = ['cutoff', 'typesPhoto', 'typesVideo', 'typesFile', 'typesLink', 'typesCall', 'includeGif', 'includeLeft', 'minSizeMB', 'protectStarred'];
  const typeFields = [['typesPhoto', 'photo'], ['includeGif', 'gif'], ['typesVideo', 'video'], ['typesFile', 'file'], ['typesLink', 'link'], ['typesCall', 'recording']];
  const presets = { categoryMedia: ['photo', 'gif', 'video'], categoryFile: ['file'], categoryLink: ['link'], categoryCall: ['recording'], categoryAll: typeFields.map(([,kind]) => kind) };
  const kindLabels = { photo: '사진', gif: 'GIF', video: '동영상', file: '파일', link: '링크', recording: '통화 녹음' };
  let protectionAccount = null, protection = { version: 1, files: [], rooms: [] }, rooms = new Map();
  let workspaceAccount = null, workspaceCriteria = null, workspaceToken = null, workspaceBlocked = false;
  let outcomes = [], rememberedSelection = [], previewRequest = 0, previewFocus = null;
  const version = globalThis.chrome?.runtime?.getManifest?.().version_name || globalThis.chrome?.runtime?.getManifest?.().version || '1.0.0-rc.1';
  const selectedRecords = () => plan ? R.selected(plan.records, selectedIds) : [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const formatSize = value => {
    if (value == null) return '확인 불가';
    const units = ['B', 'KB', 'MB', 'GB', 'TB']; let u = 0;
    while (value >= 1024 && u < units.length - 1) { value /= 1024; u++; }
    return `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} ${units[u]}`;
  };
  function status(message) {
    $('status').textContent = message;
    const help = O.describe(message, { informational: !/실패|중단|확인하지 못|끊|바뀌|지났|유효하지|만료|지원하지|필요합니다|없습니다|오류|로그인/.test(message) });
    $('recoveryHelp').hidden = help.action === 'none';
    $('recoveryHelpText').textContent = help.message;
    $('recoveryAction').textContent = help.actionLabel;
    $('recoveryAction').setAttribute('data-action', help.action);
  }
  function sameCriteria(a, b) {
    const plain = c => [c.cutoff, [...c.kinds].sort(), c.minBytes, c.protectStarred, c.includeGif, c.includeLeft];
    return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
  }
  function openWorkspace(account) {
    if (workspaceAccount === account && !workspaceBlocked) return;
    const changed = workspaceAccount !== account;
    closePreview(); outcomes = []; rememberedSelection = []; workspaceCriteria = null; savedFiles.clear();
    if (changed) { downloadRun = null; invalidate(); }
    workspaceAccount = account; workspaceBlocked = false;
    try { workspaceToken = localStorage.getItem(W.key(account)); const old = W.read(localStorage, account, Date.now()); outcomes = old?.outcomes || []; }
    catch (error) { workspaceBlocked = true; throw error; }
  }
  function checkpoint(required = false) {
    if (!workspaceAccount || !workspaceCriteria) {
      if (required) throw new Error('작업 기록을 준비하지 못했습니다. 목록을 다시 조회하세요.');
      return true;
    }
    try {
      if (workspaceBlocked || localStorage.getItem(W.key(workspaceAccount)) !== workspaceToken)
        throw new Error('다른 관리 화면에서 작업 기록이 바뀌었거나 기록을 읽지 못했습니다. 이전 작업을 다시 불러오세요.');
      if (plan) rememberedSelection = selectedRecords().map(record => ({ id: record.id, fingerprint: W.fingerprint(record) }));
      const downloads = [...savedFiles].map(([recordKey, receipt]) => ({ recordKey, ...receipt, filename: receipt.filename.split(/[\\/]/).at(-1) }));
      W.write(localStorage, workspaceAccount, { criteria: workspaceCriteria, selection: rememberedSelection,
        view: { search: $('reviewSearch').value, room: $('reviewRoom').value, minMB: $('reviewMinMB').value,
          selectedOnly: $('reviewSelectedOnly').checked, sort: $('reviewSort').value, mode: reviewView }, downloads, outcomes }, Date.now());
      workspaceToken = localStorage.getItem(W.key(workspaceAccount));
      $('workspaceStatus').textContent = '이 계정의 조건·선택·저장 기록을 최근 7일간 이 Edge에 보관합니다.';
      return true;
    } catch (error) {
      $('workspaceStatus').textContent = `작업 기록 저장 중단: ${error.message}`;
      if (required) throw error;
      return false;
    }
  }
  function beginOutcome(type, records, criteria) {
    const outcome = { type, startedAt: Date.now(), finishedAt: null, criteria,
      items: records.map(record => ({ id: record.id, name: record.name || kindLabels[record.kind], kind: record.kind, size: record.size,
        fingerprint: W.fingerprint(record), state: 'not-started' })) };
    outcomes = [...outcomes, outcome].slice(-2); renderOutcomes(); return outcome;
  }
  function markOutcome(outcome, records, state) {
    const ids = new Set(records.map(record => record.id));
    for (const item of outcome.items) if (ids.has(item.id)) item.state = state;
  }
  function reconcileOutcome(outcome, result) {
    if (outcome.type !== 'trash') return;
    for (const item of outcome.items) if (['requested', 'uncertain', 'pending', 'failed'].includes(item.state))
      item.state = result.ids.has(item.id) ? 'failed' : 'verified';
    outcome.finishedAt = Date.now();
  }
  function reconcileDownloads(outcome, current) {
    const byId = new Map(current.records.map(record => [record.id, record]));
    for (const item of outcome.items) {
      const record = byId.get(item.id);
      const valid = record && D.eligible(record) && item.fingerprint === W.fingerprint(record) &&
        savedFiles.has(D.receiptKey(current.criteria.account, record));
      if (valid) item.state = 'verified';
      else if (item.state !== 'not-started') item.state = 'failed';
    }
    outcome.finishedAt = Date.now();
  }
  function renderOutcomes() {
    $('outcomeSection').hidden = !outcomes.length;
    $('outcomeList').replaceChildren();
    const labels = { verified: '완료 확인', requested: '서버 요청됨 · 재확인 필요', uncertain: '결과 확인 필요', pending: '결과 확인 필요', failed: '다시 확인 필요', 'not-started': '아직 시작하지 않음' };
    for (const outcome of [...outcomes].reverse()) {
      const card = document.createElement('section'), heading = document.createElement('h3'), counts = document.createElement('p');
      const done = outcome.items.filter(item => item.state === 'verified').length;
      heading.textContent = outcome.type === 'trash' ? '휴지통 이동' : 'PC 저장';
      counts.textContent = `전체 ${outcome.items.length.toLocaleString()}개 · 완료 확인 ${done.toLocaleString()}개 · 확인·진행 필요 ${(outcome.items.length - done).toLocaleString()}개`;
      card.append(heading, counts);
      const details = document.createElement('details'), summary = document.createElement('summary'), list = document.createElement('ul');
      summary.textContent = '항목별 결과 보기'; details.append(summary);
      for (const item of outcome.items.slice(0, 100)) {
        const row = document.createElement('li'); row.textContent = `${item.name || kindLabels[item.kind]} · ${labels[item.state]}`; list.append(row);
      }
      if (outcome.items.length > 100) { const note = document.createElement('li'); note.textContent = '화면에는 앞 100개만 표시합니다. 전체 내용은 결과 기록으로 저장할 수 있습니다.'; list.append(note); }
      details.append(list); card.append(details);
      const retry = button(outcome.type === 'trash' ? '결과 재확인·남은 항목 선택' : '저장 기록 확인·남은 파일 선택', () => retryOutcome(outcome));
      retry.disabled = busy; card.append(retry); $('outcomeList').append(card);
    }
  }
  function applyCriteria(criteria) {
    $('cutoff').value = criteria.cutoff; $('minSizeMB').value = String(criteria.minBytes / 1024 / 1024);
    $('protectStarred').checked = criteria.protectStarred; $('includeLeft').checked = criteria.includeLeft;
    for (const [id, kind] of typeFields) $(id).checked = criteria.kinds.includes(kind);
  }
  async function restoreReceipts(state, current) {
    const keys = new Set(D.files(current.records).map(record => D.receiptKey(current.criteria.account, record)));
    for (const stored of state.downloads || []) {
      if (!keys.has(stored.recordKey)) continue;
      checkPlan(current);
      try {
        const found = await chrome.downloads.search({ id: stored.downloadId });
        if (found.length !== 1 || found[0].filename.split(/[\\/]/).at(-1) !== stored.filename) continue;
        const receipt = await D.checkReceipt(chrome.downloads, { ...stored, state: 'complete', filename: found[0].filename });
        checkPlan(current); savedFiles.set(stored.recordKey, receipt);
      } catch (_) { /* Old records never bypass current browser download verification. */ }
    }
    if (await call('account') !== current.criteria.account) throw new Error('카카오 계정이 바뀌었습니다. 다시 조회하세요.');
    checkPlan(current);
  }
  async function restoreWorkspace() {
    if (busy || !ready) return;
    busy = true; update();
    let state;
    try {
      const account = await call('account'); openWorkspace(account); loadProtection(account);
      state = W.read(localStorage, account, Date.now());
      if (!state) { status('이 계정에 최근 7일 이내의 작업이 없습니다. 날짜와 유형을 정해 새로 조회하세요.'); return; }
      state = { ...state, account }; applyCriteria(state.criteria);
    } catch (error) { status(error.message); return; }
    finally { busy = false; update(); }
    await scan(state);
  }
  async function retryOutcome(outcome) {
    if (busy || !ready || !outcome.criteria || !workspaceAccount) return;
    let state;
    try { state = W.read(localStorage, workspaceAccount, Date.now()); } catch (error) { status(error.message); return; }
    applyCriteria(outcome.criteria);
    await scan({ ...(state || {}), account: workspaceAccount, criteria: outcome.criteria, retry: outcome,
      downloads: state?.downloads || [], selection: [], view: { sort: 'size-desc', mode: 'flat' } });
  }
  function closePreview() {
    previewRequest++; $('photoPreviewImage').removeAttribute('src'); $('photoPreviewImage').hidden = true;
    $('photoPreview').hidden = true; previewFocus?.focus?.(); previewFocus = null;
  }
  async function showPreview(record, control) {
    if (busy || !plan || !V.eligible(record)) return;
    const current = plan, request = ++previewRequest; previewFocus = control;
    $('photoPreview').hidden = false; $('photoPreviewTitle').textContent = record.name || '사진 미리보기';
    $('photoPreviewImage').removeAttribute('src'); $('photoPreviewImage').hidden = true;
    $('photoPreviewStatus').textContent = '썸네일을 불러오는 중… 원본 파일을 저장하지 않습니다.'; $('closePhotoPreview').focus();
    try {
      checkPlan(current);
      const result = V.validateResult(await call('previewPhoto', { record, criteria: current.criteria }), record);
      checkPlan(current);
      if (request !== previewRequest || plan !== current) return;
      $('photoPreviewImage').src = result.url; $('photoPreviewImage').hidden = false;
      $('photoPreviewStatus').textContent = '톡클라우드 썸네일입니다. 촬영 원본과 화질이 다를 수 있습니다.';
    } catch (error) { if (request === previewRequest) $('photoPreviewStatus').textContent = error.message; }
  }
  function log(message) {
    logLines.push(`[${new Date().toLocaleTimeString('ko-KR')}] ${message}`);
    $('log').textContent = logLines.slice(-300).join('\n');
  }
  function showScanWarnings({ typeMismatchCount, unknownRoomCount }) {
    const warnings = [typeMismatchCount ? `유형 정보가 일치하지 않는 ${typeMismatchCount.toLocaleString()}개는 삭제 대상에서 제외했습니다.` : '', unknownRoomCount ? `채팅방을 확인할 수 없는 ${unknownRoomCount.toLocaleString()}개는 보호 채팅방일 수 있어 제외했습니다.` : ''].filter(Boolean).join(' ');
    $('typeWarning').textContent = warnings; $('typeWarning').hidden = !warnings;
    if (warnings) log(warnings);
  }
  function update() {
    $('scan').disabled = busy || !ready;
    $('stop').disabled = !busy || stopped;
    for (const name of [...filterFields, 'refresh']) $(name).disabled = busy;
    for (const name of [...Object.keys(presets), 'loadRooms', 'roomSearch', 'clearProtectedFiles']) $(name).disabled = busy || !ready;
    $('clearProtectedFiles').disabled = busy || !protection.files.length;
    const selected = selectedRecords();
    const files = D.files(selected);
    const savedCount = plan ? files.filter(record => savedFiles.has(D.receiptKey(plan.criteria.account, record))).length : 0;
    const missing = files.length - savedCount;
    const backupBlocked = $('backupBeforeTrash').checked && missing > 0;
    $('executeSection').hidden = !lastTrashSummary;
    $('executeSummary').textContent = lastTrashSummary;
    $('execute').disabled = busy || !plan || !selected.length || backupBlocked;
    $('execute').textContent = selected.length ? `선택한 ${selected.length.toLocaleString()}개 휴지통으로 이동` : '선택한 항목을 휴지통으로 이동';
    $('executeBlockReason').textContent = busy ? '진행 중인 작업이 끝나면 계속할 수 있습니다.' : reviewNeedsRefresh ? '현재 목록은 참고용입니다. 계속 정리하려면 ‘목록 찾기’를 눌러 현재 상태를 확인하세요.' : !selected.length ? '목록에서 정리할 항목을 체크하세요.' : backupBlocked ? `다운로드 완료 조건이 켜져 있습니다. 파일 ${missing.toLocaleString()}개를 저장하거나 ‘PC에 저장’에서 조건을 해제하세요.` : '저장하지 않고 바로 정리할 수 있습니다. 버튼을 누르면 확인 창이 열립니다.';
    $('openDownload').disabled = busy || !plan || !files.length;
    $('downloadPhotos').disabled = busy || !plan || !files.length || !globalThis.chrome?.downloads;
    $('downloadPhotos').textContent = files.length ? missing ? `선택한 파일 ${files.length.toLocaleString()}개 저장` : '저장 완료 기록 다시 확인' : '선택한 파일 원본 저장';
    $('downloadStop').disabled = !busy || jobKind !== 'download' || stopped;
    $('downloadFolder').disabled = !globalThis.chrome?.downloads?.showDefaultFolder;
    $('downloadReport').disabled = busy || !downloadRun;
    $('backupBeforeTrash').disabled = busy;
    const unsupported = selected.filter(record => !D.eligible(record));
    const excluded = unsupported.length ? ` · 저장 제외: ${[...new Set(unsupported.map(record => kindLabels[record.kind]))].join('·')} ${unsupported.length.toLocaleString()}개` : '';
    $('downloadSummary').textContent = !selected.length ? '목록에서 저장할 파일을 선택하세요.' : !files.length ? `선택한 ${selected.length.toLocaleString()}개는 다운로드 대상이 아닙니다. 녹음은 공식 모바일 앱에서 확인하고, 링크는 목록 정보로 남길 수 있습니다.` : `저장 가능한 파일 ${files.length.toLocaleString()}개 중 이 화면에서 저장 완료를 확인한 항목 ${savedCount.toLocaleString()}개${excluded}`;
    $('export').disabled = busy || !selected.length;
    $('previewPrevious').disabled = busy || !plan || pageIndex <= 0;
    $('previewNext').disabled = busy || !plan || pageIndex + 1 >= reviewPages;
    for (const name of [...reviewFields, ...reviewButtons]) $(name).disabled = busy || !plan;
    $('reviewLoadRooms').disabled = busy || !ready;
    $('largeFiles').setAttribute('aria-pressed', String(Number($('reviewMinMB').value) === 50));
    $('selectPage').disabled = busy || !plan || !visibleRecords.length;
    $('selectFiltered').disabled = busy || !plan || !filteredRecords.length;
    $('clearSelection').disabled = busy || !selected.length;
    for (const control of document.querySelectorAll('#preview input, #preview button, #groupPreview input, #groupPreview button')) control.disabled = busy || !plan || control.getAttribute('data-boundary-disabled') === 'true';
    for (const control of document.querySelectorAll('#roomList input, #protectedFiles button')) control.disabled = busy;
    for (const [name, kinds] of Object.entries(presets)) {
      const selectedKinds = typeFields.filter(([id]) => $(id).checked).map(([,kind]) => kind);
      $(name).setAttribute('aria-pressed', String(name === 'categoryAll' ? selectedKinds.length === kinds.length : selectedKinds.length > 0 && selectedKinds.every(kind => kinds.includes(kind))));
    }
    $('restoreWorkspace').disabled = busy || !ready;
    $('forgetWorkspace').disabled = busy || !ready;
    $('exportOutcomes').disabled = busy || !outcomes.length;
    renderOutcomes();
    if (!busy && plan) checkpoint();
  }
  function invalidate() {
    closePreview();
    $('reviewSearch').value = ''; $('reviewRoom').value = ''; $('reviewMinMB').value = '0'; $('reviewSelectedOnly').checked = false; $('reviewSort').value = 'size-desc';
    $('downloadProgress').max = 1; $('downloadProgress').value = 0;
    $('downloadStatus').textContent = downloadRun ? '새 목록에서는 저장 완료 확인을 다시 진행합니다. 이전에 PC에 저장한 파일은 유지됩니다.' : '2단계에서 항목을 체크한 뒤 ‘선택한 파일 저장’을 누르세요.';
    plan = null; lastTrashSummary = ''; reviewNeedsRefresh = false; savedFiles.clear(); selectedIds.clear(); expandedRooms.clear(); roomPages.clear(); pageIndex = 0; $('typeWarning').textContent = ''; $('typeWarning').hidden = true; render([]); update();
  }
  function loadProtection(account) {
    if (protectionAccount !== account) {
      rooms = new Map(); protectionAccount = null; protection = { version: 1, files: [], rooms: [] }; renderProtection();
    }
    protection = S.read(localStorage, account); protectionAccount = account; renderProtection();
  }
  function roomName(record) {
    return rooms.get(record.roomId)?.name || protection.rooms.find(room => room.id === record.roomId)?.name || (record.roomId ? `${record.joined === false ? '나간 채팅방 · ' : ''}이름 미확인 (${record.roomId.slice(0, 10)})` : '채팅방 확인 불가');
  }
  function mutateProtection(change) {
    if (busy || !protectionAccount) return false;
    try {
      const latest = S.read(localStorage, protectionAccount);
      change(latest);
      protection = S.write(localStorage, protectionAccount, latest); renderProtection();
      return true;
    } catch (error) { invalidate(); status(error.message); return false; }
  }
  function renderProtection() {
    $('protectedFileCount').textContent = protection.files.length.toLocaleString();
    $('protectedRoomCount').textContent = protection.rooms.length.toLocaleString();
    $('protectionStatus').textContent = protectionAccount ? '이 계정의 보호 설정을 이 Edge에 저장합니다. 다음 조회에도 적용됩니다.' : '채팅방 불러오기 또는 대상 조회를 하면 이 계정의 보호 설정을 불러옵니다.';
    $('protectedFiles').replaceChildren();
    for (const file of protection.files) {
      const row = document.createElement('div'), label = document.createElement('span'), button = document.createElement('button');
      row.className = 'protected-item'; label.textContent = file.name || '이름 없는 항목';
      button.type = 'button'; button.className = 'button button-quiet'; button.textContent = '보호 해제'; button.disabled = busy;
      button.setAttribute('aria-label', `${file.name || '항목'} 보호 해제`);
      button.addEventListener('click', () => {
        if (!mutateProtection(data => { data.files = data.files.filter(item => item.id !== file.id); })) return;
        invalidate(); status('보호를 해제했습니다. 대상 목록을 다시 조회하세요.');
      });
      row.append(label, button); $('protectedFiles').append(row);
    }
    if (!protection.files.length) $('protectedFiles').textContent = '조회 목록에서 보관할 항목의 ‘보호’를 누르세요.';
    renderRooms();
  }
  function renderRooms() {
    $('roomList').replaceChildren();
    const all = new Map(rooms);
    for (const room of protection.rooms) if (!all.has(room.id)) all.set(room.id, room);
    const query = $('roomSearch').value.trim().toLocaleLowerCase();
    const sorted = [...all.values()].filter(room => room.name.toLocaleLowerCase().includes(query)).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    for (const room of sorted) {
      const label = document.createElement('label'), checkbox = document.createElement('input'), text = document.createElement('span');
      label.className = 'room-option'; checkbox.type = 'checkbox'; checkbox.checked = protection.rooms.some(item => item.id === room.id); checkbox.disabled = busy;
      text.textContent = `${room.name}${room.joined === false && room.id !== P.LEFT_ROOMS ? ' · 나간 채팅방' : ''}`;
      checkbox.addEventListener('change', () => {
        if (busy) return;
        if (!mutateProtection(data => { data.rooms = data.rooms.filter(item => item.id !== room.id); if (checkbox.checked) data.rooms.push({ id: room.id, name: room.name }); })) return;
        invalidate(); status('보호 채팅방을 저장했습니다. 대상 목록을 다시 조회하세요.');
      });
      label.append(checkbox, text); $('roomList').append(label);
    }
    if (!sorted.length) $('roomList').textContent = all.size ? '검색 결과가 없습니다.' : '채팅방 불러오기를 누른 뒤 보관할 방을 체크하세요.';
  }
  function protectFile(record) {
    if (!plan || busy) return;
    if (!mutateProtection(data => { if (!data.files.some(item => item.id === record.id)) data.files.push({ id: record.id, name: record.name || kindLabels[record.kind] }); })) return;
    const criteria = Object.freeze({ ...plan.criteria, ...S.filters(protection) });
    const records = plan.records.filter(item => !P.protectedRecord(item, criteria));
    const remainingIds = new Set(records.map(item => item.id));
    for (const id of selectedIds) if (!remainingIds.has(id)) selectedIds.delete(id);
    plan = Object.freeze({ ...plan, criteria, records: Object.freeze(records), protectionSignature: S.signature(protection) });
    render(records); update();
    status('항목을 보호 목록에 저장하고 삭제 대상에서 제외했습니다. 다음 조회에서도 보호됩니다.');
  }
  async function call(method, options) {
    const results = await chrome.scripting.executeScript({ target: { tabId },
      func: async (method, options) => {
        if (location.origin !== 'https://talkcloud.kakao.com' || !globalThis.TalkCleanerBridge)
          return { ok: false, error: '원래 톡클라우드 탭에서 확장 프로그램을 다시 열어 주세요.' };
        try { return { ok: true, value: await globalThis.TalkCleanerBridge[method](options) }; }
        catch (error) { return { ok: false, error: error.message }; }
      }, args: [method, options ?? null]
    });
    const result = results[0]?.result;
    if (!result?.ok) throw new Error(result?.error || '톡클라우드 탭과 연결이 끊겼습니다. 다시 조회하세요.');
    return result.value;
  }
  async function collect(criteria, message) {
    if (await call('account') !== criteria.account) throw new Error('카카오 계정이 바뀌었습니다. 다시 조회하세요.');
    const records = new Map(), allIds = new Set(), typeMismatchIds = new Set(), unknownRoomIds = new Set(), ineligibleIds = new Set(); let pages = 0, scanned = 0;
    const verticals = [];
    if (criteria.kinds.some(k => ['photo', 'gif', 'video'].includes(k))) verticals.push('MEDIA');
    if (criteria.kinds.includes('file')) verticals.push('FILE');
    if (criteria.kinds.includes('link')) verticals.push('LINK');
    if (criteria.kinds.includes('recording')) verticals.push('RECORDING');
    for (const verticalType of verticals) {
    for (const joined of verticalType === 'RECORDING' ? [true] : criteria.includeLeft ? [true, false] : [true]) {
      let offset = null, pageIndex = 1; const cursors = new Set(), recordingPages = new Set();
      do {
        if (stopped) throw new Error('중지했습니다. 부분 조회 목록은 삭제에 사용하지 않습니다.');
        const page = await call('readPage', { ...criteria, verticalType, joined, offset, pageIndex });
        if (verticalType === 'RECORDING' && page.ids.length) {
          const fingerprint = JSON.stringify([...page.ids].sort());
          if (recordingPages.has(fingerprint)) throw new Error('녹음 목록 페이지가 반복되어 중단했습니다.');
          recordingPages.add(fingerprint);
        }
        pages++; scanned += page.scanned;
        for (const id of page.ids) allIds.add(id);
        for (const id of page.typeMismatchIds || []) { typeMismatchIds.add(id); records.delete(id); }
        for (const id of page.unknownRoomIds || []) { unknownRoomIds.add(id); records.delete(id); }
        for (const id of page.ineligibleIds || []) { ineligibleIds.add(id); records.delete(id); }
        for (const record of page.records) {
          if (ineligibleIds.has(record.id) || typeMismatchIds.has(record.id) || unknownRoomIds.has(record.id) || P.protectedRecord(record, criteria)) continue;
          const old = records.get(record.id);
          if (old && (old.createdAt !== record.createdAt || old.kind !== record.kind || old.bookmarked !== record.bookmarked || old.roomId !== record.roomId || old.size !== record.size || old.joined !== record.joined))
            throw new Error('같은 항목의 정보가 달라 중단했습니다. 다시 조회하세요.');
          records.set(record.id, Object.freeze(record));
        }
        status(`${message} · ${scanned.toLocaleString()}개 확인 · 대상 ${records.size.toLocaleString()}개${typeMismatchIds.size ? ` · 유형 확인 불가 ${typeMismatchIds.size.toLocaleString()}개 제외` : ''}`);
        if (!page.hasMore) break;
        if (!page.next || cursors.has(page.next) || pages >= 10000)
          throw new Error('목록 조회가 완결되지 않아 중단했습니다.');
        cursors.add(page.next); if (verticalType === 'RECORDING') pageIndex = page.next; else offset = page.next;
        await sleep(200);
      } while (true);
    }
    }
    if (await call('account') !== criteria.account) throw new Error('조회 중 카카오 계정이 바뀌었습니다. 다시 조회하세요.');
    return { records: [...records.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)), ids: allIds, typeMismatchCount: typeMismatchIds.size, unknownRoomCount: unknownRoomIds.size };
  }
  async function readRoomMetadata(account, signature) {
    async function checkIdentity() {
      try {
        if (await call('account') !== account) throw new Error('카카오 계정이 바뀌었습니다. 다시 조회하세요.');
        if (S.signature(S.read(localStorage, account)) !== signature) throw new Error('보호 설정이 바뀌었습니다. 다시 조회하세요.');
      } catch (error) { error.invalidatesPlan = true; throw error; }
    }
    await checkIdentity();
    const loaded = new Map(); let skipped = 0, failure = null;
    try {
      for (const verticalType of P.VERTICALS) {
        if (stopped) throw new Error('채팅방 이름 조회를 중지했습니다.');
        const page = await call('readRooms', { verticalType }); skipped += page.skipped;
        for (const room of page.rooms) loaded.set(room.id, room);
      }
    } catch (error) { failure = error; }
    await checkIdentity();
    if (stopped) throw new Error('채팅방 이름 조회를 중지했습니다.');
    if (failure) throw failure;
    rooms = loaded; renderRooms();
    $('roomStatus').textContent = `${rooms.size.toLocaleString()}개 채팅방 이름 확인.${skipped ? ` 식별 불가 ${skipped}개 제외.` : ''}`;
  }
  function metrics(records) {
    $('selectedCount').textContent = records.length.toLocaleString();
    const sized = records.filter(r => r.kind !== 'link'), known = sized.filter(r => r.size != null);
    $('bytes').textContent = `${formatSize(known.reduce((sum, r) => sum + r.size, 0))}${known.length !== sized.length ? ' + 크기 미확인' : ''}${records.length !== sized.length ? ' · 링크 제외' : ''}`;
    const dates = records.map(record => record.date).sort();
    $('range').textContent = dates.length ? `${dates[0]} ~ ${dates.at(-1)}` : '선택 항목 없음';
  }
  function summary(records) {
    const stats = R.stats(records);
    return `${stats.count.toLocaleString()}개 · ${formatSize(stats.bytes)}${stats.unknownCount ? ` + 크기 미확인 ${stats.unknownCount}개` : ''}${stats.linkCount ? ` · 링크 ${stats.linkCount}개 용량 제외` : ''}`;
  }
  function selectionChange(records, checked) {
    if (busy || !plan) return;
    for (const record of records) { if (checked) selectedIds.add(record.id); else selectedIds.delete(record.id); }
    render(plan.records); update();
  }
  const reviewControls = () => [...document.querySelectorAll('#preview input, #preview button, #groupPreview input, #groupPreview button')];
  function controlRoom(control) {
    for (let node = control; node; node = node.parentElement) {
      const key = node.getAttribute?.('data-review-room');
      if (key != null) return key;
    }
    return null;
  }
  function captureReviewFocus() {
    const active = document.activeElement;
    if (!active || !reviewControls().includes(active)) return null;
    for (const attribute of ['data-record-id', 'data-room-key', 'data-room-toggle', 'data-room-sort']) {
      const value = active.getAttribute(attribute);
      if (value != null) return { attribute, value, type: active.type, room: controlRoom(active), index: visibleRecords.findIndex(record => record.id === value) };
    }
    return null;
  }
  function restoreReviewFocus(saved) {
    if (!saved || busy || !plan) return;
    const controls = reviewControls();
    let next = controls.find(control => control.getAttribute(saved.attribute) === saved.value && control.type === saved.type && controlRoom(control) === saved.room);
    if (!next && saved.attribute === 'data-record-id' && visibleRecords.length) {
      const nearest = visibleRecords[Math.max(0, Math.min(saved.index, visibleRecords.length - 1))];
      next = controls.find(control => control.type === 'checkbox' && control.getAttribute('data-record-id') === nearest.id);
    }
    (next || $('reviewSelectedOnly')).focus?.({ preventScroll: true });
  }
  function renderRows(records, body) {
    for (const record of records) {
      const tr = document.createElement('tr'); tr.className = selectedIds.has(record.id) ? 'selected-row' : '';
      tr.setAttribute('data-record-id', record.id);
      const selectCell = document.createElement('td'), checkbox = document.createElement('input');
      checkbox.type = 'checkbox'; checkbox.checked = selectedIds.has(record.id);
      checkbox.setAttribute('data-record-id', record.id);
      checkbox.setAttribute('aria-label', `${record.date} ${record.name || kindLabels[record.kind]} 선택`);
      checkbox.addEventListener('change', () => selectionChange([record], checkbox.checked));
      selectCell.append(checkbox); tr.append(selectCell);
      for (const [index, text] of [record.name || '(이름 미제공)', roomName(record), record.date, record.kind === 'link' ? '용량 집계 제외' : formatSize(record.size), kindLabels[record.kind]].entries()) {
        const td = document.createElement('td'); td.textContent = text; td.title = text;
        if (index === 0 && V.eligible(record)) {
          const preview = button('미리보기', () => showPreview(record, preview), 'button button-text preview-photo');
          preview.setAttribute('data-photo-preview', record.id); preview.setAttribute('aria-label', `${record.name || '사진'} 미리보기`); td.append(preview);
        }
        tr.append(td);
      }
      const protectCell = document.createElement('td'), protect = document.createElement('button');
      protect.type = 'button'; protect.className = 'button button-quiet'; protect.textContent = '보호';
      protect.setAttribute('data-record-id', record.id);
      protect.setAttribute('data-record-protect', record.id);
      protect.setAttribute('aria-label', `${record.name || kindLabels[record.kind]} 계속 보호`);
      protect.addEventListener('click', () => protectFile(record));
      protectCell.append(protect); tr.append(protectCell);
      body.append(tr);
    }
  }
  function button(text, action, className = 'button button-quiet') {
    const element = document.createElement('button'); element.type = 'button'; element.className = className; element.textContent = text;
    element.addEventListener('click', action); return element;
  }
  function toggleSort(name) {
    if (busy || !plan) return;
    const value = $('reviewSort').value;
    $('reviewSort').value = value === `${name}-asc` ? `${name}-desc` : value === `${name}-desc` ? `${name}-asc` : `${name}-${name === 'size' || name === 'date' ? 'desc' : 'asc'}`;
    if (reviewView === 'flat') pageIndex = 0;
    roomPages.clear(); render(plan.records); update();
  }
  function renderGroup(group) {
    const section = document.createElement('section'), header = document.createElement('div');
    section.className = 'review-room'; section.setAttribute('data-review-room', group.key); header.className = 'review-room-header';
    const open = expandedRooms.has(group.key);
    const toggle = button(`${open ? '▾' : '▸'} ${group.name}`, () => {
      if (busy || !plan) return;
      if (expandedRooms.has(group.key)) expandedRooms.delete(group.key); else expandedRooms.add(group.key);
      render(plan.records); update();
    }, 'review-room-title');
    toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('data-room-toggle', group.key);
    const label = document.createElement('label'), checkbox = document.createElement('input'), labelText = document.createElement('span');
    label.className = 'review-room-select'; checkbox.type = 'checkbox';
    const state = R.triState(group.records, selectedIds); checkbox.checked = state.checked; checkbox.indeterminate = state.indeterminate;
    checkbox.setAttribute('aria-checked', state.indeterminate ? 'mixed' : String(state.checked));
    checkbox.setAttribute('data-room-key', group.key);
    checkbox.setAttribute('aria-label', `${group.name}의 검색 결과 전체 ${group.records.length}개 선택`);
    checkbox.addEventListener('change', () => selectionChange(group.records, checkbox.checked));
    labelText.textContent = `이 방 검색 결과 전체 선택 (${state.count}/${state.total})`; label.append(checkbox, labelText);
    const info = document.createElement('span'); info.className = 'review-room-summary'; info.textContent = summary(group.records);
    header.append(toggle, info, label); section.append(header);
    if (open) {
      const body = document.createElement('div'), table = document.createElement('table'), head = document.createElement('thead'), row = document.createElement('tr'), rows = document.createElement('tbody');
      body.className = 'review-room-body'; table.className = 'preview-table';
      const [sortField, sortDirection] = $('reviewSort').value.split('-');
      for (const [title, field] of [['포함'], ['이름', 'name'], ['채팅방', 'room'], ['기준 날짜', 'date'], ['크기', 'size'], ['유형', 'kind'], ['보호']]) {
        const th = document.createElement('th'); th.setAttribute('scope', 'col');
        if (field) {
          const sort = button(title, () => toggleSort(field), 'sort-button');
          sort.setAttribute('data-room-sort', field); sort.setAttribute('aria-label', `${title} 정렬 순서 변경`);
          th.setAttribute('aria-sort', sortField === field ? sortDirection === 'asc' ? 'ascending' : 'descending' : 'none');
          th.append(sort);
        } else th.textContent = title;
        row.append(th);
      }
      head.append(row); table.append(head, rows); body.append(table);
      const page = R.page(group.records, roomPages.get(group.key) || 0, 50); roomPages.set(group.key, page.index);
      renderRows(page.items, rows); visibleRecords.push(...page.items);
      const nav = document.createElement('div'), info = document.createElement('span'); nav.className = 'review-room-pagination';
      info.textContent = `${page.index + 1} / ${page.totalPages} 페이지 · 한 번에 50개`;
      const previous = button('이 방 이전', () => { if (!busy && plan && page.index > 0) { roomPages.set(group.key, page.index - 1); render(plan.records); update(); } });
      const next = button('이 방 다음', () => { if (!busy && plan && page.index + 1 < page.totalPages) { roomPages.set(group.key, page.index + 1); render(plan.records); update(); } });
      previous.disabled = page.index <= 0; next.disabled = page.index + 1 >= page.totalPages;
      previous.setAttribute('data-room-previous', group.key); next.setAttribute('data-room-next', group.key);
      // update() also applies the busy state, preserving these pagination boundaries.
      previous.setAttribute('data-boundary-disabled', String(previous.disabled)); next.setAttribute('data-boundary-disabled', String(next.disabled));
      nav.append(previous, info, next); body.append(nav); section.append(body);
    }
    $('groupPreview').append(section);
  }
  function render(records) {
    const focused = captureReviewFocus();
    metrics(R.selected(records, selectedIds));
    $('foundCount').textContent = records.length.toLocaleString();
    const roomFilter = $('reviewRoom').value;
    $('reviewRoom').replaceChildren();
    const allOption = document.createElement('option'); allOption.value = ''; allOption.textContent = '모든 채팅방'; $('reviewRoom').append(allOption);
    const groups = R.group(records, roomName);
    for (const group of groups) { const option = document.createElement('option'); option.value = group.key; option.textContent = `${group.name} (${group.records.length})`; $('reviewRoom').append(option); }
    $('reviewRoom').value = groups.some(group => group.key === roomFilter) ? roomFilter : '';
    const minBytes = Math.ceil(Number($('reviewMinMB').value) * 1024 * 1024);
    const validMinimum = Number.isSafeInteger(minBytes) && minBytes >= 0;
    filteredRecords = validMinimum ? R.sort(R.filter(records, { search: $('reviewSearch').value, room: $('reviewRoom').value, minBytes, selectedOnly: $('reviewSelectedOnly').checked }, selectedIds, roomName), $('reviewSort').value, roomName) : [];
    visibleRecords = []; $('preview').replaceChildren(); $('groupPreview').replaceChildren();
    $('flatView').hidden = reviewView !== 'flat' || !filteredRecords.length; $('groupPreview').hidden = reviewView !== 'rooms' || !filteredRecords.length;
    $('expandRooms').hidden = reviewView !== 'rooms'; $('collapseRooms').hidden = reviewView !== 'rooms';
    $('viewFlat').setAttribute('aria-pressed', String(reviewView === 'flat')); $('viewRooms').setAttribute('aria-pressed', String(reviewView === 'rooms'));
    const page = R.page(reviewView === 'flat' ? filteredRecords : R.group(filteredRecords, roomName), pageIndex, reviewView === 'flat' ? 100 : 10);
    pageIndex = page.index; reviewPages = page.totalPages;
    if (reviewView === 'flat') { visibleRecords = page.items; renderRows(page.items, $('preview')); } else page.items.forEach(renderGroup);
    $('pageInfo').textContent = `${pageIndex + 1} / ${reviewPages} 페이지${reviewView === 'rooms' ? ' · 채팅방 10개씩' : ''}`;
    $('reviewSummary').textContent = validMinimum ? `검색 결과 ${summary(filteredRecords)} · 전체 조회 ${records.length.toLocaleString()}개` : '검토 최소 크기는 0 이상의 숫자로 입력하세요.';
    $('reviewEmpty').hidden = filteredRecords.length > 0;
    $('reviewEmpty').textContent = reviewNeedsRefresh ? '현재 목록은 참고용입니다. ‘목록 찾기’를 눌러 다시 조회하세요.' : !plan ? '먼저 1단계에서 날짜와 유형을 정하고 ‘목록 찾기’를 누르세요.' : !records.length ? '조회 조건에 맞는 항목이 없습니다.' : validMinimum ? '검토 조건에 맞는 항목이 없습니다. 필터를 해제하면 남은 목록을 확인할 수 있습니다.' : '검토 최소 크기를 확인하세요.';
    $('selectFiltered').textContent = `검색 결과 전체 ${filteredRecords.length.toLocaleString()}개 선택`;
    $('selectPage').textContent = `지금 보이는 ${visibleRecords.length.toLocaleString()}개 선택`;
    const selected = R.selected(records, selectedIds), visibleIds = new Set(visibleRecords.map(record => record.id)), hidden = selected.filter(record => !visibleIds.has(record.id));
    $('selectionSummary').textContent = `선택한 항목 ${summary(selected)}`;
    $('hiddenSelection').hidden = !hidden.length;
    $('hiddenSelection').textContent = hidden.length ? `현재 화면 밖의 ${summary(hidden)}도 선택되어 있습니다. 검색·접기·페이지를 바꿔도 선택은 유지됩니다. 위의 ‘선택한 항목만 보기’로 전체 선택을 확인하세요.` : '';
    const [field, direction] = $('reviewSort').value.split('-');
    for (const name of ['Name', 'Room', 'Date', 'Size', 'Kind']) $('sortHeader' + name).setAttribute('aria-sort', field === name.toLowerCase() ? direction === 'asc' ? 'ascending' : 'descending' : 'none');
    restoreReviewFocus(focused);
  }
  async function scan(restore = null) {
    if (busy) return;
    let kinds, minBytes;
    try {
      P.cutoffMs($('cutoff').value);
      kinds = typeFields.filter(([id]) => $(id).checked).map(([,kind]) => kind);
      if (!kinds.length) throw new Error('정리할 종류를 하나 이상 선택하세요.');
      minBytes = Math.ceil(Number($('minSizeMB').value) * 1024 * 1024);
      if (!Number.isSafeInteger(minBytes) || minBytes < 0) throw new Error('최소 크기는 0 이상의 숫자로 입력하세요.');
    } catch (error) { status(error.message); return; }
    invalidate(); busy = true; stopped = false; update(); $('progress').value = 0;
    try {
      const account = await call('account'); loadProtection(account);
      openWorkspace(account);
      if (restore && restore.account !== account) throw new Error('카카오 계정이 바뀌었습니다. 이전 작업을 불러오지 않았습니다.');
      const criteria = Object.freeze({ cutoff: $('cutoff').value, kinds: Object.freeze(kinds), minBytes, protectStarred: $('protectStarred').checked, includeGif: $('includeGif').checked, includeLeft: $('includeLeft').checked, account, ...S.filters(protection) });
      const result = await collect(criteria, restore ? '이전 작업의 최신 상태 확인 중' : '목록 찾는 중');
      const { records, typeMismatchCount, unknownRoomCount } = result;
      if (stopped) throw new Error('중지했습니다. 다시 조회하세요.');
      if (S.signature(S.read(localStorage, account)) !== S.signature(protection)) throw new Error('조회 중 보호 설정이 바뀌었습니다. 다시 조회하세요.');
      const signature = S.signature(protection);
      let roomWarning = '';
      if (records.length) {
        try { await readRoomMetadata(account, signature); }
        catch (error) {
          if (error.invalidatesPlan || stopped) throw error;
          roomWarning = ' 채팅방 이름을 불러오지 못했습니다. 이름 미확인으로 표시하며 목록은 검토할 수 있습니다.';
          $('roomStatus').textContent = `${roomWarning.trim()} ${error.message}`;
        }
      }
      plan = Object.freeze({ criteria, records: Object.freeze(records), createdAt: Date.now(), protectionSignature: signature, typeMismatchCount, unknownRoomCount });
      workspaceCriteria = criteria;
      let restoreNote = '';
      if (restore) {
        const fingerprints = new Map((restore.selection || []).map(item => [item.id, item.fingerprint]));
        for (const record of records) if (fingerprints.get(record.id) === W.fingerprint(record)) selectedIds.add(record.id);
        const view = restore.view || {};
        $('reviewSearch').value = view.search || ''; $('reviewRoom').value = view.room || '';
        $('reviewMinMB').value = view.minMB || '0'; $('reviewSelectedOnly').checked = !!view.selectedOnly;
        $('reviewSort').value = view.sort || 'size-desc'; reviewView = view.mode || 'flat';
        await restoreReceipts(restore, plan);
        for (const outcome of outcomes) if (outcome.criteria && sameCriteria(outcome.criteria, criteria)) {
          if (outcome.type === 'download') reconcileDownloads(outcome, plan); else reconcileOutcome(outcome, result);
        }
        if (restore.retry) {
          const wanted = new Map(restore.retry.items.filter(item => item.state !== 'verified' && item.fingerprint).map(item => [item.id, item.fingerprint]));
          selectedIds.clear();
          for (const record of records) if (wanted.get(record.id) === W.fingerprint(record)) {
            if (restore.retry.type === 'download' && (!D.eligible(record) || savedFiles.has(D.receiptKey(account, record)))) continue;
            selectedIds.add(record.id);
          }
        }
        restoreNote = ` 이전 선택 ${selectedIds.size.toLocaleString()}개와 현재 확인된 저장 기록 ${savedFiles.size.toLocaleString()}개를 불러왔습니다. 변경되거나 보호된 항목은 자동 선택하지 않습니다. 실행하려면 목록을 확인한 뒤 버튼을 눌러 주세요.`;
      }
      render(records);
      showScanWarnings(plan);
      log(`${criteria.cutoff} 이전 ${criteria.kinds.map(k => kindLabels[k]).join('·')} ${records.length.toLocaleString()}개 조회 완료. 삭제 요청 없음.`);
      status((records.length ? `${records.length.toLocaleString()}개를 찾았습니다. 정리할 항목을 체크한 뒤 ‘휴지통으로 이동’을 누르세요.${roomWarning}` : '조건에 맞는 항목이 없습니다. 중요 표시 여부를 확인할 수 없는 항목도 보호 옵션에 따라 제외됩니다.') + restoreNote);
    } catch (error) { plan = null; status(error.message); log(error.message); }
    finally { busy = false; update(); }
  }
  $('scan').addEventListener('click', () => scan());
  function checkPlan(current) {
    if (stopped) throw new Error('사용자가 중지했습니다.');
    if (Date.now() - current.createdAt > 3600000) throw new Error('조회 후 1시간이 지났습니다. 최신 목록을 다시 조회하세요.');
    if (S.signature(S.read(localStorage, current.criteria.account)) !== current.protectionSignature) throw new Error('보호 설정이 바뀌었습니다. 다시 조회하세요.');
  }
  async function verifySaved(current, records) {
    for (const record of D.files(records)) {
      checkPlan(current);
      const key = D.receiptKey(current.criteria.account, record), receipt = savedFiles.get(key);
      if (!receipt) throw new Error('다운로드 완료 조건이 켜져 있습니다. 먼저 저장하거나 ‘PC에 저장’에서 조건을 해제하세요.');
      try { await D.checkReceipt(chrome.downloads, receipt); }
      catch (error) { savedFiles.delete(key); throw error; }
      checkPlan(current);
    }
  }
  function saveJson(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
  $('openDownload').addEventListener('click', () => {
    if (busy || !plan || !D.files(selectedRecords()).length) return;
    $('downloadSection').open = true;
    $('downloadSection').scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    $('downloadHeading').focus();
  });
  $('backupBeforeTrash').addEventListener('change', update);
  $('downloadPhotos').addEventListener('click', async () => {
    const records = D.files(selectedRecords()), current = plan;
    if (busy || !current || !records.length || !globalThis.chrome?.downloads) return;
    busy = true; stopped = false; jobKind = 'download';
    const directory = D.folder();
    downloadRun = { startedAt: new Date().toISOString(), folder: directory, requested: records.length, items: [] };
    const outcome = beginOutcome('download', records, current.criteria);
    $('downloadProgress').max = records.length; $('downloadProgress').value = 0; update();
    let completed = 0;
    try {
      checkpoint(true);
      for (let index = 0; index < records.length; index++) {
        checkPlan(current);
        if (plan !== current) throw new Error('조회 조건이 바뀌었습니다. 다시 조회하세요.');
        const record = records[index], key = D.receiptKey(current.criteria.account, record);
        markOutcome(outcome, [record], 'uncertain'); checkpoint(true);
        let receipt = savedFiles.get(key), reused = false;
        if (receipt) {
          try { receipt = await D.checkReceipt(chrome.downloads, receipt); reused = true; }
          catch (_) { savedFiles.delete(key); receipt = null; }
        }
        if (!receipt) {
          $('downloadStatus').textContent = `${index + 1} / ${records.length}번째 파일의 원본 정보를 확인하는 중…`;
          const original = await call('originalFile', { record, criteria: current.criteria });
          checkPlan(current);
          // The list's size may describe a compressed copy, not the preferred HQ URL.
          // Validate actual completion/bytes through the browser without equating those sizes.
          receipt = await D.saveOne(chrome.downloads, {
            url: original.url, filename: D.filename({ ...record, name: original.name || record.name }, index, directory),
            kind: record.kind, expectedMime: original.mimeType || null,
            expectedSize: record.kind === 'file' ? original.size : null
          }, { shouldStop: () => stopped || plan !== current,
            onProgress: progress => { $('downloadStatus').textContent = `${index + 1} / ${records.length}번째 파일 저장 중 · ${formatSize(progress.bytes)}${progress.totalBytes ? ` / ${formatSize(progress.totalBytes)}` : ''}`; }
          });
        }
        checkPlan(current);
        if (await call('account') !== current.criteria.account) throw new Error('카카오 계정이 바뀌어 저장 확인을 중단했습니다. 다시 조회하세요.');
        checkPlan(current);
        savedFiles.set(key, receipt); completed++;
        markOutcome(outcome, [record], 'verified'); checkpoint();
        // Keep absolute browser paths only in the in-memory receipt used for verification.
        // Reports need the saved basename, including a browser-added duplicate suffix.
        const savedName = receipt.filename.split(/[\\/]/).at(-1);
        downloadRun.items.push({ name: record.name || kindLabels[record.kind], kind: record.kind, filename: savedName, bytes: receipt.bytes, state: 'complete', reused });
        $('downloadProgress').value = completed;
        $('downloadStatus').textContent = `${completed.toLocaleString()} / ${records.length.toLocaleString()}개 저장 완료${reused ? ' · 이전 저장 기록 재확인' : ''}`;
        update();
      }
      $('downloadStatus').textContent = `선택한 파일 ${completed.toLocaleString()}개 저장 완료. ‘다운로드 폴더 열기’에서 파일을 확인하세요. 휴지통으로 이동하지 않았습니다.`;
      status('파일 저장이 끝났습니다. 정리가 필요하면 선택 요약의 ‘휴지통으로 이동’을 누르세요.');
      log(`파일 ${completed.toLocaleString()}개 다운로드 완료 확인. 휴지통 이동 요청 없음.`);
    } catch (error) {
      for (const item of outcome.items) if (item.state === 'uncertain') item.state = 'failed';
      // Browser errors can include signed URLs or local paths; never export their raw text.
      downloadRun.error = '다운로드가 완료되지 않았습니다. 관리 화면에서 중단 이유를 확인하세요.';
      $('downloadStatus').textContent = `저장 중단: ${error.message} 완료 확인 ${completed.toLocaleString()} / ${records.length.toLocaleString()}개. 이미 저장된 파일은 유지됩니다.`;
      status('파일 저장이 완료되지 않았습니다. ‘PC에 저장’의 안내와 Edge 다운로드 목록을 확인하세요.');
      log(`파일 저장 중단. 완료 확인 ${completed.toLocaleString()}개. 휴지통 이동 요청 없음.`);
    } finally {
      downloadRun.finishedAt = new Date().toISOString();
      outcome.finishedAt = Date.now(); checkpoint();
      busy = false; jobKind = null; update();
    }
  });
  $('downloadStop').addEventListener('click', () => {
    if (!busy || jobKind !== 'download') return;
    stopped = true; $('downloadStatus').textContent = '중지 요청됨. 진행 중인 다운로드를 취소하고 다음 파일부터 시작하지 않습니다.'; update();
  });
  $('downloadFolder').addEventListener('click', async () => {
    try { await chrome.downloads.showDefaultFolder(); }
    catch (_) { $('downloadStatus').textContent = 'Edge의 다운로드 목록에서 저장 위치를 열어 주세요.'; }
  });
  $('downloadReport').addEventListener('click', () => {
    if (!busy && downloadRun) saveJson(downloadRun, `talkcloud-download-${downloadRun.startedAt.slice(0, 10)}.json`);
  });
  $('execute').addEventListener('click', async () => {
    const chosen = selectedRecords();
    if (busy || !plan || !chosen.length) return;
    const reviewed = plan;
    const current = Object.freeze({ ...reviewed, records: Object.freeze(chosen) });
    try { if (S.signature(S.read(localStorage, current.criteria.account)) !== current.protectionSignature) throw new Error('보호 설정이 바뀌었습니다. 다시 조회하세요.'); }
    catch (error) { invalidate(); status(error.message); return; }
    if (Date.now() - current.createdAt > 3600000) { invalidate(); status('조회 후 1시간이 지났습니다. 최신 목록을 다시 조회하세요.'); return; }
    const requiresBackup = $('backupBeforeTrash').checked && D.files(chosen).length > 0;
    if (requiresBackup) {
      busy = true; stopped = false; jobKind = 'verify'; update();
      try {
        status('저장한 파일의 다운로드 기록을 다시 확인하고 있습니다.');
        await verifySaved(current, chosen);
        if (await call('account') !== current.criteria.account) throw new Error('카카오 계정이 바뀌었습니다. 다시 조회하세요.');
        checkPlan(current);
      } catch (error) {
        $('downloadSection').open = true; $('downloadStatus').textContent = `저장 확인 중단: ${error.message}`; status(error.message); return;
      } finally { busy = false; jobKind = null; update(); }
    }
    const visibleIds = new Set(visibleRecords.map(record => record.id));
    const hiddenCount = chosen.filter(record => !visibleIds.has(record.id)).length;
    const selectedKinds = [...new Set(chosen.map(record => record.kind))].map(kind => kindLabels[kind]).join(', ');
    if (!confirm(`선택한 ${summary(chosen)}를 휴지통으로 옮길까요?\n종류: ${selectedKinds}\n기준: ${current.criteria.cutoff} 이전${hiddenCount ? `\n현재 화면에 보이지 않는 선택 ${hiddenCount.toLocaleString()}개도 포함됩니다.` : ''}\n\n파일 다운로드는 실행하지 않습니다. 영구 삭제는 하지 않습니다.`)) return;
    closePreview();
    const outcome = beginOutcome('trash', chosen, current.criteria);
    rememberedSelection = chosen.map(record => ({ id: record.id, fingerprint: W.fingerprint(record) }));
    lastTrashSummary = `처리 대상: ${summary(chosen)} · ${selectedKinds}`;
    $('progress').value = 0;
    busy = true; stopped = false; jobKind = 'trash'; plan = null; update();
    let accepted = 0, pending = 0;
    try {
      for (let i = 0; i < current.records.length; i += P.CHUNK) {
        checkPlan(current);
        const records = current.records.slice(i, i + P.CHUNK);
        if (requiresBackup) await verifySaved(current, records);
        pending = records.length;
        markOutcome(outcome, records, 'uncertain');
        try { checkpoint(true); } catch (error) { markOutcome(outcome, records, 'not-started'); pending = 0; throw error; }
        await call('trash', { ...current.criteria, records });
        markOutcome(outcome, records, 'requested'); checkpoint();
        accepted += records.length; pending = 0;
        $('progress').value = accepted / current.records.length * 100;
        status(`서버 요청 성공 ${accepted.toLocaleString()} / ${current.records.length.toLocaleString()}개 · 완료 후 재조회합니다.`);
        log(`${records.length}개 휴지통 이동 요청 성공 (누적 ${accepted.toLocaleString()}개).`);
        await sleep(350);
      }
      if (stopped) throw new Error('사용자가 중지했습니다.');
      const remaining = await collect(current.criteria, '처리 결과 재조회 중');
      checkPlan(current);
      reconcileOutcome(outcome, remaining); checkpoint();
      const plannedIds = new Set(current.records.map(r => r.id));
      const left = [...remaining.ids].filter(id => plannedIds.has(id)).length;
      if (left) throw new Error(`재조회에서 대상 ${left}개가 남아 있습니다. 새로 조회해 확인하세요.`);
      // Reuse only reviewed IDs, with freshly verified metadata. New uploads need a new scan.
      const reviewedIds = new Set(reviewed.records.map(record => record.id));
      const records = remaining.records.filter(record => reviewedIds.has(record.id));
      const receiptKeys = new Set(D.files(records).map(record => D.receiptKey(current.criteria.account, record)));
      for (const key of savedFiles.keys()) if (!receiptKeys.has(key)) savedFiles.delete(key);
      plan = Object.freeze({ ...reviewed, records: Object.freeze(records), createdAt: Date.now(), typeMismatchCount: remaining.typeMismatchCount, unknownRoomCount: remaining.unknownRoomCount });
      showScanWarnings(plan);
      status(`${accepted.toLocaleString()}개 처리 후 목록에서 사라진 것을 확인했습니다. ${records.length ? `남은 ${records.length.toLocaleString()}개는 다시 조회하지 않고 계속 선택할 수 있습니다.` : '조회한 목록의 정리가 끝났습니다.'}`);
      log('재조회 검증 완료. 영구 삭제는 실행하지 않았습니다.');
    } catch (error) {
      plan = null; reviewNeedsRefresh = true;
      const message = `중단: ${error.message} 요청 성공 ${accepted.toLocaleString()}개${pending ? `, 마지막 ${pending}개는 결과 미확정` : ''}. 기존 목록은 참고용으로 남겨 두었습니다. ‘목록 찾기’를 눌러 다시 조회하여 현재 상태를 확인하세요.`;
      status(message); log(message);
    } finally {
      outcome.finishedAt = Date.now(); checkpoint();
      busy = false; jobKind = null; selectedIds.clear();
      $('reviewSelectedOnly').checked = false;
      render(plan ? plan.records : reviewed.records); update();
    }
  });
  $('stop').addEventListener('click', () => { stopped = true; status('중지 요청됨. 진행 중인 서버 요청이 끝나면 멈춥니다.'); update(); });
  for (const name of filterFields) $(name).addEventListener('change', () => {
    invalidate(); status('조건이 바뀌었습니다. 다시 조회하세요.');
  });
  for (const [name, kinds] of Object.entries(presets)) $(name).addEventListener('click', () => {
    if (busy) return;
    for (const [id, kind] of typeFields) $(id).checked = kinds.includes(kind);
    invalidate(); status('분류를 선택했습니다. 기준일과 보호 설정을 확인한 뒤 조회하세요.');
  });
  $('roomSearch').addEventListener('input', renderRooms);
  async function loadRoomsForReview() {
    if (busy || !ready) return;
    const existingPlan = plan;
    busy = true; stopped = false; update();
    try {
      const account = existingPlan ? existingPlan.criteria.account : await call('account');
      if (!existingPlan) loadProtection(account);
      await readRoomMetadata(account, existingPlan ? existingPlan.protectionSignature : S.signature(protection));
      if (plan) render(plan.records);
      status(existingPlan ? '채팅방 이름을 갱신했습니다. 조회 목록과 선택은 유지됩니다.' : '보관할 채팅방을 체크한 뒤 조회하세요.');
    } catch (error) {
      if (error.invalidatesPlan) invalidate();
      $('roomStatus').textContent = `채팅방 이름 미확인: ${error.message}`; status(error.message);
    }
    finally { busy = false; update(); }
  }
  $('loadRooms').addEventListener('click', loadRoomsForReview);
  $('reviewLoadRooms').addEventListener('click', loadRoomsForReview);
  $('clearProtectedFiles').addEventListener('click', () => {
    if (!mutateProtection(data => { data.files = []; })) return;
    invalidate(); status('파일 보호 목록을 비웠습니다. 실제 항목은 변경하지 않았습니다. 다시 조회하세요.');
  });
  $('previewPrevious').addEventListener('click', () => { if (!busy && plan && pageIndex > 0) { pageIndex--; render(plan.records); update(); } });
  $('previewNext').addEventListener('click', () => { if (!busy && plan && pageIndex + 1 < reviewPages) { pageIndex++; render(plan.records); update(); } });
  for (const name of reviewFields) $(name).addEventListener(name === 'reviewSearch' || name === 'reviewMinMB' ? 'input' : 'change', () => {
    if (busy || !plan) return;
    if (name === 'reviewSelectedOnly' && $('reviewSelectedOnly').checked) {
      $('reviewSearch').value = ''; $('reviewRoom').value = ''; $('reviewMinMB').value = '0';
      status('선택한 항목 전체를 볼 수 있도록 검색·채팅방·검토 최소 크기 조건을 초기화했습니다.');
    }
    pageIndex = 0; roomPages.clear(); render(plan.records); update();
  });
  for (const [name, view] of [['viewFlat', 'flat'], ['viewRooms', 'rooms']]) $(name).addEventListener('click', () => {
    if (busy || !plan) return;
    reviewView = view; pageIndex = 0; render(plan.records); update();
  });
  for (const field of ['Name', 'Room', 'Date', 'Size', 'Kind']) $('sort' + field).addEventListener('click', () => {
    toggleSort(field.toLowerCase());
  });
  $('selectPage').addEventListener('click', () => selectionChange(visibleRecords, true));
  $('selectFiltered').addEventListener('click', () => selectionChange(filteredRecords, true));
  $('clearSelection').addEventListener('click', () => selectionChange(selectedRecords(), false));
  $('largeFiles').addEventListener('click', () => {
    if (busy || !plan) return;
    const active = Number($('reviewMinMB').value) === 50;
    $('reviewMinMB').value = active ? '0' : '50';
    if (!active) $('reviewSort').value = 'size-desc';
    pageIndex = 0; roomPages.clear(); render(plan.records); update();
  });
  $('resetReview').addEventListener('click', () => {
    if (busy || !plan) return;
    $('reviewSearch').value = ''; $('reviewRoom').value = ''; $('reviewMinMB').value = '0'; $('reviewSelectedOnly').checked = false; $('reviewSort').value = 'size-desc';
    pageIndex = 0; roomPages.clear(); render(plan.records); update();
  });
  $('expandRooms').addEventListener('click', () => {
    if (busy || !plan) return;
    for (const group of R.group(filteredRecords, roomName)) expandedRooms.add(group.key);
    render(plan.records); update();
  });
  $('collapseRooms').addEventListener('click', () => {
    if (busy || !plan) return;
    expandedRooms.clear(); render(plan.records); update();
  });
  $('refresh').addEventListener('click', async () => {
    if (busy || !ready) return;
    invalidate(); ready = false; update();
    try { await chrome.tabs.reload(tabId); status('톡클라우드를 새로고침했습니다. 원래 탭에서 확장 프로그램 아이콘을 다시 눌러 주세요.'); }
    catch { status('톡클라우드 탭을 찾을 수 없습니다. 다시 열어 주세요.'); }
  });
  $('export').addEventListener('click', () => {
    if (!plan) return;
    // Export only user-visible scan conditions, never account IDs or unrelated protection IDs.
    const { cutoff, kinds, minBytes, protectStarred, includeGif, includeLeft } = plan.criteria;
    const criteria = { cutoff, kinds, minBytes, protectStarred, includeGif, includeLeft };
    const records = selectedRecords().map(({ id, createdAt, date, size, name, roomId, joined, bookmarked, verticalType, kind }) =>
      ({ id, createdAt, date, size, name, roomId, joined, bookmarked, verticalType, kind }));
    saveJson({ criteria, records, createdAt: plan.createdAt }, `talkcloud-before-${plan.criteria.cutoff}.json`);
  });
  $('restoreWorkspace').addEventListener('click', restoreWorkspace);
  $('forgetWorkspace').addEventListener('click', async () => {
    if (busy || !ready || !confirm('이 계정의 조건·선택·작업 기록을 지울까요? 보호 목록과 PC에 저장한 파일은 유지됩니다.')) return;
    busy = true; update();
    try {
      const account = await call('account');
      W.clear(localStorage, account); workspaceAccount = null; workspaceCriteria = null; workspaceToken = null; workspaceBlocked = false;
      outcomes = []; rememberedSelection = []; invalidate();
      $('workspaceStatus').textContent = '이 계정의 작업 기록을 지웠습니다. 보호 목록과 다운로드한 파일은 유지됩니다.';
    } catch (error) { status(error.message); }
    finally { busy = false; update(); }
  });
  $('exportOutcomes').addEventListener('click', () => {
    if (busy || !outcomes.length) return;
    saveJson({ version: 1, outcomes: outcomes.map(({ type, startedAt, finishedAt, items }) => ({ type, startedAt, finishedAt,
      items: items.map(({ id, name, kind, size, state }) => ({ id, name, kind, size, state })) })) }, 'talkcloud-results.json');
  });
  $('closePhotoPreview').addEventListener('click', closePreview);
  $('photoPreviewImage').addEventListener('error', () => {
    $('photoPreviewImage').removeAttribute('src'); $('photoPreviewImage').hidden = true;
    $('photoPreviewStatus').textContent = '이미지를 표시하지 못했습니다. 로그인 상태를 확인하거나 원본 저장을 사용하세요.';
  });
  $('photoPreview').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closePreview(); }
    if (event.key === 'Tab') { event.preventDefault(); $('closePhotoPreview').focus(); }
  });
  $('acknowledgeIntro').addEventListener('click', () => {
    try { O.acknowledge(localStorage, version); $('firstRunSection').hidden = true; }
    catch (error) { status(error.message); }
  });
  $('showIntro').addEventListener('click', () => { $('firstRunSection').hidden = false; $('acknowledgeIntro').focus(); });
  $('recoveryAction').addEventListener('click', () => {
    const action = $('recoveryAction').getAttribute('data-action');
    if (busy) return;
    if (action === 'scan') return scan();
    if (action === 'settings') { $('workspaceSection').scrollIntoView?.({ behavior: 'smooth' }); return; }
    const url = action === 'source' ? 'https://talkcloud.kakao.com/photo/all' : chrome.runtime?.getURL?.('guide.html');
    if (url) chrome.tabs.create({ url });
  });
  addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  addEventListener('storage', event => {
    if (workspaceAccount && event.key === W.key(workspaceAccount)) {
      workspaceBlocked = true; closePreview();
      if (busy) stopped = true; else { plan = null; reviewNeedsRefresh = true; update(); }
      status('다른 관리 화면에서 작업 기록이 바뀌었습니다. 이전 작업을 다시 불러온 뒤 현재 상태를 확인하세요.'); return;
    }
    if (!protectionAccount || event.key !== S.key(protectionAccount)) return;
    if (busy) { stopped = true; status('다른 창에서 보호 설정이 바뀌어 중지를 요청했습니다.'); }
    else { invalidate(); try { loadProtection(protectionAccount); status('보호 설정이 바뀌었습니다. 다시 조회하세요.'); } catch (error) { status(error.message); } }
  });
  async function init() {
    $('reviewSort').value = 'size-desc';
    render([]);
    renderProtection();
    update();
    try {
      const intro = O.inspect(localStorage, version);
      $('firstRunSection').hidden = !intro.firstRun && !intro.updated;
      $('introTitle').textContent = intro.updated ? `${version} 업데이트 안내` : '처음 사용하시나요?';
      $('introSteps').replaceChildren();
      for (const step of O.steps) { const item = document.createElement('li'); item.textContent = `${step.title}: ${step.message}`; $('introSteps').append(item); }
    } catch (error) { status(error.message); }
    if (!globalThis.chrome?.scripting || !Number.isSafeInteger(tabId) || tabId <= 0) {
      $('sourceStatus').textContent = '엣지의 톡클라우드 탭에서 확장 프로그램 아이콘을 눌러 열어 주세요.';
      status('일반 웹페이지에서는 실행되지 않습니다. 확장 프로그램으로 설치해 사용하세요.'); return;
    }
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['protocol.js', 'bridge.js'] });
      ready = true; $('sourceStatus').textContent = '톡클라우드 탭에 연결됨 · 로그인 상태는 조회 시 확인합니다.';
      update();
    } catch { $('sourceStatus').textContent = '연결 실패'; status('톡클라우드에 로그인한 후 그 탭에서 확장 프로그램 아이콘을 다시 눌러 주세요.'); }
  }
  init();
})();
