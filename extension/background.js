chrome.action.onClicked.addListener(async tab => {
  const url = new URL(tab.url || 'about:blank');
  if (url.origin !== 'https://talkcloud.kakao.com') {
    await chrome.tabs.create({ url: chrome.runtime.getURL('guide.html') });
    return;
  }
  await chrome.tabs.create({ url: chrome.runtime.getURL(`manager.html?tabId=${tab.id}`) });
});
