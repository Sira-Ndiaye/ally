#!/usr/bin/env node
'use strict';
// End-to-end check on the current system, in a throwaway home folder:
//   1. the hook writes and removes a session record
//   2. the hook command written to settings.json runs through the shell Claude Code uses
//   3. the real app starts, lists a live session, drops a dead one, and renders its window
//   4. the Tasks tab searches a stand-in Jira once when opened, and lists tickets and todos
//   5. a ticket's right-click menu lists its allowed moves, and a move reaches Jira
//   6. the Projects tab measures an epic from one Jira search and a checklist from its todos
//   7. Update board asks for the board's address once, copies the projects and opens the board
//   8. a logged-in Atlassian CLI pre-fills the Jira site and email (not on Windows)
//   9. Sign in with Atlassian, against a stand-in: the browser step, the saved login, tickets through MCP
// Exits 0 when everything passes. Linux needs a display (xvfb-run in CI).
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { fakeAtlassian } = require('../test/fake-atlassian');

const APP = path.resolve(__dirname, '..');
const WIN = process.platform === 'win32';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-smoke-'));
// ALLY_OPEN_LOG: the app writes links and clipboard text there instead of opening or copying.
const OPEN_LOG = path.join(TMP, 'open.log');
const env = { ...process.env, HOME: TMP, USERPROFILE: TMP, ALLY_OPEN_LOG: OPEN_LOG };
const SESSIONS = path.join(TMP, '.ally', 'sessions');
const record = (id) => path.join(SESSIONS, id + '.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const children = [];

let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || !detail ? '' : '\n     ' + detail}`);
  if (!ok) failed++;
}

function testHook() {
  const event = (id, name) => JSON.stringify({ session_id: id, hook_event_name: name, cwd: APP });
  const r = spawnSync(process.execPath, [path.join(APP, 'hook', 'hook.js')], { env, input: event('direct', 'SessionStart') });
  check('hook writes a session record', r.status === 0 && fs.existsSync(record('direct')), String(r.stderr));
  spawnSync(process.execPath, [path.join(APP, 'hook', 'hook.js')], { env, input: event('direct', 'SessionEnd') });
  check('hook removes it at session end', !fs.existsSync(record('direct')));

  const inst = spawnSync(process.execPath, [path.join(APP, 'scripts', 'install-hooks.js'), '--apply'], { env });
  let command = '';
  try {
    command = JSON.parse(fs.readFileSync(path.join(TMP, '.claude', 'settings.json'), 'utf8')).hooks.SessionStart[0].hooks[0].command;
  } catch {}
  check('hooks installer writes settings.json', inst.status === 0 && !!command, String(inst.stderr));
  // Claude Code runs hook commands through Git Bash on Windows and sh elsewhere.
  const sh = spawnSync(WIN ? 'bash' : 'sh', ['-c', command], { env, input: event('viashell', 'SessionStart') });
  check(`installed hook command runs through ${WIN ? 'bash' : 'sh'}`, sh.status === 0 && fs.existsSync(record('viashell')),
    `${command}\n     ${sh.error || sh.stderr}`);
  try { fs.unlinkSync(record('viashell')); } catch {}
}

// A process the app recognises as a Claude Code session: a `claude` symlink to node.
// Windows has no process list in the app, so the record alone is enough there.
function fakeSession() {
  let pid = 0;
  if (!WIN) {
    const bin = path.join(TMP, 'bin', 'claude');
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    fs.symlinkSync(process.execPath, bin);
    const p = spawn(bin, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', cwd: APP });
    children.push(p);
    pid = p.pid;
  }
  const now = Date.now();
  fs.mkdirSync(SESSIONS, { recursive: true });
  fs.writeFileSync(record('live'), JSON.stringify({ id: 'live', pid, cwd: APP, state: 'working', message: 'Smoke test', since: now, updated: now }));
  fs.writeFileSync(record('dead'), JSON.stringify({ id: 'dead', pid: 999999, cwd: APP, state: 'idle', message: 'Gone', since: 0, updated: 0 }));
}

// A stand-in Jira on this computer, and an account saved for it (plain token: CI has no keychain).
// Also a todo saved by Claude Meter, before todos had a state.
function fakeJira() {
  const seen = [];
  const issue = (key, summary, fields) => ({ key, fields: { summary, status: { name: 'Dev testing', statusCategory: { key: 'indeterminate' } }, priority: { id: '2', name: 'High' }, ...fields } });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body });
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/rest/api/3/issue/SMK-1/transitions') {
        if (req.method === 'POST') { res.statusCode = 204; return res.end(); }
        return res.end(JSON.stringify({ transitions: [
          { id: '11', name: 'Back', to: { name: 'Dev testing', statusCategory: { key: 'indeterminate' } } },
          { id: '31', name: 'Finish', to: { name: 'Terminé', statusCategory: { key: 'done' } } },
        ] }));
      }
      if (req.url === '/rest/api/3/issue/SMK-2' && req.method === 'PUT') { res.statusCode = 204; return res.end(); }
      if (req.url !== '/rest/api/3/search/jql') { res.statusCode = 404; return res.end('{}'); }
      if (JSON.parse(body).jql.includes('parent in')) {
        return res.end(JSON.stringify({ isLast: true, issues: [
          issue('SMK-100', 'Payments v2', { duedate: '2020-02-01' }),
          { key: 'SMK-101', fields: { status: { statusCategory: { key: 'done' } }, parent: { key: 'SMK-100' } } },
          { key: 'SMK-102', fields: { status: { statusCategory: { key: 'indeterminate' } }, parent: { key: 'SMK-100' } } },
        ] }));
      }
      res.end(JSON.stringify({ isLast: true, issues: [
        issue('SMK-1', 'Mine and late', { assignee: { accountId: 'me', displayName: 'Smoke Me' }, duedate: '2020-01-01' }),
        issue('SMK-2', 'Blocked one', { assignee: { accountId: 'me', displayName: 'Smoke Me' },
          issuelinks: [{ type: { name: 'Blocks', inward: 'is blocked by' }, inwardIssue: { key: 'SMK-9', fields: { status: { statusCategory: { key: 'new' } } } } }] }),
      ] }));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const site = `http://127.0.0.1:${server.address().port}`;
    fs.mkdirSync(path.join(TMP, '.ally'), { recursive: true });
    fs.writeFileSync(path.join(TMP, '.ally', 'jira.json'), JSON.stringify({ site, email: 'smoke@example.com', accountId: 'me', labels: [], token: { plain: 'smoke-token' } }));
    fs.writeFileSync(path.join(TMP, '.ally', 'todos.json'), JSON.stringify([
      { t: 'Old personal todo', p: 'P2', d: false, due: '2026-01-01', doneAt: null },
      { t: 'Order desk', p: 'P2', s: 'done', d: true, due: '2099-01-01', doneAt: Date.now(), project: 'home-office' },
      { t: 'Book movers', p: 'P2', s: 'todo', d: false, due: '2099-01-01', doneAt: null, project: 'home-office' },
    ]));
    fs.writeFileSync(path.join(TMP, '.ally', 'projects.json'), JSON.stringify([
      { id: 'payments', name: 'Payments', kind: 'epic', epic: 'SMK-100' },
      { id: 'home-office', name: 'Home office', kind: 'checklist', due: '2099-12-20' },
    ]));
    resolve({ server, seen });
  }));
}

async function testTasks(wsUrl, jiraFake) {
  await evaluate(wsUrl, "document.querySelector('[data-t=todo]').click()");
  let rows = [];
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    rows = JSON.parse(await evaluate(wsUrl, "JSON.stringify([...document.querySelectorAll('#list .item')].map((li) => li.textContent))"));
    if (rows.length >= 3) break;
  }
  const searches = jiraFake.seen.filter((r) => r.path === '/rest/api/3/search/jql');
  check('opening Tasks searches Jira once, with the saved token', searches.length === 1 &&
    searches[0].auth === 'Basic ' + Buffer.from('smoke@example.com:smoke-token').toString('base64') &&
    JSON.parse(searches[0].body).jql.startsWith('assignee = currentUser() AND'), JSON.stringify(jiraFake.seen));
  const has = (re) => rows.some((r) => re.test(r));
  check('your tickets are listed with priority, late date and blocked',
    has(/P1.*Mine and late.*late.*SMK-1/) && has(/Blocked one.*SMK-2.*blocked/) && !rows.some((r) => /following/.test(r)), JSON.stringify(rows));
  check('a todo saved by Claude Meter shows as a personal task', has(/Old personal todo/), JSON.stringify(rows));
  await shot(wsUrl, 'tasks');
  await sleep(1500);
  check('no second search without a refresh', jiraFake.seen.filter((r) => r.path === '/rest/api/3/search/jql').length === 1);
  await testMatrix(wsUrl, jiraFake);
}

// The Matrix view places tickets by due date and priority; moving one writes Jira once.
async function testMatrix(wsUrl, jiraFake) {
  await evaluate(wsUrl, "document.querySelector('#fview .seg [data-v=matrix]').click()");
  const squares = async () => JSON.parse(await evaluate(wsUrl, "JSON.stringify(Object.fromEntries([...document.querySelectorAll('#matrix .mq')].map((q) => [q.dataset.q, [...q.querySelectorAll('.mc')].map((c) => c.textContent)])))"));
  let q = await squares();
  check('Matrix: a late P1 ticket is in Do now, an undated P1 ticket in Plan',
    (q.now || []).some((t) => t.includes('SMK-1')) && (q.plan || []).some((t) => t.includes('SMK-2')), JSON.stringify(q));
  await evaluate(wsUrl, "(() => { const c = [...document.querySelectorAll('#matrix .mc')].find((x) => x.textContent.includes('SMK-2')); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); })()");
  let put;
  for (let i = 0; i < 20 && !put; i++) { await sleep(250); put = jiraFake.seen.find((r) => r.method === 'PUT' && r.path === '/rest/api/3/issue/SMK-2'); }
  const today = new Date(); const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  check('moving a ticket to Do now sends its due date to Jira, priority untouched',
    !!put && JSON.stringify(JSON.parse(put.body)) === JSON.stringify({ fields: { duedate: iso } }), JSON.stringify(put));
  q = await squares();
  check('the ticket shows in its new square at once', (q.now || []).some((t) => t.includes('SMK-2')), JSON.stringify(q));
  await shot(wsUrl, 'matrix');
  await evaluate(wsUrl, "document.querySelector('#fview .seg [data-v=list]').click()");
}

async function testProjects(wsUrl, jiraFake) {
  await evaluate(wsUrl, "document.querySelector('[data-t=projects]').click()");
  let cards = [];
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    cards = JSON.parse(await evaluate(wsUrl, "JSON.stringify([...document.querySelectorAll('#plist .proj')].map((li) => li.textContent))"));
    if (cards.some((c) => c.includes('1/2 done') && c.includes('Payments'))) break;
  }
  const searches = jiraFake.seen.filter((r) => r.path === '/rest/api/3/search/jql' && JSON.parse(r.body).jql.includes('parent in'));
  check('opening Projects runs one search for its epics and labels', searches.length === 1 &&
    JSON.parse(searches[0].body).jql === 'key in (SMK-100) OR parent in (SMK-100) ORDER BY key ASC', JSON.stringify(searches.map((r) => r.body)));
  check('an epic project shows its progress, health and late due date', cards.some((c) => /^PaymentsAt riskepic SMK-1001\/2 doneFeb 1$/.test(c)), JSON.stringify(cards));
  check('a checklist project counts its own todos', cards.some((c) => /^Home officeOn trackchecklist1\/2 doneDec 20$/.test(c)), JSON.stringify(cards));
  await evaluate(wsUrl, "[...document.querySelectorAll('#plist .proj')].find((li) => li.textContent.includes('Home office')).click()");
  await sleep(300);
  await shot(wsUrl, 'projects');
  if (process.env.SMOKE_SHOT) {
    await evaluate(wsUrl, "document.getElementById('nclose').click(); document.getElementById('pnew').click(); document.querySelector('#pform select').value = 'epic'; document.querySelector('#pform select').dispatchEvent(new Event('input'))");
    await sleep(300);
    await shot(wsUrl, 'new-project');
  }
}

// Update board: the first press asks for the address; the projects go to the clipboard
// with a hash the board checks, and the board opens at #board~paste.
async function testBoard(wsUrl) {
  const outs = () => { try { return fs.readFileSync(OPEN_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  await evaluate(wsUrl, "document.getElementById('nclose').click(); document.getElementById('pform').hidden = true; document.getElementById('pboard').click()");
  await sleep(300);
  const title = await evaluate(wsUrl, "document.getElementById('pform').hidden ? '' : document.querySelector('#pform .ptitle').textContent");
  check('the first Update board asks for the board address', title === 'Board address', title);
  await evaluate(wsUrl, "document.querySelector('#pform input').value = 'https://claude.ai/artifact/SmokeBoard1#old'; document.getElementById('pform').requestSubmit()");
  let out = [];
  for (let i = 0; i < 20 && out.length < 2; i++) { await sleep(250); out = outs(); }
  const copy = out.find((o) => o.kind === 'copy');
  const open = out.find((o) => o.kind === 'open');
  let env = null;
  try { env = JSON.parse(copy.value); } catch {}
  const Projects = require(path.join(APP, 'src', 'projects.js'));
  const sha = env && require('crypto').createHash('sha256').update(Projects.canonical(env.data)).digest('hex');
  check('Update board copies the projects with a hash the board can check',
    !!env && env.v === 1 && env.sha === sha && env.data.projects.map((p) => p.id).join() === 'payments,home-office' &&
    env.data.todos.map((t) => `${t.t}:${t.s}`).join() === 'Order desk:done,Book movers:todo' && !copy.value.includes('smoke-token'), copy && copy.value.slice(0, 300));
  check('and opens the board to paste them', open && open.value === 'https://claude.ai/artifact/SmokeBoard1#board~paste', JSON.stringify(open));
  const note = await evaluate(wsUrl, "document.getElementById('ntext').textContent");
  check('the widget says what to do on the board', /^Copied 2 projects\. On the board, click the paste box and press (⌘V|Ctrl\+V)\.$/.test(note), note);
  await shot(wsUrl, 'board-notice');
}

// A stand-in acli in the throwaway home: the widget asks it, through the main process,
// for the site and email only.
function fakeAcli() {
  if (WIN) return;
  const bin = path.join(TMP, '.local', 'bin', 'acli');
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, '#!/bin/sh\n[ "$*" = "jira auth status" ] || exit 2\necho "Site: acme.atlassian.net"\necho "Email: ada@acme.io"\n', { mode: 0o755 });
}
async function testAcli(wsUrl) {
  if (WIN) return;
  const res = await cdp(wsUrl, [['Runtime.evaluate', { expression: 'window.meter.jiraSuggest().then((r) => JSON.stringify(r))', awaitPromise: true, returnByValue: true }]]);
  const r = res.result?.value;
  check('a logged-in acli gives the Jira site and email, and nothing else', r === JSON.stringify({ site: 'acme.atlassian.net', email: 'ada@acme.io' }), r);
}

// Sign in with Atlassian: the widget opens the consent page (logged, not opened); this
// test is the browser and follows Atlassian's redirect back to the widget.
async function testSignIn(wsUrl, atl) {
  const before = (() => { try { return fs.readFileSync(OPEN_LOG, 'utf8'); } catch { return ''; } })().length;
  await evaluate(wsUrl, "document.querySelector('[data-t=todo]').click(); document.getElementById('jedit').click()");
  await sleep(200);
  if (process.env.SMOKE_SHOT) {
    // What someone without a Jira login sees: the form as it opens for them.
    await evaluate(wsUrl, "(() => { const was = jiraState; jiraState = { configured: false, labels: [] }; showJiraForm(true); jiraState = was; })()");
    await sleep(200);
    await shot(wsUrl, 'signin-form');
  }
  await evaluate(wsUrl, "document.getElementById('jsignin').click()");
  let url = '';
  for (let i = 0; i < 40 && !url; i++) {
    await sleep(250);
    const tail = fs.readFileSync(OPEN_LOG, 'utf8').slice(before).trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    url = (tail.find((o) => o.kind === 'open' && o.value.startsWith(atl.base + '/authorize')) || {}).value || '';
  }
  check('Sign in with Atlassian opens the consent page', !!url, 'no authorize link opened');
  if (!url) return;
  const page = await fetch(url, { redirect: 'follow' }).then((r) => r.text()).catch((e) => String(e));
  check('the browser lands back on Ally', page.includes('Signed in'), page.slice(0, 200));
  let who = '';
  for (let i = 0; i < 40 && !who.includes('signed in'); i++) { await sleep(250); who = await evaluate(wsUrl, "document.getElementById('jwho').textContent"); }
  check('the widget says it is signed in to the site Atlassian named', who === 'acme.atlassian.net · signed in', who);
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(TMP, '.ally', 'jira.json'), 'utf8')); } catch {}
  const file = JSON.stringify(saved);
  check('the sign-in is saved: a refresh token, never the access token or an API token',
    saved.auth === 'oauth' && saved.cloudId === 'cloud-1' && !!saved.refresh && !saved.token && !/acc-/.test(file), file.slice(0, 300));
  let rows = [];
  for (let i = 0; i < 40 && !rows.some((r) => r.includes('ACME-9')); i++) {
    await sleep(250);
    rows = JSON.parse(await evaluate(wsUrl, "JSON.stringify([...document.querySelectorAll('#list .tk')].map((li) => li.textContent))"));
  }
  check('tickets come through Atlassian\'s MCP server', rows.some((r) => r.includes('ACME-9') && r.includes('Signed-in ticket')) && atl.state.calls.some((c) => c.name === 'searchJiraIssuesUsingJql'), JSON.stringify(rows));
  await shot(wsUrl, 'signed-in');
}

// The window stays on Ally's page, ~/.ally is private, and plan limits stay off until ticked.
async function testSecurity(wsUrl) {
  const page = await evaluate(wsUrl, 'location.href');
  await evaluate(wsUrl, "location.href = 'https://example.com/'");
  await sleep(800);
  const after = await evaluate(wsUrl, 'location.href');
  check('the widget refuses to navigate away from its page', after === page && /index\.html$/.test(after), after);
  const opened = await evaluate(wsUrl, "String(window.open('https://example.com/'))");
  check('and opens no other window', opened === 'null', opened);
  if (!WIN) {
    const mode = fs.statSync(path.join(TMP, '.ally')).mode & 0o777;
    check('~/.ally is readable by you only', mode === 0o700, mode.toString(8));
  }
  await evaluate(wsUrl, "document.querySelector('[data-t=usage]').click()");
  await sleep(300);
  const off = await evaluate(wsUrl, "!!document.querySelector('#limits .uoff') && !document.getElementById('flim').checked");
  check('plan limits are off until ticked in Settings', off === true);
  await evaluate(wsUrl, "document.getElementById('opBtn').click()");
  await shot(wsUrl, 'settings');
  await evaluate(wsUrl, "document.getElementById('opBtn').click()");
}

// SMOKE_SHOT=<folder> saves what the Tasks tab and its menu look like.
async function shot(wsUrl, name) {
  if (!process.env.SMOKE_SHOT) return;
  const r = await cdp(wsUrl, [['Page.captureScreenshot', { format: 'png' }]]);
  fs.writeFileSync(path.join(process.env.SMOKE_SHOT, name + '.png'), Buffer.from(r.data, 'base64'));
}

async function testMenu(wsUrl, jiraFake) {
  await evaluate(wsUrl, `(() => {
    const row = [...document.querySelectorAll('#list .tk')].find((li) => li.textContent.includes('SMK-1'));
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 40, clientY: r.top + 10 }));
  })()`);
  let items = [];
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    items = JSON.parse(await evaluate(wsUrl, "JSON.stringify([...document.querySelectorAll('#menu .mitem, #menu .mhead')].map((b) => b.textContent))"));
    if (items.some((t) => t.startsWith('Terminé'))) break;
  }
  check('the menu lists the allowed moves and the actions',
    ['Move to', 'TerminéFinish', 'Plan with Claude', 'Open in Jira↗', 'Copy keySMK-1'].every((t) => items.includes(t)) && !items.includes('Dev testingBack') && !items.some((t) => /Follow/.test(t)),
    JSON.stringify(items));
  await shot(wsUrl, 'menu');
  await evaluate(wsUrl, "[...document.querySelectorAll('#menu .mitem')].find((b) => b.textContent.startsWith('Terminé')).click()");
  let note = '';
  for (let i = 0; i < 20 && !note.includes('moved'); i++) { await sleep(250); note = await evaluate(wsUrl, "document.getElementById('ntext').textContent"); }
  const move = jiraFake.seen.find((r) => r.path === '/rest/api/3/issue/SMK-1/transitions' && r.body);
  check('a move reaches Jira and the widget says so', !!move && JSON.parse(move.body).transition.id === '31' && note === 'SMK-1 moved to Terminé', `${JSON.stringify(move)} ${note}`);
}

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Sends DevTools protocol calls to the widget's page, in order; resolves with the last result.
function cdp(wsUrl, calls) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let i = 0;
    const next = () => ws.send(JSON.stringify({ id: i, method: calls[i][0], params: calls[i][1] }));
    ws.onerror = () => reject(new Error('devtools socket failed'));
    ws.onopen = next;
    ws.onmessage = (m) => {
      const d = JSON.parse(m.data);
      if (d.id !== i) return;
      if (++i < calls.length) return next();
      ws.close();
      resolve(d.result);
    };
  });
}
const evaluate = async (wsUrl, expression) =>
  (await cdp(wsUrl, [['Runtime.evaluate', { expression, returnByValue: true }]])).result?.value;

// Presses the header, moves the pointer, releases: the window must follow.
async function testDrag(wsUrl) {
  const at = async () => JSON.parse(await evaluate(wsUrl, 'JSON.stringify([screenX, screenY])'));
  const mouse = (type, x, y) => ['Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }];
  const before = await at();
  const moves = [1, 2, 3, 4, 5].map((i) => mouse('mouseMoved', 90 - i * 6, 18 + i * 6));
  await cdp(wsUrl, [mouse('mousePressed', 90, 18), ...moves, mouse('mouseReleased', 60, 48)]);
  await sleep(700);
  const after = await at();
  check('dragging the header moves the window', after[0] < before[0] && after[1] > before[1], `${before} -> ${after}`);
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(path.join(TMP, '.ally', 'window.json'), 'utf8')); } catch {}
  check('the new position is saved', saved.x === after[0] && saved.y === after[1], `${JSON.stringify(saved)} vs ${after}`);
}

async function testApp() {
  fakeAcli();
  fakeSession();
  const jiraFake = await fakeJira();
  const atl = await fakeAtlassian({ issues: [{ key: 'ACME-9', fields: { summary: 'Signed-in ticket', status: { name: 'En cours', statusCategory: { key: 'indeterminate' } }, assignee: { displayName: 'Ada Lovelace', accountId: 'me' }, labels: [], project: { name: 'Acme' } } }] });
  env.ALLY_ATLASSIAN_MCP = atl.mcp;
  const port = await freePort();
  // On macOS the throwaway home has no keychain: Chromium's test keychain keeps the
  // system's out of it (otherwise macOS asks where to store "ally Key").
  const keychain = process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
  const app = spawn(require('electron'), [`--remote-debugging-port=${port}`, '--remote-allow-origins=*', `--user-data-dir=${path.join(TMP, 'ud')}`, ...keychain, APP], { env });
  children.push(app);
  let log = '';
  app.stdout.on('data', (d) => { log += d; });
  app.stderr.on('data', (d) => { log += d; });

  const PAGE = `JSON.stringify({
    rows: [...document.querySelectorAll('#slist .sess')].map((li) => li.textContent),
    summary: document.getElementById('sSum').textContent,
    opacity: document.getElementById('opv').textContent,
  })`;
  let page = null;
  let state = null;
  for (let i = 0; i < 60 && app.exitCode === null && app.signalCode === null; i++) {
    await sleep(500);
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      page = list.find((p) => p.url.endsWith('index.html'));
      if (!page) continue;
      state = JSON.parse(await evaluate(page.webSocketDebuggerUrl, PAGE));
      // Sessions can arrive before init() has applied the settings: wait for both.
      if (state.rows.some((r) => r.includes('Smoke test')) && !fs.existsSync(record('dead')) && /%$/.test(state.opacity)) break;
    } catch {}
  }
  if (!WIN) check('stand-in claude process is alive', children[0].exitCode === null && children[0].signalCode === null);
  check('app starts and stays running', app.exitCode === null && app.signalCode === null, `exit code ${app.exitCode}, signal ${app.signalCode}`);
  check('widget window loads', !!page);
  check('widget is wired to the main process', !!state && /%$/.test(state.opacity), JSON.stringify(state));
  // Other rows can be real sessions of the person running this.
  const live = state ? state.rows.filter((r) => r.includes('Smoke test')) : [];
  check('live session is listed', live.length === 1 && live[0].includes(path.basename(APP)) && live[0].includes('Working'), JSON.stringify(state));
  check('dead session is dropped', !fs.existsSync(record('dead')));
  if (page && process.env.SMOKE_SHOT) {
    // Only the stand-in session: real sessions on this machine stay out of screenshots.
    await evaluate(page.webSocketDebuggerUrl, "[...document.querySelectorAll('#slist .sess')].filter((li) => !li.textContent.includes('Smoke test')).forEach((li) => li.remove()); document.getElementById('sSum').textContent = '1 session · 1 working · 0 waiting'");
    await shot(page.webSocketDebuggerUrl, 'sessions');
  }
  if (page && app.exitCode === null && app.signalCode === null) {
    await testDrag(page.webSocketDebuggerUrl);
    await testTasks(page.webSocketDebuggerUrl, jiraFake);
    await testMenu(page.webSocketDebuggerUrl, jiraFake);
    await testProjects(page.webSocketDebuggerUrl, jiraFake);
    await testBoard(page.webSocketDebuggerUrl);
    await testAcli(page.webSocketDebuggerUrl);
    await testSignIn(page.webSocketDebuggerUrl, atl);
    await testSecurity(page.webSocketDebuggerUrl);
  }
  jiraFake.server.close();
  await atl.close();
  const errors = log.split('\n').filter((l) => /Uncaught|UnhandledPromiseRejection|TypeError|ReferenceError|Cannot find module|FATAL/.test(l));
  check('no errors in the app output', !errors.length, errors.join('\n     '));
  if (failed && log.trim()) console.log('--- app output ---\n' + log.trim());
}

(async () => {
  console.log(`Smoke test on ${process.platform} ${process.arch}, Node ${process.version}`);
  try {
    testHook();
    await testApp();
  } catch (e) {
    check('smoke test ran to the end', false, e.stack);
  }
  for (const c of children) { try { c.kill(); } catch {} }
  await sleep(500);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
  console.log(failed ? `\n${failed} check(s) failed.` : '\nAll checks passed.');
  process.exit(failed ? 1 : 0);
})();
