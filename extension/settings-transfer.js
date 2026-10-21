(() => {
  'use strict';
  const T = window.TalkCleanerProtectionTransfer;
  const $ = id => document.getElementById(id);
  let exported = null;
  let incoming = null;
  let revision = 0;
  let exportRevision = 0;
  const counts = value => `계정 ${value.accounts.toLocaleString()}개 · 보호 항목 ${value.files.toLocaleString()}개 · 보호 채팅방 ${value.rooms.toLocaleString()}개`;
  function status(message) { $('status').textContent = message; }
  function clearImport() { revision += 1; incoming = null; $('restore').disabled = true; $('importPreview').hidden = true; $('verified').hidden = true; }
  function clearExport() { exportRevision += 1; exported = null; $('saveBackup').disabled = true; $('backupResult').hidden = true; $('backupText').value = ''; }
  async function fingerprint(backup) {
    const accounts = backup.accounts.map(entry => ({ account: entry.account, protection: { version: 1,
      files: [...entry.protection.files].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      rooms: [...entry.protection.rooms].sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    }})).sort((a,b) => a.account < b.account ? -1 : a.account > b.account ? 1 : 0);
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(accounts)));
    return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2,'0')).join('');
  }
  function refresh() {
    const backup = T.createBackup(localStorage);
    const totals = T.summarize(backup);
    $('currentCounts').textContent = counts(totals);
    return backup;
  }
  async function preview(text) {
    clearImport();
    const currentRevision = revision;
    try {
      const parsed = T.parseBackup(text);
      const result = T.previewMerge(localStorage, parsed);
      const hash = await fingerprint(parsed);
      if (currentRevision !== revision) return;
      incoming = parsed;
      $('incomingCounts').textContent = `백업: ${counts(result.incoming)}`;
      $('mergedCounts').textContent = `복원 대상 계정 합계: ${counts(result.after)} · 새 보호 항목 ${result.addedFiles}개, 채팅방 ${result.addedRooms}개 추가`;
      $('incomingFingerprint').textContent = hash;
      $('importPreview').hidden = false;
      $('restore').disabled = false;
      status('백업 형식을 확인했습니다. 아직 저장하지 않았습니다. 목록 수와 확인값을 확인한 뒤 복원하세요.');
    } catch (error) { if (currentRevision === revision) status(error.message); }
  }
  $('backup').addEventListener('click', async () => {
    clearExport(); const currentExportRevision = exportRevision;
    try {
      const backup = refresh();
      const hash = await fingerprint(backup);
      if (currentExportRevision !== exportRevision) return;
      exported = backup;
      $('backupText').value = JSON.stringify(backup);
      $('backupFingerprint').textContent = hash;
      $('backupResult').hidden = false; $('saveBackup').disabled = false;
      const totals = T.summarize(backup);
      status(totals.files + totals.rooms ? '백업을 만들었습니다. 파일로 저장하거나 JSON 전체를 복사하세요.' : '저장된 보호 항목·채팅방이 0개입니다. 기존 설치본에서 연 화면인지 먼저 확인하세요.');
    } catch (error) { if (currentExportRevision === exportRevision) status(error.message); }
  });
  $('saveBackup').addEventListener('click', async () => {
    if (!exported) return;
    const text = JSON.stringify(exported);
    const currentExportRevision = exportRevision;
    const name = `talkcloud-protection-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;
    try {
      if (typeof window.showSaveFilePicker === 'function') {
        const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{description:'보호 설정 JSON',accept:{'application/json':['.json']}}] });
        const writable = await handle.createWritable(); await writable.write(text); await writable.close();
        status(currentExportRevision === exportRevision ? '백업 파일을 저장했습니다. 기존 확장을 유지한 채 새 설치 폴더의 확장을 등록하세요.' : '파일은 저장했지만 그동안 보호 설정이 바뀌었습니다. 최신 백업을 다시 만들어 저장하세요.');
      } else {
        const url = URL.createObjectURL(new Blob([text],{type:'application/json'}));
        const link = document.createElement('a'); link.href=url; link.download=name; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url),30000);
        status('백업 파일 다운로드를 요청했습니다. 저장된 파일을 확인하고 본인만 접근할 수 있는 폴더에 보관하세요.');
      }
    } catch (error) { status(error.name === 'AbortError' ? '저장을 취소했습니다. 보호 설정은 바뀌지 않았습니다.' : `파일 저장 실패: ${error.message}. 백업 JSON을 직접 복사할 수도 있습니다.`); }
  });
  $('refreshCounts').addEventListener('click', () => { clearExport(); clearImport(); try { refresh(); status('현재 보호 목록을 다시 확인했습니다.'); } catch (error) { status(error.message); } });
  $('backupFile').addEventListener('change', async () => {
    clearImport(); const currentRevision = revision; const file = $('backupFile').files[0]; if (!file) return;
    if (file.size > 10*1024*1024) { status('백업 파일이 10 MB를 넘습니다. 저장하지 않았습니다.'); return; }
    try { const text = await file.text(); if (currentRevision === revision) await preview(text); } catch (error) { if (currentRevision === revision) status(error.message); }
  });
  $('importText').addEventListener('input',clearImport);
  $('previewText').addEventListener('click', () => preview($('importText').value));
  $('restore').addEventListener('click', async () => {
    if (!incoming) return;
    const backup = incoming; clearImport();
    clearExport(); const currentRevision = revision;
    try {
      T.createBackup(localStorage);
      const result = T.applyMerge(localStorage,backup);
      const saved = refresh();
      const hash = await fingerprint(saved);
      if (currentRevision !== revision) return;
      $('verifiedCounts').textContent = `현재 설치본 전체: ${counts(T.summarize(saved))}`;
      $('verifiedFingerprint').textContent = hash;
      $('verified').hidden = false;
      status('보호 설정을 합쳐 저장하고 다시 읽어 확인했습니다. 새 관리 화면에서 보호 목록을 확인하세요.');
    } catch (error) { if (currentRevision === revision) status(error.message); }
  });
  window.addEventListener('storage', event => { if (event.key === null || event.key.startsWith('talkcloud-protection-v1:')) { clearImport(); clearExport(); try { refresh(); } catch {} status('다른 탭에서 보호 설정이 바뀌었습니다. 백업이나 복원 미리보기를 다시 확인하세요.'); } });
  try {
    const isExtension = location.protocol === 'chrome-extension:' || location.protocol === 'moz-extension:';
    const localDemo = ['localhost','127.0.0.1'].includes(location.hostname);
    if (!isExtension && !localDemo) throw new Error('확장 프로그램 안에서 이 화면을 열어야 보호 설정에 접근할 수 있습니다. 파일 주소로 연 화면에서는 이전할 수 없습니다.');
    if (!T) throw new Error('설정 이전 도구 파일을 찾을 수 없습니다. 설치 폴더를 확인하세요.');
    $('extensionId').textContent = isExtension ? location.hostname : '로컬 가상 데이터 검증';
    refresh();
    for (const id of ['backup','refreshCounts','backupFile','importText','previewText']) $(id).disabled = false;
    status(localDemo ? '로컬 화면 검증용입니다. 실제 확장의 보호 설정과 연결되지 않습니다.' : '현재 확장의 보호 목록을 읽었습니다. 기존 설치본이면 백업부터 시작하세요.');
  } catch (error) { status(error.message); }
})();
