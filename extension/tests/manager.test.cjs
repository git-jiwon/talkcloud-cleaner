"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const protocol = require("../protocol.js");
const protection = require("../protection.js");
const review = require("../review.js");
const download = require("../download.js");
const source = fs.readFileSync(path.join(__dirname, "../manager.js"), "utf8");
const html = fs.readFileSync(path.join(__dirname, "../manager.html"), "utf8");

class Element {
  constructor(id = "", ownerDocument = null) {
    this.id = id;
    this.ownerDocument = ownerDocument;
    this.parentElement = null;
    this.textContent = "";
    this.value = "";
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.open = false;
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
  }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  append(...children) { for (const child of children) child.parentElement = this; this.children.push(...children); }
  setAttribute(name, value) { this.attributes.set(name, value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  replaceChildren(...children) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  focus(options) { assert.ok(this.ownerDocument, "Focus target must belong to the mock document"); this.ownerDocument.activeElement = this; this.focusOptions = options; }
  scrollIntoView(options) { this.scrollOptions = options; }
  async dispatch(type) {
    for (const handler of this.listeners.get(type) || []) {
      await handler({ target: this, preventDefault() {} });
    }
  }
  click() { return this.disabled ? Promise.resolve() : this.dispatch("click"); }
}

function photoRecords(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `photo-${String(index).padStart(4, "0")}`,
    createdAt: Date.parse("2020-01-01T00:00:00+09:00") + index * 60000,
    date: "2020-01-01",
    size: 1024 + index,
    name: `photo-${index}.jpg`,
    bookmarked: false,
    verticalType: "MEDIA",
    kind: "photo"
  }));
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function harness(config = {}) {
  const documentState = { activeElement: null };
  const elements = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(match => [match[1], new Element(match[1], documentState)]));
  for (const match of html.matchAll(/<[a-z][^>]*\bid="([^"]+)"[^>]*>/gi)) {
    elements[match[1]].hidden = /\bhidden(?:\s|=|>)/.test(match[0]);
    elements[match[1]].open = /\bopen(?:\s|=|>)/.test(match[0]);
  }
  for (const match of html.matchAll(/<input\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements[match[1]].checked = /\bchecked\b/.test(match[0]);
    elements[match[1]].value = /\bvalue="([^"]*)"/.exec(match[0])?.[1] || "";
  }
  if (typeof config.backupBeforeTrash === "boolean") elements.backupBeforeTrash.checked = config.backupBeforeTrash;
  const calls = [];
  const downloadCalls = [], downloadSearches = [], downloadCancels = [], downloadItems = new Map();
  const downloadSources = new Map();
  let folderOpened = 0;
  const confirmations = [];
  const exports = [];
  const storage = config.storage || new Map();
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const walk = node => [node, ...node.children.flatMap(walk)];
  let active = config.records || photoRecords(config.count ?? 205);
  let accountCalls = 0;
  let trashCalls = 0;
  let clock = Date.now();
  class TestDate extends Date { static now() { return clock; } }
  const previewCheckboxes = () => {
    const walk = node => [node, ...node.children.flatMap(walk)];
    return walk(elements.preview).filter(node => node.type === "checkbox");
  };
  const context = vm.createContext({
    document: {
      get activeElement() { return documentState.activeElement; },
      getElementById(id) {
        assert.ok(elements[id], `manager.html must provide #${id}`);
        return elements[id];
      },
      createElement: tag => new Element(tag, documentState),
      querySelectorAll(selector) {
        return selector.split(', ').flatMap(part => {
          const match = /^#(preview|groupPreview|roomList|protectedFiles) (input|button)$/.exec(part);
          assert.ok(match, `Unsupported fake DOM selector: ${part}`);
          assert.ok(elements[match[1]], `Missing selector root: ${match[1]}`);
          return walk(elements[match[1]]).filter(node => node.id === match[2]);
        });
      }
    },
    location: { search: "?tabId=42" },
    TalkCleanerProtocol: protocol,
    TalkCleanerProtection: protection,
    TalkCleanerReview: review,
    TalkCleanerDownload: download,
    localStorage,
    URLSearchParams,
    Blob,
    Date: TestDate,
    URL: {
      createObjectURL(blob) { exports.push(blob); return "blob:mock-export"; },
      revokeObjectURL() {}
    },
    confirm(message) { confirmations.push(message); return typeof config.confirm === "function" ? config.confirm(message) : config.confirm !== false; },
    addEventListener() {},
    setTimeout(callback) { queueMicrotask(callback); return 1; },
    chrome: {
      tabs: { async reload() {} },
      downloads: {
        async download(request) {
          downloadCalls.push(structuredClone(request));
          const id = downloadCalls.length;
          if (config.failDownloadAt === id) throw new Error("Synthetic download start failure");
          const source = downloadSources.get(request.url);
          assert.ok(source, "Only a previously resolved original URL may be downloaded");
          const bytes = source.kind === "file" ? source.size ?? 4096 : 4096;
          downloadItems.set(id, { id, url: request.url, finalUrl: request.url, state: "complete", exists: true,
            filename: `D:\\MockDownloads\\${request.filename.replaceAll('/', '\\')}`, fileSize: bytes,
            bytesReceived: bytes, totalBytes: bytes, mime: source.mimeType });
          if (config.onDownload) await config.onDownload(request, id, downloadItems);
          return id;
        },
        async search(query) {
          downloadSearches.push({ ...query });
          if (config.onDownloadSearch) await config.onDownloadSearch(query.id, downloadItems, downloadSearches.length);
          const item = downloadItems.get(query.id);
          return item ? [{ ...item }] : [];
        },
        async cancel(id) { downloadCancels.push(id); const item = downloadItems.get(id); if (item) item.state = "interrupted"; },
        async showDefaultFolder() { folderOpened += 1; }
      },
      scripting: {
        async executeScript(request) {
          assert.equal(request.target.tabId, 42);
          if (request.files) return [];
          const [method, options] = request.args;
          calls.push({ method, options: structuredClone(options) });
          try {
            let value;
            if (method === "account") {
              accountCalls += 1;
              value = config.accountAt ? config.accountAt(accountCalls) : "account-one";
            } else if (method === "readPage") {
              if (config.onRead) await config.onRead(options, calls);
              if (config.readError) throw new Error(config.readError);
              const start = options.verticalType === "RECORDING" ? (options.pageIndex - 1) * 100 : options.offset ? Number(options.offset.slice("cursor-".length)) : 0;
              const inVertical = active.filter(record => record.verticalType === options.verticalType);
              const rawPage = options.joined === false ? [] : inVertical.slice(start, start + 100);
              const records = rawPage.filter(record => options.kinds.includes(record.kind) &&
                (!options.protectStarred || record.kind === "recording" || record.bookmarked === false) &&
                !protocol.protectedRecord(record, options) &&
                (record.kind === "link" || !options.minBytes || (record.size != null && record.size >= options.minBytes)));
              const hasMore = options.joined !== false && start + 100 < inVertical.length;
              value = { records, ids: rawPage.map(record => record.id), scanned: rawPage.length, hasMore, next: hasMore ? options.verticalType === "RECORDING" ? options.pageIndex + 1 : `cursor-${start + 100}` : null };
              if (config.readPage) value = config.readPage(options, calls, trashCalls);
            } else if (method === "readRooms") {
              if (config.onReadRooms) await config.onReadRooms(options, calls);
              if (config.roomsError) throw new Error(config.roomsError);
              value = { rooms: config.rooms || [], skipped: 0 };
            } else if (method === "originalFile") {
              assert.equal(options.criteria.account, "account-one");
              assert.ok(download.eligible(options.record), "Only supported file types may request a download URL");
              if (config.originalFileError) throw new Error(config.originalFileError);
              const record = options.record;
              const mimeType = record.kind === "video" ? "video/mp4" : record.kind === "file" ? "application/pdf" : record.kind === "gif" ? "image/gif" : "image/jpeg";
              value = { id: record.id, name: record.name, size: record.size, kind: record.kind, mimeType,
                url: `https://dn.talk.kakao.com/${encodeURIComponent(record.id)}?signature=synthetic-token` };
              downloadSources.set(value.url, { ...record, mimeType });
            } else if (method === "trash") {
              trashCalls += 1;
              if (config.onTrash) await config.onTrash(options, trashCalls);
              if (config.failTrashAt === trashCalls) throw new Error("테스트: server connection lost");
              assert.equal(options.account, "account-one");
              assert.equal(options.cutoff, "2024-01-01");
              protocol.trashBody(options.records, options.cutoff, options);
              if (!config.keepRecords) {
                const removed = new Set(options.records.map(record => record.id));
                active = active.filter(record => !removed.has(record.id));
              }
              if (config.markStarredAfterTrash) active = active.map(record => ({ ...record, bookmarked: true }));
              value = { accepted: true };
            } else {
              throw new Error(`Unexpected mocked bridge method: ${method}`);
            }
            return [{ result: { ok: true, value } }];
          } catch (error) {
            return [{ result: { ok: false, error: error.message } }];
          }
        }
      }
    }
  });
  if (config.downloadsAvailable === false) delete context.chrome.downloads;
  vm.runInContext(source, context, { filename: "manager.js" });
  // Let init finish its mocked extension injection without waiting on real timers.
  await new Promise(setImmediate);
  elements.cutoff.value = "2024-01-01";
  elements.includeLeft.checked = false;
  const h = {
    elements, calls, confirmations, exports, storage, localStorage, documentState,
    downloadCalls, downloadSearches, downloadCancels, downloadItems, folderOpened: () => folderOpened,
    click: id => elements[id].click(),
    change: id => elements[id].dispatch("change"),
    input: id => elements[id].dispatch("input"),
    trashCalls: () => calls.filter(call => call.method === "trash"),
    remaining: () => active.length,
    replaceRecords: records => { active = records; },
    checkboxes: previewCheckboxes,
    protectButtons: () => walk(elements.preview).filter(node => node.id === "button"),
    roomCheckboxes: () => walk(elements.roomList).filter(node => node.type === "checkbox"),
    grouped: () => walk(elements.groupPreview),
    groupControl: (attribute, key) => walk(elements.groupPreview).find(node => node.getAttribute(attribute) === key),
    advanceTime: ms => { clock += ms; }
  };
  assert.equal(elements.scan.disabled, false);
  return h;
}

// Deletion behavior tests use the ordinary optional-download path; backup-specific tests opt in explicitly.
const legacyHarness = (config = {}) => harness({ ...config, backupBeforeTrash: false });

test("selected-list exports keep requested records but omit account, protection IDs and unrecognized metadata", async () => {
  const storage = new Map();
  protection.write({ setItem: (key, value) => storage.set(key, value) }, "account-one", {
    version: 1,
    files: [{ id: "private-unselected-protected-file", name: "보호 예시" }],
    rooms: [{ id: "private-unselected-protected-room", name: "보호 방 예시" }]
  });
  const records = photoRecords(1).map(record => ({ ...record, roomId: "selected-room", joined: true,
    url: "https://dn.talk.kakao.com/unused?token=synthetic-private-url",
    extraMetadata: "synthetic-private-metadata" }));
  const h = await harness({ storage, records });
  await h.click("scan"); await h.click("selectPage"); await h.click("export");
  const text = await h.exports[0].text(), exported = JSON.parse(text);
  assert.deepEqual(Object.keys(exported.criteria).sort(), ["cutoff", "includeGif", "includeLeft", "kinds", "minBytes", "protectStarred"].sort());
  assert.equal(exported.records.length, 1);
  assert.equal(exported.records[0].id, records[0].id);
  assert.equal(exported.records[0].name, records[0].name);
  assert.equal(exported.records[0].roomId, "selected-room");
  assert.doesNotMatch(text, /account-one|private-unselected|synthetic-private|protectedFileIds|protectedRoomIds|extraMetadata|"url"/);
});

test("download reports retain the saved basename but never export an absolute browser path", async () => {
  let actualFilename;
  const h = await harness({ count: 1, onDownload(request, id, items) {
    const basename = request.filename.split("/").at(-1).replace(/\.jpg$/, " (1).jpg");
    actualFilename = `C:\\Users\\synthetic-private-user\\PrivateFolder\\${basename}`;
    items.get(id).filename = actualFilename;
  } });
  await h.click("scan"); await h.click("selectPage"); await h.click("downloadPhotos");
  // Rechecking uses the original absolute receipt, preserving duplicate-name verification.
  await h.click("downloadPhotos");
  assert.equal(h.downloadCalls.length, 1);
  await h.click("downloadReport");
  const text = await h.exports[0].text(), report = JSON.parse(text);
  assert.equal(report.items[0].filename, actualFilename.split("\\").at(-1));
  assert.equal(report.items[0].reused, true);
  assert.match(report.folder, /^TalkCloud-Backup\//);
  assert.doesNotMatch(text, /synthetic-private-user|PrivateFolder|Users|signature=|https?:|[A-Z]:/);
});

test("download reports omit raw error URLs, local paths and signed query values", async () => {
  const h = await harness({ count: 1,
    originalFileError: "Synthetic failure https://dn.talk.kakao.com/file?token=private-report-token C:\\Users\\private-report-user\\file.jpg" });
  await h.click("scan"); await h.click("selectPage"); await h.click("downloadPhotos"); await h.click("downloadReport");
  const text = await h.exports[0].text(), report = JSON.parse(text);
  assert.equal(report.items.length, 0);
  assert.match(report.error, /다운로드가 완료되지 않았습니다/);
  assert.doesNotMatch(text, /private-report|https?:|Users|token=|[A-Z]:/);
  assert.equal(h.trashCalls().length, 0);
});

async function selectRecord(h, id) {
  const checkbox = h.checkboxes().find(node => node.getAttribute("data-record-id") === id) ||
    h.grouped().find(node => node.type === "checkbox" && node.getAttribute("data-record-id") === id);
  assert.ok(checkbox, `Expected visible record ${id}`);
  assert.equal(checkbox.disabled, false, `Expected selectable record ${id}`);
  checkbox.checked = true; await checkbox.dispatch("change");
}

function assertReadOnlySnapshot(h, count) {
  assert.equal(h.elements.foundCount.textContent, count.toLocaleString());
  assert.equal(h.elements.selectedCount.textContent, "0");
  assert.equal(h.elements.execute.disabled, true);
  assert.equal(h.elements.selectFiltered.disabled, true);
  assert.equal(h.elements.scan.disabled, false);
  assert.ok(h.checkboxes().length > 0, "The reviewed snapshot must stay visible");
  assert.ok(h.checkboxes().every(checkbox => checkbox.disabled && !checkbox.checked));
  assert.match(h.elements.status.textContent, /다시 조회/);
}

test("new managers make saving optional and keep destructive actions unavailable with zero selection", async () => {
  const h = await harness({ count: 1 });
  assert.equal(h.elements.backupBeforeTrash.checked, false, "Saving is an optional action in production HTML");
  for (const id of ["confirmCount", "confirmHelp", "countHelp", "reviewContinue"]) assert.equal(h.elements[id], undefined, `Removed UI #${id} must not be mocked or rendered`);
  assert.equal(h.elements.downloadSection.open, false);
  assert.equal(h.elements.executeSection.hidden, true);
  assert.equal(h.elements.openDownload.disabled, true);
  assert.equal(h.elements.downloadPhotos.disabled, true);
  await h.click("scan");
  assert.equal(h.elements.openDownload.disabled, true);
  assert.equal(h.elements.execute.disabled, true);
  await h.elements.execute.dispatch("click");
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.trashCalls().length, 0);
  await h.click("selectFiltered");
  assert.equal(h.elements.openDownload.disabled, false);
  assert.equal(h.elements.execute.disabled, false);
  assert.equal(h.elements.downloadPhotos.disabled, false);
});

test("default photo video and document trash uses one confirmation with no download work", async () => {
  for (const kind of ["photo", "video", "file"]) {
    const record = { ...photoRecords(1)[0], kind, name: kind === "video" ? "clip.mp4" : kind === "file" ? "report.pdf" : "photo.jpg", verticalType: kind === "file" ? "FILE" : "MEDIA" };
    const h = await harness({ records: [record] });
    await h.click("categoryAll"); await h.click("scan"); await h.click("selectFiltered");
    assert.equal(h.elements.execute.disabled, false);
    assert.equal(h.elements.executeSection.hidden, true);
    await h.click("execute");
    assert.equal(h.confirmations.length, 1);
    assert.match(h.confirmations[0], /1개/);
    assert.equal(h.trashCalls().length, 1);
    assert.equal(h.remaining(), 0);
    assert.equal(h.downloadCalls.length, 0);
    assert.equal(h.downloadSearches.length, 0);
    assert.equal(h.calls.filter(call => call.method === "originalFile").length, 0);
    assert.equal(h.elements.downloadSection.open, false, "Direct trash does not open the optional download panel");
    assert.equal(h.elements.executeSection.hidden, false, "The progress area appears only once trash work starts");
  }
});

test("opening optional saving only opens the panel and never saves or deletes files", async () => {
  const h = await harness({ count: 2 });
  await h.click("scan"); await h.click("selectFiltered");
  const previousCalls = h.calls.length;
  await h.click("openDownload");
  assert.equal(h.elements.downloadSection.open, true);
  assert.equal(h.elements.executeSection.hidden, true);
  assert.equal(h.elements.backupBeforeTrash.checked, false);
  assert.equal(h.elements.selectedCount.textContent, "2");
  assert.equal(h.calls.length, previousCalls);
  assert.equal(h.downloadCalls.length, 0);
  assert.equal(h.downloadSearches.length, 0);
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.trashCalls().length, 0);
});

test("default trash works without the downloads API while optional saving stays unavailable", async () => {
  const h = await harness({ count: 1, downloadsAvailable: false });
  await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.backupBeforeTrash.checked, false);
  assert.equal(h.elements.execute.disabled, false);
  await h.click("openDownload");
  assert.equal(h.elements.downloadSection.open, true);
  assert.equal(h.elements.downloadPhotos.disabled, true);
  await h.elements.downloadPhotos.dispatch("click");
  assert.equal(h.downloadCalls.length, 0);
  await h.click("execute");
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.trashCalls().length, 1);
  assert.equal(h.remaining(), 0);
  assert.equal(h.downloadSearches.length, 0);
  assert.equal(h.calls.filter(call => call.method === "originalFile").length, 0);
});

test("opting into the backup condition blocks missing files and opting out allows trash without downloading", async () => {
  const h = await harness({ count: 1 });
  await h.click("scan"); await h.click("selectFiltered");
  h.elements.backupBeforeTrash.checked = true; await h.change("backupBeforeTrash");
  assert.equal(h.elements.execute.disabled, true);
  await h.elements.execute.dispatch("click");
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.trashCalls().length, 0);
  assert.equal(h.downloadCalls.length, 0);
  h.elements.backupBeforeTrash.checked = false; await h.change("backupBeforeTrash");
  assert.equal(h.elements.execute.disabled, false);
  await h.click("execute");
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.trashCalls().length, 1);
  assert.equal(h.downloadCalls.length, 0);
  assert.equal(h.downloadSearches.length, 0);
});

test("selected photos remain blocked until completed downloads and saving never automatically trashes", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness({ backupBeforeTrash: true, count: 2, onDownloadSearch: async (_id, _items, call) => {
    if (call === 1) { entered.resolve(); await release.promise; }
  } });
  await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.execute.disabled, true);
  // Direct dispatch verifies the execution guard independently of a disabled button.
  await h.elements.execute.dispatch("click");
  assert.equal(h.trashCalls().length, 0);
  const saving = h.click("downloadPhotos");
  await entered.promise;
  assert.equal(h.downloadCalls.length, 1, "Photos are saved sequentially");
  assert.equal(h.elements.execute.disabled, true);
  assert.equal(h.elements.downloadStop.disabled, false);
  assert.equal(h.elements.scan.disabled, true);
  release.resolve(); await saving;
  assert.equal(h.downloadCalls.length, 2);
  assert.equal(h.calls.filter(call => call.method === "originalFile").length, 2);
  assert.equal(h.trashCalls().length, 0, "Saving is independent of trash execution");
  assert.equal(h.remaining(), 2);
  assert.match(h.elements.downloadSummary.textContent, /완료.*2개/);

  assert.equal(h.elements.execute.disabled, false);
  await h.click("execute");
  assert.equal(h.trashCalls().length, 1);
  assert.equal(h.remaining(), 0);
});

test("saving includes selected photos GIF video and documents while explaining recording and link exclusions", async () => {
  const rows = photoRecords(6).map((row, index) => index === 1 ? { ...row, kind: "video", name: "clip.mp4" } : index === 2 ? { ...row, kind: "file", verticalType: "FILE", name: "report.pdf" } : index === 3 ? { ...row, kind: "recording", verticalType: "RECORDING", name: "녹음" } : index === 4 ? { ...row, kind: "link", verticalType: "LINK", name: "링크" } : index === 5 ? { ...row, kind: "gif", name: "motion.gif" } : row);
  const h = await harness({ backupBeforeTrash: true, records: rows });
  await h.click("categoryAll"); await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.selectedCount.textContent, "6");
  await h.click("downloadPhotos");
  assert.equal(h.downloadCalls.length, 4);
  assert.deepEqual(h.calls.filter(call => call.method === "originalFile").map(call => call.options.record.id), [rows[0].id, rows[1].id, rows[2].id, rows[5].id]);
  assert.equal(h.elements.selectedCount.textContent, "6");
  assert.equal(h.trashCalls().length, 0);
  assert.match(h.elements.downloadSummary.textContent, /저장 제외.*통화 녹음.*링크.*2개/);
  assert.match(h.elements.downloadSummary.textContent, /완료.*4개/);
  assert.match(h.downloadCalls[1].filename, /\.mp4$/);
  assert.match(h.downloadCalls[2].filename, /\.pdf$/);
  assert.equal(h.downloadItems.get(3).fileSize, rows[2].size);

  assert.equal(h.elements.execute.disabled, false);
});

test("a failed video or document download blocks trash even when the photo was saved", async () => {
  for (const kind of ["video", "file"]) {
    const rows = photoRecords(2);
    rows[1] = { ...rows[1], kind, name: kind === "video" ? "clip.mp4" : "report.pdf", verticalType: kind === "video" ? "MEDIA" : "FILE" };
    const h = await harness({ backupBeforeTrash: true, records: rows, failDownloadAt: 2 });
    await h.click("categoryAll"); await h.click("scan"); await h.click("selectFiltered"); await h.click("downloadPhotos");
    assert.match(h.elements.downloadSummary.textContent, /완료.*1개/);
    assert.equal(h.elements.execute.disabled, true);
    await h.elements.execute.dispatch("click");
    assert.equal(h.trashCalls().length, 0);
  }
});

test("a recording-only selection explains the mobile limitation and cannot start a download", async () => {
  const record = { ...photoRecords(1)[0], kind: "recording", verticalType: "RECORDING", name: "회의 녹음" };
  const h = await harness({ backupBeforeTrash: true, records: [record] });
  await h.click("categoryCall"); await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.downloadPhotos.disabled, true);
  assert.match(h.elements.downloadSummary.textContent, /모바일 앱/);
  await h.elements.downloadPhotos.dispatch("click");
  assert.equal(h.downloadCalls.length, 0);
  assert.equal(h.calls.filter(call => call.method === "originalFile").length, 0);
});

test("missing video and document downloads are rechecked before trash", async () => {
  for (const kind of ["video", "file"]) {
    const record = { ...photoRecords(1)[0], kind, name: kind === "video" ? "clip.mp4" : "report.pdf", verticalType: kind === "video" ? "MEDIA" : "FILE" };
    const h = await harness({ backupBeforeTrash: true, records: [record] });
    await h.click("categoryAll"); await h.click("scan"); await h.click("selectFiltered"); await h.click("downloadPhotos");
    assert.equal(h.elements.execute.disabled, false);
    h.downloadItems.get(1).exists = false;
    await h.click("execute");
    assert.equal(h.trashCalls().length, 0);
    assert.equal(h.elements.selectedCount.textContent, "1");
    assert.equal(h.elements.execute.disabled, true);
  }
});

test("failed photo download keeps the backup guard locked and preserves the reviewed plan", async () => {
  const h = await harness({ backupBeforeTrash: true, count: 2, failDownloadAt: 1 });
  await h.click("scan"); await h.click("selectFiltered");
  await h.click("downloadPhotos");
  assert.equal(h.elements.execute.disabled, true);
  assert.equal(h.elements.selectedCount.textContent, "2");
  assert.equal(h.elements.preview.children.length, 2);
  assert.equal(h.elements.scan.disabled, false);
  await h.elements.execute.dispatch("click");
  assert.equal(h.trashCalls().length, 0);
  assert.equal(h.remaining(), 2);
});

test("trash preflight rechecks a saved file and preserves the plan when it is missing", async () => {
  const h = await harness({ backupBeforeTrash: true, count: 1 });
  await h.click("scan"); await h.click("selectFiltered"); await h.click("downloadPhotos");
  assert.equal(h.downloadCalls.length, 1);

  assert.equal(h.elements.execute.disabled, false);
  h.downloadItems.get(1).exists = false;
  await h.click("execute");
  assert.equal(h.trashCalls().length, 0);
  assert.equal(h.elements.selectedCount.textContent, "1");
  assert.equal(h.elements.preview.children.length, 1);
  assert.equal(h.elements.downloadPhotos.disabled, false);
  assert.equal(h.elements.execute.disabled, true);
  assert.match(h.elements.status.textContent, /다운로드|사진|백업/);
});

test("a new scan forgets previous download receipts and requires a fresh photo-save confirmation", async () => {
  const h = await harness({ backupBeforeTrash: true, count: 1 });
  await h.click("scan"); await h.click("selectFiltered"); await h.click("downloadPhotos");

  assert.equal(h.elements.execute.disabled, false);
  await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.execute.disabled, true);
  assert.match(h.elements.downloadSummary.textContent, /완료.*0개/);
  assert.equal(h.trashCalls().length, 0);
});

test("stopping a photo batch keeps the first completed receipt and does not start the third photo", async () => {
  const entered = deferred(), release = deferred();
  let held = false;
  const h = await harness({ backupBeforeTrash: true, count: 3,
    onDownload: (_request, id, items) => { if (id === 2) items.get(id).state = "in_progress"; },
    onDownloadSearch: async id => {
      if (id === 2 && !held) { held = true; entered.resolve(); await release.promise; }
    }
  });
  await h.click("scan"); await h.click("selectFiltered");
  const saving = h.click("downloadPhotos");
  await entered.promise;
  assert.equal(h.downloadCalls.length, 2);
  assert.match(h.elements.downloadSummary.textContent, /완료.*1개/);
  await h.click("downloadStop"); release.resolve(); await saving;
  assert.equal(h.downloadCalls.length, 2, "No later photo is started after stop");
  assert.deepEqual(h.downloadCancels, [2]);
  assert.equal(h.downloadItems.get(1).state, "complete");
  assert.equal(h.downloadItems.get(2).state, "interrupted");
  assert.match(h.elements.downloadSummary.textContent, /완료.*1개/);
  assert.equal(h.elements.selectedCount.textContent, "3");

  assert.equal(h.elements.execute.disabled, true);
  assert.equal(h.trashCalls().length, 0);
});

test("an account change during a download prevents recording its receipt or enabling trash", async () => {
  const entered = deferred(), release = deferred();
  let accountChanged = false;
  const h = await harness({ backupBeforeTrash: true, count: 2, accountAt: () => accountChanged ? "account-two" : "account-one",
    onDownloadSearch: async (_id, _items, count) => { if (count === 1) { entered.resolve(); await release.promise; } }
  });
  await h.click("scan"); await h.click("selectFiltered");
  const saving = h.click("downloadPhotos");
  await entered.promise; accountChanged = true; release.resolve(); await saving;
  assert.equal(h.downloadCalls.length, 1);
  assert.equal(h.downloadItems.get(1).state, "complete", "Downloaded bytes remain but are not accepted as a receipt");
  assert.match(h.elements.downloadSummary.textContent, /완료.*0개/);
  assert.match(h.elements.downloadStatus.textContent, /계정/);

  assert.equal(h.elements.execute.disabled, true);
  await h.elements.execute.dispatch("click");
  assert.equal(h.trashCalls().length, 0);
});

test("a protection change during a download prevents accepting its receipt and any later download", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness({ backupBeforeTrash: true, count: 2,
    onDownloadSearch: async (_id, _items, count) => { if (count === 1) { entered.resolve(); await release.promise; } }
  });
  await h.click("scan"); await h.click("selectFiltered");
  const saving = h.click("downloadPhotos");
  await entered.promise;
  protection.write(h.localStorage, "account-one", { version: 1, files: [{ id: "photo-0000", name: "보관" }], rooms: [] });
  release.resolve(); await saving;
  assert.equal(h.downloadCalls.length, 1);
  assert.match(h.elements.downloadSummary.textContent, /완료.*0개/);
  assert.match(h.elements.downloadStatus.textContent, /보호 설정/);

  assert.equal(h.elements.execute.disabled, true);
  await h.elements.execute.dispatch("click");
  assert.equal(h.trashCalls().length, 0);
});

test("205-photo plan needs one confirmation, trashes 100/100/5, and verifies an empty requery", async () => {
  const h = await legacyHarness();
  await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.selectedCount.textContent, "205");
  assert.equal(h.elements.preview.children.length, 100);
  assert.equal(h.trashCalls().length, 0, "Scanning is read-only");
  assert.equal(h.elements.execute.disabled, false);
  await h.click("execute");

  assert.deepEqual(h.trashCalls().map(call => call.options.records.length), [100, 100, 5]);
  const ids = h.trashCalls().flatMap(call => call.options.records.map(record => record.id));
  assert.equal(new Set(ids).size, 205);
  assert.equal(h.remaining(), 0);
  assert.equal(h.calls.filter(call => call.method === "readPage").length, 4, "Three scan pages and a final empty verification page");
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0], /205/);
  assert.equal(h.elements.progress.value, 100);
  assert.match(h.elements.status.textContent, /사라진 것을 확인/);

  assert.equal(h.elements.selectedCount.textContent, "0");
  assert.equal(h.elements.execute.disabled, true);
  assert.equal(h.elements.scan.disabled, false);
});

test("changing any date, kind, size or protection filter invalidates the reviewed plan", async () => {
  for (const id of ["cutoff", "typesPhoto", "typesVideo", "typesFile", "typesLink", "typesCall", "includeGif", "includeLeft", "minSizeMB", "protectStarred"]) {
    const h = await legacyHarness({ count: 1 });
    await h.click("scan"); await h.click("selectFiltered");

    assert.equal(h.elements.execute.disabled, false);
    if (id === "cutoff") h.elements.cutoff.value = "2025-01-01";
    else if (id === "minSizeMB") h.elements.minSizeMB.value = "5";
    else h.elements[id].checked = !h.elements[id].checked;
    await h.change(id);

    assert.equal(h.elements.selectedCount.textContent, "0", id);
    assert.equal(h.elements.execute.disabled, true, id);

    await h.click("execute");
    assert.equal(h.trashCalls().length, 0, id);
    assert.match(h.elements.status.textContent, /조건이 바뀌었습니다/);
  }
});

test("invalid date, server lookup failure, and an account change produce no executable plan", async () => {
  const badDate = await legacyHarness({ count: 1 });
  badDate.elements.cutoff.value = "2023-02-29";
  await badDate.click("scan"); await badDate.click("selectFiltered");
  assert.equal(badDate.calls.length, 0);
  assert.equal(badDate.elements.execute.disabled, true);

  const failed = await legacyHarness({ count: 1, readError: "조회 실패: 인증이 필요합니다." });
  await failed.click("scan"); await failed.click("selectFiltered");

  await failed.click("execute");
  assert.equal(failed.trashCalls().length, 0);
  assert.equal(failed.elements.execute.disabled, true);
  assert.equal(failed.elements.scan.disabled, false);
  assert.match(failed.elements.status.textContent, /인증이 필요/);

  const changed = await legacyHarness({ count: 1, accountAt: count => count < 3 ? "account-one" : "account-two" });
  await changed.click("scan"); await changed.click("selectFiltered");

  await changed.click("execute");
  assert.equal(changed.trashCalls().length, 0);
  assert.equal(changed.elements.execute.disabled, true);
  assert.match(changed.elements.status.textContent, /계정이 바뀌었습니다/);
});

test("cancelling the final confirmation leaves the plan available and makes no trash request", async () => {
  const h = await legacyHarness({ count: 1, confirm: false });
  await h.click("scan"); await h.click("selectFiltered");

  await h.click("execute");
  assert.equal(h.confirmations.length, 1);
  assert.equal(h.trashCalls().length, 0);
  assert.equal(h.elements.execute.disabled, false);
  assert.equal(h.elements.selectedCount.textContent, "1");
  assert.equal(h.elements.preview.children.length, 1);
  assert.equal(h.checkboxes()[0].checked, true);
  assert.equal(h.elements.executeSection.hidden, true);
  assert.equal(h.downloadCalls.length, 0);
  assert.equal(h.downloadSearches.length, 0);
});

test("the single confirmation uses the latest selection and includes selected rows hidden by filters", async () => {
  let approved = false;
  const h = await harness({ count: 3, confirm: () => approved });
  await h.click("scan"); await h.click("selectFiltered");
  assert.match(h.elements.execute.textContent, /3개/);
  const checkbox = h.checkboxes()[0]; checkbox.checked = false; await checkbox.dispatch("change");
  assert.match(h.elements.execute.textContent, /2개/);
  h.elements.reviewSearch.value = "photo-0"; await h.input("reviewSearch");
  await h.click("execute");
  assert.equal(h.confirmations.length, 1);
  assert.match(h.confirmations[0], /선택한 2개/);
  assert.match(h.confirmations[0], /보이지 않는 선택 1개/);
  assert.match(h.confirmations[0], /종류: 사진/);
  assert.equal(h.elements.selectedCount.textContent, "2");
  assert.equal(h.elements.executeSection.hidden, true);
  assert.equal(h.remaining(), 3);
  approved = true;
  await h.click("execute");
  assert.equal(h.confirmations.length, 2, "Exactly one confirmation is shown for each click");
  assert.match(h.confirmations[1], /선택한 2개/);
  assert.deepEqual(h.trashCalls()[0].options.records.map(record => record.id), ["photo-0000", "photo-0001"]);
  assert.equal(h.remaining(), 1);
  assert.equal(h.downloadCalls.length, 0);
});

test("stop during lookup discards partial results and never enables deletion", async () => {
  const entered = deferred();
  const release = deferred();
  const h = await legacyHarness({ onRead: async () => { entered.resolve(); await release.promise; } });
  const scanning = h.click("scan");
  await entered.promise;
  assert.equal(h.elements.stop.disabled, false);
  await h.click("stop");
  release.resolve();
  await scanning;
  assert.equal(h.calls.filter(call => call.method === "readPage").length, 1);

  await h.click("execute");
  assert.equal(h.trashCalls().length, 0);
  assert.equal(h.elements.execute.disabled, true);
  assert.equal(h.elements.scan.disabled, false);
  assert.match(h.elements.status.textContent, /중지/);
});

test("stop during an in-flight batch waits for it and sends no later batches or requery", async () => {
  const entered = deferred();
  const release = deferred();
  const h = await legacyHarness({ onTrash: async () => { entered.resolve(); await release.promise; } });
  await h.click("scan"); await h.click("selectFiltered");

  const executing = h.click("execute");
  await entered.promise;
  assert.equal(h.elements.cutoff.disabled, true);
  await h.click("stop");
  release.resolve();
  await executing;
  assert.deepEqual(h.trashCalls().map(call => call.options.records.length), [100]);
  assert.equal(h.remaining(), 105);
  assert.equal(h.calls.filter(call => call.method === "readPage").length, 3);
  assert.match(h.elements.status.textContent, /중단:.*요청 성공 100개/);
  assert.equal(h.elements.execute.disabled, true);
  assert.equal(h.elements.stop.disabled, true);
  assert.equal(h.elements.cutoff.disabled, false);
});

test("an uncertain second trash request stops without retrying or reporting full completion", async () => {
  const h = await legacyHarness({ failTrashAt: 2 });
  await h.click("scan"); await h.click("selectFiltered");

  await h.click("execute");
  assert.deepEqual(h.trashCalls().map(call => call.options.records.length), [100, 100]);
  assert.equal(h.remaining(), 105);
  assert.match(h.elements.status.textContent, /요청 성공 100개, 마지막 100개는 결과 미확정/);
  assert.doesNotMatch(h.elements.status.textContent, /사라진 것을 확인/);
  assert.equal(h.elements.execute.disabled, true);
});

test("successful responses are not called complete when requery still finds planned photos", async () => {
  const h = await legacyHarness({ count: 2, keepRecords: true });
  await h.click("scan"); await h.click("selectFiltered");

  await h.click("execute");
  assert.equal(h.trashCalls().length, 1);
  assert.match(h.elements.status.textContent, /재조회에서 대상 2개가 남아 있습니다/);
  assert.doesNotMatch(h.elements.status.textContent, /사라진 것을 확인/);
  assert.equal(h.elements.execute.disabled, true);
});

test("pagination preserves individual exclusions, updates selection, and exports only selected items", async () => {
  const h = await legacyHarness();
  await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.foundCount.textContent, "205");
  assert.equal(h.elements.pageInfo.textContent, "1 / 3 페이지");
  assert.equal(h.elements.previewPrevious.disabled, true);

  let checkbox = h.checkboxes()[0];
  const firstExcluded = checkbox.getAttribute("data-record-id");
  checkbox.checked = false;
  await checkbox.dispatch("change");
  assert.equal(h.elements.selectedCount.textContent, "204");
  assert.match(h.elements.execute.textContent, /204개/);
  assert.equal(h.elements.execute.disabled, false);
  await h.click("previewNext");
  assert.equal(h.elements.pageInfo.textContent, "2 / 3 페이지");
  assert.equal(h.checkboxes().length, 100);
  checkbox = h.checkboxes()[0];
  const secondExcluded = checkbox.getAttribute("data-record-id");
  checkbox.checked = false;
  await checkbox.dispatch("change");
  await h.click("previewNext");
  assert.equal(h.elements.pageInfo.textContent, "3 / 3 페이지");
  assert.equal(h.checkboxes().length, 5);
  assert.equal(h.elements.previewNext.disabled, true);
  await h.click("previewPrevious");
  assert.equal(h.checkboxes()[0].checked, false);
  await h.click("previewPrevious");
  assert.equal(h.checkboxes()[0].checked, false);
  assert.equal(h.elements.selectedCount.textContent, "203");
  assert.equal(h.elements.foundCount.textContent, "205");

  await h.click("export");
  assert.equal(h.exports.length, 1);
  const exported = JSON.parse(await h.exports[0].text());
  assert.equal(exported.records.length, 203);
  assert.equal(Object.hasOwn(exported.criteria, "account"), false);
  assert.equal(exported.records.some(record => [firstExcluded, secondExcluded].includes(record.id)), false);

  await h.click("execute");
  assert.deepEqual(h.trashCalls().map(call => call.options.records.length), [100, 100, 3]);
  assert.equal(h.remaining(), 2, "Excluded items remain and do not count as failed selected deletions");
  assert.match(h.elements.status.textContent, /사라진 것을 확인/);
});

test("kind, size and protection settings are passed to both vertical queries and deletion", async () => {
  const base = photoRecords(1)[0];
  const rows = [
    { ...base, id: "small-photo", size: 512 },
    { ...base, id: "large-video", kind: "video", size: 3 * 1024 * 1024 },
    { ...base, id: "large-file", kind: "file", verticalType: "FILE", size: 2 * 1024 * 1024 },
    { ...base, id: "starred-file", kind: "file", verticalType: "FILE", bookmarked: true, size: 2 * 1024 * 1024 },
    { ...base, id: "gif", kind: "gif", size: 2 * 1024 * 1024 }
  ];
  const h = await legacyHarness({ records: rows });
  h.elements.typesPhoto.checked = false;
  h.elements.includeGif.checked = false;
  h.elements.typesVideo.checked = true;
  h.elements.typesFile.checked = true;
  h.elements.minSizeMB.value = "1.5";
  await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.selectedCount.textContent, "2");
  const reads = h.calls.filter(call => call.method === "readPage");
  assert.deepEqual(reads.map(call => call.options.verticalType), ["MEDIA", "FILE"]);
  for (const call of reads) {
    assert.deepEqual(call.options.kinds, ["video", "file"]);
    assert.equal(call.options.minBytes, 1572864);
    assert.equal(call.options.protectStarred, true);
  }

  await h.click("execute");
  assert.deepEqual(h.trashCalls()[0].options.records.map(record => record.id), ["large-file", "large-video"]);
  assert.equal(h.remaining(), 3);
  assert.match(h.elements.status.textContent, /사라진 것을 확인/);
});

test("missing kinds and negative minimum size are rejected before any server read", async () => {
  const h = await legacyHarness({ count: 1 });
  for (const id of ["typesPhoto", "typesVideo", "typesFile", "includeGif"]) h.elements[id].checked = false;
  await h.click("scan"); await h.click("selectFiltered");
  assert.match(h.elements.status.textContent, /하나 이상/);
  assert.equal(h.calls.length, 0);
  h.elements.typesPhoto.checked = true;
  h.elements.minSizeMB.value = "-1";
  await h.click("scan"); await h.click("selectFiltered");
  assert.match(h.elements.status.textContent, /0 이상의 숫자/);
  assert.equal(h.calls.length, 0);
});

test("post-delete verification catches raw remaining IDs even when protection hides the records", async () => {
  const h = await legacyHarness({ count: 2, keepRecords: true, markStarredAfterTrash: true });
  await h.click("scan"); await h.click("selectFiltered");

  await h.click("execute");
  assert.equal(h.trashCalls().length, 1);
  assert.equal(h.calls.filter(call => call.method === "readPage").length, 2);
  assert.match(h.elements.status.textContent, /재조회에서 대상 2개가 남아 있습니다/);
  assert.doesNotMatch(h.elements.status.textContent, /사라진 것을 확인/);
});

test("a plan older than one hour cannot be executed", async () => {
  const h = await legacyHarness({ count: 1 });
  await h.click("scan"); await h.click("selectFiltered");

  h.advanceTime(3600001);
  await h.click("execute");
  assert.equal(h.trashCalls().length, 0);
  assert.equal(h.confirmations.length, 0);
  assert.equal(h.elements.execute.disabled, true);

  assert.equal(h.elements.selectedCount.textContent, "0");
  assert.match(h.elements.status.textContent, /1시간/);
});

const rawPhoto = (id, patch = {}) => ({ id, drawerId: `drawer-${id}`, contentType: "IMAGE", createdAt: Date.parse("2020-01-01T00:00:00+09:00"), mimeType: "image/jpeg", bookmarked: false, size: 2048, hashedChatId: "room-open", ...patch });

test("raw MIME mismatch pages continue, count unique exclusions, and keep normal items selectable", async () => {
  const h = await legacyHarness({ readPage: options => protocol.parsePage({ items: options.offset ? [rawPhoto("ok"), rawPhoto("bad", { mimeType: "video/mp4" })] : [rawPhoto("bad", { mimeType: "application/octet-stream" })], hasMore: !options.offset }, options) });
  await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.selectedCount.textContent, "1");
  assert.equal(h.elements.typeWarning.hidden, false);
  assert.match(h.elements.typeWarning.textContent, /일치하지 않는 1개/);
  assert.equal(h.calls.filter(c => c.method === "readPage")[1].options.offset, "drawer-bad");
  assert.equal(h.trashCalls().length, 0);

  assert.equal(h.elements.execute.disabled, false);
});

test("an all-mismatched scan reports exclusions and never enables deletion", async () => {
  const h = await legacyHarness({ readPage: options => protocol.parsePage({ items: [rawPhoto("bad", { mimeType: "text/plain" })], hasMore: false }, options) });
  await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.selectedCount.textContent, "0");
  assert.match(h.elements.typeWarning.textContent, /1개/);

  assert.equal(h.elements.execute.disabled, true);
  assert.equal(h.trashCalls().length, 0);
});

test("same-ID uncertainty quarantines candidates regardless of which page appears first", async () => {
  for (const badFirst of [false, true]) {
    const h = await legacyHarness({ readPage: options => protocol.parsePage({ items: [rawPhoto("same", { drawerId: options.offset ? "second" : "first", mimeType: Boolean(options.offset) === badFirst ? "text/plain" : "image/jpeg" })], hasMore: !options.offset }, options) });
    await h.click("scan"); await h.click("selectFiltered");
    assert.equal(h.elements.selectedCount.textContent, "0");
    assert.match(h.elements.typeWarning.textContent, /1개/);
  }
});

test("a previously eligible duplicate later protected by room cannot survive in the plan", async () => {
  const storage = new Map();
  protection.write({ setItem: (k, v) => storage.set(k, v) }, "account-one", { version: 1, files: [], rooms: [{ id: "room-protected", name: "보관" }] });
  for (const blockedFirst of [false, true]) {
    const h = await legacyHarness({ storage, readPage: options => protocol.parsePage({ items: [rawPhoto("same", { drawerId: options.offset ? "second" : "first", hashedChatId: Boolean(options.offset) === blockedFirst ? "room-protected" : "room-open" })], hasMore: !options.offset }, options) });
    await h.click("scan"); await h.click("selectFiltered");
    assert.equal(h.elements.selectedCount.textContent, "0");
    assert.equal(h.elements.execute.disabled, true);
  }
});

test("a remaining raw ID cannot be mistaken for success when its MIME changes after trash", async () => {
  const h = await legacyHarness({ readPage: (options, calls, trashCalls) => protocol.parsePage({ items: [rawPhoto("same", { mimeType: trashCalls ? "text/plain" : "image/jpeg" })], hasMore: false }, options) });
  await h.click("scan"); await h.click("selectFiltered");

  await h.click("execute");
  assert.equal(h.trashCalls().length, 1);
  assert.match(h.elements.status.textContent, /재조회에서 대상 1개가 남아 있습니다/);
});

test("protecting a file removes it immediately, updates the selection, and persists across managers", async () => {
  const h = await legacyHarness({ count: 2 });
  await h.click("scan"); await h.click("selectFiltered");

  await h.protectButtons()[0].click();
  assert.equal(h.elements.selectedCount.textContent, "1");
  assert.equal(h.elements.protectedFileCount.textContent, "1");
  assert.match(h.elements.execute.textContent, /1개/);
  assert.equal(h.elements.execute.disabled, false);
  const second = await legacyHarness({ count: 2, storage: h.storage });
  await second.click("scan"); await second.click("selectFiltered");
  assert.equal(second.elements.selectedCount.textContent, "1");

  await second.click("execute");
  assert.deepEqual(second.trashCalls()[0].options.records.map(r => r.id), ["photo-0000"]);
});

test("chat room protection can be selected before scan and excludes every matching item", async () => {
  const rows = photoRecords(2).map((r, i) => ({ ...r, roomId: i ? "room-open" : "room-protected" }));
  const h = await legacyHarness({ records: rows, rooms: [{ id: "room-protected", name: "보관 채팅방" }] });
  await h.click("loadRooms");
  assert.equal(h.calls.filter(c => c.method === "readRooms").length, 4);
  const checkbox = h.roomCheckboxes()[0]; checkbox.checked = true; await checkbox.dispatch("change");
  assert.equal(h.elements.protectedRoomCount.textContent, "1");
  await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.selectedCount.textContent, "1");
  assert.match(h.elements.protectionStatus.textContent, /다음 조회에도/);
});

test("protection changes in another manager prevent any destructive request", async () => {
  const h = await legacyHarness({ count: 1 });
  await h.click("scan"); await h.click("selectFiltered");
  protection.write(h.localStorage, "account-one", { version: 1, files: [{ id: "photo-0000", name: "보관" }], rooms: [] });
  await h.click("execute");
  assert.equal(h.trashCalls().length, 0);
  assert.equal(h.confirmations.length, 0);
  assert.match(h.elements.status.textContent, /보호 설정이 바뀌었습니다/);
});

test("protection changes between batches prevent later POSTs", async () => {
  let h;
  h = await legacyHarness({ onTrash: async (_options, count) => {
    if (count === 1) protection.write(h.localStorage, "account-one", { version: 1, files: [{ id: "photo-0100", name: "새 보호" }], rooms: [] });
  } });
  await h.click("scan"); await h.click("selectFiltered"); await h.click("execute");
  assert.deepEqual(h.trashCalls().map(c => c.options.records.length), [100]);
  assert.match(h.elements.status.textContent, /보호 설정이 바뀌어/);
});

test("category presets select the exact type and recording scans once with page numbers", async () => {
  const h = await legacyHarness({ readPage: options => {
    assert.equal(options.verticalType, "RECORDING");
    return protocol.parsePage({ items: [{ id: `recording-${options.pageIndex}`, recordingStartedAt: rawPhoto("x").createdAt, voiceSize: 1024, displayName: "통화 녹음" }], hasMore: options.pageIndex === 1 }, options);
  } });
  h.elements.includeLeft.checked = true;
  await h.click("categoryCall"); await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.elements.selectedCount.textContent, "2");
  assert.deepEqual(h.calls.filter(c => c.method === "readPage").map(c => c.options.pageIndex), [1, 2]);
  assert.equal(h.elements.categoryCall.attributes.get("aria-pressed"), "true");
  await h.click("categoryLink");
  assert.equal(h.elements.typesLink.checked, true);
  assert.equal(h.elements.typesCall.checked, false);
  assert.equal(h.elements.execute.disabled, true);
});

test("repeated recording result pages abort instead of producing a partial plan", async () => {
  const h = await legacyHarness({ readPage: options => protocol.parsePage({ items: [{ id: "same-recording", recordingStartedAt: rawPhoto("x").createdAt, voiceSize: 1024 }], hasMore: true }, options) });
  await h.click("categoryCall"); await h.click("scan"); await h.click("selectFiltered");
  assert.equal(h.calls.filter(c => c.method === "readPage").length, 2);
  assert.equal(h.elements.execute.disabled, true);
  assert.match(h.elements.status.textContent, /페이지가 반복/);
});

test("a completed lookup selects nothing and only manually selected IDs can be deleted", async () => {
  const h = await legacyHarness({ count: 3 });
  assert.equal(h.elements.reviewSort.value, "size-desc");
  assert.match(h.elements.reviewEmpty.textContent, /1단계.*목록 찾기/);
  assert.equal(h.elements.expandRooms.hidden, true);
  await h.click("scan");
  assert.equal(h.elements.selectedCount.textContent, "0");
  assert.equal(h.elements.foundCount.textContent, "3");
  assert.ok(h.checkboxes().every(checkbox => !checkbox.checked));
  await h.click("execute");
  assert.equal(h.trashCalls().length, 0);
  const checkbox = h.checkboxes()[1]; checkbox.checked = true; await checkbox.dispatch("change");

  assert.equal(h.elements.selectedCount.textContent, "1");
  assert.equal(h.elements.execute.disabled, false);
  await h.click("execute");
  assert.deepEqual(h.trashCalls()[0].options.records.map(record => record.id), ["photo-0001"]);
  assert.equal(h.remaining(), 2);
});

test("sorting, search, room and size filters preserve selected IDs and expose hidden selection", async () => {
  const rows = photoRecords(3).map((record, index) => ({ ...record, name: ["zeta", "alpha", "beta"][index], size: [60, 5, 80][index] * 1024 * 1024, roomId: index === 2 ? "room-b" : "room-a" }));
  const h = await legacyHarness({ records: rows, rooms: [{ id: "room-a", name: "A방" }, { id: "room-b", name: "B방" }] });
  await h.click("scan");
  const checkbox = h.checkboxes().find(item => item.getAttribute("data-record-id") === "photo-0000"); checkbox.checked = true; await checkbox.dispatch("change");

  await h.click("sortSize");
  assert.equal(h.elements.sortHeaderSize.getAttribute("aria-sort"), "ascending");
  await h.click("sortSize");
  assert.equal(h.elements.sortHeaderSize.getAttribute("aria-sort"), "descending");
  assert.deepEqual(h.checkboxes().map(item => item.getAttribute("data-record-id")), ["photo-0002", "photo-0000", "photo-0001"]);
  assert.equal(h.checkboxes()[1].checked, true);
  h.elements.reviewSearch.value = "beta"; await h.input("reviewSearch");
  assert.equal(h.elements.selectedCount.textContent, "1", "view changes do not change selection");
  assert.equal(h.elements.hiddenSelection.hidden, false);
  assert.match(h.elements.hiddenSelection.textContent, /1개.*60 MB/);
  await h.click("selectFiltered");
  assert.equal(h.elements.selectedCount.textContent, "2");

  assert.match(h.elements.execute.textContent, /2개/);
  h.elements.reviewRoom.value = "room:room-b"; await h.change("reviewRoom");
  h.elements.reviewMinMB.value = "70"; await h.input("reviewMinMB");
  assert.equal(h.checkboxes().length, 1);
  h.elements.reviewSelectedOnly.checked = true; await h.change("reviewSelectedOnly");
  assert.equal(h.elements.reviewSearch.value, "");
  assert.equal(h.elements.reviewRoom.value, "");
  assert.equal(h.elements.reviewMinMB.value, "0");
  assert.equal(h.checkboxes().length, 2);
  assert.equal(h.elements.hiddenSelection.hidden, true);
  await h.click("clearSelection");
  assert.equal(h.elements.selectedCount.textContent, "0");

  assert.equal(h.checkboxes().length, 0, "Selected-only view is empty after clearing selection");
  assert.equal(h.elements.execute.disabled, true);
});

test("large-file view only filters and sorts, and deleting a chosen large file preserves others", async () => {
  const rows = photoRecords(4).map((record, index) => ({ ...record, size: [49, 50, 100, null][index] === null ? null : [49, 50, 100][index] * 1024 * 1024 }));
  const h = await legacyHarness({ records: rows });
  await h.click("scan"); await h.click("largeFiles");
  assert.equal(h.elements.reviewMinMB.value, "50");
  assert.equal(h.elements.reviewSort.value, "size-desc");
  assert.equal(h.elements.selectedCount.textContent, "0");
  assert.deepEqual(h.checkboxes().map(item => item.getAttribute("data-record-id")), ["photo-0002", "photo-0001"]);
  const checkbox = h.checkboxes()[0]; checkbox.checked = true; await checkbox.dispatch("change");
  await h.click("execute");
  assert.deepEqual(h.trashCalls()[0].options.records.map(record => record.id), ["photo-0002"]);
  assert.equal(h.remaining(), 3);
});

test("the 50MB filter toggles off on a second click and preserves selections outside the filtered view", async () => {
  const rows = photoRecords(3).map((record, index) => ({ ...record, size: [10, 50, 100][index] * 1024 * 1024 }));
  const h = await harness({ records: rows });
  await h.click("scan");
  const small = h.checkboxes().find(checkbox => checkbox.getAttribute("data-record-id") === "photo-0000");
  small.checked = true; await small.dispatch("change");
  assert.equal(h.elements.largeFiles.getAttribute("aria-pressed"), "false");
  await h.click("largeFiles");
  assert.equal(h.elements.reviewMinMB.value, "50");
  assert.equal(h.elements.largeFiles.getAttribute("aria-pressed"), "true");
  assert.deepEqual(h.checkboxes().map(checkbox => checkbox.getAttribute("data-record-id")), ["photo-0002", "photo-0001"]);
  assert.equal(h.elements.selectedCount.textContent, "1");
  assert.equal(h.elements.hiddenSelection.hidden, false);
  await h.click("largeFiles");
  assert.equal(h.elements.reviewMinMB.value, "0");
  assert.equal(h.elements.largeFiles.getAttribute("aria-pressed"), "false");
  assert.equal(h.checkboxes().length, 3);
  assert.equal(h.checkboxes().find(checkbox => checkbox.getAttribute("data-record-id") === "photo-0000").checked, true);
  assert.equal(h.elements.selectedCount.textContent, "1");
  assert.equal(h.elements.hiddenSelection.hidden, true);
  assert.equal(h.trashCalls().length, 0);
  assert.equal(h.downloadCalls.length, 0);
});

test("select-page selects only the visible 100 while select-filtered spans every result page", async () => {
  const h = await legacyHarness();
  await h.click("scan"); await h.click("selectPage");
  assert.equal(h.elements.selectedCount.textContent, "100");
  await h.click("previewNext");
  assert.ok(h.checkboxes().every(checkbox => !checkbox.checked));
  assert.match(h.elements.hiddenSelection.textContent, /100개/);
  await h.click("selectFiltered");
  assert.equal(h.elements.selectedCount.textContent, "205");

  assert.match(h.elements.execute.textContent, /205개/);
  await h.click("previewNext");
  assert.ok(h.checkboxes().every(checkbox => checkbox.checked));
});

test("room groups start collapsed, paginate ten rooms and fifty rows, and use full filtered tri-state selection", async () => {
  const rows = [...photoRecords(62).map(record => ({ ...record, roomId: "room-00" })), ...photoRecords(11).map((record, index) => ({ ...record, id: `extra-${index}`, roomId: `room-${String(index + 1).padStart(2, "0")}` }))];
  const rooms = Array.from({ length: 12 }, (_, index) => ({ id: `room-${String(index).padStart(2, "0")}`, name: `방 ${String(index).padStart(2, "0")}` }));
  const h = await legacyHarness({ records: rows, rooms });
  await h.click("scan"); await h.click("viewRooms");
  assert.equal(h.elements.groupPreview.children.length, 10);
  assert.match(h.elements.pageInfo.textContent, /1 \/ 2 페이지/);
  assert.equal(h.elements.selectPage.disabled, true, "Collapsed room rows are not visible");
  await h.groupControl("data-room-toggle", "room:room-00").click();
  assert.equal(h.grouped().filter(node => node.type === "checkbox" && node.getAttribute("data-record-id")).length, 50);
  await h.click("selectPage");
  assert.equal(h.elements.selectedCount.textContent, "50");
  let roomCheckbox = h.groupControl("data-room-key", "room:room-00");
  assert.equal(roomCheckbox.checked, false);
  assert.equal(roomCheckbox.indeterminate, true);
  assert.equal(roomCheckbox.getAttribute("aria-checked"), "mixed");
  await h.groupControl("data-room-next", "room:room-00").click();
  assert.equal(h.grouped().filter(node => node.type === "checkbox" && node.getAttribute("data-record-id")).length, 12);
  assert.equal(h.groupControl("data-room-next", "room:room-00").disabled, true);

  roomCheckbox = h.groupControl("data-room-key", "room:room-00"); roomCheckbox.checked = true; await roomCheckbox.dispatch("change");
  assert.equal(h.elements.selectedCount.textContent, "62", "Room selector includes all 62 filtered records, not the current 12 rows");

  assert.match(h.elements.execute.textContent, /62개/);
  assert.equal(h.groupControl("data-room-key", "room:room-00").checked, true);
  await h.click("collapseRooms");
  assert.equal(h.elements.selectedCount.textContent, "62");
  assert.match(h.elements.hiddenSelection.textContent, /62개/);
  await h.click("previewNext");
  assert.equal(h.elements.groupPreview.children.length, 2);
  await h.click("previewPrevious"); await h.click("expandRooms");
  assert.equal(h.groupControl("data-room-key", "room:room-00").checked, true);
});

test("room selection affects only that room's matching search subset", async () => {
  const rows = photoRecords(3).map((record, index) => ({ ...record, roomId: "one", name: index ? `keep-${index}` : "delete-me" }));
  const h = await legacyHarness({ records: rows });
  await h.click("scan"); await h.click("viewRooms");
  h.elements.reviewSearch.value = "delete-me"; await h.input("reviewSearch");
  const checkbox = h.groupControl("data-room-key", "room:one"); checkbox.checked = true; await checkbox.dispatch("change");
  assert.equal(h.elements.selectedCount.textContent, "1");
  await h.click("resetReview");
  assert.equal(h.groupControl("data-room-key", "room:one").indeterminate, true);
  await h.click("execute");
  assert.deepEqual(h.trashCalls()[0].options.records.map(record => record.id), ["photo-0000"]);
});

test("expanded room tables expose synchronized column sorting without changing selected IDs", async () => {
  const rows = photoRecords(3).map(record => ({ ...record, roomId: "one" }));
  const h = await legacyHarness({ records: rows });
  await h.click("scan"); await h.click("selectPage"); await h.click("viewRooms");
  await h.groupControl("data-room-toggle", "room:one").click();
  assert.equal(h.grouped().filter(node => node.getAttribute("data-room-sort")).length, 5);
  assert.equal(h.groupControl("data-room-sort", "date").textContent, "기준 날짜");
  await h.groupControl("data-room-sort", "size").click();
  assert.equal(h.elements.reviewSort.value, "size-asc");
  assert.equal(h.elements.sortHeaderSize.getAttribute("aria-sort"), "ascending");
  const sizeHeader = h.grouped().find(node => node.id === "th" && node.children.some(child => child.getAttribute("data-room-sort") === "size"));
  assert.equal(sizeHeader.getAttribute("aria-sort"), "ascending");
  assert.deepEqual(h.grouped().filter(node => node.type === "checkbox" && node.getAttribute("data-record-id")).map(node => node.getAttribute("data-record-id")), ["photo-0000", "photo-0001", "photo-0002"]);
  assert.equal(h.elements.selectedCount.textContent, "3");
  assert.match(h.elements.execute.textContent, /3개/);
});

test("room metadata refresh preserves the plan, selection and count after identity checks", async () => {
  const h = await legacyHarness({ count: 2, rooms: [{ id: "known", name: "알려진 방" }] });
  await h.click("scan"); await h.click("selectPage");
  const before = h.calls.length;
  await h.click("reviewLoadRooms");
  assert.equal(h.elements.selectedCount.textContent, "2");
  assert.match(h.elements.execute.textContent, /2개/);
  assert.equal(h.elements.execute.disabled, false);
  assert.deepEqual(h.calls.slice(before).map(call => call.method), ["account", "readRooms", "readRooms", "readRooms", "readRooms", "account"]);
  assert.match(h.elements.status.textContent, /선택은 유지/);
});

test("room name failure is best effort but account or protection changes invalidate the retained plan", async () => {
  const h = await legacyHarness({ records: photoRecords(1).map(record => ({ ...record, roomId: "unknown-room" })), roomsError: "이름 요청 실패" });
  await h.click("scan");
  assert.equal(h.elements.foundCount.textContent, "1");
  assert.match(h.elements.status.textContent, /이름 미확인/);
  assert.match(h.elements.preview.children[0].children[2].textContent, /이름 미확인/);
  await h.click("selectPage"); await h.click("loadRooms");
  assert.equal(h.elements.execute.disabled, false);
  assert.equal(h.elements.selectedCount.textContent, "1");

  let account = "account-one";
  const changed = await legacyHarness({ count: 1, accountAt: () => account });
  await changed.click("scan"); await changed.click("selectPage");
  account = "other-account"; await changed.click("loadRooms");
  assert.equal(changed.elements.selectedCount.textContent, "0");
  assert.equal(changed.elements.execute.disabled, true);
  assert.match(changed.elements.status.textContent, /계정이 바뀌었습니다/);
  assert.equal(changed.trashCalls().length, 0);

  const protectedPlan = await legacyHarness({ count: 1 });
  await protectedPlan.click("scan"); await protectedPlan.click("selectPage");
  protection.write(protectedPlan.localStorage, "account-one", { version: 1, files: [{ id: "photo-0000", name: "보관" }], rooms: [] });
  await protectedPlan.click("reviewLoadRooms");
  assert.equal(protectedPlan.elements.selectedCount.textContent, "0");
  assert.match(protectedPlan.elements.status.textContent, /보호 설정이 바뀌었습니다/);
});

test("a protection change during room metadata requests discards the plan before any deletion", async () => {
  let changeDuringRooms = false, h;
  h = await legacyHarness({ count: 1, onReadRooms: async () => {
    if (changeDuringRooms) protection.write(h.localStorage, "account-one", { version: 1, files: [{ id: "photo-0000", name: "보호" }], rooms: [] });
  } });
  await h.click("scan"); await h.click("selectPage");
  changeDuringRooms = true; await h.click("reviewLoadRooms");
  assert.equal(h.elements.execute.disabled, true);

  assert.equal(h.elements.selectedCount.textContent, "0");
  assert.equal(h.trashCalls().length, 0);
  assert.match(h.elements.status.textContent, /보호 설정이 바뀌었습니다/);
});

test("keyboard focus survives row replacement and moves to the next selected row or review toggle when removed", async () => {
  const h = await legacyHarness({ count: 3 });
  await h.click("scan");
  let checkbox = h.checkboxes()[0]; checkbox.focus(); checkbox.checked = true; await checkbox.dispatch("change");
  assert.notEqual(h.documentState.activeElement, checkbox, "The focused node was replaced by rendering");
  assert.equal(h.documentState.activeElement, h.checkboxes()[0]);
  assert.equal(h.documentState.activeElement.getAttribute("data-record-id"), "photo-0002");
  assert.equal(h.documentState.activeElement.focusOptions.preventScroll, true);
  await h.click("selectPage");
  h.elements.reviewSelectedOnly.checked = true; await h.change("reviewSelectedOnly");

  checkbox = h.checkboxes()[0]; checkbox.focus(); checkbox.checked = false; await checkbox.dispatch("change");
  assert.equal(h.documentState.activeElement, h.checkboxes()[0]);
  assert.equal(h.documentState.activeElement.getAttribute("data-record-id"), "photo-0001");
  assert.equal(h.elements.selectedCount.textContent, "2");
  assert.equal(h.elements.execute.disabled, false);
  const protect = h.protectButtons()[0]; protect.focus(); await protect.click();
  assert.equal(h.documentState.activeElement, h.checkboxes()[0]);
  assert.equal(h.documentState.activeElement.getAttribute("data-record-id"), "photo-0000");
  assert.equal(h.elements.preview.children[0].children[1].title, "photo-0.jpg");
  checkbox = h.checkboxes()[0]; checkbox.focus(); checkbox.checked = false; await checkbox.dispatch("change");
  assert.equal(h.documentState.activeElement, h.elements.reviewSelectedOnly);
  assert.equal(h.elements.selectedCount.textContent, "0");
});

test("group control focus remains in its own room after selection and column sorting", async () => {
  const h = await legacyHarness({ records: photoRecords(2).map((record, index) => ({ ...record, roomId: index ? "two" : "one" })) });
  await h.click("scan"); await h.click("viewRooms"); await h.click("expandRooms");
  const room = h.groupControl("data-room-key", "room:two"); room.focus(); room.checked = true; await room.dispatch("change");
  assert.equal(h.documentState.activeElement, h.groupControl("data-room-key", "room:two"));
  const size = h.grouped().filter(control => control.getAttribute("data-room-sort") === "size").at(-1);
  size.focus(); await size.click();
  assert.equal(h.documentState.activeElement.getAttribute("data-room-sort"), "size");
  let section = h.documentState.activeElement;
  while (section && section.getAttribute("data-review-room") == null) section = section.parentElement;
  assert.equal(section.getAttribute("data-review-room"), "room:two");
  assert.equal(h.elements.selectedCount.textContent, "1");
});

test("invalidating a plan resets review filters so a fresh lookup is visible with zero selected", async () => {
  const h = await legacyHarness({ records: photoRecords(3).map(record => ({ ...record, roomId: "one" })) });
  await h.click("scan"); await h.click("selectPage");
  h.elements.reviewSelectedOnly.checked = true; await h.change("reviewSelectedOnly");
  h.elements.reviewSearch.value = "photo-1"; await h.input("reviewSearch");
  h.elements.reviewRoom.value = "room:one"; await h.change("reviewRoom");
  h.elements.reviewMinMB.value = "50"; await h.input("reviewMinMB");
  h.elements.reviewSort.value = "name-asc"; await h.change("reviewSort");
  assert.equal(h.checkboxes().length, 0);
  await h.click("categoryMedia");
  assert.equal(h.elements.reviewSearch.value, "");
  assert.equal(h.elements.reviewRoom.value, "");
  assert.equal(h.elements.reviewMinMB.value, "0");
  assert.equal(h.elements.reviewSelectedOnly.checked, false);
  assert.equal(h.elements.reviewSort.value, "size-desc");

  assert.equal(h.elements.selectedCount.textContent, "0");
  await h.click("scan");
  assert.equal(h.elements.foundCount.textContent, "3");
  assert.equal(h.checkboxes().length, 3);
  assert.ok(h.checkboxes().every(checkbox => !checkbox.checked));
  assert.equal(h.elements.selectedCount.textContent, "0");
  assert.equal(h.elements.execute.disabled, true);
  assert.equal(h.trashCalls().length, 0);
});

test("verified trash of two out of five retains the other three and supports a second manual selection without scanning", async () => {
  const h = await harness({ count: 5 });
  await h.click("scan");
  await selectRecord(h, "photo-0001"); await selectRecord(h, "photo-0003");
  await h.click("execute");
  assert.equal(h.remaining(), 3);
  assert.equal(h.elements.foundCount.textContent, "3");
  assert.deepEqual(h.checkboxes().map(node => node.getAttribute("data-record-id")), ["photo-0004", "photo-0002", "photo-0000"]);
  assert.ok(h.checkboxes().every(node => !node.checked && !node.disabled));
  assert.equal(h.elements.selectedCount.textContent, "0");
  assert.equal(h.elements.execute.disabled, true);
  assert.equal(h.elements.selectFiltered.disabled, false);
  await selectRecord(h, "photo-0002");
  assert.equal(h.elements.execute.disabled, false);
  await h.click("execute");
  assert.deepEqual(h.trashCalls().map(call => call.options.records.map(row => row.id)), [["photo-0001", "photo-0003"], ["photo-0002"]]);
  assert.equal(h.remaining(), 2);
  assert.equal(h.elements.foundCount.textContent, "2");
  assert.equal(h.confirmations.length, 2);
  assert.equal(h.calls.filter(call => call.method === "readPage").length, 3, "One initial scan and one verification per execution");
});

test("successful partial trash preserves room view expansion, search, size and name sorting", async () => {
  const rows = photoRecords(5).map((row, index) => ({ ...row, roomId: index === 4 ? "other" : "one", name: ["keep-z", "keep-a", "keep-b", "unrelated", "keep-c"][index], size: (20 + index) * 1024 * 1024 }));
  const h = await harness({ records: rows, rooms: [{ id: "one", name: "보관방" }, { id: "other", name: "다른방" }] });
  await h.click("scan"); await h.click("viewRooms");
  h.elements.reviewSearch.value = "keep"; await h.input("reviewSearch");
  h.elements.reviewRoom.value = "room:one"; await h.change("reviewRoom");
  h.elements.reviewMinMB.value = "10"; await h.input("reviewMinMB");
  h.elements.reviewSort.value = "name-asc"; await h.change("reviewSort");
  await h.groupControl("data-room-toggle", "room:one").click();
  await selectRecord(h, "photo-0002"); await h.click("execute");
  assert.equal(h.elements.foundCount.textContent, "4");
  assert.equal(h.elements.reviewSearch.value, "keep");
  assert.equal(h.elements.reviewRoom.value, "room:one");
  assert.equal(h.elements.reviewMinMB.value, "10");
  assert.equal(h.elements.reviewSort.value, "name-asc");
  assert.equal(h.elements.viewRooms.getAttribute("aria-pressed"), "true");
  assert.equal(h.elements.sortHeaderName.getAttribute("aria-sort"), "ascending");
  const visibleRows = h.grouped().filter(node => node.type === "checkbox" && node.getAttribute("data-record-id"));
  assert.deepEqual(visibleRows.map(node => node.getAttribute("data-record-id")), ["photo-0001", "photo-0000"]);
  assert.ok(visibleRows.every(node => !node.checked && !node.disabled));
});

test("deleting the final result page clamps to the last remaining page without resetting to page one", async () => {
  const h = await harness({ count: 205 });
  await h.click("scan"); await h.click("previewNext"); await h.click("previewNext");
  assert.equal(h.elements.pageInfo.textContent, "3 / 3 페이지");
  await h.click("selectPage"); await h.click("execute");
  assert.equal(h.elements.foundCount.textContent, "200");
  assert.equal(h.elements.pageInfo.textContent, "2 / 2 페이지");
  assert.equal(h.checkboxes().length, 100);
  assert.equal(h.elements.previewPrevious.disabled, false);
  assert.equal(h.elements.previewNext.disabled, true);
  assert.equal(h.elements.selectedCount.textContent, "0");
});

test("successful trash exits selected-only view so unselected remaining records are visible", async () => {
  const h = await harness({ count: 4 });
  await h.click("scan"); await selectRecord(h, "photo-0001");
  h.elements.reviewSelectedOnly.checked = true; await h.change("reviewSelectedOnly");
  assert.equal(h.checkboxes().length, 1);
  await h.click("execute");
  assert.equal(h.elements.reviewSelectedOnly.checked, false);
  assert.equal(h.elements.foundCount.textContent, "3");
  assert.equal(h.checkboxes().length, 3);
  assert.equal(h.elements.reviewEmpty.hidden, true);
  assert.ok(h.checkboxes().every(node => !node.checked && !node.disabled));
});

test("an uncertain partial request retains the original snapshot read-only until a new scan", async () => {
  const h = await harness({ count: 205, failTrashAt: 2 });
  await h.click("scan"); await h.click("selectFiltered"); await h.click("execute");
  assert.equal(h.remaining(), 105);
  assertReadOnlySnapshot(h, 205);
  assert.match(h.elements.status.textContent, /결과 미확정/);
  await h.elements.execute.dispatch("click"); await h.elements.selectFiltered.dispatch("click");
  assert.equal(h.trashCalls().length, 2, "A read-only snapshot cannot be executed even through direct dispatch");
  assert.equal(h.elements.selectedCount.textContent, "0");
  await h.click("scan");
  assert.equal(h.elements.foundCount.textContent, "105");
  assert.ok(h.checkboxes().every(node => !node.checked && !node.disabled));
  await selectRecord(h, "photo-0204"); await h.click("execute");
  assert.equal(h.trashCalls().length, 3);
  assert.equal(h.remaining(), 104);
  assert.equal(h.elements.foundCount.textContent, "104");
});

test("stopping after an accepted batch keeps the reviewed snapshot read-only and allows a fresh scan", async () => {
  const entered = deferred(), release = deferred();
  const h = await harness({ count: 205, onTrash: async () => { entered.resolve(); await release.promise; } });
  await h.click("scan"); await h.click("selectFiltered");
  const execution = h.click("execute"); await entered.promise;
  await h.click("stop"); release.resolve(); await execution;
  assert.equal(h.trashCalls().length, 1);
  assertReadOnlySnapshot(h, 205);
  await h.click("scan");
  assert.equal(h.elements.foundCount.textContent, "105");
  assert.equal(h.elements.selectFiltered.disabled, false);
  assert.ok(h.checkboxes().every(node => !node.checked && !node.disabled));
});

test("raw selected IDs still present after trash leave the original snapshot read-only", async () => {
  const h = await harness({ count: 3, keepRecords: true, markStarredAfterTrash: true });
  await h.click("scan"); await selectRecord(h, "photo-0001"); await h.click("execute");
  assert.match(h.elements.status.textContent, /재조회에서 대상 1개가 남아 있습니다/);
  assertReadOnlySnapshot(h, 3);
  await h.elements.execute.dispatch("click");
  assert.equal(h.trashCalls().length, 1);
});

test("retained records use fresh metadata but never add unreviewed IDs discovered during verification", async () => {
  const rows = photoRecords(3);
  const fresh = [{ ...rows[1], name: "updated-name.jpg", size: 9000 }, rows[2], { ...rows[0], id: "unreviewed-new", name: "new.jpg" }];
  let changed = false, h;
  h = await harness({ records: rows, onRead: async (_options, calls) => {
    if (!changed && calls.some(call => call.method === "trash")) { changed = true; h.replaceRecords(fresh); }
  } });
  await h.click("scan"); await selectRecord(h, "photo-0000"); await h.click("execute");
  assert.equal(h.remaining(), 3, "The unreviewed record remains on the server");
  assert.equal(h.elements.foundCount.textContent, "2");
  assert.deepEqual(h.checkboxes().map(node => node.getAttribute("data-record-id")), ["photo-0001", "photo-0002"]);
  assert.equal(h.elements.preview.children[0].children[1].title, "updated-name.jpg");
  await h.click("selectFiltered"); await h.click("execute");
  assert.deepEqual(h.trashCalls()[1].options.records.map(row => row.id), ["photo-0001", "photo-0002"]);
  assert.equal(h.remaining(), 1);
  assert.equal(h.elements.foundCount.textContent, "0");
});

test("a protection change during post-trash verification cannot restore an executable remaining plan", async () => {
  let changed = false, h;
  h = await harness({ count: 4, onRead: async (_options, calls) => {
    if (!changed && calls.some(call => call.method === "trash")) {
      changed = true;
      protection.write(h.localStorage, "account-one", { version: 1, files: [{ id: "photo-0001", name: "새 보호" }], rooms: [] });
    }
  } });
  await h.click("scan"); await selectRecord(h, "photo-0000"); await h.click("execute");
  assertReadOnlySnapshot(h, 4);
  assert.match(h.elements.status.textContent, /보호 설정이 바뀌/);
  await h.elements.execute.dispatch("click");
  assert.equal(h.trashCalls().length, 1);
  await h.click("scan");
  assert.equal(h.elements.foundCount.textContent, "2");
  assert.deepEqual(h.checkboxes().map(node => node.getAttribute("data-record-id")), ["photo-0003", "photo-0002"]);
});

test("an account change during post-trash verification cannot restore an executable remaining plan", async () => {
  let account = "account-one";
  const h = await harness({ count: 3, accountAt: () => account, onRead: async (_options, calls) => {
    if (calls.some(call => call.method === "trash")) account = "account-two";
  } });
  await h.click("scan"); await selectRecord(h, "photo-0000"); await h.click("execute");
  assertReadOnlySnapshot(h, 3);
  assert.match(h.elements.status.textContent, /계정이 바뀌/);
  await h.elements.execute.dispatch("click");
  assert.equal(h.trashCalls().length, 1);
});

test("a failed verification read retains the original snapshot and can be replaced by a later successful scan", async () => {
  let failVerification = true;
  const h = await harness({ count: 3, onRead: async (_options, calls) => {
    if (failVerification && calls.some(call => call.method === "trash")) throw new Error("검증 연결 실패");
  } });
  await h.click("scan"); await selectRecord(h, "photo-0001"); await h.click("execute");
  assertReadOnlySnapshot(h, 3);
  assert.match(h.elements.status.textContent, /검증 연결 실패/);
  failVerification = false; await h.click("scan");
  assert.equal(h.elements.foundCount.textContent, "2");
  assert.ok(h.checkboxes().every(node => !node.checked && !node.disabled));
});

test("remaining files retain matching download receipts while changed metadata requires a new saved copy", async () => {
  const rows = photoRecords(3);
  let changed = false, h;
  h = await harness({ backupBeforeTrash: true, records: rows, onRead: async (_options, calls) => {
    if (!changed && calls.some(call => call.method === "trash")) {
      changed = true; h.replaceRecords([{ ...rows[1], name: "changed-original.jpg", size: rows[1].size + 100 }, rows[2]]);
    }
  } });
  await h.click("scan"); await h.click("selectFiltered"); await h.click("downloadPhotos");
  assert.equal(h.downloadCalls.length, 3);
  await h.click("clearSelection"); await selectRecord(h, "photo-0000"); await h.click("execute");
  assert.equal(h.elements.foundCount.textContent, "2");
  await h.click("selectFiltered");
  assert.match(h.elements.downloadSummary.textContent, /파일 2개.*확인한 항목 1개/);
  assert.equal(h.elements.execute.disabled, true, "The changed original cannot reuse its former download receipt");
  await h.click("downloadPhotos");
  assert.equal(h.downloadCalls.length, 4, "Only the changed remaining original downloads again");
  assert.deepEqual(h.calls.filter(call => call.method === "originalFile").map(call => call.options.record.id), ["photo-0000", "photo-0001", "photo-0002", "photo-0001"]);
  assert.equal(h.elements.execute.disabled, false);
  await h.click("execute");
  assert.equal(h.remaining(), 0);
  assert.equal(h.elements.foundCount.textContent, "0");
});
