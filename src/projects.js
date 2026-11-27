'use strict';
// Projects: an epic, a label, or a checklist of todos. Stored in ~/.ally/projects.json:
//   { id, name, kind: 'epic' | 'label' | 'checklist', epic?, label?, due?, followed?, archived? }
// `id` is also the project's #name on the board page, so it stays fixed once made.
// A checklist project's items are todos whose `project` is its id.
// Shared by the renderer (as window.Projects), the main process and the tests.
(function (root) {
  const DAY = 86400000;
  // Names claude.ai keeps for itself in an artifact's address.
  const RESERVED = /^(board|settings|sidebar|customize|upgrade|downloads|comment-.*)$/;

  function slug(name, taken = []) {
    let base = String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'project';
    if (RESERVED.test(base)) base += '-project';
    let id = base;
    for (let n = 2; taken.includes(id); n++) id = `${base}-${n}`;
    return id;
  }

  // One search for every linked epic and label: the epics themselves, their children,
  // and the tickets of each label.
  function jql(projects) {
    const live = projects.filter((p) => !p.archived);
    const epics = [...new Set(live.filter((p) => p.kind === 'epic' && p.epic).map((p) => p.epic))];
    const labels = [...new Set(live.filter((p) => p.kind === 'label' && p.label).map((p) => p.label))];
    const q = (s) => `"${String(s).replace(/[\\"]/g, '\\$&')}"`;
    const parts = [];
    if (epics.length) parts.push(`key in (${epics.join(', ')})`, `parent in (${epics.join(', ')})`);
    if (labels.length) parts.push(`labels in (${labels.map(q).join(', ')})`);
    return parts.length ? parts.join(' OR ') + ' ORDER BY key ASC' : '';
  }

  const todayIso = (now) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  const daysUntil = (iso, now) => Math.round((new Date(iso + 'T00:00:00').getTime() - new Date(todayIso(now) + 'T00:00:00').getTime()) / DAY);

  // Done: everything done. Blocked: an open item is blocked. At risk: past due with work
  // left, or due within a week with more than a fifth left. Not started: nothing done or
  // under way. Otherwise on track.
  function health({ total, done, doing, blocked, due }, now) {
    if (total && done === total) return 'done';
    if (blocked) return 'blocked';
    if (due && total) {
      const left = daysUntil(due, now);
      if (left < 0 || (left <= 7 && (total - done) / total > 0.2)) return 'at-risk';
    }
    if (!done && !doing) return 'not-started';
    return 'on-track';
  }

  // tickets: as jira.projectSearch gives them: { key, cat, labels, parent, blocked, due, assignee, summary }.
  function summarize(p, { tickets = [], todos = [] }, now) {
    let items;
    let epic = null;
    if (p.kind === 'epic') {
      epic = tickets.find((t) => t.key === p.epic) || null;
      items = tickets.filter((t) => t.parent === p.epic);
    } else if (p.kind === 'label') {
      items = tickets.filter((t) => t.labels.includes(p.label));
    } else {
      items = todos.filter((t) => t.project === p.id).map((t) => ({ cat: t.s || (t.d ? 'done' : 'todo'), due: t.due, blocked: false }));
    }
    const done = items.filter((t) => t.cat === 'done').length;
    const doing = items.filter((t) => t.cat === 'doing').length;
    const blocked = items.filter((t) => t.blocked && t.cat !== 'done').length;
    // The project's own date, else the epic's, else (label) the last open ticket's.
    const openDues = items.filter((t) => t.cat !== 'done' && t.due).map((t) => t.due).sort();
    const due = p.due || epic?.due || (p.kind === 'label' ? openDues[openDues.length - 1] : null) || null;
    const s = { total: items.length, done, doing, blocked, due };
    return {
      ...s,
      health: health(s, now),
      found: p.kind !== 'epic' || !!epic,
      title: epic?.summary || '',
      owner: p.followed && epic?.assignee ? epic.assignee : null,
    };
  }

  // ---- Jira tickets, as the widget's REST search and the board's connector both give them.
  const CAT = { new: 'todo', indeterminate: 'doing', done: 'done' };
  const initials = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

  // Blocked: an open "is blocked by" link, or the Flagged field set. The connector puts
  // custom fields under fields.customFields.
  function isBlocked(f, flaggedField) {
    const flag = flaggedField && (f[flaggedField] ?? f.customFields?.[flaggedField]);
    if (Array.isArray(flag) ? flag.length : flag && typeof flag === 'object') return true;
    return (f.issuelinks || []).some((l) => {
      const t = l.type || {};
      const blocks = /^block/i.test(t.name || '') || /block|bloqu/i.test(t.inward || '');
      const by = l.inwardIssue;
      return blocks && by && (by.fields?.status?.statusCategory?.key || 'new') !== 'done';
    });
  }

  // { key, summary, cat, labels, parent, due, blocked, assignee }: what projects need.
  function ticketOf(i, { flaggedField = '', accountId = '' } = {}) {
    const f = i.fields || {};
    return {
      key: i.key,
      summary: f.summary || '',
      cat: CAT[f.status?.statusCategory?.key] || 'todo',
      labels: f.labels || [],
      parent: f.parent?.key || null,
      due: f.duedate || null,
      blocked: isBlocked(f, flaggedField),
      assignee: f.assignee ? { name: f.assignee.displayName || '', initials: initials(f.assignee.displayName), me: !!accountId && f.assignee.accountId === accountId } : null,
    };
  }

  // One page of the Atlassian connector's searchJiraIssuesUsingJql: its issues and the
  // token for the next page. It answers with issues.nodes and pageInfo, though its own
  // description says issues and nextPageToken: both are read.
  function connectorPage(payload) {
    const iss = payload?.issues;
    const nodes = Array.isArray(iss) ? iss : iss?.nodes || [];
    const info = iss?.pageInfo || {};
    return { issues: nodes, next: info.hasNextPage ? info.endCursor || null : payload?.nextPageToken || null };
  }

  // ---- Update board: what Ally hands the board, through the clipboard.
  // JSON with sorted keys: the board's db gives keys back sorted, so both sides hash this.
  function canonical(v) {
    const sort = (x) => Array.isArray(x) ? x.map(sort)
      : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] != null).map((k) => [k, sort(x[k])]))
        : x;
    return JSON.stringify(sort(v));
  }

  const keep = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] != null && o[k] !== false && o[k] !== '').map((k) => [k, o[k]]));
  const stateOf = (t) => (['todo', 'doing', 'done'].includes(t.s) ? t.s : t.d ? 'done' : 'todo');

  // Active projects, the items of checklist projects, and where their Jira is.
  // jira: { site, accountId, flaggedField }, all optional.
  function boardData({ projects = [], todos = [], jira = null }) {
    const live = projects.filter((p) => !p.archived && p.id);
    const lists = new Set(live.filter((p) => p.kind === 'checklist').map((p) => p.id));
    let site = '';
    try { site = jira?.site ? new URL(jira.site).host : ''; } catch {}
    return {
      ...keep({ site, me: jira?.accountId, flagged: jira?.flaggedField }, ['site', 'me', 'flagged']),
      projects: live.map((p) => keep(p, ['id', 'name', 'kind', 'epic', 'label', 'due', 'followed'])),
      todos: todos.filter((t) => lists.has(t.project)).map((t) => keep({ project: t.project, t: String(t.t || ''), s: stateOf(t), due: t.due }, ['project', 't', 's', 'due'])),
    };
  }

  // The board's own address, from what was pasted: https://claude.ai/artifact/<id>, nothing after.
  function boardAddress(input) {
    let u;
    try { u = new URL(String(input || '').trim()); } catch { return ''; }
    const m = /^\/artifact\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
    return u.protocol === 'https:' && u.hostname === 'claude.ai' && m ? `https://claude.ai/artifact/${m[1]}` : '';
  }

  // Active projects first, by due date (none last), then name.
  const order = (list) => [...list].sort((a, b) => !!a.archived - !!b.archived ||
    (a.due || '9999').localeCompare(b.due || '9999') || a.name.localeCompare(b.name));

  const api = { slug, jql, health, summarize, order, daysUntil, initials, isBlocked, ticketOf, connectorPage, canonical, boardData, boardAddress };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Projects = api;
})(this);
