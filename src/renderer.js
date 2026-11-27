'use strict';
const $ = (id) => document.getElementById(id);
const w = $('w');

let todos = [];
let sessions = [];

// Nothing dropped on the widget is opened: a dropped link or file must not load a page here.
for (const t of ['dragover', 'drop']) document.addEventListener(t, (e) => e.preventDefault());

// ---- header controls
function setOpacity(v) {
  w.style.setProperty('--op', v / 100);
  w.style.setProperty('--alpha', (0.3 + (v / 100) * 0.6).toFixed(2));
  $('op').value = v;
  $('opv').textContent = v + '%';
}
$('op').oninput = (e) => { setOpacity(+e.target.value); window.meter.savePrefs({ opacity: +e.target.value }); };
$('opBtn').onclick = (e) => {
  const open = $('oprow').hidden;
  $('frow').hidden = $('wrow').hidden = $('oprow').hidden = !open;
  $('jrow').hidden = !open || !features.jira;
  e.currentTarget.classList.toggle('on', open);
  e.currentTarget.setAttribute('aria-expanded', open);
};
$('wd').oninput = (e) => { $('wdv').textContent = e.target.value + 'px'; };
// Applied on release: resizing during the drag would move the slider under the pointer.
$('wd').onchange = (e) => window.meter.setWidth(+e.target.value);
$('pin').onclick = (e) => {
  const on = e.currentTarget.classList.toggle('on');
  e.currentTarget.title = `Always on top (${on ? 'on' : 'off'})`;
  window.meter.setPinned(on);
};
$('min').onclick = () => {
  const compact = w.classList.toggle('compact');
  window.meter.setCompact(compact);
};
$('close').onclick = () => window.meter.quit();

// Moving the window by its header. Done here and not with a CSS drag region: that one
// did not move the window on macOS, and it swallows every click on the header.
const head = document.querySelector('.whead');
let grab = null;
head.onpointerdown = (e) => {
  if (e.button !== 0 || e.target.closest('button')) return;
  grab = { x: e.screenX - window.screenX, y: e.screenY - window.screenY };
  head.setPointerCapture(e.pointerId);
};
head.onpointermove = (e) => { if (grab) window.meter.moveTo(e.screenX - grab.x, e.screenY - grab.y); };
head.onpointerup = head.onpointercancel = () => { grab = null; };

// ---- optional parts
function applyFeatures() {
  $('fjira').checked = features.jira;
  $('fproj').checked = features.projects;
  $('flim').checked = features.limits;
  document.querySelector('.tab[data-t="projects"]').hidden = !features.projects;
  $('jrow').hidden = $('frow').hidden || !features.jira;
  if (!features.projects && !$('p-projects').hidden) showTab('sessions');
}
function setFeature(key, on) {
  features = { ...features, [key]: on };
  window.meter.savePrefs({ features });
  applyFeatures();
  renderTasks();
  renderProjects();
  renderUsage(lastUsage);
  if (on && key === 'jira' && !$('p-todo').hidden) refreshTickets();
}
$('fjira').onchange = (e) => setFeature('jira', e.target.checked);
$('fproj').onchange = (e) => setFeature('projects', e.target.checked);
$('flim').onchange = (e) => setFeature('limits', e.target.checked);

// ---- tabs
function showTab(name) {
  if (name === 'projects' && !features.projects) name = 'sessions';
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', t.dataset.t === name));
  for (const k of ['usage', 'sessions', 'todo', 'projects']) $('p-' + k).hidden = k !== name;
  if (w.classList.contains('compact')) $('min').click();
  if (name === 'usage') window.meter.refreshUsage();
  if (name === 'todo') refreshTickets();
  if (name === 'projects') refreshProjects();
}
document.querySelectorAll('.tab').forEach((t) => { t.onclick = () => showTab(t.dataset.t); });

// ---- usage
const fmtTokens = (n) => (n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'k' : String(n));
const color = (p) => (p >= 90 ? 'var(--crit)' : p >= 70 ? 'var(--p2)' : 'var(--ok)');

function resetText(iso) {
  if (!iso) return '';
  const ms = Date.parse(iso) - Date.now();
  if (ms <= 0) return 'resets now';
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  if (h < 24) return `resets in ${h}h ${String(m).padStart(2, '0')}m`;
  return 'resets ' + new Date(iso).toLocaleString('en', { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

function renderUsage(u) {
  lastUsage = u;
  const box = $('limits');
  box.replaceChildren();
  // Off: nothing read, nothing asked. Tokens and replies below come from local logs.
  const lim = features.limits ? u.limits : null;
  if (!features.limits) {
    const e = document.createElement('div');
    e.className = 'uoff';
    e.textContent = 'Plan limits are off. Tick Usage limits in Settings to see them: Ally then reads Claude Code\'s login on this computer.';
    box.appendChild(e);
  }
  if (lim?.error) {
    const e = document.createElement('div');
    e.className = 'uerr';
    e.textContent = lim.error;
    box.appendChild(e);
  }
  for (const l of lim?.limits || []) {
    const m = document.createElement('div');
    m.className = 'meter';
    m.innerHTML = '<div class="mrow"><span class="mlabel"></span><span class="mpct"></span></div><div class="track"><div class="fill"></div></div><div class="msub"></div>';
    m.querySelector('.mlabel').textContent = l.label;
    m.querySelector('.mpct').textContent = l.percent + '%';
    m.querySelector('.mpct').style.color = color(l.percent);
    m.querySelector('.fill').style.width = Math.min(100, l.percent) + '%';
    m.querySelector('.fill').style.background = color(l.percent);
    m.querySelector('.msub').textContent = resetText(l.resetsAt);
    box.appendChild(m);
  }
  const plan = lim?.plan ? lim.plan[0].toUpperCase() + lim.plan.slice(1) + ' plan' : '';
  $('plan').textContent = plan;
  $('upd').textContent = lim?.at ? 'updated ' + new Date(lim.at).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false }) : 'refresh';
  if (u.logs) {
    $('tok').textContent = fmtTokens(u.logs.tokens);
    $('msgs').textContent = u.logs.messages;
    spark(u.logs.hours);
  }
  const session = (lim?.limits || []).find((l) => l.label.startsWith('Session'));
  $('pU').textContent = session ? `5h ${session.percent}%` : '';
}
$('upd').onclick = () => window.meter.refreshUsage();

function spark(hours) {
  const W = 240, H = 38, max = Math.max(...hours, 1), step = W / (hours.length - 1);
  const pts = hours.map((v, i) => [i * step, H - 3 - (v / max) * (H - 8)]);
  const line = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
  const last = pts[pts.length - 1];
  $('spk').innerHTML = `<line x1="0" y1="${H - 3}" x2="${W}" y2="${H - 3}" stroke="rgba(255,255,255,.08)"/>` +
    `<path d="${line} L${W} ${H} L0 ${H}Z" fill="rgba(229,139,108,.18)"/>` +
    `<path d="${line}" fill="none" stroke="#e58b6c" stroke-width="1.6" vector-effect="non-scaling-stroke"/>` +
    `<circle cx="${last[0] - 2}" cy="${last[1]}" r="2.6" fill="#e58b6c"/>`;
}

// ---- sessions
const LABEL = { input: 'Needs input', working: 'Working', idle: 'Idle', unknown: 'Running' };
const RANK = { input: 0, working: 1, idle: 2, unknown: 3 };
const base = (p) => (p || '').split(/[\\/]/).filter(Boolean).pop() || p || '?';
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? s + 's' : s < 3600 ? Math.floor(s / 60) + 'm' : Math.floor(s / 3600) + 'h';
};

function sessionSummary() {
  const need = sessions.filter((s) => s.state === 'input').length;
  const working = sessions.filter((s) => s.state === 'working').length;
  return [`${sessions.length} sessions`, `${working} working`, `${need} waiting`];
}

// One cell per count, spread over the row.
function drawSummary() {
  $('sSum').replaceChildren(...sessionSummary().map((text) => Object.assign(document.createElement('span'), { textContent: text })));
}

async function focus(s) {
  const r = await window.meter.focus(s);
  if (r.ok) return;
  $('sSum').textContent = r.reason;
  $('sSum').classList.add('err');
  setTimeout(() => { $('sSum').classList.remove('err'); drawSummary(); }, 6000);
}

function renderSessions() {
  const L = $('slist');
  L.replaceChildren();
  const list = [...sessions].sort((a, b) => RANK[a.state] - RANK[b.state] || (b.since || 0) - (a.since || 0));
  if (!list.length) L.innerHTML = '<li class="empty">No Claude Code session running.</li>';
  for (const s of list) {
    const li = document.createElement('li');
    li.className = 'sess ' + s.state;
    li.title = (s.cwd || '') + '\nClick to open its terminal';
    // Session files are data: their values go in as text and known class names only.
    const st = Object.hasOwn(LABEL, s.state) ? s.state : 'unknown';
    li.append(el('span', `st ${st}`), el('span', 'sname'), el('span', `sstate ${st}`, LABEL[s.state] || String(s.state || '')), el('span', 'smeta'));
    li.querySelector('.sname').textContent = base(s.cwd);
    li.querySelector('.smeta').textContent = [s.branch, s.message, s.since && ago(s.since)].filter(Boolean).join(' · ');
    li.onclick = () => focus(s);
    L.appendChild(li);
  }
  const need = sessions.filter((s) => s.state === 'input').length;
  $('sessN').textContent = need || sessions.length;
  $('sessN').classList.toggle('alert', need > 0);
  $('hdot').classList.toggle('alert', need > 0);
  if (!$('sSum').classList.contains('err')) drawSummary();
  $('pI').textContent = '⚑ ' + need;
  $('pI').style.color = need ? 'var(--crit)' : '';
}

// ---- pending prompt
// The oldest pending prompt takes over the widget until it is answered, here or in the terminal.
const SENT_MS = 900;
let askOn = null;
let askSentAt = 0;
let askTimer;

function renderAsk() {
  clearTimeout(askTimer);
  const wait = askSentAt + SENT_MS - Date.now();
  if (wait > 0) { askTimer = setTimeout(renderAsk, wait); return; }
  const s = sessions.filter((x) => x.ask).sort((a, b) => a.ask.at - b.ask.at)[0];
  if (!s) { if (askOn) leaveAsk(); return; }
  if (!askOn || askOn.s.id !== s.id || askOn.s.ask.at !== s.ask.at) {
    askOn = { s, steps: Ask.steps(s.ask), i: 0, replies: [], drawn: false };
  }
  drawAsk();
}

function leaveAsk() {
  askOn = null;
  w.classList.add('leaving');
  setTimeout(() => {
    if (askOn) return;
    w.classList.remove('asking', 'leaving');
    $('ask').hidden = true;
    window.meter.askDone();
  }, 300);
}

function drawAsk() {
  const { s, steps, i } = askOn;
  const step = steps[i];
  const waiting = sessions.filter((x) => x.ask).length;
  $('aMeta').textContent = [s.branch, `asked ${ago(s.ask.at)} ago`].filter(Boolean).join(' · ');
  $('aNote').textContent = [steps.length > 1 && `question ${i + 1} of ${steps.length}`, waiting > 1 && `1 of ${waiting} waiting`].filter(Boolean).join(' · ');
  if (askOn.drawn) return;
  askOn.drawn = true;
  $('ask').classList.remove('sent');
  $('aName').textContent = base(s.cwd);
  $('aState').textContent = 'Needs input';
  $('aHdr').textContent = step.header;
  $('aQ').textContent = step.question;
  $('aDetail').hidden = !step.detail;
  $('aDetail').textContent = step.detail || '';
  $('aText').value = '';
  $('aText').placeholder = step.placeholder;
  $('aOther').classList.remove('picked');
  const box = $('aOpts');
  box.replaceChildren();
  step.options.forEach((o, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'opt';
    b.dataset.v = o.value;
    b.innerHTML = '<span class="okey"></span><span class="olabel"></span><span class="odesc"></span>';
    b.children[0].textContent = n + 1;
    b.children[1].textContent = o.label;
    b.children[2].textContent = o.description;
    if (step.multi) b.setAttribute('aria-pressed', 'false');
    b.onclick = () => {
      if (step.multi) b.setAttribute('aria-pressed', b.getAttribute('aria-pressed') !== 'true');
      else replyAsk([o.value], '', [b]);
    };
    box.appendChild(b);
  });
  $('ask').hidden = false;
  w.classList.remove('leaving');
  w.classList.add('asking');
  requestAnimationFrame(() => window.meter.askSize(w.offsetHeight));
}

function replyAsk(picks, text, chosen) {
  const { s, steps } = askOn;
  askOn.replies[askOn.i] = { picks, text };
  if (askOn.i < steps.length - 1) {
    askOn.i++;
    askOn.drawn = false;
    drawAsk();
    return;
  }
  for (const el of chosen) el.classList.add('picked');
  $('ask').classList.add('sent');
  $('aState').textContent = 'Answered';
  $('aNote').textContent = '✓ Sent';
  askSentAt = Date.now();
  window.meter.answer({ id: s.id, at: s.ask.at, decision: Ask.decision(s.ask, askOn.replies) });
  askTimer = setTimeout(renderAsk, SENT_MS);
}

$('aOther').onsubmit = (e) => {
  e.preventDefault();
  const text = $('aText').value.trim();
  const pressed = [...$('aOpts').querySelectorAll('[aria-pressed=true]')];
  if (!text && !pressed.length) return;
  replyAsk(pressed.map((b) => b.dataset.v), text, text ? [...pressed, $('aOther')] : pressed);
};
$('ask').ondblclick = async (e) => {
  if (e.target.closest('button, input')) return;
  const r = await window.meter.focus(askOn.s);
  if (!r.ok) $('aNote').textContent = r.reason;
};

// ---- tasks: Jira tickets and personal todos in one list
const NEXT = { P1: 'P2', P2: 'P3', P3: 'P1' };
const NEXT_STATE = { todo: 'doing', doing: 'done', done: 'todo' };
const STATE_LABEL = { todo: 'To Do', doing: 'In Progress', done: 'Done' };
const TOKEN_PAGE = 'https://id.atlassian.com/manage-profile/security/api-tokens';
const saveTodos = () => window.meter.saveTodos(todos);
const sel = { status: new Set(['todo', 'doing']), scope: new Set() };
let jiraState = { configured: false, labels: [] };
// Jira tickets and Projects are optional, switched on in Settings.
let features = { jira: false, projects: false, limits: false };
let lastUsage = { limits: null, logs: null };
const jiraOn = () => features.jira && jiraState.configured;
let jira = { tickets: [], at: 0, error: '', more: false, loading: false };
let redating = -1;

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const hhmm = (ms) => new Date(ms).toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });

function applyJira(r) {
  jira = { ...jira, tickets: r.tickets || [], at: r.at || 0, error: r.error || '', more: !!r.more };
}

async function refreshTickets() {
  if (!jiraOn() || jira.loading) return;
  jira.loading = true;
  renderTasks();
  applyJira(await window.meter.jiraRefresh());
  jira.loading = false;
  renderTasks();
}

function scopeChip(key, label, n) {
  const c = el('button', 'chip', label);
  c.setAttribute('aria-pressed', sel.scope.has(key));
  c.appendChild(el('span', 'c', String(n)));
  c.onclick = () => {
    if (sel.scope.has(key)) sel.scope.delete(key); else sel.scope.add(key);
    renderTasks();
  };
  return c;
}

function renderScopes(n) {
  const box = $('fscope');
  box.replaceChildren();
  if (jiraOn()) box.appendChild(scopeChip('mine', 'Mine', n.mine));
  box.appendChild(scopeChip('personal', 'Personal', n.personal));
}

function renderJiraState() {
  const box = $('jstate');
  box.replaceChildren();
  box.className = 'jstate';
  if (!features.jira) return;
  if (!jiraOn()) {
    box.append(el('span', '', 'Jira is not connected. '));
    const b = el('button', 'link', 'Connect');
    b.onclick = () => showJiraForm(true);
    box.appendChild(b);
    return;
  }
  if (jira.loading) { box.textContent = 'Refreshing from Jira…'; return; }
  if (jira.error) {
    box.classList.add('err');
    box.append(el('span', '', jira.error + ' '));
    const b = el('button', 'link', 'Settings');
    b.onclick = () => showJiraForm(true);
    box.appendChild(b);
    return;
  }
  if (jira.at) box.textContent = `${jira.tickets.length} tickets · updated ${hhmm(jira.at)}` + (jira.more ? ' · the 100 most recently updated' : '');
}

function ticketRow(t, now) {
  const li = el('li', `item tk ${t.cat}`);
  li.title = `${t.key} · ${t.status}\nClick to open in Jira, right-click for more`;
  const dot = el('span', `sdot ${t.cat}`);
  dot.title = t.status;
  const pri = el('span', `pri ${t.p}`, t.p);
  pri.title = t.priority || t.p;
  const due = el('span', 'due');
  if (t.due) {
    const d = Todos.dueLabel({ due: t.due, d: t.cat === 'done' }, now);
    due.textContent = d.text;
    due.classList.toggle('late', d.late);
  }
  const meta = el('span', 'meta');
  meta.appendChild(el('span', 'key', t.key));
  meta.append(' ' + t.status);
  if (t.assignee && !t.assignee.me) { const a = el('span', 'who', t.assignee.initials); a.title = t.assignee.name; meta.appendChild(a); }
  if (!t.assignee) meta.appendChild(el('span', 'who none', 'unassigned'));
  if (t.blocked) meta.appendChild(el('span', 'tag blocked', 'blocked'));
  if (planning.has(t.key)) meta.appendChild(el('span', 'tag planning', '● planning in terminal'));
  li.append(dot, pri, el('span', 'txt', t.summary), due, el('span'), meta);
  li.onclick = () => window.meter.openUrl(t.url);
  li.oncontextmenu = (e) => ticketMenu(e, t);
  return li;
}

function todoRow(t, now) {
  const x = todos[t.i];
  const li = el('li', `item ${t.cat}`);
  const dot = el('button', `sdot ${t.cat}`);
  dot.title = `${STATE_LABEL[t.cat]} · click for ${STATE_LABEL[NEXT_STATE[t.cat]]}`;
  dot.setAttribute('aria-label', dot.title);
  dot.onclick = () => { Tasks.setTodoState(x, NEXT_STATE[t.cat], Date.now()); saveTodos(); renderTasks(); };
  const pri = el('button', `pri ${t.p}`, t.p);
  pri.title = 'Change priority';
  pri.onclick = () => { x.p = NEXT[t.p]; saveTodos(); renderTasks(); };
  const d = Todos.dueLabel({ due: t.due, d: t.cat === 'done' }, now);
  const due = el('button', 'due', d.text);
  due.title = 'Change due date';
  due.classList.toggle('late', d.late);
  due.onclick = () => { redating = t.i; $('redate').value = t.due || Todos.isoDate(now); $('redate').showPicker(); };
  const del = el('button', 'ic del');
  del.setAttribute('aria-label', 'Delete');
  del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  del.onclick = () => { todos.splice(t.i, 1); saveTodos(); renderTasks(); };
  li.append(dot, pri, el('span', 'txt', t.summary), due, del);
  const proj = projects.find((p) => p.id === todos[t.i].project);
  if (t.cat === 'doing' || proj) {
    const meta = el('span', 'meta', t.cat === 'doing' ? 'In progress' : '');
    if (proj) meta.appendChild(el('span', 'tag', proj.name));
    li.appendChild(meta);
  }
  li.oncontextmenu = (e) => todoMenu(e, t);
  return li;
}

function renderTasks() {
  const now = Date.now();
  const items = [...(jiraOn() ? jira.tickets : []), ...Tasks.fromTodos(todos)];
  const n = Tasks.counts(items, sel);
  document.querySelectorAll('#fstatus .chip').forEach((c) => {
    c.setAttribute('aria-pressed', sel.status.has(c.dataset.s));
    c.querySelector('.c').textContent = n.status[c.dataset.s];
  });
  $('jrefresh').hidden = !jiraOn();
  $('jrefresh').classList.toggle('spin', jira.loading);
  renderScopes(n.scope);
  renderJiraState();
  const matrix = view === 'matrix';
  document.querySelectorAll('#fstatus .chip').forEach((c) => { c.hidden = matrix; });
  document.querySelectorAll('#fview .seg button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.v === view));
  $('list').hidden = matrix;
  $('matrix').hidden = !matrix;
  if (matrix) renderMatrix(Tasks.filter(items, { status: new Set(), scope: sel.scope }), now);
  const L = $('list');
  L.replaceChildren();
  const rows = matrix ? [] : Tasks.sort(Tasks.filter(items, sel));
  if (!matrix && !rows.length) L.appendChild(el('li', 'empty', items.length ? 'Nothing matches these filters.' : 'Nothing to do. Add a task above.'));
  for (const t of rows) L.appendChild(t.kind === 'jira' ? ticketRow(t, now) : todoRow(t, now));
  // The tab's count: my open tickets and open personal tasks.
  const open = items.filter((t) => t.cat !== 'done' && (t.kind === 'todo' || t.assignee?.me)).length;
  $('openN').textContent = open;
  $('pT').textContent = '☐ ' + open;
}

$('redate').onchange = (e) => {
  if (redating < 0 || !e.target.value) return;
  todos[redating].due = e.target.value;
  redating = -1;
  saveTodos(); renderTasks();
};
$('addf').onsubmit = (e) => {
  e.preventDefault();
  const v = $('newt').value.trim();
  if (!v) return;
  todos.push({ t: v, p: $('newp').value, s: 'todo', d: false, due: $('newd').value || Todos.isoDate(Date.now()), doneAt: null });
  $('newt').value = '';
  $('newd').value = Todos.isoDate(Date.now());
  saveTodos(); renderTasks();
};
document.querySelectorAll('#fstatus .chip').forEach((c) => {
  c.onclick = () => {
    if (sel.status.has(c.dataset.s)) sel.status.delete(c.dataset.s); else sel.status.add(c.dataset.s);
    renderTasks();
  };
});
$('jrefresh').onclick = refreshTickets;

// ---- right-click menus
let homeDir = '';
const planning = new Set();
const menu = $('menu');

function closeMenu() { menu.hidden = true; menu.replaceChildren(); }

// items: { label, hint, run, off } or { head } or 'sep'. A promise for items fills in later.
function menuItems(box, items) {
  box.replaceChildren();
  for (const it of items) {
    if (it === 'sep') { box.appendChild(el('div', 'msep')); continue; }
    if (it.head) { box.appendChild(el('div', 'mhead', it.head)); continue; }
    const b = el('button', 'mitem', it.label);
    b.setAttribute('role', 'menuitem');
    if (it.hint) b.appendChild(el('span', 'mhint', it.hint));
    if (it.off) b.disabled = true;
    else b.onclick = () => { closeMenu(); it.run(); };
    box.appendChild(b);
  }
}

function openMenu(e, sections) {
  e.preventDefault();
  menu.replaceChildren();
  for (const sec of sections) {
    const box = el('div', 'msec');
    menu.appendChild(box);
    if (typeof sec.then === 'function') {
      menuItems(box, [{ label: 'Loading…', off: true }]);
      sec.then((items) => { if (!menu.hidden) { menuItems(box, items); place(); } });
    } else menuItems(box, sec);
  }
  menu.hidden = false;
  const place = () => {
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(e.clientX, innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(e.clientY, innerHeight - r.height - 4)) + 'px';
  };
  place();
  const first = menu.querySelector('.mitem:not(:disabled)');
  if (first) first.focus();
}
addEventListener('pointerdown', (e) => { if (!menu.hidden && !menu.contains(e.target)) closeMenu(); });
addEventListener('keydown', (e) => {
  if (menu.hidden) return;
  if (e.key === 'Escape') closeMenu();
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const all = [...menu.querySelectorAll('.mitem:not(:disabled)')];
    const i = all.indexOf(document.activeElement);
    all[(i + (e.key === 'ArrowDown' ? 1 : all.length - 1)) % all.length]?.focus();
  }
});
addEventListener('blur', closeMenu);
$('p-todo').addEventListener('scroll', closeMenu, true);

// Signed in with Atlassian without write access: reading works, changing Jira does not.
const canWrite = () => jiraState.write !== false;
const allowWrite = () => ({ label: 'Allow write access…', hint: 'sign in again', run: jiraSignIn });

// Fetched only when the menu opens: the moves this ticket's workflow allows now.
async function moveItems(t) {
  if (!canWrite()) return [{ label: 'Moves need write access in Jira', off: true }, allowWrite()];
  const r = await window.meter.jiraTransitions(t.key);
  if (!r.ok) return [{ label: r.error, off: true }];
  const moves = r.value.filter((m) => m.to !== t.status);
  if (!moves.length) return [{ label: 'No move allowed from here', off: true }];
  return [{ head: 'Move to' }, ...moves.map((m) => ({ label: m.to, hint: m.name !== m.to ? m.name : '', run: () => moveTicket(t, m) }))];
}

async function moveTicket(t, m) {
  const r = await window.meter.jiraTransition(t.key, m.id);
  if (!r.ok) return notice(`${t.key} not moved: ${r.error}`, { error: true });
  // Shown at once; the refresh brings the rest of Jira's changes.
  Object.assign(t, { status: m.to, cat: m.cat });
  renderTasks();
  notice(`${t.key} moved to ${m.to}`);
  refreshTickets();
}

function ticketMenu(e, t) {
  openMenu(e, [
    moveItems(t),
    ['sep', { label: 'Plan with Claude', run: () => planItem({ kind: 'jira', key: t.key, summary: t.summary, status: t.status, p: t.p, due: t.due, labels: t.labels, project: t.project }) },
      'sep',
      { label: 'Open in Jira', hint: '↗', run: () => window.meter.openUrl(t.url) },
      { label: 'Copy key', hint: t.key, run: () => { window.meter.copy(t.key); notice(`Copied ${t.key}`); } }],
  ]);
}

// Projects the todo can go to: the ones your listed tickets belong to.
function knownProjects() {
  const seen = new Map();
  for (const t of jira.tickets) {
    const k = t.key.split('-')[0];
    if (!seen.has(k)) seen.set(k, t.project || k);
  }
  return [...seen];
}

async function sendToJira(t, project) {
  const x = todos[t.i];
  notice(`Creating a ticket in ${project}…`, { stay: true });
  const r = await window.meter.jiraCreate({ project, summary: x.t, due: x.due, p: x.p });
  if (!r.ok) return notice(`Not sent: ${r.error}`, { error: true });
  // The todo became that ticket.
  todos.splice(todos.indexOf(x), 1);
  saveTodos();
  notice(`Sent as ${r.value}`);
  refreshTickets();
}

// Your checklist projects, for a todo to join; or leaving the one it is in.
function projectItems(t) {
  const x = todos[t.i];
  const inside = projects.find((p) => p.id === x.project);
  const lists = projects.filter((p) => p.kind === 'checklist' && !p.archived && !p.followed && p !== inside);
  const items = [];
  if (lists.length) items.push('sep', { head: 'Add to project' }, ...lists.map((p) => ({ label: p.name, run: () => { x.project = p.id; saveTodos(); renderTasks(); renderProjects(); notice(`Added to ${p.name}`); } })));
  if (inside) items.push('sep', { label: `Remove from ${inside.name}`, run: () => { delete x.project; saveTodos(); renderTasks(); renderProjects(); } });
  return items;
}

function todoMenu(e, t) {
  const projects = jiraOn() ? knownProjects() : [];
  const send = !jiraOn() ? [{ label: 'Send to Jira: connect Jira first', off: true }]
    : !canWrite() ? [{ label: 'Send to Jira: needs write access', off: true }, allowWrite()]
    : !projects.length ? [{ label: 'Send to Jira: no project known yet', off: true }]
      : [{ head: 'Send to Jira' }, ...projects.map(([k, name]) => ({ label: name, hint: k, run: () => sendToJira(t, k) }))];
  openMenu(e, [
    features.jira ? send : [],
    features.projects ? projectItems(t) : [],
    ['sep', { label: 'Plan with Claude', run: () => planItem({ kind: 'todo', text: t.summary, p: t.p, due: t.due }) },
      'sep', { label: 'Delete', run: () => { todos.splice(t.i, 1); saveTodos(); renderTasks(); renderProjects(); } }],
  ]);
}

// ---- notices: what just happened, fading after a few seconds unless hovered
const notif = $('notice');
let noticeTimer;
let lastPlan = null;

function notice(text, { error = false, stay = false, change = false } = {}) {
  clearTimeout(noticeTimer);
  $('ntext').textContent = text;
  $('nchange').hidden = !change;
  $('nform').hidden = true;
  notif.classList.toggle('err', error);
  notif.hidden = false;
  if (!stay) noticeTimer = setTimeout(fadeNotice, error ? 9000 : change ? 7000 : 3500);
}
function fadeNotice() {
  if (notif.matches(':hover') || !$('nform').hidden) { noticeTimer = setTimeout(fadeNotice, 2000); return; }
  notif.hidden = true;
}
$('nclose').onclick = () => { notif.hidden = true; };

const shortPath = (p) => {
  const t = homeDir && (p === homeDir || p.startsWith(homeDir + '/') || p.startsWith(homeDir + '\\')) ? '~' + p.slice(homeDir.length) : p;
  const parts = t.split(/[\\/]/);
  return parts.length > 3 ? `${parts[0]}/…/${parts[parts.length - 1]}` : t;
};

async function planItem(item, change) {
  notice(`Opening a terminal for ${item.key || 'this task'}…`, { stay: true });
  const r = await window.meter.plan(item, change);
  if (!r.ok) return notice(`Could not open a terminal: ${r.error}`, { error: true });
  lastPlan = { item, r };
  if (item.key) { planning.add(item.key); renderTasks(); }
  const how = r.skill ? `with /${r.skill}` : 'plan mode';
  notice(`Planning ${r.name} · ${how} · in ${r.known ? shortPath(r.folder) : 'your home folder (repository unknown)'}`, { change: true });
}

$('nchange').onclick = () => {
  if (!lastPlan) return;
  const { item, r } = lastPlan;
  const skill = $('nskill');
  skill.replaceChildren(el('option', '', 'Built-in prompt (plan mode)'));
  skill.firstChild.value = '';
  for (const n of r.choices.skills) { const o = el('option', '', '/' + n); o.value = n; skill.appendChild(o); }
  skill.value = r.skill;
  $('nskillrow').hidden = item.kind !== 'jira';
  const folder = $('nfolder');
  folder.replaceChildren();
  for (const d of r.choices.folders) { const o = el('option', '', shortPath(d)); o.value = d; folder.appendChild(o); }
  const other = el('option', '', 'Other folder…');
  other.value = '?';
  folder.appendChild(other);
  folder.value = r.folder;
  $('nscope').textContent = r.scope === 'personal' ? 'personal tasks' : `every ${r.scope} ticket`;
  $('nform').hidden = false;
};
$('nfolder').onchange = async (e) => {
  if (e.target.value !== '?') return;
  const dir = await window.meter.pickFolder();
  if (!dir) { e.target.value = lastPlan.r.folder; return; }
  const o = el('option', '', shortPath(dir));
  o.value = dir;
  e.target.insertBefore(o, e.target.lastChild);
  e.target.value = dir;
};
$('nform').onsubmit = (e) => {
  e.preventDefault();
  planItem(lastPlan.item, { skill: $('nskill').value, repo: $('nfolder').value });
};

// ---- projects: an epic, a label, or a checklist of your todos
const HEALTH = { 'on-track': 'On track', 'at-risk': 'At risk', blocked: 'Blocked', done: 'Done', 'not-started': 'Not started' };
let projects = [];
let pdata = { tickets: [], at: 0, error: '', more: false, loading: false };
// ---- Matrix view: urgent × important from due dates and priorities. Drag to change them.
let view = 'list';
document.querySelectorAll('#fview .seg button').forEach((b) => {
  b.onclick = () => { view = b.dataset.v; window.meter.savePrefs({ tasksView: view }); renderTasks(); };
});
const itemId = (t) => (t.kind === 'jira' ? 'j:' + t.key : 't:' + t.i);
let dragged = false;

function renderMatrix(items, now) {
  const box = $('matrix');
  const focused = document.activeElement?.closest?.('.mc')?.dataset.id;
  box.replaceChildren();
  const g = Matrix.group(items, now);
  for (const q of Matrix.QUADS) {
    const sq = el('div', `mq ${q.id}`);
    sq.dataset.q = q.id;
    const head = el('div', 'mqh', q.label);
    head.appendChild(el('span', 'c', String(g[q.id].length)));
    const list = el('div', 'mql');
    if (!g[q.id].length) list.appendChild(el('span', 'mqe', q.id === 'now' ? 'Nothing urgent' : 'Empty'));
    for (const t of g[q.id]) list.appendChild(matrixChip(t, q.id, now));
    sq.append(head, list);
    box.appendChild(sq);
  }
  if (focused) box.querySelector(`.mc[data-id="${CSS.escape(focused)}"]`)?.focus();
}

function matrixChip(t, quad, now) {
  const c = el('button', `mc ${t.p}`);
  c.dataset.id = itemId(t);
  const d = Matrix.daysLeft(t, now);
  const due = t.due || t.kind === 'todo' ? Todos.dueLabel({ due: t.due }, now) : null;
  c.title = `${t.kind === 'jira' ? t.key + ' · ' : ''}${t.summary}\n${t.p}${due ? ' · due ' + due.text : ' · no due date'}\nDrag to another square, or use the arrow keys`;
  if (t.kind === 'jira') c.appendChild(el('span', 'key', t.key));
  c.appendChild(el('span', 'txt', t.summary));
  // Room is short in a square: a late task just says late (the tooltip has how late).
  if (due) { const x = el('span', 'due', d < 0 ? 'late' : due.text); x.classList.toggle('late', d < 0); c.appendChild(x); }
  c.onclick = () => { if (dragged) return; if (t.kind === 'jira') window.meter.openUrl(t.url); };
  c.oncontextmenu = (e) => (t.kind === 'jira' ? ticketMenu(e, t) : todoMenu(e, t));
  c.onkeydown = (e) => {
    if (!e.key.startsWith('Arrow')) return;
    e.preventDefault();
    const to = Matrix.neighbour(quad, e.key);
    if (to !== quad) placeIn(t, to);
  };
  c.onpointerdown = (e) => startDrag(e, c, t);
  return c;
}

function startDrag(e, chip, t) {
  if (e.button !== 0) return;
  const x0 = e.clientX, y0 = e.clientY;
  let ghost = null, over = null;
  dragged = false;
  const move = (ev) => {
    if (!ghost) {
      if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < 5) return;
      dragged = true;
      ghost = chip.cloneNode(true);
      ghost.className += ' ghost';
      ghost.style.width = chip.offsetWidth + 'px';
      document.body.appendChild(ghost);
      chip.classList.add('lifted');
    }
    ghost.style.transform = `translate(${ev.clientX + 6}px, ${ev.clientY - 10}px)`;
    const sq = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.mq');
    if (sq !== over) { over?.classList.remove('over'); over = sq; over?.classList.add('over'); }
  };
  const up = () => {
    removeEventListener('pointermove', move);
    removeEventListener('pointerup', up);
    removeEventListener('pointercancel', up);
    if (!ghost) return;
    ghost.remove();
    chip.classList.remove('lifted');
    over?.classList.remove('over');
    if (over) placeIn(t, over.dataset.q);
    setTimeout(() => { dragged = false; }, 0);
  };
  addEventListener('pointermove', move);
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
}

const changeText = (patch) => [patch.p, patch.due && 'due ' + Todos.dueLabel({ due: patch.due }, Date.now()).text].filter(Boolean).join(', ');

// Only what must change to land in the square: priority, due date, or both.
async function placeIn(t, quad) {
  const patch = Matrix.dropChange(t, quad, Date.now());
  if (!patch) return;
  if (t.kind === 'todo') {
    Object.assign(todos[t.i], patch);
    saveTodos();
    renderTasks();
    return notice(`${t.summary}: ${changeText(patch)}`);
  }
  if (!canWrite()) return notice(`${t.key} not changed: Ally has no write access in Jira.`, { error: true });
  const before = { p: t.p, priority: t.priority, due: t.due };
  const priority = patch.p ? Matrix.priorityName(patch.p, jira.tickets) : undefined;
  // Shown at once; put back if Jira refuses.
  Object.assign(t, patch, priority ? { priority } : {});
  renderTasks();
  const r = await window.meter.jiraEdit(t.key, { priority, due: patch.due });
  if (!r.ok) {
    Object.assign(t, before);
    renderTasks();
    return notice(`${t.key} not changed: ${r.error}`, { error: true });
  }
  notice(`${t.key}: ${changeText({ ...patch, p: priority || undefined })}`);
}

let boardUrl = '';
let showArchived = false;
const openProjects = new Set();
const saveProjects = () => window.meter.saveProjects(projects);
const linked = () => projects.some((p) => !p.archived && p.kind !== 'checklist');
const shortDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });
const jqlUrl = (jql) => `${jiraState.site}/issues/?jql=${encodeURIComponent(jql)}`;

async function refreshProjects() {
  if (!jiraOn() || !linked() || pdata.loading) return renderProjects();
  pdata.loading = true;
  renderProjects();
  const r = await window.meter.projectsRefresh(projects);
  pdata = { tickets: r.tickets || [], at: r.at || 0, error: r.error || '', more: !!r.more, loading: false };
  // A followed epic is named after the epic once Jira says what it is.
  for (const p of projects) {
    if (p.kind === 'epic' && p.name === p.epic) {
      const e = pdata.tickets.find((t) => t.key === p.epic);
      if (e && e.summary) { p.name = e.summary; saveProjects(); }
    }
  }
  renderProjects();
}

function kindText(p) {
  if (p.kind === 'epic') return `epic ${p.epic}`;
  if (p.kind === 'label') return `#${p.label}`;
  return 'checklist';
}

function projectCard(p, sum, now) {
  const li = el('li', `proj ${sum.health}` + (p.archived ? ' archived' : ''));
  const head = el('div', 'prow');
  head.append(el('span', 'pname', p.name), el('span', `phealth ${sum.health}`, p.archived ? 'Archived' : HEALTH[sum.health]));
  const bar = el('div', 'pbar');
  const fill = el('span');
  fill.style.width = (sum.total ? Math.round((sum.done / sum.total) * 100) : 0) + '%';
  bar.appendChild(fill);
  const meta = el('div', 'pmeta');
  meta.appendChild(el('span', 'kind', kindText(p)));
  meta.appendChild(el('span', '', sum.total ? `${sum.done}/${sum.total} done` : p.kind === 'checklist' ? 'no items yet' : jiraOn() ? (sum.found ? 'no tickets' : pdata.at ? 'not found in Jira' : '') : 'connect Jira'));
  if (sum.due) {
    const d = el('span', 'pdue', shortDate(sum.due));
    if (sum.health !== 'done' && Projects.daysUntil(sum.due, now) < 0) d.classList.add('late');
    meta.appendChild(d);
  }
  if (p.followed) {
    const f = el('span', 'tag', '👁 following');
    meta.appendChild(f);
    if (sum.owner) { const o = el('span', 'who', sum.owner.initials); o.title = 'Owner: ' + sum.owner.name; meta.appendChild(o); }
  }
  li.append(head, bar, meta);
  if (openProjects.has(p.id)) li.appendChild(projectDetail(p, sum));
  li.onclick = (e) => {
    if (e.target.closest('.pdetail')) return;
    if (openProjects.has(p.id)) openProjects.delete(p.id); else openProjects.add(p.id);
    renderProjects();
  };
  li.oncontextmenu = (e) => projectMenu(e, p);
  return li;
}

function projectDetail(p, sum) {
  const box = el('div', 'pdetail');
  if (p.kind !== 'checklist') {
    const todo = sum.total - sum.done - sum.doing;
    box.appendChild(el('div', 'pcounts', `${todo} to do · ${sum.doing} in progress · ${sum.blocked} blocked · ${sum.done} done`));
    if (jiraOn()) {
      const a = el('button', 'link', 'Open in Jira ↗');
      a.onclick = () => window.meter.openUrl(p.kind === 'epic' ? `${jiraState.site}/browse/${p.epic}` : jqlUrl(`labels = "${p.label}" ORDER BY status`));
      box.appendChild(a);
    }
    return box;
  }
  const ul = el('ul', 'citems');
  todos.forEach((t, i) => {
    if (t.project !== p.id) return;
    const cat = Tasks.todoState(t);
    const row = el('li', 'citem ' + cat);
    const ring = el('button', `sdot ${cat}`);
    ring.title = `${STATE_LABEL[cat]} · click for ${STATE_LABEL[NEXT_STATE[cat]]}`;
    ring.onclick = () => { Tasks.setTodoState(t, NEXT_STATE[cat], Date.now()); saveTodos(); renderTasks(); renderProjects(); };
    const del = el('button', 'ic del');
    del.setAttribute('aria-label', 'Delete');
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>';
    del.onclick = () => { todos.splice(i, 1); saveTodos(); renderTasks(); renderProjects(); };
    row.append(ring, el('span', 'txt', t.t), del);
    ul.appendChild(row);
  });
  const add = el('form', 'cadd');
  const input = el('input');
  input.placeholder = 'Add an item…';
  input.id = 'cadd-' + p.id;
  add.appendChild(input);
  add.onsubmit = (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (!v) return;
    todos.push({ t: v, p: 'P2', s: 'todo', d: false, due: p.due || Todos.isoDate(Date.now()), doneAt: null, project: p.id });
    saveTodos(); renderTasks(); renderProjects();
    setTimeout(() => $('cadd-' + p.id)?.focus());
  };
  box.append(ul, add);
  return box;
}

function renderProjects() {
  const now = Date.now();
  const data = { tickets: pdata.tickets, todos };
  const all = projects.map((p) => ({ p, sum: Projects.summarize(p, data, now) }));
  const shown = all.filter((x) => !!x.p.archived === showArchived)
    .sort((a, b) => (a.sum.due || '9999').localeCompare(b.sum.due || '9999') || a.p.name.localeCompare(b.p.name));
  const L = $('plist');
  L.replaceChildren();
  if (!shown.length) L.appendChild(el('li', 'empty', showArchived ? 'No archived projects.' : 'No projects yet. A project follows an epic, a label, or a checklist of your own.'));
  for (const x of shown) L.appendChild(projectCard(x.p, x.sum, now));
  const archived = projects.filter((p) => p.archived).length;
  $('parch').hidden = !archived && !showArchived;
  $('parch').textContent = showArchived ? '← Active projects' : `Archived (${archived})`;
  $('pnew').hidden = showArchived;
  $('pboard').hidden = showArchived || !projects.some((p) => !p.archived);
  $('pfollow').hidden = showArchived || !jiraOn();
  $('prefresh').hidden = !jiraOn() || !linked();
  $('prefresh').classList.toggle('spin', pdata.loading);
  const st = $('pstate');
  st.className = 'jstate';
  st.textContent = pdata.loading ? 'Refreshing from Jira…'
    : pdata.error ? pdata.error
      : linked() && !jiraOn() ? 'Connect Jira in the Tasks tab for epic and label progress.'
        : pdata.at && linked() ? `updated ${hhmm(pdata.at)}` + (pdata.more ? ' · first 1000 tickets' : '') : '';
  if (pdata.error) st.classList.add('err');
  $('projN').textContent = projects.filter((p) => !p.archived).length;
}

// ---- project forms: one small form at a time, above the list
// fields: [{ id, label, type: 'text' | 'date' | 'select', options: [[value, text]], value, placeholder, when }]
function showForm(title, fields, submit, onSubmit) {
  const f = $('pform');
  f.replaceChildren(el('div', 'ptitle', title));
  const inputs = {};
  for (const d of fields) {
    const row = el('label', 'pfield');
    row.appendChild(el('span', '', d.label));
    let i;
    if (d.type === 'select') {
      i = el('select');
      for (const [v, t] of d.options) { const o = el('option', '', t); o.value = v; i.appendChild(o); }
    } else {
      i = el('input');
      i.type = d.type || 'text';
      i.autocomplete = 'off';
      if (d.placeholder) i.placeholder = d.placeholder;
    }
    if (d.value != null) i.value = d.value;
    inputs[d.id] = i;
    row.appendChild(i);
    row.dataset.id = d.id;
    f.appendChild(row);
  }
  const sync = () => { for (const d of fields) if (d.when) f.querySelector(`[data-id="${d.id}"]`).hidden = !d.when(inputs); };
  for (const i of Object.values(inputs)) i.oninput = sync;
  sync();
  const msg = el('p', 'jmsg');
  const btns = el('div', 'jrow');
  const cancel = el('button', 'link', 'Cancel');
  cancel.type = 'button';
  cancel.onclick = () => { f.hidden = true; };
  const ok = el('button', 'jsave', submit);
  btns.append(el('span'), el('span', 'jbtns'));
  btns.lastChild.append(cancel, ok);
  f.append(btns, msg);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const v = Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value.trim()]));
    ok.disabled = true;
    const err = await onSubmit(v);
    ok.disabled = false;
    if (err) { msg.className = 'jmsg err'; msg.textContent = err; return; }
    f.hidden = true;
  };
  f.hidden = false;
  Object.values(inputs)[0]?.focus();
}

const EPIC_KEY = /^[A-Z][A-Z0-9_]*-\d+$/;
// Checks an epic key or label typed in a form; returns [kind, value] or an error string.
function linkTarget(kind, raw) {
  if (kind === 'epic') {
    const k = raw.toUpperCase();
    return EPIC_KEY.test(k) ? ['epic', k] : 'Enter the epic\'s key, like CM-1.';
  }
  const l = raw.replace(/^#/, '');
  return l && !/\s/.test(l) ? ['label', l] : 'Enter one Jira label, without spaces.';
}

function addProject(p) {
  p.id = Projects.slug(p.name, projects.map((x) => x.id));
  projects.push(p);
  saveProjects();
  refreshProjects();
}

$('pnew').onclick = () => {
  const kinds = [['checklist', 'A checklist of your own items']];
  if (jiraOn()) kinds.push(['epic', 'A Jira epic'], ['label', 'A Jira label']);
  showForm('New project', [
    { id: 'name', label: 'Name', placeholder: 'Home office move' },
    { id: 'kind', label: 'Progress', type: 'select', options: kinds },
    { id: 'target', label: 'Linked to', placeholder: 'CM-1 or release-1.2', when: (i) => i.kind.value !== 'checklist' },
    { id: 'due', label: 'Due', type: 'date' },
  ], 'Create', (v) => {
    if (!v.name) return 'Give it a name.';
    const p = { name: v.name, kind: v.kind, due: v.due || null };
    if (v.kind !== 'checklist') {
      const t = linkTarget(v.kind, v.target);
      if (typeof t === 'string') return t;
      p[t[0]] = t[1];
    }
    addProject(p);
    if (p.kind === 'checklist') { openProjects.add(p.id); renderProjects(); setTimeout(() => $('cadd-' + p.id)?.focus()); }
    return null;
  });
};

// Someone else's epic or label, which Jira knows about.
$('pfollow').onclick = () => {
  showForm('Follow a project', [
    { id: 'kind', label: 'Follow', type: 'select', options: [['epic', 'An epic'], ['label', 'A label']] },
    { id: 'target', label: 'Linked to', placeholder: 'BIL-2 or release-1.2' },
  ], 'Follow', (v) => {
    const t = linkTarget(v.kind, v.target);
    if (typeof t === 'string') return t;
    if (projects.some((p) => p[t[0]] === t[1] && !p.archived)) return 'You already have this project.';
    addProject({ name: t[0] === 'epic' ? t[1] : '#' + t[1], kind: t[0], [t[0]]: t[1], followed: true });
    return null;
  });
};
$('parch').onclick = () => { showArchived = !showArchived; renderProjects(); };

// ---- Update board: Ally copies the projects and checklist items, the board opens, and
// one paste there saves them. Claude is not involved.
const PASTE_KEY = /Mac/.test(navigator.platform) ? '⌘V' : 'Ctrl+V';
function askBoardAddress(then) {
  showForm('Board address', [
    { id: 'url', label: 'Address', value: boardUrl, placeholder: 'https://claude.ai/artifact/…' },
  ], 'Save', async (v) => {
    const r = await window.meter.boardSet(v.url);
    if (!r.ok) return r.error;
    boardUrl = r.url;
    renderProjects();
    if (then) setTimeout(then);
    return null;
  });
}
async function updateBoard() {
  if (!boardUrl) return askBoardAddress(updateBoard);
  const r = await window.meter.boardUpdate(projects, todos);
  if (!r.ok) return notice(r.error, { error: true });
  notice(`Copied ${r.projects} project${r.projects === 1 ? '' : 's'}. On the board, click the paste box and press ${PASTE_KEY}.`, { stay: true });
}
$('pboard').onclick = updateBoard;
$('pboard').oncontextmenu = (e) => {
  e.preventDefault();
  openMenu(e, [[
    boardUrl ? { label: 'Open board', hint: '↗', run: () => window.meter.openUrl(boardUrl + '#board') } : { label: 'Open board', hint: 'no address yet', off: true },
    { label: boardUrl ? 'Change board address…' : 'Set board address…', run: () => askBoardAddress() },
  ]]);
};
$('prefresh').onclick = refreshProjects;

function projectMenu(e, p) {
  const own = !p.followed;
  const items = [
    boardUrl ? { label: 'Open its page', hint: '↗', run: () => window.meter.openUrl(`${boardUrl}#${p.id}`) } : { label: 'Open its page', hint: 'set the board first', run: () => askBoardAddress() },
  ];
  if (p.kind === 'checklist') items.push({ label: 'Edit checklist', run: () => { openProjects.add(p.id); renderProjects(); setTimeout(() => $('cadd-' + p.id)?.focus()); } });
  if (own && p.kind === 'checklist' && jiraOn()) items.push(canWrite() ? { label: 'Create a Jira epic for it', run: () => createEpicFor(p) } : { label: 'Create a Jira epic for it', hint: 'needs write access', off: true });
  if (own && jiraOn()) items.push({ label: p.kind === 'checklist' ? 'Link to an epic or label…' : 'Link to another epic or label…', run: () => linkProject(p) });
  items.push('sep', { label: 'Rename', run: () => renameProject(p) });
  if (p.followed) items.push({ label: 'Stop following', run: () => { projects.splice(projects.indexOf(p), 1); saveProjects(); renderProjects(); } });
  else items.push({ label: p.archived ? 'Unarchive' : 'Archive', run: () => { p.archived = !p.archived; saveProjects(); renderProjects(); } });
  openMenu(e, [items]);
}

function renameProject(p) {
  showForm('Rename', [{ id: 'name', label: 'Name', value: p.name }], 'Rename', (v) => {
    if (!v.name) return 'Give it a name.';
    // The id, and so the page's #name, stays: links already shared keep working.
    p.name = v.name;
    saveProjects(); renderProjects();
    return null;
  });
}

function linkProject(p) {
  showForm(`Link ${p.name}`, [
    { id: 'kind', label: 'Progress', type: 'select', options: [['epic', 'From a Jira epic'], ['label', 'From a Jira label']], value: p.kind === 'label' ? 'label' : 'epic' },
    { id: 'target', label: 'Linked to', value: p.epic || p.label || '', placeholder: 'CM-1 or release-1.2' },
  ], 'Link', (v) => {
    const t = linkTarget(v.kind, v.target);
    if (typeof t === 'string') return t;
    delete p.epic; delete p.label;
    p.kind = t[0];
    p[t[0]] = t[1];
    saveProjects(); refreshProjects();
    return null;
  });
}

// The epic, then one ticket under it for each open item; the items it made are removed.
function createEpicFor(p) {
  const open = todos.filter((t) => t.project === p.id && Tasks.todoState(t) !== 'done');
  const keys = knownProjects();
  if (!keys.length) return notice('No Jira project known yet: refresh the Tasks tab first.', { error: true });
  showForm(`Create a Jira epic for ${p.name}`, [
    { id: 'project', label: 'In', type: 'select', options: keys.map(([k, name]) => [k, `${name} (${k})`]) },
  ], open.length ? `Create epic and ${open.length} ticket${open.length > 1 ? 's' : ''}` : 'Create epic', async (v) => {
    const r = await window.meter.jiraCreate({ project: v.project, summary: p.name, due: p.due, p: 'P2', epic: true });
    if (!r.ok) return r.error;
    const epic = r.value;
    let made = 0;
    let failed = '';
    for (const t of open) {
      const c = await window.meter.jiraCreate({ project: v.project, summary: t.t, due: t.due, p: t.p, parent: epic });
      if (c.ok) { todos.splice(todos.indexOf(t), 1); made++; } else failed = c.error;
    }
    p.kind = 'epic';
    p.epic = epic;
    saveTodos(); saveProjects();
    renderTasks();
    notice(failed ? `Created ${epic} with ${made} of ${open.length} tickets. ${failed}` : `Created ${epic}` + (made ? ` with ${made} ticket${made > 1 ? 's' : ''}` : ''), { error: !!failed });
    refreshProjects();
    return null;
  });
}

// ---- Jira account form: Sign in with Atlassian first; an API token behind a link.
function jiraWay(way) {
  $('jway-oauth').hidden = way !== 'oauth';
  $('jway-token').hidden = way !== 'token';
  if (way === 'token') {
    $('jsite').focus();
    if (!jiraState.configured) suggestJira();
  }
}
function showJiraForm(show) {
  $('jform').hidden = !show;
  if (!show) return;
  $('jintro').hidden = jiraState.configured;
  $('jsites').hidden = true;
  $('jsignin').disabled = false;
  $('jsignin').textContent = jiraState.auth === 'oauth' ? 'Sign in again with Atlassian' : 'Sign in with Atlassian';
  const token = jiraState.auth === 'token';
  $('jsite').value = token && jiraState.site ? jiraState.site.replace(/^https:\/\//, '') : '';
  $('jemail').value = token ? jiraState.email || '' : '';
  $('jtoken').value = '';
  $('jtoken').placeholder = token ? 'API token (leave empty to keep it)' : 'API token';
  $('jforget').hidden = !jiraState.configured;
  $('jsave').textContent = token ? 'Save' : 'Connect';
  $('jmsg').textContent = jiraState.plain ? 'No system keychain here: Ally keeps its Jira login as plain text in ~/.ally/jira.json.' : '';
  $('jmsg').className = 'jmsg';
  jiraWay(token ? 'token' : 'oauth');
  if (!token) $('jsignin').focus();
}
$('jtoken-way').onclick = () => jiraWay('token');
$('joauth-way').onclick = () => jiraWay('oauth');

function jiraConnected(status) {
  jiraState = status;
  $('jform').hidden = true;
  jira.error = '';
  refreshTickets();
  renderJiraAccount();
  renderProjects();
  if (status.write === false) notice(NO_WRITE_NOTE, { error: true, stay: true });
}
const NO_WRITE_NOTE = 'Signed in without write access: Ally can show your tickets but not move or create them. Sign in again to allow it.';
async function jiraSignIn() {
  showTab('todo');
  if ($('jform').hidden) showJiraForm(true);
  jiraWay('oauth');
  $('jsignin').disabled = true;
  $('jsites').hidden = true;
  $('jmsg').className = 'jmsg';
  $('jmsg').textContent = 'Waiting for Atlassian in your browser…';
  const r = await window.meter.jiraSignIn();
  $('jsignin').disabled = false;
  if (!r.ok) { $('jmsg').className = 'jmsg err'; $('jmsg').textContent = r.error; return; }
  if (r.choose) {
    const pick = $('jsite-pick');
    pick.replaceChildren(...r.choose.map((x) => { const o = el('option', '', x.url.replace(/^https:\/\//, '')); o.value = x.id; return o; }));
    $('jsites').hidden = false;
    $('jmsg').textContent = 'You have several Jira sites: choose the one for Ally.';
    pick.focus();
    return;
  }
  $('jmsg').textContent = '';
  jiraConnected(r.status);
}
$('jsignin').onclick = jiraSignIn;
$('jsite-use').onclick = async () => {
  $('jsite-use').disabled = true;
  const r = await window.meter.jiraSite($('jsite-pick').value);
  $('jsite-use').disabled = false;
  if (!r.ok) { $('jmsg').className = 'jmsg err'; $('jmsg').textContent = r.error; return; }
  jiraConnected(r.status);
};
// A logged-in Atlassian CLI knows the site and email: fill them if still empty. The
// token is always yours to paste.
async function suggestJira() {
  const r = await window.meter.jiraSuggest();
  if (!r || $('jform').hidden || $('jway-token').hidden || jiraState.configured) return;
  const fill = (id, v) => { if (v && !$(id).value.trim()) { $(id).value = v; return true; } return false; };
  const site = fill('jsite', r.site);
  const email = fill('jemail', r.email);
  if (!site && !email) return;
  if (!$('jmsg').textContent) $('jmsg').textContent = `${site && email ? 'Site and email' : site ? 'Site' : 'Email'} from your acli login. Paste an API token to connect.`;
  if ($('jsite').value && $('jemail').value && document.activeElement !== $('jemail')) $('jtoken').focus();
}
$('jform').onsubmit = async (e) => {
  e.preventDefault();
  $('jsave').disabled = true;
  $('jmsg').className = 'jmsg';
  $('jmsg').textContent = 'Checking with Jira…';
  const r = await window.meter.jiraConnect({ site: $('jsite').value, email: $('jemail').value, token: $('jtoken').value });
  $('jsave').disabled = false;
  $('jtoken').value = '';
  if (!r.ok) { $('jmsg').className = 'jmsg err'; $('jmsg').textContent = r.error; return; }
  jiraConnected(r.status);
};
$('jnew').onclick = () => window.meter.openUrl(TOKEN_PAGE);
$('jcancel').onclick = () => showJiraForm(false);
$('jforget').onclick = async () => {
  jiraState = await window.meter.jiraForget();
  jira = { tickets: [], at: 0, error: '', more: false, loading: false };
  sel.scope.clear();
  showJiraForm(false);
  renderTasks();
  renderProjects();
  renderJiraAccount();
};
function renderJiraAccount() {
  const host = jiraState.site ? jiraState.site.replace(/^https:\/\//, '') : '';
  $('jwho').textContent = !jiraState.configured ? 'not connected'
    : jiraState.auth === 'oauth' ? `${host} · ${jiraState.write === false ? 'read only' : 'signed in'}`
      : `${jiraState.name || jiraState.email} · ${host}`;
  $('jedit').textContent = jiraState.configured ? 'Change' : 'Connect';
}
$('jedit').onclick = () => { showTab('todo'); showJiraForm(true); };

// Removes last week's done tasks and rolls "today" over at midnight.
setInterval(() => {
  const kept = Todos.purge(todos, Date.now());
  if (kept.length !== todos.length) { todos = kept; saveTodos(); }
  renderTasks();
  renderProjects();
}, 10 * 60 * 1000);

// ---- boot
window.meter.onSessions((list) => { sessions = list; renderSessions(); renderAsk(); });
window.meter.onUsage(renderUsage);
window.meter.onShowTab(showTab);
window.meter.init().then((s) => {
  setOpacity(s.prefs.opacity);
  $('wd').value = s.prefs.width;
  $('wdv').textContent = s.prefs.width + 'px';
  if (s.prefs.compact) w.classList.add('compact');
  if (s.nativeDrag) { head.classList.add('nativedrag'); head.onpointerdown = null; }
  sessions = s.sessions;
  todos = Todos.purge(s.todos, Date.now());
  jiraState = s.jira;
  features = { ...features, ...s.prefs.features };
  if (s.prefs.tasksView === 'matrix') view = 'matrix';
  applyFeatures();
  homeDir = s.home;
  projects = s.projects;
  boardUrl = s.boardUrl;
  pdata = { ...pdata, tickets: s.projectsData.tickets || [], at: s.projectsData.at || 0 };
  applyJira(s.jira);
  if (todos.length !== s.todos.length) saveTodos();
  $('newd').value = Todos.isoDate(Date.now());
  renderSessions();
  renderAsk();
  renderTasks();
  renderProjects();
  renderJiraAccount();
  renderUsage(s.usage);
});
