'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/tasks');

const ticket = (key, o = {}) => ({ kind: 'jira', key, summary: key, cat: 'todo', p: 'P2', due: null, assignee: null, labels: [], watching: false, ...o });
const me = { name: 'Me', initials: 'ME', me: true };
const other = { name: 'Awa Kane', initials: 'AK', me: false };
const sel = (status = [], scope = []) => ({ status: new Set(status), scope: new Set(scope) });

test('todos saved before Ally become To Do or Done; states keep done and doneAt in step', () => {
  assert.equal(T.todoState({ d: false }), 'todo');
  assert.equal(T.todoState({ d: true }), 'done');
  assert.equal(T.todoState({ s: 'doing', d: false }), 'doing');
  const t = { t: 'x', d: false, doneAt: null };
  T.setTodoState(t, 'done', 5);
  assert.deepStrictEqual([t.s, t.d, t.doneAt], ['done', true, 5]);
  T.setTodoState(t, 'todo', 9);
  assert.deepStrictEqual([t.s, t.d, t.doneAt], ['todo', false, null]);
});

test('scopes: mine (your Jira tickets) and personal (your todos)', () => {
  assert.deepStrictEqual(T.scopesOf(ticket('A-1', { assignee: me, watching: true, labels: ['mvp2'] })), ['mine']);
  assert.deepStrictEqual(T.scopesOf(ticket('A-2', { assignee: other, watching: true })), []);
  assert.deepStrictEqual(T.scopesOf({ kind: 'todo', cat: 'todo' }), ['personal']);
});

test('chips filter by status and scope; nothing pressed means everything', () => {
  const items = [
    ticket('A-1', { assignee: me }),
    ticket('A-2', { assignee: me, cat: 'doing' }),
    ticket('A-3', { assignee: me, cat: 'done' }),
    ...T.fromTodos([{ t: 'dentist', p: 'P2', d: false, due: '2026-11-17' }]),
  ];
  const keys = (s) => T.filter(items, s).map((i) => i.key || i.summary);
  assert.deepStrictEqual(keys(sel()), ['A-1', 'A-2', 'A-3', 'dentist']);
  assert.deepStrictEqual(keys(sel(['todo', 'doing'])), ['A-1', 'A-2', 'dentist']);
  assert.deepStrictEqual(keys(sel([], ['mine'])), ['A-1', 'A-2', 'A-3']);
  assert.deepStrictEqual(keys(sel([], ['personal'])), ['dentist']);
  assert.deepStrictEqual(keys(sel(['todo'], ['mine', 'personal'])), ['A-1', 'dentist']);
});

test('each chip counts what it would show given the other row', () => {
  const items = [ticket('A-1', { assignee: me }), ticket('A-2', { assignee: me, cat: 'done' }), ...T.fromTodos([{ t: 'dentist', p: 'P2', d: false }])];
  const n = T.counts(items, sel(['todo'], ['mine']));
  assert.deepStrictEqual(n.status, { todo: 1, doing: 0, done: 1 });
  assert.deepStrictEqual(n.scope, { mine: 1, personal: 1 });
});

test('sort: open first, then due date (none last), priority, key', () => {
  const items = [
    ticket('A-10', { due: null, p: 'P1' }),
    ticket('A-2', { due: '2026-11-20', p: 'P3' }),
    ticket('A-9', { due: '2026-11-20', p: 'P1' }),
    ticket('A-1', { due: '2026-11-01', cat: 'done' }),
    ticket('A-3', { due: null, p: 'P1' }),
  ];
  assert.deepStrictEqual(T.sort(items).map((i) => i.key), ['A-9', 'A-2', 'A-3', 'A-10', 'A-1']);
});
