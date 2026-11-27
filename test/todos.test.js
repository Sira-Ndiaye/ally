'use strict';
const test = require('node:test');
const assert = require('node:assert');
const T = require('../src/todos');

// Wednesday 11 Nov 2026, 10:00 local time. Its week starts Monday 9 Nov.
const NOW = new Date(2026, 10, 11, 10).getTime();
const at = (d, h = 9) => new Date(2026, 10, d, h).getTime();
const task = (o) => ({ t: 'x', p: 'P2', d: false, doneAt: null, ...o });

test('week starts on Monday at midnight', () => {
  assert.equal(T.startOfWeek(NOW), new Date(2026, 10, 9).getTime());
  assert.equal(T.startOfWeek(new Date(2026, 10, 15, 23).getTime()), new Date(2026, 10, 9).getTime());
});

test('done tasks from previous weeks are purged, open ones never are', () => {
  const todos = [
    task({ t: 'done last week', d: true, doneAt: new Date(2026, 10, 8, 22).getTime() }),
    task({ t: 'done this week', d: true, doneAt: at(9) }),
    task({ t: 'open and old', due: '2026-10-01' }),
  ];
  assert.deepEqual(T.purge(todos, NOW).map((t) => t.t), ['done this week', 'open and old']);
});

test('due labels', () => {
  assert.deepEqual(T.dueLabel(task({ due: '2026-11-09' }), NOW), { text: '2d late', late: true });
  assert.equal(T.dueLabel(task({ due: '2026-11-09', d: true }), NOW).late, false);
  assert.equal(T.dueLabel(task({ due: '2026-11-11' }), NOW).text, 'today');
  assert.equal(T.dueLabel(task({ due: '2026-11-12' }), NOW).text, 'tomorrow');
  assert.equal(T.dueLabel(task({ due: '2026-11-14' }), NOW).text, 'Sat');
  assert.equal(T.dueLabel(task({ due: '2026-11-30' }), NOW).text, 'Nov 30');
});
