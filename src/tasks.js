'use strict';
// The Tasks tab's list: Jira tickets and personal todos together.
// Shared by the renderer (as window.Tasks) and the unit tests (as a CommonJS module).
(function (root) {
  const CATS = ['todo', 'doing', 'done'];
  const RANK = { P1: 0, P2: 1, P3: 2 };

  // Todos saved before Ally only had done or not.
  const todoState = (t) => (CATS.includes(t.s) ? t.s : t.d ? 'done' : 'todo');

  // Moves a todo to a state, keeping `d` and `doneAt` (used to purge old done todos) in step.
  function setTodoState(t, s, now) {
    t.s = s;
    t.d = s === 'done';
    t.doneAt = t.d ? (t.doneAt || now) : null;
    return t;
  }

  const fromTodos = (todos) => todos.map((t, i) => ({
    kind: 'todo', i, summary: t.t, p: t.p, due: t.due || null, cat: todoState(t),
  }));

  // Mine: your Jira tickets (the search brings only those assigned to you). Personal: todos.
  const scopesOf = (item) => (item.kind === 'todo' ? ['personal'] : item.assignee?.me ? ['mine'] : []);

  const inStatus = (item, sel) => !sel.status.size || sel.status.has(item.cat);
  const inScope = (item, sel) => !sel.scope.size || scopesOf(item).some((s) => sel.scope.has(s));

  // Each chip counts what it would show with the other row's chips as they are.
  function counts(items, sel) {
    const status = { todo: 0, doing: 0, done: 0 };
    const scope = { mine: 0, personal: 0 };
    for (const it of items) {
      if (inScope(it, sel)) status[it.cat]++;
      if (inStatus(it, sel)) for (const s of scopesOf(it)) scope[s]++;
    }
    return { status, scope };
  }

  const filter = (items, sel) => items.filter((it) => inStatus(it, sel) && inScope(it, sel));

  // Open before done, then by due date (none last), then priority, then key.
  function sort(items) {
    return [...items].sort((a, b) =>
      (a.cat === 'done') - (b.cat === 'done') ||
      (a.due || '9999').localeCompare(b.due || '9999') ||
      RANK[a.p] - RANK[b.p] ||
      String(a.key || '').localeCompare(String(b.key || ''), 'en', { numeric: true }));
  }

  const api = { CATS, todoState, setTodoState, fromTodos, scopesOf, counts, filter, sort };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Tasks = api;
})(this);
