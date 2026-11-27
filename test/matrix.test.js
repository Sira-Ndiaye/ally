'use strict';
const test = require('node:test');
const assert = require('node:assert');
const M = require('../src/matrix');

// Friday 27 Nov 2026, midday local time.
const NOW = new Date(2026, 10, 27, 12).getTime();
const tk = (p, due, extra) => ({ kind: 'jira', key: 'AC-1', p, due, cat: 'todo', ...extra });
const todo = (p, due) => ({ kind: 'todo', i: 0, p, due, cat: 'todo' });

test('squares: due within 2 days is urgent, P1 and P2 are important', () => {
  assert.equal(M.quadOf(tk('P1', '2026-11-29'), NOW), 'now');
  assert.equal(M.quadOf(tk('P2', '2026-11-20'), NOW), 'now');
  assert.equal(M.quadOf(tk('P1', '2026-11-30'), NOW), 'plan');
  assert.equal(M.quadOf(tk('P3', '2026-11-27'), NOW), 'quick');
  assert.equal(M.quadOf(tk('P3', null), NOW), 'later');
  assert.equal(M.quadOf(tk('P1', null), NOW), 'plan');
});

test('a todo with no date means today; a ticket with none has none', () => {
  assert.equal(M.daysLeft(todo('P2', null), NOW), 0);
  assert.equal(M.daysLeft(tk('P2', null), NOW), null);
  assert.equal(M.quadOf(todo('P2', null), NOW), 'now');
});

test('group: done left out, each square by due date (none last), then priority', () => {
  const items = [tk('P2', null, { key: 'A' }), tk('P1', '2026-12-10', { key: 'B' }), tk('P1', null, { key: 'C' }), tk('P1', '2026-11-28', { key: 'D', cat: 'done' })];
  const g = M.group(items, NOW);
  assert.deepStrictEqual(g.plan.map((t) => t.key), ['B', 'C', 'A']);
  assert.equal(g.now.length, 0);
});

test('drop: only what must change to land in the square', () => {
  assert.equal(M.dropChange(tk('P1', '2026-11-28'), 'now', NOW), null);
  assert.deepStrictEqual(M.dropChange(tk('P3', null), 'now', NOW), { p: 'P1', due: '2026-11-27' });
  assert.deepStrictEqual(M.dropChange(tk('P1', '2026-11-28'), 'plan', NOW), { due: '2026-12-04' });
  assert.deepStrictEqual(M.dropChange(tk('P2', '2026-11-28'), 'quick', NOW), { p: 'P3' });
  assert.deepStrictEqual(M.dropChange(todo('P1', null), 'later', NOW), { p: 'P3', due: '2026-12-04' });
  assert.equal(M.dropChange(tk('P1', null), 'nowhere', NOW), null);
});

test('arrow keys move to the next square and stop at the edge', () => {
  assert.equal(M.neighbour('now', 'ArrowRight'), 'plan');
  assert.equal(M.neighbour('now', 'ArrowDown'), 'quick');
  assert.equal(M.neighbour('later', 'ArrowUp'), 'plan');
  assert.equal(M.neighbour('now', 'ArrowLeft'), 'now');
});

test('priority name: the one this site\'s tickets use most, else the default', () => {
  const tickets = [{ p: 'P1', priority: 'Haute' }, { p: 'P1', priority: 'Haute' }, { p: 'P1', priority: 'La plus haute' }];
  assert.equal(M.priorityName('P1', tickets), 'Haute');
  assert.equal(M.priorityName('P3', tickets), 'Low');
});
