'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../src/atlassian');
const J = require('../src/jira');
const C = require('../src/jira-config');
const { fakeAtlassian } = require('./fake-atlassian');

// What the browser does when you click Allow: follow Atlassian's redirect back to Ally.
const browser = (url) => fetch(url, { redirect: 'follow' }).then((r) => r.text());

test('sign-in finds the server, registers without a secret, and proves the code with PKCE', async () => {
  const f = await fakeAtlassian();
  try {
    const auth = await A.signIn({ open: browser, mcpUrl: f.mcp });
    assert.equal(auth.clientId, 'client-1');
    assert.ok(auth.access && auth.refresh && auth.expiresAt > Date.now());
    assert.equal(auth.tokenEndpoint, `${f.base}/oauth/token`);
    assert.ok(A.canWrite(auth.scopes));
    const reg = f.state.registered[0];
    assert.equal(reg.token_endpoint_auth_method, 'none');
    assert.match(reg.redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    assert.ok(reg.scope.split(' ').includes(A.WRITE));
  } finally { await f.close(); }
});

test('declining on Atlassian\'s page says so', async () => {
  const f = await fakeAtlassian({ deny: true });
  try {
    await assert.rejects(A.signIn({ open: browser, mcpUrl: f.mcp }), /did not allow Ally/);
  } finally { await f.close(); }
});

test('a refused access token is renewed once, and the new refresh token is kept', async () => {
  const f = await fakeAtlassian();
  try {
    const auth = await A.signIn({ open: browser, mcpUrl: f.mcp });
    const kept = [];
    const conn = new A.Connection({ auth, onTokens: (t) => kept.push(t.refresh) });
    assert.deepStrictEqual(await A.sites(conn), [{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }]);
    f.state.expire = true;
    assert.deepStrictEqual(await conn.tool('atlassianUserInfo', {}), { accountId: 'me' });
    assert.equal(kept.length, 1);
    assert.notEqual(kept[0], auth.refresh);
    // The old refresh token was used up; the new one renews again.
    const again = new A.Connection({ auth: { ...auth, access: '', refresh: kept[0] } });
    assert.deepStrictEqual(await again.tool('atlassianUserInfo', {}), { accountId: 'me' });
  } finally { await f.close(); }
});

test('a sign-in that cannot be renewed asks to sign in again', async () => {
  const f = await fakeAtlassian();
  try {
    const auth = await A.signIn({ open: browser, mcpUrl: f.mcp });
    const conn = new A.Connection({ auth: { ...auth, access: '', refresh: 'used-up' } });
    await assert.rejects(conn.tool('atlassianUserInfo', {}), /sign-in has ended/);
  } finally { await f.close(); }
});

test('each request Ally makes has its MCP tool; anything else is refused', () => {
  assert.deepStrictEqual(A.route('GET', '/rest/api/3/myself'), { tool: 'atlassianUserInfo', args: {} });
  assert.deepStrictEqual(A.route('GET', '/rest/api/3/issue/AC-1/transitions'), { tool: 'executeRead', args: { name: 'listJiraIssueTransitions', inputs: { issueIdOrKey: 'AC-1' } } });
  assert.deepStrictEqual(A.route('POST', '/rest/api/3/issue/AC-1/transitions', { transition: { id: 31 } }), { tool: 'transitionJiraIssue', args: { issueIdOrKey: 'AC-1', transitionId: '31' }, write: 'transition' });
  assert.deepStrictEqual(A.route('PUT', '/rest/api/3/issue/AC-1', { fields: { priority: { name: 'High' } } }), { tool: 'editJiraIssue', args: { issueIdOrKey: 'AC-1', fields: { priority: { name: 'High' } } }, write: 'edit' });
  assert.equal(A.route('DELETE', '/rest/api/3/issue/AC-1/watchers?accountId=me').args.inputs.action, 'unwatch');
  assert.equal(A.route('POST', '/rest/api/3/issue/AC-1/watchers', 'me').args.inputs.action, 'watch');
  assert.deepStrictEqual(A.route('GET', '/rest/api/3/issue/AC-1?fields=summary,status').args, { issueIdOrKey: 'AC-1', fields: ['summary', 'status'], fieldsByKeys: true, responseContentFormat: 'markdown' });
  assert.equal(A.route('GET', '/rest/api/3/issue/createmeta/AC/issuetypes').args.name, 'listJiraProjectIssueTypesMetadata');
  assert.equal(A.route('GET', '/rest/api/3/issue/createmeta/AC/issuetypes/10003').args.inputs.issueTypeId, '10003');
  assert.equal(A.route('DELETE', '/rest/api/3/issue/AC-1'), null);
  assert.equal(A.route('GET', '/rest/api/2/serverInfo'), null);
});

async function signedIn(f) {
  const auth = await A.signIn({ open: browser, mcpUrl: f.mcp });
  return { auth: 'oauth', site: 'https://acme.atlassian.net', cloudId: 'cloud-1', labels: [], conn: new A.Connection({ auth }) };
}

test('Ally\'s Jira code runs unchanged through the sign-in: search, moves, follow, create, details', async () => {
  const f = await fakeAtlassian({ issues: [{ key: 'AC-1', fields: { summary: 'Retry', status: { name: 'En cours', statusCategory: { key: 'indeterminate' } }, watches: { isWatching: true }, labels: ['mvp2'], project: { name: 'Acme' } } }] });
  try {
    const cfg = await signedIn(f);
    Object.assign(cfg, await J.connect(fetch, cfg));
    assert.equal(cfg.accountId, 'me');
    assert.equal(cfg.flaggedField, '');
    const s = await J.search(fetch, cfg);
    assert.deepStrictEqual(s.tickets.map((t) => [t.key, t.cat, t.watching, t.url]), [['AC-1', 'doing', true, 'https://acme.atlassian.net/browse/AC-1']]);
    assert.equal(f.state.calls.find((c) => c.name === 'searchJiraIssuesUsingJql').args.cloudId, 'cloud-1');
    assert.deepStrictEqual(await J.transitions(fetch, cfg, 'AC-1'), [{ id: '31', name: 'Done', to: 'Terminé', cat: 'done' }]);
    await J.transition(fetch, cfg, 'AC-1', '31');
    await J.watch(fetch, cfg, 'AC-1', false);
    assert.equal(f.state.calls.at(-1).args.inputs.action, 'unwatch');
    // Types carry no hierarchy level here: an epic is told by its name; priority goes by name.
    assert.equal(await J.createIssue(fetch, cfg, { project: 'AC', summary: 'Desk', due: '2026-12-01', p: 'P1' }), 'AC-77');
    const made = f.state.calls.at(-1).args;
    assert.deepStrictEqual({ ...made, cloudId: undefined }, { cloudId: undefined, projectKey: 'AC', summary: 'Desk', issueType: 'Tâche', assignee: 'me', priority: 'Haute', additional_fields: { duedate: '2026-12-01' } });
    await J.createIssue(fetch, cfg, { project: 'AC', summary: 'Move', epic: true });
    assert.equal(f.state.calls.at(-1).args.issueType, 'Épopée');
    const d = await J.issueDetail(fetch, cfg, 'AC-1');
    assert.equal(d.description, 'Line one.\n\nLine two.');
  } finally { await f.close(); }
});

test('without write access, reading works and changes are refused with a clear reason', async () => {
  const f = await fakeAtlassian({ scopes: 'read:me offline_access read:jira:agent-interface search:jira:agent-interface' });
  try {
    const cfg = await signedIn(f);
    await J.search(fetch, cfg);
    await assert.rejects(J.transition(fetch, cfg, 'AC-1', '31'), (e) => e.status === 403 && /not given write access/.test(e.message));
    await assert.rejects(J.watch(fetch, cfg, 'AC-1', true), /not given write access/);
    assert.ok(!f.state.calls.some((c) => c.name === 'transitionJiraIssue' || c.args.name === 'watchJiraIssue'));
  } finally { await f.close(); }
});

test('the refresh token is stored encrypted, the live connection never; status says read only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ally-cfg-'));
  const file = path.join(dir, 'jira.json');
  const crypt = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from('E:' + s), decryptString: (b) => String(b).slice(2) };
  C.save(file, { auth: 'oauth', site: 'https://acme.atlassian.net', refresh: 'ref-1', scopes: 'read:jira:agent-interface', labels: [], conn: { secret: 1 } }, crypt);
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('ref-1') && !raw.includes('conn') && !raw.includes('"token"'));
  const back = C.load(file, crypt);
  assert.equal(back.refresh, 'ref-1');
  assert.deepStrictEqual([C.status(back).auth, C.status(back).write], ['oauth', false]);
  assert.equal(C.status({ ...back, scopes: 'read:jira:agent-interface write:jira:agent-interface' }).write, true);
  assert.deepStrictEqual([C.status({ site: 's', email: 'e', token: 't', labels: [] }).auth, C.status({ site: 's', token: 't', labels: [] }).write], ['token', true]);
});
