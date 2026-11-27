'use strict';
// Jira Cloud, read straight from its REST API with the person's API token: no Claude
// tokens. One search per refresh, only when asked (tab opened or refresh pressed).
// The functions take `fetch` as an argument so the tests can run them without a network.

const { initials, isBlocked, ticketOf } = require('./projects');
const atlassian = require('./atlassian');

const FIELDS = ['summary', 'status', 'priority', 'duedate', 'assignee', 'labels', 'issuelinks', 'watches', 'project'];
const MAX = 100;
const CAT = { new: 'todo', indeterminate: 'doing', done: 'done' };

// "acme", "acme.atlassian.net" or a pasted Jira link all mean https://acme.atlassian.net.
// Plain http is only accepted on this computer, for tests.
function siteUrl(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + (/[.:]/.test(s) ? s : s + '.atlassian.net');
  let u;
  try { u = new URL(s); } catch { return ''; }
  const local = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return '';
  return `${u.protocol}//${u.host}`;
}

// Your tickets: the ones assigned to you. Done tickets only for a week, so the Done chip
// shows recent work without growing forever.
const buildJql = () => 'assignee = currentUser() AND (statusCategory != Done OR statusCategoryChangedDate >= -7d) ORDER BY updated DESC';

// The default priority scheme's ids are 1 (Highest) to 5 (Lowest). Other schemes are
// matched by name, in English and French.
function priorityOf(p) {
  if (!p) return 'P2';
  const id = Number(p.id);
  if (id >= 1 && id <= 5 && /^(highest|high|medium|low|lowest|la plus haute|haute|moyenne|basse|la plus basse)$/i.test(p.name || '')) {
    return id <= 2 ? 'P1' : id === 3 ? 'P2' : 'P3';
  }
  const n = (p.name || '').toLowerCase();
  if (/highest|high|critical|blocker|urgent|haute|critique|bloquant/.test(n)) return 'P1';
  if (/low|minor|trivial|basse|mineur/.test(n)) return 'P3';
  return 'P2';
}

// Only what the Tasks tab shows. A field Jira leaves out (no due date, no assignee) is empty.
function normalize(issue, me, site, flaggedField) {
  const f = issue.fields || {};
  const status = f.status || {};
  const a = f.assignee;
  return {
    kind: 'jira',
    key: issue.key,
    summary: f.summary || '',
    url: `${site}/browse/${issue.key}`,
    status: status.name || '',
    cat: CAT[status.statusCategory?.key] || 'todo',
    p: priorityOf(f.priority),
    priority: f.priority?.name || '',
    due: f.duedate || null,
    assignee: a ? { name: a.displayName || '', initials: initials(a.displayName), me: a.accountId === me } : null,
    labels: f.labels || [],
    watching: !!f.watches?.isWatching,
    blocked: isBlocked(f, flaggedField),
    project: f.project?.name || '',
  };
}

class JiraError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

async function request(fetchImpl, cfg, method, path, body) {
  // Signed in with Atlassian: the same request, made through Atlassian's MCP server.
  if (cfg.auth === 'oauth') {
    try { return await atlassian.rest(cfg.conn, cfg.cloudId, method, path, body); }
    catch (e) { throw new JiraError(e.message, e.status || 0); }
  }
  const auth = 'Basic ' + Buffer.from(`${cfg.email}:${cfg.token}`).toString('base64');
  let res;
  try {
    res = await fetchImpl(cfg.site + path, {
      method,
      headers: { Authorization: auth, Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new JiraError(`Could not reach ${new URL(cfg.site).host}.`, 0);
  }
  // Moves and watches answer 204 with no body.
  if (res.ok) return res.status === 204 ? null : res.json().catch(() => null);
  let detail = '';
  try { const j = await res.json(); detail = [...(j.errorMessages || []), ...Object.values(j.errors || {})].join(' '); } catch {}
  const host = new URL(cfg.site).host;
  const msg = {
    401: 'Jira refused the email or API token.',
    403: `This account has no access to Jira on ${host}.`,
    404: `No Jira site at ${host}.`,
    429: `Jira asks to wait${res.headers.get('retry-after') ? ` ${res.headers.get('retry-after')} s` : ''} before the next refresh.`,
  }[res.status] || detail || `Jira answered ${res.status}.`;
  throw new JiraError(msg, res.status);
}

// Checks the account and learns what later searches need: who "me" is, and the
// Flagged field's id (it differs per site).
async function connect(fetchImpl, cfg) {
  const me = await request(fetchImpl, cfg, 'GET', '/rest/api/3/myself');
  let flaggedField = '';
  try {
    const fields = await request(fetchImpl, cfg, 'GET', '/rest/api/3/field');
    flaggedField = (fields.find((x) => /^(flagged|signalé)$/i.test(x.name || '')) || {}).id || '';
  } catch {}
  return { accountId: me.accountId, name: me.displayName || '', flaggedField };
}

async function search(fetchImpl, cfg) {
  const fields = cfg.flaggedField ? [...FIELDS, cfg.flaggedField] : FIELDS;
  const r = await request(fetchImpl, cfg, 'POST', '/rest/api/3/search/jql', { jql: buildJql(), fields, maxResults: MAX });
  return {
    tickets: (r.issues || []).map((i) => normalize(i, cfg.accountId, cfg.site, cfg.flaggedField)),
    more: r.isLast === false || !!r.nextPageToken,
  };
}

// ---- Actions, each fetched or sent only when a menu item is used.
const enc = encodeURIComponent;

// The moves this ticket's workflow allows from its current status.
async function transitions(fetchImpl, cfg, key) {
  const r = await request(fetchImpl, cfg, 'GET', `/rest/api/3/issue/${enc(key)}/transitions`);
  return (r.transitions || []).map((t) => ({
    id: t.id, name: t.name, to: t.to?.name || t.name, cat: CAT[t.to?.statusCategory?.key] || 'todo',
  }));
}

const transition = (fetchImpl, cfg, key, id) =>
  request(fetchImpl, cfg, 'POST', `/rest/api/3/issue/${enc(key)}/transitions`, { transition: { id } });

// Following a ticket is Jira's own Watch, so it is the same in Jira and here.
const watch = (fetchImpl, cfg, key, on) => (on
  ? request(fetchImpl, cfg, 'POST', `/rest/api/3/issue/${enc(key)}/watchers`, cfg.accountId)
  : request(fetchImpl, cfg, 'DELETE', `/rest/api/3/issue/${enc(key)}/watchers?accountId=${enc(cfg.accountId)}`));

// The Matrix view's drag: a new priority (by name) and/or due date ('' or null clears it).
function editIssue(fetchImpl, cfg, key, { priority, due } = {}) {
  const fields = {};
  if (priority) fields.priority = { name: priority };
  if (due !== undefined) fields.duedate = due || null;
  if (!Object.keys(fields).length) return Promise.resolve(null);
  return request(fetchImpl, cfg, 'PUT', `/rest/api/3/issue/${enc(key)}`, { fields });
}

// Jira's rich text (ADF) as plain text, for the planning prompt.
function adfText(node) {
  if (!node || typeof node !== 'object') return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.type === 'mention' || node.type === 'emoji') return node.attrs?.text || '';
  if (node.type === 'inlineCard') return node.attrs?.url || '';
  const inner = (node.content || []).map(adfText).join('');
  if (node.type === 'listItem') return '- ' + inner.trim() + '\n';
  if (['paragraph', 'heading', 'codeBlock', 'blockquote', 'rule', 'mediaSingle'].includes(node.type)) return inner + '\n';
  return inner;
}

function linkText(l) {
  if (l.outwardIssue) return `${l.type?.outward || 'relates to'} ${l.outwardIssue.key}`;
  if (l.inwardIssue) return `${l.type?.inward || 'relates to'} ${l.inwardIssue.key}`;
  return '';
}

// One read, at the click on Plan with Claude: what the terminal needs so Claude does not fetch it.
async function issueDetail(fetchImpl, cfg, key) {
  const fields = 'summary,status,priority,duedate,description,issuelinks,labels,parent,project,issuetype';
  const r = await request(fetchImpl, cfg, 'GET', `/rest/api/3/issue/${enc(key)}?fields=${fields}`);
  const f = r.fields || {};
  return {
    key: r.key,
    summary: f.summary || '',
    status: f.status?.name || '',
    p: priorityOf(f.priority),
    due: f.duedate || null,
    type: f.issuetype?.name || '',
    labels: f.labels || [],
    parent: f.parent ? `${f.parent.key} ${f.parent.fields?.summary || ''}`.trim() : '',
    project: { key: f.project?.key || String(key).split('-')[0], name: f.project?.name || '' },
    // Atlassian sign-in gives the description as markdown text, the REST API as ADF.
    description: (typeof f.description === 'string' ? f.description : adfText(f.description)).replace(/\n{3,}/g, '\n\n').trim(),
    links: (f.issuelinks || []).map(linkText).filter(Boolean),
  };
}

// Send to Jira: a todo becomes a ticket in the chosen project, assigned to me.
// `epic: true` makes an epic instead; `parent` puts the ticket under an epic.
// Only fields on the project's create screen are sent, so no screen refuses the ticket.
async function createIssue(fetchImpl, cfg, { project, summary, due, p, epic = false, parent }) {
  const base = `/rest/api/3/issue/createmeta/${enc(project)}/issuetypes`;
  const types = await request(fetchImpl, cfg, 'GET', base);
  const all = (types.issueTypes || types.values || []).filter((t) => !t.subtask);
  // Through Atlassian sign-in the types carry no hierarchy level: an epic is told by its name.
  const EPIC = /^(epic|épopée)$/i;
  const leveled = all.some((t) => t.hierarchyLevel != null);
  const list = leveled ? all.filter((t) => (t.hierarchyLevel ?? 0) === (epic ? 1 : 0)) : all.filter((t) => EPIC.test(t.name) === epic);
  const type = (epic ? list.find((t) => EPIC.test(t.name)) : list.find((t) => /^(task|tâche)$/i.test(t.name))) || list[0];
  if (!type) throw new JiraError(`Project ${project} has no ${epic ? 'epic' : 'ticket'} type you can create.`, 400);
  const meta = await request(fetchImpl, cfg, 'GET', `${base}/${enc(type.id)}`);
  const onScreen = new Map((meta.fields || meta.values || []).map((m) => [m.fieldId || m.key, m]));
  // Atlassian sign-in creates by type and priority name; the REST API takes ids.
  const named = cfg.auth === 'oauth';
  const fields = { project: { key: project }, issuetype: named ? { id: type.id, name: type.name } : { id: type.id }, summary };
  if (due && onScreen.has('duedate')) fields.duedate = due;
  if (onScreen.has('assignee')) fields.assignee = { accountId: cfg.accountId };
  const prios = onScreen.get('priority')?.allowedValues || [];
  const prio = prios.find((x) => priorityOf(x) === p && (p !== 'P2' || String(x.id) === '3')) || prios.find((x) => priorityOf(x) === p);
  if (prio) fields.priority = named ? { id: prio.id, name: prio.name } : { id: prio.id };
  if (parent) fields.parent = { key: parent };
  const r = await request(fetchImpl, cfg, 'POST', '/rest/api/3/issue', { fields });
  return r.key;
}

// The Projects tab's one search: every linked epic, its children, and each label's
// tickets, with only what progress needs. Paged, at most 1000 tickets.
const PROJECT_FIELDS = ['summary', 'status', 'labels', 'parent', 'duedate', 'issuelinks', 'assignee'];
async function projectSearch(fetchImpl, cfg, jql) {
  if (!jql) return { tickets: [], more: false };
  const fields = cfg.flaggedField ? [...PROJECT_FIELDS, cfg.flaggedField] : PROJECT_FIELDS;
  const tickets = [];
  let token;
  for (let page = 0; page < 10; page++) {
    const r = await request(fetchImpl, cfg, 'POST', '/rest/api/3/search/jql', { jql, fields, maxResults: MAX, ...(token ? { nextPageToken: token } : {}) });
    for (const i of r.issues || []) tickets.push(ticketOf(i, cfg));
    token = r.nextPageToken;
    if (r.isLast !== false || !token) return { tickets, more: false };
  }
  return { tickets, more: true };
}

module.exports = {
  siteUrl, buildJql, priorityOf, initials, isBlocked, normalize, connect, search, JiraError, MAX,
  transitions, transition, watch, editIssue, adfText, issueDetail, createIssue, projectSearch,
};
