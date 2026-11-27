'use strict';
const { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, safeStorage, screen, shell, Tray } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { listClaudeProcesses, mergeSessions, gitBranch, focusSession } = require('./sessions');
const { fetchLimits, LogScanner } = require('./usage');
const { home, migrate, makePrivate } = require('./home');
const jira = require('./jira');
const jiraConfig = require('./jira-config');
const acli = require('./acli');
const atlassian = require('./atlassian');
const plan = require('./plan');
const terminal = require('./terminal');
const Projects = require('./projects');

// Memory: no GPU acceleration. On Linux this is also what makes transparent windows reliable.
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=64');
// Fewer Chromium helper processes: GPU and network run inside the main process.
app.commandLine.appendSwitch('in-process-gpu');
app.commandLine.appendSwitch('enable-features', 'NetworkServiceInProcess2');
app.commandLine.appendSwitch('disable-features', 'SpareRendererForSitePerProcess,MediaRouter,AudioServiceOutOfProcess');

// Started without the `ally` command (login item, shortcut, npm start): migrate here too.
migrate();
makePrivate();
const HOME = home();
const SESSIONS = path.join(HOME, 'sessions');
const TODOS = path.join(HOME, 'todos.json');
const PREFS = path.join(HOME, 'window.json');
const LIMITS = path.join(HOME, 'limits.json');
const JIRA = path.join(HOME, 'jira.json');
const JIRA_CACHE = path.join(HOME, 'jira-cache.json');
const PLAN = path.join(HOME, 'plan.json');
const PROJECTS = path.join(HOME, 'projects.json');
const PROJECTS_CACHE = path.join(HOME, 'projects-cache.json');
const MIN_WIDTH = 300;
const MAX_WIDTH = 600;
const FULL_HEIGHT = 440;
const COMPACT_HEIGHT = 40;
const LIMITS_EVERY = 90 * 1000;
const LOGS_EVERY = 60 * 1000;

let win;
let tray;
let indicator;
let trayShown = '';
let prefs = { opacity: 80, compact: false, width: MIN_WIDTH };
let sessions = [];
// The widget was hidden when a pending prompt made it appear: it hides again afterwards.
let shownForAsk = false;
let usage = { limits: null, logs: null };
const scanner = new LogScanner();
let jiraCfg = null;
let jiraBusy = null;

// ---- Security: only Ally's own page may talk to the app. The window never navigates
// away (a link dropped on it would otherwise load that page with Ally's bridge) and never
// opens other windows. Every IPC message from anything else is ignored.
const PAGE = require('url').pathToFileURL(path.join(__dirname, 'index.html')).href;
const trusted = (e) => !!e.senderFrame && e.senderFrame.url.split('#')[0] === PAGE;
function handle(channel, fn) {
  ipcMain.handle(channel, (e, ...args) => {
    if (!trusted(e)) throw new Error('Refused: not Ally\'s window.');
    return fn(e, ...args);
  });
}
function on(channel, fn) {
  ipcMain.on(channel, (e, ...args) => { if (trusted(e)) fn(e, ...args); });
}
app.on('web-contents-created', (_e, wc) => {
  wc.on('will-navigate', (e) => e.preventDefault());
  wc.on('will-frame-navigate', (e) => { if (e.url !== PAGE) e.preventDefault(); });
  wc.on('will-redirect', (e) => e.preventDefault());
  wc.on('will-attach-webview', (e) => e.preventDefault());
  wc.setWindowOpenHandler(() => ({ action: 'deny' }));
});

const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 }); fs.writeFileSync(f, JSON.stringify(v, null, 2), { mode: 0o600 }); };
const send = (ch, v) => { if (win && !win.isDestroyed()) win.webContents.send(ch, v); };

// Without a process list (Windows) a session is kept until SessionEnd or 12h of silence.
function isAliveFallback(r) { return Date.now() - (r.updated || 0) < 12 * 3600 * 1000; }

function loadSessions() {
  let files = [];
  try { files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.json')); } catch {}
  const records = files.map((f) => readJson(path.join(SESSIONS, f), null)).filter(Boolean);
  const procs = listClaudeProcesses();
  let { sessions: list, stale } = mergeSessions(records, procs);
  if (!procs) {
    stale = list.filter((r) => !isAliveFallback(r)).map((r) => r.id);
    list = list.filter(isAliveFallback);
  }
  for (const id of stale) { try { fs.unlinkSync(path.join(SESSIONS, id + '.json')); } catch {} }
  return list.map((s) => (s.branch || !s.cwd ? s : { ...s, branch: gitBranch(s.cwd) }));
}

function refreshSessions() {
  const prevInput = new Set(sessions.filter((s) => s.state === 'input').map((s) => s.id));
  const wasAsking = sessions.some((s) => s.ask);
  sessions = loadSessions();
  if (!wasAsking && !win && sessions.some((s) => s.ask)) {
    shownForAsk = true;
    createWindow();
  }
  for (const s of sessions) {
    if (s.state === 'input' && !prevInput.has(s.id)) notify(s);
  }
  send('sessions', sessions);
  updateTray();
}

function notify(s) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title: `${path.basename(s.cwd || '') || 'Claude'} needs your input`, body: s.message });
  n.on('click', () => { focusSession(s.pid, s.cwd); if (win) send('show-tab', 'sessions'); else createWindow(); });
  n.show();
}

function watchSessions() {
  fs.mkdirSync(SESSIONS, { recursive: true });
  let t;
  // A watcher error must not stop the app: the 15s refresh below still runs.
  fs.watch(SESSIONS, () => { clearTimeout(t); t = setTimeout(refreshSessions, 120); }).on('error', () => {});
  setInterval(refreshSessions, 15000);
  refreshSessions();
}

let limitsRetryAt = 0;
// Opt-in: plan limits need Claude Code's own login, read from this computer. Off, Ally
// never reads it and never calls Anthropic.
const limitsOn = () => !!prefs.features?.limits;
function clearLimits() {
  usage.limits = null;
  try { fs.unlinkSync(LIMITS); } catch {}
  send('usage', usage);
  updateTray();
}
async function refreshLimits() {
  if (!limitsOn()) return;
  if (Date.now() < limitsRetryAt) return;
  const r = await fetchLimits();
  // Switched off while the request was on its way.
  if (!limitsOn()) return;
  if (r.retryAfter) limitsRetryAt = Date.now() + r.retryAfter * 1000;
  if (r.limits) writeJson(LIMITS, r);
  // A failed refresh keeps the last known limits on screen, with the error above them.
  usage.limits = r.limits || !usage.limits?.limits ? r : { ...usage.limits, error: r.error };
  send('usage', usage);
  updateTray();
}

function refreshLogs() {
  try { usage.logs = scanner.scan(); } catch { usage.logs = null; }
  send('usage', usage);
}

const ICON = path.join(__dirname, '..', 'assets', 'icon.png');
const sessionLimit = () => (usage.limits?.limits || []).find((l) => l.label.startsWith('Session'));

// Linux gets its own indicator, the only way to show text next to the icon there.
// Without a tray host it falls back to Electron's Tray: icon and menu, no text.
async function createTray() {
  if (process.platform === 'linux') {
    try { indicator = await require('./indicator').createIndicator(ICON); } catch {}
  }
  if (!indicator) tray = new Tray(nativeImage.createFromPath(ICON).resize({ width: 18, height: 18 }));
  // A left click on a Windows tray icon does nothing by default: the menu is on right click.
  if (tray && process.platform === 'win32') tray.on('click', toggleWidget);
  updateTray();
}

function updateTray() {
  if (!tray && !indicator) return;
  const need = sessions.filter((s) => s.state === 'input').length;
  const lines = (usage.limits?.limits || []).map((l) => `${l.label}: ${l.percent}%`);
  if (usage.limits?.error) lines.push(usage.limits.error);
  lines.push(`${sessions.length} sessions, ${need} waiting`);
  const s = sessionLimit();
  const title = (s ? `${s.percent}%` : '') + (need ? ' ⚑' : '');
  const items = [
    ...lines.map((label) => ({ label, enabled: false })),
    { type: 'separator' },
    { label: 'Show / hide widget', click: toggleWidget },
    { label: 'Quit', click: () => app.quit() },
  ];
  if (indicator) return indicator.update(title, items);
  const shown = title + '\n' + lines.join('\n');
  if (shown === trayShown) return;
  trayShown = shown;
  tray.setToolTip('Ally\n' + lines.join('\n'));
  if (process.platform === 'darwin') tray.setTitle(title && ' ' + title);
  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// Hiding destroys the window instead of hiding it: that frees its whole renderer
// process, and the top bar item does not need it.
function toggleWidget() {
  if (win) win.destroy();
  else createWindow();
}

const width = () => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(prefs.width) || MIN_WIDTH));

function onScreen(b) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x >= a.x - 50 && b.y >= a.y - 10 && b.x < a.x + a.width - 50 && b.y < a.y + a.height - 30);
}

function createWindow() {
  prefs = { ...prefs, ...readJson(PREFS, {}) };
  const wa = screen.getPrimaryDisplay().workArea;
  let pos = { x: wa.x + wa.width - width() - 20, y: wa.y + 20 };
  if (Number.isFinite(prefs.x) && onScreen(prefs)) pos = { x: prefs.x, y: prefs.y };

  win = new BrowserWindow({
    ...pos,
    width: width(),
    height: prefs.compact ? COMPACT_HEIGHT : FULL_HEIGHT,
    frame: false,
    transparent: true,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    // macOS: a click on the widget acts at once, without first having to focus it.
    acceptFirstMouse: true,
    show: false,
    icon: ICON,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), spellcheck: false, contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true, navigateOnDragDrop: false },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true);
  win.loadFile(path.join(__dirname, 'index.html'));
  win.once('ready-to-show', () => win.showInactive());
  win.on('closed', () => { win = null; });

  let t;
  win.on('move', () => {
    clearTimeout(t);
    t = setTimeout(() => { if (!win) return; const [x, y] = win.getPosition(); savePrefs({ x, y }); }, 300);
  });
}

function savePrefs(patch) {
  prefs = { ...prefs, ...patch };
  writeJson(PREFS, prefs);
}

// ---- Jira: read only when the Tasks tab opens or refresh is pressed. No polling.
// Linux without a keyring falls back to a fixed key ("basic_text"): that is not secret.
const crypt = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable() &&
    !(process.platform === 'linux' && safeStorage.getSelectedStorageBackend?.() === 'basic_text'),
  encryptString: (s) => safeStorage.encryptString(s),
  decryptString: (b) => safeStorage.decryptString(b),
};

// ---- Sign in with Atlassian. The test suite points this at a stand-in on this computer;
// nothing else can change where Ally signs in.
const MCP_URL = /^http:\/\/127\.0\.0\.1:\d+\//.test(process.env.ALLY_ATLASSIAN_MCP || '') ? process.env.ALLY_ATLASSIAN_MCP : atlassian.MCP_URL;

// The live connection of a signed-in config. Atlassian hands out a new refresh token at
// each renewal, so each one is saved at once.
function connect(cfg) {
  if (!cfg || cfg.auth !== 'oauth' || cfg.conn) return cfg;
  const conn = new atlassian.Connection({
    auth: { clientId: cfg.clientId, tokenEndpoint: cfg.tokenEndpoint, resource: cfg.resource, mcp: cfg.mcp, refresh: cfg.refresh, scopes: cfg.scopes },
    onTokens: (t) => { if (jiraCfg && jiraCfg.conn === conn) jiraCfg = jiraConfig.save(JIRA, { ...jiraCfg, ...t }, crypt); },
  });
  return { ...cfg, conn };
}

let pendingSignIn = null;
handle('jira:signin', async () => {
  try {
    const auth = await atlassian.signIn({ open: (url) => openExternal(url), mcpUrl: MCP_URL });
    const conn = new atlassian.Connection({ auth });
    const sites = await atlassian.sites(conn);
    if (!sites.length) return { ok: false, error: 'This Atlassian account has no Jira site.' };
    pendingSignIn = { auth, conn, sites };
    if (sites.length === 1) return finishSignIn(sites[0].id);
    return { ok: true, choose: sites.map((x) => ({ id: x.id, url: x.url })) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
handle('jira:site', (_e, id) => finishSignIn(id));
async function finishSignIn(id) {
  const p = pendingSignIn;
  const site = p && p.sites.find((x) => x.id === id);
  if (!site) return { ok: false, error: 'Sign in again.' };
  const a = p.conn.auth;
  const base = { auth: 'oauth', site: site.url, cloudId: site.id, clientId: a.clientId, tokenEndpoint: a.tokenEndpoint, resource: a.resource, mcp: a.mcp, refresh: a.refresh, scopes: a.scopes,
    labels: jiraCfg && jiraCfg.site === site.url ? jiraCfg.labels : [] };
  try {
    const who = await jira.connect(fetch, { ...base, conn: p.conn });
    jiraCfg = jiraConfig.save(JIRA, { ...base, ...who, refresh: p.conn.auth.refresh, scopes: p.conn.auth.scopes }, crypt);
    jiraCfg = { ...jiraCfg, conn: p.conn };
    p.conn.onTokens = (t) => { if (jiraCfg && jiraCfg.conn === p.conn) jiraCfg = jiraConfig.save(JIRA, { ...jiraCfg, ...t }, crypt); };
    pendingSignIn = null;
    return { ok: true, status: jiraConfig.status(jiraCfg) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function jiraCache() {
  const c = readJson(JIRA_CACHE, null);
  return c && jiraCfg && c.site === jiraCfg.site ? c : { tickets: [], at: 0 };
}

// Two refreshes at once share one search. A failed one keeps the last tickets shown.
function refreshJira() {
  if (!jiraCfg) return Promise.resolve({ tickets: [], at: 0 });
  if (jiraBusy) return jiraBusy;
  jiraBusy = (async () => {
    try {
      const r = await jira.search(fetch, jiraCfg);
      const c = { site: jiraCfg.site, at: Date.now(), tickets: r.tickets, more: r.more };
      writeJson(JIRA_CACHE, c);
      return c;
    } catch (e) {
      return { ...jiraCache(), error: e.message };
    } finally {
      jiraBusy = null;
    }
  })();
  return jiraBusy;
}

handle('jira:refresh', () => refreshJira());
// The site and email of a logged-in Atlassian CLI, to pre-fill the form. Never its token.
handle('jira:suggest', () => acli.status().catch(() => null));
handle('jira:connect', async (_e, form) => {
  const site = jira.siteUrl(form.site);
  if (!site) return { ok: false, error: 'Enter your Jira site, like yourteam.atlassian.net.' };
  const email = String(form.email || '').trim();
  // A blank token keeps the saved one, so the form can be saved again without retyping it.
  const token = String(form.token || '').trim() || (jiraCfg && jiraCfg.site === site && jiraCfg.email === email ? jiraCfg.token : '');
  if (!email || !token) return { ok: false, error: 'Enter your Atlassian email and an API token.' };
  try {
    const who = await jira.connect(fetch, { site, email, token });
    const labels = jiraCfg && jiraCfg.site === site ? jiraCfg.labels : [];
    jiraCfg = jiraConfig.save(JIRA, { site, email, token, labels, ...who }, crypt);
    return { ok: true, status: jiraConfig.status(jiraCfg) };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
handle('jira:forget', () => {
  jiraCfg = null;
  for (const f of [JIRA, JIRA_CACHE]) { try { fs.unlinkSync(f); } catch {} }
  return jiraConfig.status(null);
});
// ---- menu actions: each one Jira call (two for the move menu: list, then move)
const jiraCall = async (fn) => {
  if (!jiraCfg) return { ok: false, error: 'Jira is not connected.' };
  try { return { ok: true, value: await fn(jiraCfg) }; } catch (e) { return { ok: false, error: e.message }; }
};
handle('jira:transitions', (_e, key) => jiraCall((c) => jira.transitions(fetch, c, key)));
handle('jira:transition', (_e, key, id) => jiraCall((c) => jira.transition(fetch, c, key, id)));
handle('jira:edit', (_e, key, change) => jiraCall((c) => jira.editIssue(fetch, c, key, change || {})));
handle('jira:create', (_e, todo) => jiraCall((c) => jira.createIssue(fetch, c, todo)));
on('copy', (_e, text) => copyText(String(text)));

// ---- Projects: one search for every linked epic and label, when the tab opens or on refresh.
function projectsCache(jql) {
  const c = readJson(PROJECTS_CACHE, null);
  return c && jiraCfg && c.site === jiraCfg.site && c.jql === jql ? c : { tickets: [], at: 0 };
}
let projectsBusy = null;
function refreshProjects(list) {
  const jql = Projects.jql(list);
  if (!jiraCfg || !jql) return Promise.resolve({ tickets: [], at: 0 });
  if (projectsBusy && projectsBusy.jql === jql) return projectsBusy.p;
  const p = (async () => {
    try {
      const r = await jira.projectSearch(fetch, jiraCfg, jql);
      const c = { site: jiraCfg.site, jql, at: Date.now(), tickets: r.tickets, more: r.more };
      writeJson(PROJECTS_CACHE, c);
      return c;
    } catch (e) {
      return { ...projectsCache(jql), error: e.message };
    } finally {
      projectsBusy = null;
    }
  })();
  projectsBusy = { jql, p };
  return p;
}
handle('projects:refresh', (_e, list) => refreshProjects(Array.isArray(list) ? list : []));
on('projects:save', (_e, list) => { if (Array.isArray(list)) writeJson(PROJECTS, list); });

// ---- Plan with Claude: decided from local files, then one terminal. The folders where
// Claude Code ran and the skills of each folder are kept for a day.
const DAY = 24 * 3600 * 1000;
let planFolders = { at: 0, list: [] };
const planSkills = new Map();
function folders() {
  if (Date.now() - planFolders.at > DAY) planFolders = { at: Date.now(), list: plan.claudeFolders() };
  return planFolders.list;
}
function skillsFor(dir) {
  const c = planSkills.get(dir);
  if (c && Date.now() - c.at < DAY) return c.list;
  const list = plan.allSkills(dir);
  planSkills.set(dir, { at: Date.now(), list });
  return list;
}

// item: { kind: 'jira', key, ...the row as shown } or { kind: 'todo', text, p, due }.
// change: { skill, repo } picked with Change, remembered for the Jira project (todos: "personal").
async function planWith(item, change) {
  let ticket = null;
  if (item.kind === 'jira') {
    const r = await jiraCall((c) => jira.issueDetail(fetch, c, item.key));
    // Offline, the row's own fields still make a usable prompt.
    ticket = r.ok ? r.value : { key: item.key, summary: item.summary, status: item.status, p: item.p, due: item.due, labels: item.labels, project: { key: item.key.split('-')[0], name: item.project || '' } };
  }
  const scope = ticket ? ticket.project.key : 'personal';
  const saved = readJson(PLAN, {});
  if (change) { saved[scope] = { skill: change.skill, repo: change.repo }; writeJson(PLAN, saved); }
  const chosen = saved[scope] || {};
  const folder = plan.chooseFolder({ folders: folders(), project: ticket?.project, ticketKey: ticket?.key, remembered: chosen.repo });
  const skills = ticket ? skillsFor(folder.dir) : [];
  const skill = ticket ? plan.chooseSkill(skills, chosen.skill) : null;
  const args = plan.planArgs({ ticket, todo: ticket ? null : item, skill, folder });
  try {
    terminal.open({ cwd: folder.dir, bin: terminal.findClaude(), args, title: args[args.indexOf('-n') + 1] });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return {
    ok: true, scope, name: args[args.indexOf('-n') + 1],
    skill: skill ? skill.name : '', folder: folder.dir, why: folder.why, known: folder.known,
    choices: { skills: skills.map((s) => s.name), folders: [...new Set([folder.dir, ...folders().map((f) => f.dir)])] },
  };
}
handle('plan', (_e, item, change) => planWith(item, change));
handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? '' : r.filePaths[0];
});

// The smoke test sets ALLY_OPEN_LOG: links and clipboard writes go to that file, so a
// test run opens no browser and leaves the clipboard alone.
const OPEN_LOG = process.env.ALLY_OPEN_LOG || '';
const logOut = (kind, value) => fs.appendFileSync(OPEN_LOG, JSON.stringify({ kind, value }) + '\n');
const openExternal = (href) => (OPEN_LOG ? logOut('open', href) : shell.openExternal(href));
const copyText = (text) => (OPEN_LOG ? logOut('copy', text) : clipboard.writeText(text));

// Links to tickets and to Atlassian's token page. Nothing but web links.
on('open-url', (_e, url) => {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname))) openExternal(u.href);
  } catch {}
});

// ---- Update board: the projects and checklist items go to the clipboard, and the board
// opens at #board~paste, where one paste saves them in the page's own storage. No Claude.
handle('board:set', (_e, input) => {
  const url = Projects.boardAddress(input);
  if (!url) return { ok: false, error: 'Paste the board\'s address: https://claude.ai/artifact/…' };
  savePrefs({ boardUrl: url });
  return { ok: true, url };
});
handle('board:update', (_e, projects, todos) => {
  if (!prefs.boardUrl) return { ok: false, error: 'No board address yet.' };
  const data = Projects.boardData({
    projects: Array.isArray(projects) ? projects : readJson(PROJECTS, []),
    todos: Array.isArray(todos) ? todos : readJson(TODOS, []),
    jira: jiraCfg,
  });
  const text = JSON.stringify({ v: 1, at: new Date().toISOString(), sha: crypto.createHash('sha256').update(Projects.canonical(data)).digest('hex'), data });
  // The board keeps it in one db document, at most 256 KiB.
  if (text.length > 240000) return { ok: false, error: 'Too many checklist items to send at once.' };
  copyText(text);
  openExternal(`${prefs.boardUrl}#board~paste`);
  return { ok: true, projects: data.projects.length, items: data.todos.length };
});

// Wayland does not let a window place itself, so there the header is a native drag region.
const nativeDrag = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
// Jira tickets and Projects are off for a new install. An install from before the
// switch keeps what it already uses.
function initFeatures() {
  if (prefs.features) return;
  savePrefs({ features: { jira: !!jiraCfg, projects: readJson(PROJECTS, []).some((p) => !p.archived) } });
}
handle('init', () => (initFeatures(), { prefs, sessions, usage, nativeDrag, home: app.getPath('home'), todos: readJson(TODOS, []), jira: { ...jiraConfig.status(jiraCfg), ...jiraCache() }, ...initProjects() }));
function initProjects() {
  const projects = readJson(PROJECTS, []);
  return { projects, projectsData: projectsCache(Projects.jql(projects)), boardUrl: prefs.boardUrl || '' };
}
on('move', (_e, x, y) => { if (win && Number.isFinite(x) && Number.isFinite(y)) win.setPosition(Math.round(x), Math.round(y)); });
handle('focus', (_e, s) => (s && Number.isInteger(s.pid) && s.pid > 1 ? focusSession(s.pid, typeof s.cwd === 'string' ? s.cwd : '') : { ok: false, reason: 'Unknown session.' }));
on('usage:refresh', () => { refreshLimits(); refreshLogs(); });
on('todos:save', (_e, todos) => writeJson(TODOS, todos));
on('prefs:save', (_e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  const was = limitsOn();
  savePrefs(patch);
  if (limitsOn() && !was) { limitsRetryAt = 0; refreshLimits(); }
  if (!limitsOn() && was) clearLimits();
});
function setHeight(height) {
  win.setResizable(true);
  win.setSize(width(), height);
  win.setResizable(false);
}
// The width is a preference, set from the widget: the window itself stays locked.
on('width', (_e, value) => {
  savePrefs({ width: value });
  setHeight(win.getSize()[1]);
});
on('compact', (_e, compact) => {
  savePrefs({ compact });
  setHeight(compact ? COMPACT_HEIGHT : FULL_HEIGHT);
});
on('ask:size', (_e, height) => { if (win && height > 0) setHeight(Math.ceil(height)); });
on('ask:done', () => {
  if (!win) return;
  if (shownForAsk) win.destroy();
  else setHeight(prefs.compact ? COMPACT_HEIGHT : FULL_HEIGHT);
  shownForAsk = false;
});
// Picked up by the session's waiting PermissionRequest hook (hook/hook.js).
on('ask:answer', (_e, a) => {
  // Only an answer to a prompt that is waiting now, in the shape Claude Code expects.
  if (!a || typeof a.id !== 'string' || !/^[\w-]+$/.test(a.id) || !Number.isFinite(a.at)) return;
  if (!a.decision || !['allow', 'deny'].includes(a.decision.behavior)) return;
  const waiting = sessions.find((x) => x.id === a.id && x.ask && x.ask.at === a.at);
  if (!waiting) return;
  writeJson(path.join(HOME, 'answers', a.id + '.json'), { at: a.at, decision: a.decision });
});
on('pin', (_e, on) => win.setAlwaysOnTop(on, 'floating'));
on('quit', () => app.quit());

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.whenReady().then(() => {
    // A menu bar widget: no Dock icon on macOS.
    if (app.dock) app.dock.hide();
    // Windows only shows notifications from an app with this id set.
    if (process.platform === 'win32') app.setAppUserModelId(process.execPath);
    // The page needs no browser permission (camera, location, ...): refuse them all.
    require('electron').session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
    require('electron').session.defaultSession.setPermissionCheckHandler(() => false);
    if (limitsOn()) usage.limits = readJson(LIMITS, null);
    // safeStorage works only once the app is ready.
    jiraCfg = connect(jiraConfig.load(JIRA, crypt));
    createWindow();
    createTray();
    watchSessions();
    refreshLogs();
    refreshLimits();
    setInterval(refreshLogs, LOGS_EVERY);
    setInterval(refreshLimits, LIMITS_EVERY);
  });
  // The app lives in the top bar: it keeps running with the widget hidden.
  app.on('window-all-closed', () => {});
}
