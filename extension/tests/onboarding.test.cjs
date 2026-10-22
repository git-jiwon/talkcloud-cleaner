'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../onboarding.js');

function storage(entries = []) {
  const data = new Map(entries);
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
}

test('first use, acknowledgment, update and reload keep a stable onboarding key', () => {
  const saved = storage();
  assert.deepEqual(O.inspect(saved, '1.0.0'), { firstRun: true, updated: false, previousVersion: null });
  assert.deepEqual(O.acknowledge(saved, '1.0.0'), { firstRun: false, updated: false, previousVersion: '1.0.0' });
  assert.deepEqual(O.inspect(saved, '1.0.1'), { firstRun: false, updated: true, previousVersion: '1.0.0' });
  O.acknowledge(saved, '1.0.1');
  assert.deepEqual(O.inspect(saved, '1.0.1'), { firstRun: false, updated: false, previousVersion: '1.0.1' });
  assert.deepEqual([...saved.data.keys()], ['talkcleaner.onboarding']);
});

test('acknowledgment never alters protected files, protected rooms or transfer backups', () => {
  const original = [
    ['talkcloud-protection-v1:fixture-account', '{"version":1,"files":[{"id":"fixture-file","name":"keep"}],"rooms":[]}'],
    ['talkcloud-protection-transfer-backup', '{"fixture":"preserved"}'],
    ['talkcloud-workspace-v1', '{"fixture":"preserved"}']
  ];
  const saved = storage(original);
  O.acknowledge(saved, '1.0.0');
  for (const [key, value] of original) assert.equal(saved.getItem(key), value);
});

test('unknown schemas, extra fields and malformed records remain untouched', () => {
  for (const value of ['{', 'null', '[]', '{"version":2,"seenVersion":"1.0.0"}', '{"version":1,"seenVersion":4}', '{"version":1,"seenVersion":"1.0.0","future":"preserve"}']) {
    const saved = storage([[O.KEY, value]]);
    assert.throws(() => O.inspect(saved, '1.0.0'), { code: 'ONBOARDING_INVALID' });
    assert.throws(() => O.acknowledge(saved, '1.0.0'), { code: 'ONBOARDING_INVALID' });
    assert.equal(saved.getItem(O.KEY), value);
  }
});

test('storage failures have actionable messages and do not pretend to persist', () => {
  assert.throws(() => O.inspect({ getItem() { throw new Error('private reason'); } }, '1.0.0'), { code: 'ONBOARDING_UNAVAILABLE' });
  assert.throws(() => O.acknowledge({ getItem: () => null, setItem() { throw new Error('private reason'); } }, '1.0.0'), error => error.code === 'ONBOARDING_UNAVAILABLE' && !error.message.includes('private reason'));
});

test('invalid application versions cannot write an acknowledgment', () => {
  const saved = storage();
  for (const version of ['', null, 'current', '1.0', '1.0.0<script>', '1'.repeat(100)]) assert.throws(() => O.acknowledge(saved, version), { code: 'ONBOARDING_INVALID' });
  assert.equal(saved.data.size, 0);
});

test('help directs login, authentication, expired list, closed tab and unsupported type to concrete actions', () => {
  for (const [error, title, action] of [
    [new Error('로그인한 계정을 확인하지 못해 중단했습니다.'), '톡클라우드에 로그인해 주세요', 'source'],
    [new Error('카카오 로그인 또는 추가 인증이 필요합니다.'), '카카오 인증을 완료해 주세요', 'source'],
    [new Error('조회 후 1시간이 지났습니다.'), '현재 목록을 다시 확인하세요', 'scan'],
    [new Error('No tab with id: 4.'), '톡클라우드 탭을 다시 연결하세요', 'source'],
    [new Error('톡클라우드 탭이 이동했습니다.'), '톡클라우드 탭을 다시 연결하세요', 'source'],
    [new Error('통화 녹음을 저장할 수 없습니다.'), '이 항목은 저장을 지원하지 않습니다', 'guide'],
    [new Error('보호 설정이 바뀌었습니다.'), '보호 조건을 다시 확인하세요', 'scan'],
    [new Error('카카오 계정이 바뀌었습니다.'), '연결한 계정이 달라졌습니다', 'source'],
    [new Error('삭제 요청 결과를 확정할 수 없습니다.'), '현재 처리 결과를 확인하세요', 'scan']
  ]) {
    const help = O.describe(error);
    assert.equal(help.title, title);
    assert.equal(help.action, action);
    assert.ok(help.message.length > 10 && help.actionLabel.length > 2);
  }
});

test('unknown errors and sensitive error payloads are never reflected into UI guidance', () => {
  const help = O.describe(new Error('https://example.invalid/?' + 'token=fixture-token <img src=x>'));
  assert.equal(help.action, 'guide');
  assert.ok(!JSON.stringify(help).includes('fixture-token'));
  assert.ok(!JSON.stringify(help).includes('<img'));
  assert.equal(O.describe(undefined, { sourceClosed: true }).action, 'source');
  assert.equal(O.describe({ code: 'PLAN_EXPIRED' }).action, 'scan');
});

test('progress and success messages can explicitly suppress recovery guidance', () => {
  assert.deepEqual(O.describe('목록 조회 완료', { informational: true }), { title: '', message: '', action: 'none', actionLabel: '' });
  assert.equal(O.describe(new Error('로그인 오류')).action, 'source');
});

test('first-run steps are immutable user text and explain optional backup and trash restoration', () => {
  assert.equal(O.steps.length, 3);
  assert.ok(Object.isFrozen(O.steps) && O.steps.every(Object.isFrozen));
  assert.match(O.steps[0].message, /조회만으로.*삭제되지는/);
  assert.match(O.steps[2].message, /PC 저장은 선택사항/);
  assert.match(O.steps[2].message, /복원은 톡클라우드/);
});
