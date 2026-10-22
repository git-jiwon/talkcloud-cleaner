'use strict';
// Serializing icon clicks also covers clicks received while tabs.query is pending.
let openQueue = Promise.resolve();
async function openCleaner(tab) {
  let source;
  try { source = new URL(tab.url || 'about:blank'); } catch { source = null; }
  const fromTalkCloud = source?.origin === 'https://talkcloud.kakao.com' && Number.isSafeInteger(tab.id) && tab.id >= 0;
  const page = chrome.runtime.getURL(fromTalkCloud ? 'manager.html' : 'guide.html');
  const pageUrl = new URL(page);
  const target = fromTalkCloud ? `${page}?tabId=${tab.id}` : page;
  // Querying tabs needs no new permission. Only this extension's own URLs are used.
  const tabs = await chrome.tabs.query({});
  const existing = tabs.find(candidate => {
    if (!Number.isSafeInteger(candidate.id) || !candidate.url) return false;
    try {
      const url = new URL(candidate.url);
      return url.protocol === pageUrl.protocol && url.host === pageUrl.host && url.pathname === pageUrl.pathname && (!fromTalkCloud || url.searchParams.get('tabId') === String(tab.id));
    } catch { return false; }
  });
  if (existing) {
    try {
      await chrome.tabs.update(existing.id, { active: true });
      if (Number.isSafeInteger(existing.windowId) && chrome.windows?.update) await chrome.windows.update(existing.windowId, { focused: true });
      return;
    } catch {
      // The manager can close between query and update; a fresh one is then safe.
      const remaining = await chrome.tabs.query({});
      if (remaining.some(candidate => candidate.id === existing.id)) return;
    }
  }
  await chrome.tabs.create({ url: target });
}
chrome.action.onClicked.addListener(tab => {
  openQueue = openQueue.catch(() => {}).then(() => openCleaner(tab));
  // The action event has no response channel; avoid leaking page URLs in errors.
  return openQueue.catch(() => { console.warn('톡클라우드 정리 화면을 열지 못했습니다. 확장 아이콘을 다시 눌러 주세요.'); });
});
