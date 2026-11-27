'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { toLimits, entryFromLine, summarize, LogScanner } = require('../src/usage');
const { mergeSessions } = require('../src/sessions');

test('limits are read from the limits list with readable labels', () => {
  const json = {
    five_hour: { utilization: 23 },
    limits: [
      { kind: 'session', percent: 23, severity: 'normal', resets_at: 'a' },
      { kind: 'weekly_all', percent: 53, severity: 'normal', resets_at: 'b' },
      { kind: 'weekly_scoped', percent: 0, scope: { model: { display_name: 'Fable' } }, resets_at: 'c' },
    ],
  };
  assert.deepEqual(toLimits(json).map((l) => `${l.label}=${l.percent}`), ['Session · 5h=23', 'Weekly · all models=53', 'Weekly · Fable=0']);
});

test('older responses without a limits list fall back to five_hour and seven_day', () => {
  const l = toLimits({ five_hour: { utilization: 23.4, resets_at: 'a' }, seven_day: { utilization: 53, resets_at: 'b' } });
  assert.deepEqual(l.map((x) => x.percent), [23, 53]);
});

const line = (id, ts, u) => JSON.stringify({ type: 'assistant', timestamp: ts, message: { id, usage: u } });

test('log entries count input, output and cache writes but not cache reads', () => {
  const e = entryFromLine(line('m1', '2026-11-11T08:00:00Z', { input_tokens: 2, output_tokens: 500, cache_creation_input_tokens: 1000, cache_read_input_tokens: 99999 }));
  assert.equal(e.tokens, 1502);
  assert.equal(entryFromLine('{"type":"user"}'), null);
  assert.equal(entryFromLine('not json'), null);
});

test('summary counts today and buckets the last 12 hours', () => {
  const now = new Date(2026, 10, 11, 14, 30).getTime();
  const entries = [
    { ts: new Date(2026, 10, 11, 14, 10).getTime(), tokens: 100 },
    { ts: new Date(2026, 10, 11, 9, 0).getTime(), tokens: 50 },
    { ts: new Date(2026, 10, 10, 23, 0).getTime(), tokens: 7 },
  ];
  const s = summarize(entries, now);
  assert.equal(s.tokens, 150);
  assert.equal(s.messages, 2);
  assert.equal(s.hours[11], 100);
  assert.equal(s.hours.reduce((a, b) => a + b), 150);
});

test('scanner reads only new lines and dedupes repeated message ids', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meter-'));
  const f = path.join(dir, 's.jsonl');
  const ts = new Date().toISOString();
  const u = { input_tokens: 10, output_tokens: 0 };
  fs.writeFileSync(f, line('m1', ts, u) + '\n' + line('m1', ts, u) + '\n');
  const sc = new LogScanner(dir);
  assert.equal(sc.scan().tokens, 10);
  fs.appendFileSync(f, line('m2', ts, u).slice(0, 20));
  assert.equal(sc.scan().tokens, 10);
  fs.appendFileSync(f, line('m2', ts, u).slice(20) + '\n');
  assert.equal(sc.scan().tokens, 20);
  fs.rmSync(dir, { recursive: true });
});

test('sessions: one row per live process, newest record wins, dead and replaced records are stale', () => {
  const procs = [{ pid: 1, cwd: '/a', tty: true }, { pid: 2, cwd: '/b', tty: true }];
  const records = [
    { id: 'old', pid: 1, state: 'idle', updated: 1 },
    { id: 'new', pid: 1, state: 'input', updated: 5 },
    { id: 'dead', pid: 9, state: 'working', updated: 5 },
  ];
  const { sessions, stale } = mergeSessions(records, procs);
  assert.deepEqual(sessions.map((s) => `${s.id}:${s.state}`), ['new:input', 'pid-2:unknown']);
  assert.deepEqual(stale.sort(), ['dead', 'old']);
});
