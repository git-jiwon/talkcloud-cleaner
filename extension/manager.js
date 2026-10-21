(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const P = globalThis.TalkCleanerProtocol;
  const S = globalThis.TalkCleanerProtection;
  const R = globalThis.TalkCleanerReview;
  const D = globalThis.TalkCleanerDownload;
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
  const selectedRecords = () => plan ? R.selected(plan.records, selectedIds) : [];
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const formatSize = value => {
    if (value == null) return '확인 불가';
    const units = ['B', 'KB', 'MB', 'GB', 'TB']; let u = 0;
    while (value >= 1024 && u < units.length - 1) { value /= 1024; u++; }
    return `${value.toLocaleString('ko-KR', { maximumFractionDigits: 2 })} ${units[u]}`;
  };
  function status(message) { $('status').textContent = message; }
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
  }
  function invalidate() {
    $('reviewSearch').value = ''; $('reviewRoom').value = ''; $('reviewMinMB').value = '0'; $('reviewSelectedOnly').checked = false; $('reviewSort').value = 'size-desc';
    $('downloadProgress').max = 1; $('downloadProgress').value = 0;
    $('downloadStatus').textContent = downloadRun ? '새 목록에서는 저장 완료 확인을 다시 진행합니다. 이전에 PC에 저장한 파일은 유지됩니다.' : '2단계에서 항목을 체크한 뒤 ‘선택한 파일 저장’을 누르세요.';
    plan = null; lastTrashSummary = ''; reviewNeedsRefresh = false; savedFiles.clear(); selectedIds.clear(); expandedRooms.clear(); roomPages.clear(); pageIndex = 0; $('typeWarning').textContent = ''; $('typeWarning').hidden = true; render([]); update();
  }
  function loadProtection(account) {
    if (protectionAccount !== account) rooms = new Map();
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
      for (const text of [record.name || '(이름 미제공)', roomName(record), record.date, record.kind === 'link' ? '용량 집계 제외' : formatSize(record.size), kindLabels[record.kind]]) {
        const td = document.createElement('td'); td.textContent = text; td.title = text; tr.append(td);
      }
      const protectCell = document.createElement('td'), protect = document.createElement('button');
      protect.type = 'button'; protect.className = 'button button-quiet'; protect.textContent = '보호';
      protect.setAttribute('data-record-id', record.id);
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
  $('scan').addEventListener('click', async () => {
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
      const criteria = Object.freeze({ cutoff: $('cutoff').value, kinds: Object.freeze(kinds), minBytes, protectStarred: $('protectStarred').checked, includeGif: $('includeGif').checked, includeLeft: $('includeLeft').checked, account, ...S.filters(protection) });
      const { records, typeMismatchCount, unknownRoomCount } = await collect(criteria, '목록 찾는 중');
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
      render(records);
      showScanWarnings(plan);
      log(`${criteria.cutoff} 이전 ${criteria.kinds.map(k => kindLabels[k]).join('·')} ${records.length.toLocaleString()}개 조회 완료. 삭제 요청 없음.`);
      status(records.length ? `${records.length.toLocaleString()}개를 찾았습니다. 정리할 항목을 체크한 뒤 ‘휴지통으로 이동’을 누르세요.${roomWarning}` : '조건에 맞는 항목이 없습니다. 중요 표시 여부를 확인할 수 없는 항목도 보호 옵션에 따라 제외됩니다.');
    } catch (error) { plan = null; status(error.message); log(error.message); }
    finally { busy = false; update(); }
  });
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
    $('downloadProgress').max = records.length; $('downloadProgress').value = 0; update();
    let completed = 0;
    try {
      for (let index = 0; index < records.length; index++) {
        checkPlan(current);
        if (plan !== current) throw new Error('조회 조건이 바뀌었습니다. 다시 조회하세요.');
        const record = records[index], key = D.receiptKey(current.criteria.account, record);
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
      // Browser errors can include signed URLs or local paths; never export their raw text.
      downloadRun.error = '다운로드가 완료되지 않았습니다. 관리 화면에서 중단 이유를 확인하세요.';
      $('downloadStatus').textContent = `저장 중단: ${error.message} 완료 확인 ${completed.toLocaleString()} / ${records.length.toLocaleString()}개. 이미 저장된 파일은 유지됩니다.`;
      status('파일 저장이 완료되지 않았습니다. ‘PC에 저장’의 안내와 Edge 다운로드 목록을 확인하세요.');
      log(`파일 저장 중단. 완료 확인 ${completed.toLocaleString()}개. 휴지통 이동 요청 없음.`);
    } finally {
      downloadRun.finishedAt = new Date().toISOString();
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
        await call('trash', { ...current.criteria, records });
        accepted += records.length; pending = 0;
        $('progress').value = accepted / current.records.length * 100;
        status(`서버 요청 성공 ${accepted.toLocaleString()} / ${current.records.length.toLocaleString()}개 · 완료 후 재조회합니다.`);
        log(`${records.length}개 휴지통 이동 요청 성공 (누적 ${accepted.toLocaleString()}개).`);
        await sleep(350);
      }
      if (stopped) throw new Error('사용자가 중지했습니다.');
      const remaining = await collect(current.criteria, '처리 결과 재조회 중');
      checkPlan(current);
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
  addEventListener('beforeunload', event => { if (busy) { event.preventDefault(); event.returnValue = ''; } });
  addEventListener('storage', event => {
    if (!protectionAccount || event.key !== S.key(protectionAccount)) return;
    if (busy) { stopped = true; status('다른 창에서 보호 설정이 바뀌어 중지를 요청했습니다.'); }
    else { invalidate(); try { loadProtection(protectionAccount); status('보호 설정이 바뀌었습니다. 다시 조회하세요.'); } catch (error) { status(error.message); } }
  });
  async function init() {
    $('reviewSort').value = 'size-desc';
    render([]);
    renderProtection();
    update();
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
