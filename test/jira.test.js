'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const J = require('../src/jira');
const C = require('../src/jira-config');

const SITE = 'https://acme.atlassian.net';
const issue = (key, fields) => ({ key, fields: { summary: key + ' title', status: { name: 'En cours', statusCategory: { key: 'indeterminate' } }, ...fields } });

test('site: a name, a host or a pasted link give the https site; other http is refused', () => {
  assert.equal(J.siteUrl('acme'), SITE);
  assert.equal(J.siteUrl(' acme.atlassian.net '), SITE);
  assert.equal(J.siteUrl('https://acme.atlassian.net/browse/X-1?y=2'), SITE);
  assert.equal(J.siteUrl('http://acme.atlassian.net'), '');
  assert.equal(J.siteUrl('http://127.0.0.1:8123'), 'http://127.0.0.1:8123');
  assert.equal(J.siteUrl(''), '');
});

test('JQL: only the tickets assigned to you, done ones for a week only', () => {
  assert.equal(J.buildJql(), 'assignee = currentUser() AND (statusCategory != Done OR statusCategoryChangedDate >= -7d) ORDER BY updated DESC');
});

test('priority: default scheme by id, other schemes by name', () => {
  assert.equal(J.priorityOf({ id: '1', name: 'Highest' }), 'P1');
  assert.equal(J.priorityOf({ id: '2', name: 'High' }), 'P1');
  assert.equal(J.priorityOf({ id: '3', name: 'Medium' }), 'P2');
  assert.equal(J.priorityOf({ id: '5', name: 'Lowest' }), 'P3');
  assert.equal(J.priorityOf({ id: '10001', name: 'Critique' }), 'P1');
  assert.equal(J.priorityOf({ id: '10002', name: 'Minor' }), 'P3');
  assert.equal(J.priorityOf(null), 'P2');
});

test('a ticket keeps only what the list shows; missing fields are empty', () => {
  const t = J.normalize(issue('ACME-1', {
    priority: { id: '2', name: 'High' }, duedate: '2026-11-20', labels: ['mvp2'],
    assignee: { accountId: 'other', displayName: 'Awa Kane' }, watches: { isWatching: true }, project: { name: 'Acme' },
  }), 'me', SITE, '');
  assert.deepStrictEqual(t, {
    kind: 'jira', key: 'ACME-1', summary: 'ACME-1 title', url: `${SITE}/browse/ACME-1`, status: 'En cours', cat: 'doing',
    p: 'P1', priority: 'High', due: '2026-11-20', assignee: { name: 'Awa Kane', initials: 'AK', me: false },
    labels: ['mvp2'], watching: true, blocked: false, project: 'Acme',
  });
  const bare = J.normalize({ key: 'ACME-2', fields: {} }, 'me', SITE, '');
  assert.equal(bare.due, null);
  assert.equal(bare.assignee, null);
  assert.equal(bare.cat, 'todo');
});

test('blocked: an open "is blocked by" link or the Flagged field', () => {
  const by = (cat) => ({ type: { name: 'Blocks', inward: 'is blocked by' }, inwardIssue: { fields: { status: { statusCategory: { key: cat } } } } });
  assert.equal(J.isBlocked({ issuelinks: [by('indeterminate')] }, ''), true);
  assert.equal(J.isBlocked({ issuelinks: [by('done')] }, ''), false);
  // The ticket blocks another one: not blocked itself.
  assert.equal(J.isBlocked({ issuelinks: [{ type: { name: 'Blocks' }, outwardIssue: {} }] }, ''), false);
  assert.equal(J.isBlocked({ issuelinks: [{ type: { name: 'Relates' }, inwardIssue: {} }] }, ''), false);
  assert.equal(J.isBlocked({ customfield_10021: [{ value: 'Impediment' }] }, 'customfield_10021'), true);
  assert.equal(J.isBlocked({ customfield_10021: null }, 'customfield_10021'), false);
});

// A stand-in for fetch that answers by path and records the requests.
function fakeFetch(routes) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url, opts });
    const path = new URL(url).pathname;
    const [status, body, headers = {}] = routes[path] || [404, {}];
    return { ok: status < 300, status, json: async () => body, headers: { get: (h) => headers[h.toLowerCase()] || null } };
  };
  f.calls = calls;
  return f;
}
const cfg = { site: SITE, email: 'me@acme.io', token: 'tok', accountId: 'me', labels: ['mvp2'], flaggedField: 'customfield_10021' };

test('connect learns who I am and the Flagged field', async () => {
  const f = fakeFetch({
    '/rest/api/3/myself': [200, { accountId: 'me', displayName: 'Ada Kane' }],
    '/rest/api/3/field': [200, [{ id: 'summary', name: 'Summary' }, { id: 'customfield_10021', name: 'Flagged' }]],
  });
  assert.deepStrictEqual(await J.connect(f, cfg), { accountId: 'me', name: 'Ada Kane', flaggedField: 'customfield_10021' });
  assert.equal(f.calls[0].opts.headers.Authorization, 'Basic ' + Buffer.from('me@acme.io:tok').toString('base64'));
});

test('search: one POST with the JQL and only the shown fields, at most 100', async () => {
  const f = fakeFetch({ '/rest/api/3/search/jql': [200, { issues: [issue('ACME-1', { assignee: { accountId: 'me', displayName: 'Ada Kane' } })], isLast: false }] });
  const r = await J.search(f, cfg);
  const body = JSON.parse(f.calls[0].opts.body);
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.equal(body.jql, J.buildJql());
  assert.equal(body.maxResults, 100);
  assert.ok(body.fields.includes('customfield_10021') && !body.fields.includes('description'));
  assert.equal(r.tickets[0].assignee.me, true);
  assert.equal(r.more, true);
});

test('errors say what to fix', async () => {
  const msg = async (routes) => { try { await J.search(fakeFetch(routes), cfg); } catch (e) { return e.message; } };
  assert.equal(await msg({ '/rest/api/3/search/jql': [401, {}] }), 'Jira refused the email or API token.');
  assert.equal(await msg({}), 'No Jira site at acme.atlassian.net.');
  assert.equal(await msg({ '/rest/api/3/search/jql': [429, {}, { 'retry-after': '30' }] }), 'Jira asks to wait 30 s before the next refresh.');
  assert.equal(await msg({ '/rest/api/3/search/jql': [400, { errorMessages: ['Bad JQL.'] }] }), 'Bad JQL.');
  const down = async () => { throw new Error('ENOTFOUND'); };
  await assert.rejects(J.search(down, cfg), /Could not reach acme.atlassian.net/);
});

test('the token is stored encrypted, never shown to the widget', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ally-jira-')), 'jira.json');
  const crypt = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('enc:' + s), decryptString: (b) => b.toString().slice(4) };
  C.save(file, { ...cfg, token: 'secret' }, crypt);
  assert.ok(!fs.readFileSync(file, 'utf8').includes('"secret"'));
  const back = C.load(file, crypt);
  assert.equal(back.token, 'secret');
  assert.equal(back.plain, false);
  assert.ok(!JSON.stringify(C.status(back)).includes('secret'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('without a keychain the token is kept as plain text and flagged', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ally-jira-')), 'jira.json');
  const none = { isEncryptionAvailable: () => false };
  C.save(file, { ...cfg, token: 'secret' }, none);
  const back = C.load(file, none);
  assert.equal(back.token, 'secret');
  assert.equal(C.status(back).plain, true);
  assert.equal(C.load(path.join(path.dirname(file), 'none.json'), none), null);
});

test('moves: the allowed transitions with their target status', async () => {
  const f = fakeFetch({ '/rest/api/3/issue/ACME-1/transitions': [200, { transitions: [
    { id: '21', name: 'Start', to: { name: 'En cours', statusCategory: { key: 'indeterminate' } } },
    { id: '31', name: 'Done', to: { name: 'Terminé', statusCategory: { key: 'done' } } },
  ] }] });
  assert.deepStrictEqual(await J.transitions(f, cfg, 'ACME-1'), [
    { id: '21', name: 'Start', to: 'En cours', cat: 'doing' },
    { id: '31', name: 'Done', to: 'Terminé', cat: 'done' },
  ]);
  const g = fakeFetch({ '/rest/api/3/issue/ACME-1/transitions': [204, null] });
  assert.equal(await J.transition(g, cfg, 'ACME-1', '31'), null);
  assert.deepStrictEqual(JSON.parse(g.calls[0].opts.body), { transition: { id: '31' } });
});

test('follow is a Jira watch: POST my account id as a JSON string, DELETE to stop', async () => {
  const f = fakeFetch({ '/rest/api/3/issue/ACME-1/watchers': [204, null] });
  await J.watch(f, cfg, 'ACME-1', true);
  await J.watch(f, cfg, 'ACME-1', false);
  assert.equal(f.calls[0].opts.method, 'POST');
  assert.equal(f.calls[0].opts.body, '"me"');
  assert.equal(f.calls[1].opts.method, 'DELETE');
  assert.match(f.calls[1].url, /watchers\?accountId=me$/);
});

test('ticket detail for the planning prompt: rich text as plain text, links named', async () => {
  const description = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Retry ' }, { type: 'mention', attrs: { text: '@Awa' } }] },
    { type: 'bulletList', content: [{ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] }] },
  ] };
  const f = fakeFetch({ '/rest/api/3/issue/ACME-1': [200, { key: 'ACME-1', fields: {
    summary: 'Hook', status: { name: 'À faire' }, priority: { id: '3', name: 'Medium' }, description,
    issuelinks: [{ type: { inward: 'is blocked by', outward: 'blocks' }, outwardIssue: { key: 'ACME-2' } }, { type: { inward: 'is blocked by' }, inwardIssue: { key: 'ACME-0' } }],
    project: { key: 'ACME', name: 'Acme' }, parent: { key: 'ACME-100', fields: { summary: 'Payments' } },
  } }] });
  const d = await J.issueDetail(f, cfg, 'ACME-1');
  assert.equal(d.description, 'Retry @Awa\n- one');
  assert.deepStrictEqual(d.links, ['blocks ACME-2', 'is blocked by ACME-0']);
  assert.deepStrictEqual(d.project, { key: 'ACME', name: 'Acme' });
  assert.equal(d.parent, 'ACME-100 Payments');
});

test('send to Jira: a Task, assigned to me, only fields on the create screen', async () => {
  const types = '/rest/api/3/issue/createmeta/ACME/issuetypes';
  const f = fakeFetch({
    [types]: [200, { issueTypes: [{ id: '1', name: 'Epic', hierarchyLevel: 1 }, { id: '2', name: 'Sub-task', subtask: true }, { id: '3', name: 'Bug' }, { id: '4', name: 'Tâche' }] }],
    [types + '/4']: [200, { fields: [{ fieldId: 'summary' }, { fieldId: 'assignee' }, { fieldId: 'priority', allowedValues: [{ id: '2', name: 'High' }, { id: '3', name: 'Medium' }, { id: '4', name: 'Low' }] }] }],
    '/rest/api/3/issue': [201, { key: 'ACME-77' }],
  });
  assert.equal(await J.createIssue(f, cfg, { project: 'ACME', summary: 'Book', due: '2026-11-20', p: 'P1' }), 'ACME-77');
  assert.deepStrictEqual(JSON.parse(f.calls[2].opts.body).fields, {
    project: { key: 'ACME' }, issuetype: { id: '4' }, summary: 'Book', assignee: { accountId: 'me' }, priority: { id: '2' },
  });
});

test('matrix drag: one PUT with the priority by name and the due date; nothing to send, no call', async () => {
  const f = fakeFetch({ '/rest/api/3/issue/ACME-1': [204, null] });
  assert.equal(await J.editIssue(f, cfg, 'ACME-1', { priority: 'High', due: '2026-12-01' }), null);
  assert.equal(f.calls[0].opts.method, 'PUT');
  assert.deepStrictEqual(JSON.parse(f.calls[0].opts.body), { fields: { priority: { name: 'High' }, duedate: '2026-12-01' } });
  await J.editIssue(f, cfg, 'ACME-1', { due: '' });
  assert.deepStrictEqual(JSON.parse(f.calls[1].opts.body), { fields: { duedate: null } });
  await J.editIssue(f, cfg, 'ACME-1', {});
  assert.equal(f.calls.length, 2);
});
