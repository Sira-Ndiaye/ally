'use strict';
// The Tasks tab's Matrix view: urgent × important, worked out from the due date and the
// priority each task already has. Nothing new to type, no Claude.
// Shared by the renderer (as window.Matrix) and the unit tests (as a CommonJS module).
(function (root) {
  const DAY = 86400000;
  // Due within this many days (or overdue) is urgent.
  const SOON = 2;
  // A task dragged out of the urgent column gets a due date this many days away.
  const LATER = 7;

  const QUADS = [
    { id: 'now', label: 'Do now', urgent: true, important: true },
    { id: 'plan', label: 'Plan', urgent: false, important: true },
    { id: 'quick', label: 'Quick win', urgent: true, important: false },
    { id: 'later', label: 'Later', urgent: false, important: false },
  ];

  const pad = (n) => String(n).padStart(2, '0');
  const isoDate = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
  const dayOf = (ms) => { const d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const parse = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).getTime(); };

  // A todo with no date means today (it rolls over each day); a ticket with none has none.
  const daysLeft = (item, now) => {
    if (!item.due) return item.kind === 'todo' ? 0 : null;
    return Math.round((parse(item.due) - dayOf(now)) / DAY);
  };
  const isUrgent = (item, now) => { const d = daysLeft(item, now); return d != null && d <= SOON; };
  const isImportant = (item) => item.p === 'P1' || item.p === 'P2';

  function quadOf(item, now) {
    const u = isUrgent(item, now), i = isImportant(item);
    return QUADS.find((q) => q.urgent === u && q.important === i).id;
  }

  // Open tasks by square, each square sorted by due date (none last), then priority.
  function group(items, now) {
    const out = Object.fromEntries(QUADS.map((q) => [q.id, []]));
    for (const it of items) if (it.cat !== 'done') out[quadOf(it, now)].push(it);
    const key = (it) => { const d = daysLeft(it, now); return d == null ? 1e9 : d; };
    for (const q of QUADS) out[q.id].sort((a, b) => key(a) - key(b) || a.p.localeCompare(b.p));
    return out;
  }

  // What dropping a task on a square changes: only what must change to land there.
  // Returns { p, due } with the fields that change, or null when nothing does.
  function dropChange(item, quad, now) {
    const q = QUADS.find((x) => x.id === quad);
    if (!q) return null;
    const patch = {};
    if (q.important && !isImportant(item)) patch.p = 'P1';
    if (!q.important && isImportant(item)) patch.p = 'P3';
    if (q.urgent && !isUrgent(item, now)) patch.due = isoDate(now);
    if (!q.urgent && isUrgent(item, now)) patch.due = isoDate(dayOf(now) + LATER * DAY + DAY / 2);
    return Object.keys(patch).length ? patch : null;
  }

  // Square next to `quad` in a direction, for the arrow keys.
  function neighbour(quad, key) {
    const q = QUADS.find((x) => x.id === quad);
    if (!q) return quad;
    let { urgent, important } = q;
    if (key === 'ArrowLeft') urgent = true;
    if (key === 'ArrowRight') urgent = false;
    if (key === 'ArrowUp') important = true;
    if (key === 'ArrowDown') important = false;
    return QUADS.find((x) => x.urgent === urgent && x.important === important).id;
  }

  // The Jira priority name for P1, P2 or P3 on this site: the one its tickets use most,
  // else the default scheme's name.
  const DEFAULT_NAME = { P1: 'High', P2: 'Medium', P3: 'Low' };
  function priorityName(p, tickets) {
    const n = new Map();
    for (const t of tickets || []) if (t.p === p && t.priority) n.set(t.priority, (n.get(t.priority) || 0) + 1);
    let best = '', most = 0;
    for (const [name, c] of n) if (c > most) { best = name; most = c; }
    return best || DEFAULT_NAME[p];
  }

  const api = { QUADS, SOON, LATER, daysLeft, isUrgent, isImportant, quadOf, group, dropChange, neighbour, priorityName };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Matrix = api;
})(this);
