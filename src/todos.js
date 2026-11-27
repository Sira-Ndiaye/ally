'use strict';
// Shared by the renderer (as window.Todos) and the unit tests (as a CommonJS module).
(function (root) {
  const DAY = 86400000;

  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const startOfDay = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const parseDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

  // Monday 00:00 local time of the week containing `now`.
  function startOfWeek(now) {
    const d = new Date(startOfDay(now));
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getTime();
  }

  // Done tasks are kept until the week they were finished in is over.
  const purge = (todos, now) => todos.filter((t) => !t.d || (t.doneAt || now) >= startOfWeek(now));

  function dueLabel(t, now) {
    if (!t.due) return { text: 'today', late: false };
    const days = Math.round((parseDate(t.due) - startOfDay(now)) / DAY);
    if (days < 0) return { text: -days + 'd late', late: !t.d };
    if (days === 0) return { text: 'today', late: false };
    if (days === 1) return { text: 'tomorrow', late: false };
    const d = new Date(parseDate(t.due));
    if (days < 7) return { text: d.toLocaleDateString('en', { weekday: 'short' }), late: false };
    return { text: d.toLocaleDateString('en', { month: 'short', day: 'numeric' }), late: false };
  }

  const api = { isoDate, startOfWeek, purge, dueLabel };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Todos = api;
})(this);
