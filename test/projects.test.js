'use strict';
const test = require('node:test');
const assert = require('node:assert');
const P = require('../src/projects');
const J = require('../src/jira');

// Tuesday 17 Nov 2026, noon.
const NOW = new Date(2026, 10, 17, 12).getTime();
const tk = (key, o = {}) => ({ key, summary: key, cat: 'todo', labels: [], parent: null, due: null, blocked: false, assignee: null, ...o });

test('ids are the page #name: ASCII, unique, never a name claude.ai keeps', () => {
  assert.equal(P.slug('Home office move'), 'home-office-move');
  assert.equal(P.slug('Équipe été 2026!'), 'equipe-ete-2026');
  assert.equal(P.slug('Settings'), 'settings-project');
  assert.equal(P.slug('board'), 'board-project');
  assert.equal(P.slug('Release', ['release', 'release-2']), 'release-3');
  assert.equal(P.slug('???'), 'project');
});

test('one search for every linked epic and label; checklists and archived ones need none', () => {
  assert.equal(P.jql([{ kind: 'checklist' }, { kind: 'epic', epic: 'CM-1', archived: true }]), '');
  assert.equal(P.jql([{ kind: 'epic', epic: 'CM-1' }, { kind: 'epic', epic: 'BIL-2' }, { kind: 'label', label: 'release-1.2' }, { kind: 'epic', epic: 'CM-1' }]),
    'key in (CM-1, BIL-2) OR parent in (CM-1, BIL-2) OR labels in ("release-1.2") ORDER BY key ASC');
});

test('health: done, blocked, at risk, not started, on track', () => {
  const h = (o) => P.health({ total: 10, done: 5, doing: 1, blocked: 0, due: null, ...o }, NOW);
  assert.equal(h({ done: 10 }), 'done');
  assert.equal(h({ blocked: 1 }), 'blocked');
  assert.equal(h({ due: '2026-11-16' }), 'at-risk');
  assert.equal(h({ due: '2026-11-24' }), 'at-risk');
  assert.equal(h({ due: '2026-11-24', done: 8 }), 'on-track');
  assert.equal(h({ due: '2026-11-25' }), 'on-track');
  assert.equal(h({ done: 0, doing: 0 }), 'not-started');
  assert.equal(h({}), 'on-track');
  assert.equal(P.health({ total: 0, done: 0, doing: 0, blocked: 0, due: null }, NOW), 'not-started');
});

test('an epic project: its children, its due date, and the owner when followed', () => {
  const tickets = [
    tk('BIL-2', { summary: 'Payments v2', due: '2027-01-09', assignee: { name: 'Awa Kane', initials: 'AK' } }),
    tk('BIL-3', { parent: 'BIL-2', cat: 'done' }),
    tk('BIL-4', { parent: 'BIL-2', cat: 'doing', blocked: true }),
    tk('BIL-5', { parent: 'BIL-2', cat: 'done', blocked: true }),
    tk('CM-9', { labels: ['release'] }),
  ];
  const s = P.summarize({ kind: 'epic', epic: 'BIL-2', followed: true }, { tickets }, NOW);
  assert.deepStrictEqual(s, { total: 3, done: 2, doing: 1, blocked: 1, due: '2027-01-09', health: 'blocked', found: true, title: 'Payments v2', owner: { name: 'Awa Kane', initials: 'AK' } });
  assert.equal(P.summarize({ kind: 'epic', epic: 'NOPE-1' }, { tickets }, NOW).found, false);
  assert.equal(P.summarize({ kind: 'epic', epic: 'BIL-2' }, { tickets }, NOW).owner, null);
});

test('a label project: its tickets; due is its own, else the last open ticket\'s', () => {
  const tickets = [tk('A-1', { labels: ['rel'], due: '2026-11-28' }), tk('A-2', { labels: ['rel'], due: '2026-12-02', cat: 'done' }), tk('A-3', { labels: ['rel'], due: '2026-11-20', cat: 'doing' })];
  assert.equal(P.summarize({ kind: 'label', label: 'rel' }, { tickets }, NOW).due, '2026-11-28');
  assert.equal(P.summarize({ kind: 'label', label: 'rel', due: '2026-12-31' }, { tickets }, NOW).due, '2026-12-31');
});

test('a checklist project measures its own todos', () => {
  const todos = [{ t: 'a', project: 'home', d: true }, { t: 'b', project: 'home', s: 'doing', d: false }, { t: 'c', project: 'home', d: false }, { t: 'x', d: false }];
  const s = P.summarize({ id: 'home', kind: 'checklist', due: '2026-12-20' }, { todos }, NOW);
  assert.deepStrictEqual([s.total, s.done, s.doing, s.health], [3, 1, 1, 'on-track']);
});

function fakeFetch(handler) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    const [status, body] = handler(new URL(url).pathname, opts && opts.body ? JSON.parse(opts.body) : null, calls.length);
    return { ok: status < 300, status, json: async () => body, headers: { get: () => null } };
  };
  f.calls = calls;
  return f;
}
const cfg = { site: 'https://acme.atlassian.net', email: 'e', token: 't', accountId: 'me', flaggedField: '' };

test('the projects search pages until Jira says it is the last page', async () => {
  const issue = (key) => ({ key, fields: { status: { statusCategory: { key: 'done' } }, parent: { key: 'CM-1' } } });
  const f = fakeFetch((p, body, n) => [200, n === 1 ? { issues: [issue('CM-2')], nextPageToken: 'next', isLast: false } : { issues: [issue('CM-3')], isLast: true }]);
  const r = await J.projectSearch(f, cfg, 'parent in (CM-1)');
  assert.deepStrictEqual(r.tickets.map((t) => [t.key, t.cat, t.parent]), [['CM-2', 'done', 'CM-1'], ['CM-3', 'done', 'CM-1']]);
  assert.equal(JSON.parse(f.calls[1].opts.body).nextPageToken, 'next');
  assert.equal(r.more, false);
  assert.deepStrictEqual(await J.projectSearch(f, cfg, ''), { tickets: [], more: false });
});

test('creating an epic picks the epic type; a child ticket names its parent', async () => {
  const types = { issueTypes: [{ id: '1', name: 'Épopée', hierarchyLevel: 1 }, { id: '4', name: 'Tâche', hierarchyLevel: 0 }] };
  const f = fakeFetch((p) => (p.endsWith('/issuetypes') ? [200, types] : p.includes('/issuetypes/') ? [200, { fields: [] }] : [201, { key: 'ACME-50' }]));
  assert.equal(await J.createIssue(f, cfg, { project: 'ACME', summary: 'Move', epic: true }), 'ACME-50');
  assert.deepStrictEqual(JSON.parse(f.calls[2].opts.body).fields.issuetype, { id: '1' });
  await J.createIssue(f, cfg, { project: 'ACME', summary: 'Desk', parent: 'ACME-50' });
  const child = JSON.parse(f.calls[5].opts.body).fields;
  assert.deepStrictEqual([child.issuetype, child.parent], [{ id: '4' }, { key: 'ACME-50' }]);
});

test('a ticket reads the same from the REST search and from the connector', () => {
  const fields = { summary: 'Retry', status: { statusCategory: { key: 'indeterminate' } }, labels: ['mvp2'], parent: { key: 'CM-1' }, duedate: '2026-11-20', assignee: { displayName: 'Awa Kane', accountId: 'me' } };
  const t = P.ticketOf({ key: 'CM-2', fields }, { accountId: 'me' });
  assert.deepStrictEqual(t, { key: 'CM-2', summary: 'Retry', cat: 'doing', labels: ['mvp2'], parent: 'CM-1', due: '2026-11-20', blocked: false, assignee: { name: 'Awa Kane', initials: 'AK', me: true } });
  // A field left out is empty; the connector puts custom fields under customFields.
  assert.deepStrictEqual(P.ticketOf({ key: 'CM-3', fields: {} }), { key: 'CM-3', summary: '', cat: 'todo', labels: [], parent: null, due: null, blocked: false, assignee: null });
  assert.equal(P.ticketOf({ key: 'CM-4', fields: { customFields: { customfield_10021: [{ value: 'Impediment' }] } } }, { flaggedField: 'customfield_10021' }).blocked, true);
});

test('a connector page: issues.nodes and pageInfo, or issues and nextPageToken', () => {
  assert.deepStrictEqual(P.connectorPage({ issues: { nodes: [{ key: 'A-1' }], pageInfo: { hasNextPage: true, endCursor: 'c2' } } }), { issues: [{ key: 'A-1' }], next: 'c2' });
  assert.deepStrictEqual(P.connectorPage({ issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: 'x' } } }), { issues: [], next: null });
  assert.deepStrictEqual(P.connectorPage({ issues: [{ key: 'B-1' }], nextPageToken: 't' }), { issues: [{ key: 'B-1' }], next: 't' });
  assert.deepStrictEqual(P.connectorPage(null), { issues: [], next: null });
});

test('Update board: active projects, checklist items, the Jira site; nothing else', () => {
  const projects = [
    { id: 'home', name: 'Home office', kind: 'checklist', due: '2026-12-20' },
    { id: 'pay', name: 'Payments', kind: 'epic', epic: 'BIL-2', due: null, followed: true },
    { id: 'old', name: 'Old', kind: 'checklist', archived: true },
  ];
  const todos = [
    { t: 'Desk', p: 'P2', s: 'doing', d: false, due: '2026-12-01', doneAt: null, project: 'home' },
    { t: 'Chair', d: true, project: 'home' },
    { t: 'Old item', s: 'todo', project: 'old' },
    { t: 'Dentist', s: 'todo' },
  ];
  const d = P.boardData({ projects, todos, jira: { site: 'https://acme.atlassian.net', accountId: 'acc', flaggedField: '', token: 'secret', email: 'e@x' } });
  assert.deepStrictEqual(d, {
    site: 'acme.atlassian.net', me: 'acc',
    projects: [{ id: 'home', name: 'Home office', kind: 'checklist', due: '2026-12-20' }, { id: 'pay', name: 'Payments', kind: 'epic', epic: 'BIL-2', followed: true }],
    todos: [{ project: 'home', t: 'Desk', s: 'doing', due: '2026-12-01' }, { project: 'home', t: 'Chair', s: 'done' }],
  });
  assert.ok(!JSON.stringify(d).includes('secret'));
  assert.deepStrictEqual(P.boardData({ projects: [], todos: [] }), { projects: [], todos: [] });
});

test('the hash both sides compute survives db sorting the keys', () => {
  const crypto = require('crypto');
  const h = (v) => crypto.createHash('sha256').update(P.canonical(v)).digest('hex');
  const sent = { projects: [{ id: 'a', name: 'A', kind: 'checklist' }], todos: [{ t: 'x', s: 'todo', project: 'a' }] };
  const back = { todos: [{ project: 'a', s: 'todo', t: 'x' }], projects: [{ kind: 'checklist', id: 'a', name: 'A' }] };
  assert.equal(h(sent), h(back));
  assert.notEqual(h(sent), h({ ...back, todos: [{ project: 'a', s: 'done', t: 'x' }] }));
  assert.equal(P.canonical({ b: 1, a: [{ d: 2, c: null }] }), '{"a":[{"d":2}],"b":1}');
});

test('the board address is a claude.ai artifact link, kept without its #name', () => {
  assert.equal(P.boardAddress(' https://claude.ai/artifact/AbCdEf123_-x#board~paste '), 'https://claude.ai/artifact/AbCdEf123_-x');
  assert.equal(P.boardAddress('https://claude.ai/artifact/abc?x=1'), 'https://claude.ai/artifact/abc');
  assert.equal(P.boardAddress('http://claude.ai/artifact/abc'), '');
  assert.equal(P.boardAddress('https://evil.example/artifact/abc'), '');
  assert.equal(P.boardAddress('https://claude.ai/chat/abc'), '');
  assert.equal(P.boardAddress('nonsense'), '');
});
