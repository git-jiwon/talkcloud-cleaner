'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const extensionOrigin = 'chrome-extension://fixture-extension-id';

function harness(config = {}) {
  let listener;
  let tabs = [...(config.tabs || [])];
  const created = [], focused = [], windows = [], warnings = [];
  vm.runInNewContext(source, {
    URL, console: { warn: value => warnings.push(value) },
    chrome: {
      action: { onClicked: { addListener(callback) { listener = callback; } } },
      runtime: { getURL: file => `${extensionOrigin}/${file}` },
      tabs: {
        async query(query) { assert.deepEqual(Object.keys(query), []); if (config.queryError) throw new Error('private error'); return [...tabs]; },
        async update(id, options) {
          if (config.closeOnFocus) { tabs = tabs.filter(tab => tab.id !== id); throw new Error('No tab with id'); }
          if (config.focusError) throw new Error('Window not focused');
          focused.push({ id, ...options });
        },
        async create(options) { const tab = { id: 100 + created.length, ...options }; created.push(tab); tabs.push(tab); return tab; }
      },
      windows: { async update(id, options) { windows.push({ id, ...options }); } }
    }
  });
  return { click: tab => listener(tab), created, focused, windows, warnings };
}

test('clicking the same source reuses its existing manager and focuses its window', async () => {
  const app = harness({ tabs: [{ id: 30, windowId: 4, url: `${extensionOrigin}/manager.html?tabId=7` }] });
  await app.click({ id: 7, url: 'https://talkcloud.kakao.com/photo/all' });
  assert.equal(app.created.length, 0);
  assert.deepEqual(app.focused, [{ id: 30, active: true }]);
  assert.deepEqual(app.windows, [{ id: 4, focused: true }]);
});

test('near-simultaneous clicks cannot create duplicate managers', async () => {
  const app = harness();
  await Promise.all([app.click({ id: 7, url: 'https://talkcloud.kakao.com/photo/all' }), app.click({ id: 7, url: 'https://talkcloud.kakao.com/file/all' })]);
  assert.equal(app.created.length, 1);
  assert.equal(app.created[0].url, `${extensionOrigin}/manager.html?tabId=7`);
  assert.equal(app.focused.length, 1);
});

test('a different source tab gets its own manager and another extension is ignored', async () => {
  const app = harness({ tabs: [{ id: 1, url: `${extensionOrigin}/manager.html?tabId=8` }, { id: 2, url: 'chrome-extension://other-extension-id/manager.html?tabId=7' }] });
  await app.click({ id: 7, url: 'https://talkcloud.kakao.com/photo/all' });
  assert.equal(app.created.length, 1);
  assert.equal(app.created[0].url, `${extensionOrigin}/manager.html?tabId=7`);
  assert.equal(app.focused.length, 0);
});

test('unrelated and malformed source URLs open or reuse a guide', async () => {
  const app = harness();
  await app.click({ id: 7, url: 'https://talkcloud.kakao.com.attacker.invalid/' });
  await app.click({ id: 8, url: 'not a valid URL' });
  await app.click({ url: 'https://talkcloud.kakao.com/photo/all' });
  assert.equal(app.created.length, 1);
  assert.equal(app.created[0].url, `${extensionOrigin}/guide.html`);
  assert.equal(app.focused.length, 2);
});

test('manager closed between query and focus is replaced once', async () => {
  const app = harness({ closeOnFocus: true, tabs: [{ id: 3, url: `${extensionOrigin}/manager.html?tabId=7` }] });
  await app.click({ id: 7, url: 'https://talkcloud.kakao.com/photo/all' });
  assert.equal(app.created.length, 1);
});

test('focusing failure cannot create another manager while existing manager remains', async () => {
  const app = harness({ focusError: true, tabs: [{ id: 3, url: `${extensionOrigin}/manager.html?tabId=7` }] });
  await app.click({ id: 7, url: 'https://talkcloud.kakao.com/photo/all' });
  assert.equal(app.created.length, 0);
});

test('failed inventory does not open a duplicate and error message contains no source URL', async () => {
  const app = harness({ queryError: true });
  await app.click({ id: 7, url: 'https://talkcloud.kakao.com/photo/all?private=fixture' });
  assert.equal(app.created.length, 0);
  assert.equal(app.warnings.length, 1);
  assert.ok(!app.warnings[0].includes('fixture') && !app.warnings[0].includes('private error'));
});
