'use strict';
// Ally's projects board, an artifact on claude.ai. #board lists every project; #<id>
// opens one. What it knows:
//   - the projects and checklist items Ally sends with Update board: Ally copies them,
//     opens #board~paste, and one paste here saves them in this page's db, private to you;
//   - epic and label tickets, read live through your Atlassian connector when the page
//     opens and when you press refresh. Nothing refreshes on its own;
//   - a one-sentence next step from Claude, asked on click, kept until the items change.
// Health and progress come from projects.js, the same code the widget uses.
(function () {
  const P = window.Projects;
  const SERVER = 'Atlassian MCP';
  const SEARCH = 'searchJiraIssuesUsingJql';
  const FIELDS = ['summary', 'status', 'parent', 'labels', 'duedate', 'assignee', 'issuelinks'];
  const HEALTH = { 'on-track': 'On track', 'at-risk': 'At risk', blocked: 'Blocked', 'not-started': 'Not started', done: 'Done' };
  const ORDER = ['blocked', 'at-risk', 'on-track', 'not-started', 'done'];
  const KINDS = ['epic', 'label', 'checklist'];
  const $ = (id) => document.getElementById(id);

  const state = {
    data: null, at: '', saved: true,
    tickets: [], ticketsAt: 0, more: false, loading: false, error: '',
    next: {}, asking: '',
  };
  let db = null;
  let me = null;
  let saving = Promise.resolve();

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  const say = (text, err) => { $('msg').textContent = text || ''; $('msg').classList.toggle('err', !!err); };
  const errText = (e) => (e && e.message) || String(e);

  async function sha256(text) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }

  // ---- dates
  const now = () => Date.now();
  const shortDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });
  function ago(t) {
    if (!t) return '';
    const ms = now() - new Date(t).getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return `${Math.round(ms / 60000)} min ago`;
    const d = new Date(t);
    return d.toDateString() === new Date().toDateString()
      ? 'today ' + d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  }
  function dueText(due, health) {
    if (!due) return null;
    const n = P.daysUntil(due, now());
    if (health === 'done') return [`Due ${shortDate(due)}`, ''];
    if (n < 0) return [`${-n} day${n === -1 ? '' : 's'} late`, 'late'];
    if (n === 0) return ['Due today', 'soon'];
    return [`Due ${shortDate(due)} · in ${n} day${n === 1 ? '' : 's'}`, n <= 7 ? 'soon' : ''];
  }

  // ---- what Ally sent: checked before it is shown or kept
  const ID = /^[a-z0-9-]{1,48}$/;
  function clean(d) {
    if (!d || !Array.isArray(d.projects) || !Array.isArray(d.todos)) return null;
    const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : undefined);
    const iso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
    const projects = d.projects.filter((p) => p && ID.test(p.id) && KINDS.includes(p.kind)).slice(0, 200).map((p) => ({
      id: p.id, name: str(p.name, 120) || p.id, kind: p.kind,
      epic: str(p.epic, 40), label: str(p.label, 120), due: iso(p.due), followed: p.followed === true,
    }));
    const todos = d.todos.filter((t) => t && ID.test(t.project)).slice(0, 5000).map((t) => ({
      project: t.project, t: str(t.t, 400) || '', s: ['todo', 'doing', 'done'].includes(t.s) ? t.s : 'todo', due: iso(t.due),
    }));
    const site = typeof d.site === 'string' && /^[a-z0-9.-]+\.atlassian\.net$/i.test(d.site) ? d.site : '';
    return { site, me: str(d.me, 128) || '', flagged: /^customfield_\d+$/.test(d.flagged || '') ? d.flagged : '', projects, todos };
  }

  // ---- storage: db, under data/users/<you>, which only you can read
  async function stores() {
    try {
      db = await claude.use('db');
      const user = await claude.use('user');
      me = user ? await user.id() : null;
    } catch { db = null; }
  }
  const ref = (name) => (db && me ? db.doc(`data/users/${me}/${name}`) : null);

  async function loadSaved() {
    const r = ref('board');
    if (!r) return;
    try {
      const [b, n] = await Promise.all([r.get(), ref('next').get()]);
      if (b.exists) {
        const env = b.data();
        const d = clean(env.data);
        if (d) { state.data = d; state.at = env.at; }
      }
      if (n.exists) state.next = { ...n.data() };
    } catch (e) { say('Your saved projects could not be read: ' + errText(e), true); }
  }

  // ---- Update board: Ally opened #board~paste with the projects on the clipboard
  function askPaste() {
    $('paste').hidden = false;
    $('pastekey').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘V' : 'Ctrl+V';
    $('pastebox').focus();
  }
  async function onPaste(e) {
    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    e.preventDefault();
    const m = $('pastemsg');
    m.className = 'msg';
    let env = null;
    try { env = JSON.parse(text); } catch {}
    const d = env && env.v === 1 && clean(env.data);
    if (!d || (await sha256(P.canonical(env.data))) !== env.sha) {
      m.className = 'msg err';
      m.textContent = 'That is not what Ally copied, or it was cut. In Ally, press Update board again, then paste here.';
      return;
    }
    state.data = d;
    state.at = env.at;
    $('paste').hidden = true;
    history.replaceState(null, '', '#board');
    state.saved = false;
    const r = ref('board');
    if (r) {
      try { await r.set({ v: 1, at: env.at, sha: env.sha, data: env.data }); state.saved = true; }
      catch (err) { say('Shown, but not kept for your next visit: ' + errText(err), true); }
    } else say('Shown, but not kept for your next visit: sign in to claude.ai to keep it.', true);
    route();
    loadTickets(true);
  }

  // ---- Jira, through the connector
  const cacheKey = (d, jql) => `ally-board:${d.site}:${jql}`;
  function readCache(d, jql) {
    try { return JSON.parse(localStorage.getItem(cacheKey(d, jql)) || 'null'); } catch { return null; }
  }
  function writeCache(d, jql, c) {
    try { localStorage.setItem(cacheKey(d, jql), JSON.stringify(c)); } catch {}
  }

  async function loadTickets(force) {
    const d = state.data;
    if (!d) return;
    const jql = P.jql(d.projects);
    if (!jql) { state.tickets = []; render(); return; }
    if (!d.site) { state.error = 'Ally did not send a Jira site: connect Jira in Ally, then press Update board.'; render(); return; }
    const c = readCache(d, jql);
    if (c) { state.tickets = c.tickets; state.ticketsAt = c.at; state.more = c.more; }
    if (state.loading) { state.again = true; render(); return; }
    if (c && !force && state.refreshed) { render(); return; }
    state.loading = true;
    state.error = '';
    render();
    try {
      const mcp = await claude.use('mcp');
      if (!mcp) throw new Error('the Atlassian connector is not available in this view');
      const tickets = [];
      let next = null;
      for (let page = 0; page < 10; page++) {
        const input = { cloudId: d.site, jql, fields: d.flagged ? [...FIELDS, d.flagged] : FIELDS, maxResults: 100 };
        if (next) input.nextPageToken = next;
        const r = await mcp.callTool(SERVER, SEARCH, input, { cache: false });
        const pg = P.connectorPage(r && r.payload);
        for (const i of pg.issues) tickets.push(P.ticketOf(i, { flaggedField: d.flagged, accountId: d.me }));
        next = pg.next;
        if (!next) break;
      }
      state.tickets = tickets;
      state.ticketsAt = now();
      state.more = !!next;
      state.refreshed = true;
      writeCache(d, jql, { tickets, at: state.ticketsAt, more: state.more });
    } catch (e) {
      state.error = `Jira could not be read: ${errText(e)}. Check that the Atlassian connector is connected in your claude.ai settings.`;
    }
    state.loading = false;
    render();
    if (state.again) { state.again = false; loadTickets(true); }
  }

  // ---- one project's items and numbers
  function itemsOf(p) {
    const d = state.data;
    if (p.kind === 'checklist') return d.todos.filter((t) => t.project === p.id).map((t) => ({ text: t.t, cat: t.s, due: t.due || null }));
    const ts = p.kind === 'epic' ? state.tickets.filter((t) => t.parent === p.epic) : state.tickets.filter((t) => t.labels.includes(p.label));
    return ts.map((t) => ({ key: t.key, text: t.summary, cat: t.cat, due: t.due, blocked: t.blocked, who: t.assignee }));
  }
  const sumOf = (p) => P.summarize(p, { tickets: state.tickets, todos: state.data.todos }, now());

  function bar(s) {
    const b = el('div', 'bar');
    b.setAttribute('role', 'img');
    b.setAttribute('aria-label', `${s.done} of ${s.total} done, ${s.doing} in progress`);
    const part = (cls, n) => { if (!n || !s.total) return; const x = el('span', cls); x.style.width = (n / s.total) * 100 + '%'; b.appendChild(x); };
    part('done', s.done);
    part('doing', s.doing);
    return b;
  }
  // Before Jira has answered, an epic or label project has no health yet.
  const pill = (p, s) => el('span', 'pill', p.kind !== 'checklist' && !state.ticketsAt ? 'Not read yet' : HEALTH[s.health]);
  function kindLine(p, s) {
    const k = el('div', 'kind');
    if (p.kind === 'epic') { k.append('Epic '); k.appendChild(el('code', '', p.epic)); }
    else if (p.kind === 'label') { k.append('Label '); k.appendChild(el('code', '', p.label)); }
    else k.append('Checklist');
    if (s.owner) k.append(` · ${s.owner.name}`);
    if (p.followed) k.append(' · following');
    return k;
  }
  function facts(p, s) {
    const f = el('div', 'facts');
    const jiraWait = p.kind !== 'checklist' && !state.ticketsAt;
    if (p.kind === 'epic' && state.ticketsAt && !s.found) f.appendChild(el('span', 'late', 'Not found in Jira'));
    else if (jiraWait) f.appendChild(el('span', '', state.loading ? 'Reading Jira…' : 'Not read from Jira yet'));
    else if (!s.total) f.appendChild(el('span', '', p.kind === 'checklist' ? 'No items yet' : 'No tickets'));
    else {
      f.appendChild(el('span', '', `${s.done} of ${s.total} done`));
      if (s.doing) f.appendChild(el('span', '', `${s.doing} in progress`));
      if (s.blocked) f.appendChild(el('span', 'blocked', `${s.blocked} blocked`));
    }
    const due = dueText(s.due, s.health);
    if (due) f.appendChild(el('span', due[1], due[0]));
    return f;
  }

  // ---- views
  function renderBoard(v) {
    const d = state.data;
    const list = d.projects.map((p) => ({ p, s: sumOf(p) }))
      .sort((a, b) => ORDER.indexOf(a.s.health) - ORDER.indexOf(b.s.health) || (a.s.due || '9999').localeCompare(b.s.due || '9999') || a.p.name.localeCompare(b.p.name));
    if (!list.length) {
      const e = el('div', 'empty');
      e.append(el('h2', '', 'No active projects'), el('p', '', 'Make one in Ally\'s Projects tab, then press Update board.'));
      v.appendChild(e);
      return;
    }
    const chips = el('div', 'chips');
    for (const h of ORDER) {
      const n = list.filter((x) => x.s.health === h).length;
      if (!n) continue;
      const c = el('span', 'chip');
      c.dataset.h = h;
      c.append(el('span', 'dot'), el('b', '', String(n)), ' ' + HEALTH[h].toLowerCase());
      chips.appendChild(c);
    }
    const grid = el('div', 'grid');
    for (const { p, s } of list) {
      const a = el('a', 'card');
      a.href = '#' + p.id;
      a.dataset.h = s.health;
      a.style.viewTransitionName = 'p-' + p.id;
      const top = el('div', 'row');
      top.append(el('h2', '', p.name), pill(p, s));
      a.append(top, kindLine(p, s), bar(s), facts(p, s));
      grid.appendChild(a);
    }
    v.append(chips, grid);
  }

  function renderProject(v, p) {
    const s = sumOf(p);
    const back = el('a', 'back', '← All projects');
    back.href = '#board';
    const head = el('section', 'head');
    head.dataset.h = s.health;
    head.style.viewTransitionName = 'p-' + p.id;
    const top = el('div', 'row');
    top.append(el('h2', '', p.name), pill(p, s));
    head.append(top, kindLine(p, s), bar(s), facts(p, s));
    v.append(back, head, nextStep(p, s));

    const items = itemsOf(p);
    const cols = el('div', 'cols');
    for (const [cat, title] of [['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']]) {
      const these = items.filter((i) => i.cat === cat)
        .sort((a, b) => !!b.blocked - !!a.blocked || (a.due || '9999').localeCompare(b.due || '9999'));
      const col = el('section', 'col');
      const h = el('h3', '', title);
      h.appendChild(el('span', '', String(these.length)));
      col.appendChild(h);
      if (!these.length) col.appendChild(el('p', 'none', 'Nothing here.'));
      const ul = el('ul', 'items');
      for (const i of these) ul.appendChild(itemRow(i));
      col.appendChild(ul);
      cols.appendChild(col);
    }
    v.appendChild(cols);
  }

  function itemRow(i) {
    const li = el('li', 'item' + (i.blocked && i.cat !== 'done' ? ' isblocked' : ''));
    li.appendChild(el('div', '', i.text || '(no title)'));
    const meta = el('div', 'meta');
    if (i.key) {
      const a = el('a', 'key', i.key);
      a.href = `https://${state.data.site}/browse/${encodeURIComponent(i.key)}`;
      a.target = '_blank';
      a.rel = 'noopener';
      meta.appendChild(a);
    }
    if (i.blocked && i.cat !== 'done') meta.appendChild(el('span', 'tag', 'Blocked'));
    if (i.due) meta.appendChild(el('span', '', 'Due ' + shortDate(i.due)));
    if (i.who) { const w = el('span', 'who', i.who.initials); w.title = i.who.name; meta.appendChild(w); }
    if (meta.childNodes.length) li.appendChild(meta);
    return li;
  }

  // ---- the next step, from Claude, on click; kept until the items change
  const fingerprint = (p) => sha256(P.canonical(itemsOf(p).map((i) => [i.key || i.text, i.cat, !!i.blocked]).sort()));

  function nextStep(p, s) {
    const box = el('section', 'next');
    box.appendChild(el('h3', '', 'Next step'));
    const text = el('p', '', '');
    const when = el('p', 'when', '');
    const acts = el('div', 'acts');
    const ask = el('button', 'btn', 'Suggest the next step');
    ask.type = 'button';
    acts.appendChild(ask);
    box.append(text, when, acts);
    const kept = state.next[p.id];
    const show = async () => {
      if (state.asking === p.id) { text.textContent = 'Thinking…'; ask.disabled = true; return; }
      if (!kept) { text.textContent = 'Claude reads this project\'s items and suggests the one thing to do next.'; return; }
      const fresh = kept.fp === (await fingerprint(p));
      text.textContent = kept.text;
      when.textContent = `Suggested ${ago(kept.at)}` + (fresh ? '' : ' · the items have changed since');
      ask.textContent = 'Suggest again';
      ask.hidden = fresh;
    };
    show();
    ask.onclick = () => suggest(p, s);
    if (p.kind !== 'checklist' && !state.ticketsAt) ask.disabled = true;
    return box;
  }

  function prompt(p, s) {
    const items = itemsOf(p).filter((i) => i.cat !== 'done').slice(0, 60).map((i) =>
      `- ${i.key ? i.key + ': ' : ''}${i.text} [${i.cat === 'doing' ? 'in progress' : 'to do'}${i.blocked ? ', blocked' : ''}${i.due ? ', due ' + i.due : ''}${i.who ? ', ' + i.who.name : ''}]`);
    const today = new Date().toISOString().slice(0, 10);
    return [
      'You help one person keep a project moving. Suggest the single most useful next step.',
      `Today: ${today}`,
      `Project: ${p.name} (${p.kind === 'checklist' ? 'a personal checklist' : p.kind === 'epic' ? 'Jira epic ' + p.epic : 'Jira label ' + p.label})`,
      `Due: ${s.due || 'no date'}. Health: ${HEALTH[s.health]}. ${s.done} of ${s.total} done, ${s.doing} in progress, ${s.blocked} blocked.`,
      'Open items:',
      items.length ? items.join('\n') : '(none)',
      '',
      'Reply with one plain sentence of at most 30 words, naming the item (and its key when it has one). No preamble, no list.',
    ].join('\n');
  }

  async function suggest(p, s) {
    const sample = await claude.use('sample');
    if (!sample) { say('Claude is not available in this view.', true); return; }
    state.asking = p.id;
    render();
    try {
      const { text } = await sample(prompt(p, s));
      state.next = { ...state.next, [p.id]: { text: text.trim(), at: new Date().toISOString(), fp: await fingerprint(p) } };
      const r = ref('next');
      // One write at a time to the same document.
      if (r) saving = saving.then(() => r.set(state.next)).catch(() => {});
    } catch (e) {
      const why = { not_granted: 'You did not allow this page to ask Claude.', rate_limited: 'Too many requests just now: try again in a while.', sampling_disabled: 'Claude is not available for this account.' }[e && e.code];
      say(why || 'No suggestion this time: ' + errText(e), true);
    }
    state.asking = '';
    render();
  }

  // ---- routing on #name, animated where the browser can
  const viewName = () => location.hash.slice(1).split('~')[0] || 'board';
  function render() {
    const v = $('view');
    v.replaceChildren();
    const d = state.data;
    $('refresh').hidden = !d || !P.jql(d.projects);
    $('refresh').disabled = state.loading;
    $('refresh').textContent = state.loading ? 'Reading Jira…' : 'Refresh from Jira';
    if (!d) {
      $('sub').textContent = 'Nothing from Ally yet';
      const e = el('div', 'empty');
      e.append(el('h2', '', 'Send your projects from Ally'),
        el('p', '', 'In Ally\'s Projects tab, press Update board. Ally copies your projects and opens this page; paste once and they stay here for your next visit.'));
      v.appendChild(e);
      return;
    }
    const parts = [`From Ally ${ago(state.at)}`];
    if (P.jql(d.projects)) parts.push(state.loading ? 'reading Jira…' : state.ticketsAt ? `Jira ${ago(state.ticketsAt)}` + (state.more ? ' (first 1000 tickets)' : '') : 'Jira not read yet');
    $('sub').textContent = parts.join(' · ');
    if (state.error) say(state.error, true);
    const name = viewName();
    const p = d.projects.find((x) => x.id === name);
    document.title = p ? `${p.name} · Ally Projects` : 'Ally Projects';
    if (name === 'board' || name === 'paste') renderBoard(v);
    else if (p) renderProject(v, p);
    else {
      const e = el('div', 'empty');
      const a = el('a', '', '← All projects');
      a.href = '#board';
      e.append(el('h2', '', `No project called #${name}`), el('p', '', 'It may be archived, or not sent yet: press Update board in Ally. '));
      e.lastChild.appendChild(a);
      v.appendChild(e);
    }
  }
  function route() {
    const go = () => { render(); scrollTo(0, 0); };
    if (document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches) document.startViewTransition(go);
    else go();
  }

  // ---- start
  async function start() {
    const pasting = /~paste$/.test(location.hash);
    if (pasting) askPaste();
    $('pastebox').addEventListener('paste', onPaste);
    addEventListener('hashchange', route);
    $('refresh').onclick = () => loadTickets(true);
    await stores();
    await loadSaved();
    render();
    loadTickets(false);
  }
  start();
})();
