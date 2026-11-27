'use strict';
// Sign in with Atlassian: Ally talks to Jira through Atlassian's MCP server, signed in as
// you, instead of with an API token. No secret ships with Ally:
//   1. the MCP endpoint names its sign-in server (OAuth protected-resource metadata);
//   2. Ally registers itself there (dynamic client registration, no client secret);
//   3. your browser shows Atlassian's consent page; you choose what Ally may do;
//   4. Ally gets an access token (kept in memory, about 8 hours) and a refresh token
//      (kept encrypted like the API token), which renews it without the browser.
// Then jira.js makes the same requests as with a token, and `rest()` turns each one
// into the matching MCP tool. The answers have Jira's REST shapes inside { data }.
const http = require('http');
const crypto = require('crypto');

const MCP_URL = 'https://mcp.atlassian.com/v2/mcp';
const WRITE = 'write:jira:agent-interface';
// Jira only, who you are, and staying signed in. The consent page lets you leave out write.
const SCOPES = ['read:me', 'read:account', 'offline_access', 'read:jira:agent-interface', 'search:jira:agent-interface', WRITE];
const PROTOCOL = '2025-06-18';
const NO_WRITE = 'Ally was not given write access in Jira. Sign in again and allow it to move or create tickets.';
const ENDED = 'Your Atlassian sign-in has ended. Sign in again.';

class AtlassianError extends Error {
  constructor(message, status = 0) { super(message); this.status = status; }
}

const b64u = (b) => Buffer.from(b).toString('base64url');
const canWrite = (scopes) => String(scopes || '').split(/\s+/).includes(WRITE);

async function getJson(fetchImpl, url, opts = {}) {
  let r;
  try { r = await fetchImpl(url, { ...opts, signal: AbortSignal.timeout(15000) }); }
  catch { throw new AtlassianError(`Could not reach ${new URL(url).host}.`); }
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch {}
  return { status: r.status, ok: r.ok, body, text, headers: r.headers };
}

// The sign-in server for an MCP endpoint, as MCP clients find it.
async function discover(fetchImpl, mcpUrl = MCP_URL) {
  const u = new URL(mcpUrl);
  const prm = await getJson(fetchImpl, `${u.origin}/.well-known/oauth-protected-resource${u.pathname}`);
  const issuer = prm.body?.authorization_servers?.[0];
  if (!prm.ok || !issuer) throw new AtlassianError('Atlassian did not say where to sign in.');
  const i = new URL(issuer);
  const tries = [`${i.origin}/.well-known/oauth-authorization-server${i.pathname.replace(/\/$/, '')}`, `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`];
  for (const url of tries) {
    const m = await getJson(fetchImpl, url);
    if (m.ok && m.body?.authorization_endpoint && m.body?.token_endpoint) {
      if (!m.body.registration_endpoint) throw new AtlassianError('Atlassian does not let apps register here. Use an API token instead.');
      return { resource: prm.body.resource || mcpUrl, ...m.body };
    }
  }
  throw new AtlassianError('Atlassian\'s sign-in server did not describe itself.');
}

const form = (o) => new URLSearchParams(Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)));
function tokens(body, before = {}) {
  if (!body?.access_token) throw new AtlassianError(body?.error_description || body?.error || 'Atlassian gave no access token.');
  return {
    access: body.access_token,
    refresh: body.refresh_token || before.refresh,
    expiresAt: Date.now() + (Number(body.expires_in) || 3600) * 1000,
    scopes: body.scope ?? before.scopes ?? '',
  };
}

// The whole browser sign-in. `open(url)` shows Atlassian's page; resolves when you answer.
async function signIn({ fetchImpl = fetch, open, mcpUrl = MCP_URL, timeoutMs = 5 * 60000, page = donePage } = {}) {
  const meta = await discover(fetchImpl, mcpUrl);
  const server = http.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const redirect = `http://127.0.0.1:${server.address().port}/callback`;
  try {
    const reg = await getJson(fetchImpl, meta.registration_endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Ally', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', scope: SCOPES.join(' ') }),
    });
    if (!reg.ok || !reg.body?.client_id) throw new AtlassianError(`Atlassian refused to register Ally (${reg.status}). Your admin may block it: use an API token instead.`);
    const clientId = reg.body.client_id;
    const verifier = b64u(crypto.randomBytes(32));
    const state = b64u(crypto.randomBytes(16));
    const auth = new URL(meta.authorization_endpoint);
    const q = { response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', state, resource: meta.resource, scope: SCOPES.join(' '), prompt: 'consent' };
    for (const [k, v] of Object.entries(q)) auth.searchParams.set(k, v);
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new AtlassianError('No answer from the browser within 5 minutes. Try again.')), timeoutMs);
      server.on('request', (req, res) => {
        const u = new URL(req.url, redirect);
        if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
        const err = u.searchParams.get('error');
        const ok = !err && u.searchParams.get('state') === state && u.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(ok ? '' : u.searchParams.get('error_description') || err || 'The answer did not match this sign-in.'));
        clearTimeout(timer);
        if (ok) resolve(u.searchParams.get('code'));
        else reject(new AtlassianError(err === 'access_denied' ? 'You did not allow Ally in Atlassian.' : `Atlassian sign-in failed: ${u.searchParams.get('error_description') || err || 'state mismatch'}.`));
      });
      Promise.resolve(open(auth.href)).catch(() => {});
    });
    const t = await getJson(fetchImpl, meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, code_verifier: verifier, resource: meta.resource }) });
    if (!t.ok) throw new AtlassianError(`Atlassian did not finish the sign-in (${t.status}).`);
    return { clientId, tokenEndpoint: meta.token_endpoint, resource: meta.resource, mcp: mcpUrl, ...tokens(t.body) };
  } finally {
    server.close();
  }
}

function donePage(error) {
  const msg = error ? `Not signed in: ${error.replace(/[<>&]/g, '')}` : 'Signed in. You can close this tab and go back to Ally.';
  return `<!DOCTYPE html><meta charset="utf-8"><title>Ally</title><body style="font:16px system-ui;max-width:32em;margin:15vh auto;padding:0 1em;color:#222"><h2>Ally</h2><p>${msg}</p>`;
}

// ---- A signed-in connection. `onTokens(t)` is told each renewal, to keep the new
// refresh token (Atlassian hands out a new one each time).
class Connection {
  constructor({ fetchImpl = fetch, auth, onTokens = () => {} }) {
    this.fetch = fetchImpl;
    this.auth = { ...auth };
    this.onTokens = onTokens;
    this.session = '';
    this.ready = false;
    this.renewing = null;
    this.id = 1;
  }

  async renew() {
    if (!this.renewing) {
      this.renewing = (async () => {
        if (!this.auth.refresh) throw new AtlassianError(ENDED, 401);
        const r = await getJson(this.fetch, this.auth.tokenEndpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: this.auth.refresh, client_id: this.auth.clientId, resource: this.auth.resource }) });
        if (!r.ok) throw new AtlassianError(ENDED, 401);
        Object.assign(this.auth, tokens(r.body, this.auth));
        this.session = '';
        this.ready = false;
        this.onTokens({ refresh: this.auth.refresh, scopes: this.auth.scopes });
      })().finally(() => { this.renewing = null; });
    }
    return this.renewing;
  }

  async post(msg) {
    if (!this.auth.access || Date.now() > (this.auth.expiresAt || 0) - 60000) await this.renew();
    let r;
    try {
      r = await this.fetch(this.auth.mcp, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.auth.access}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL, ...(this.session ? { 'mcp-session-id': this.session } : {}) },
        body: JSON.stringify(msg),
        signal: AbortSignal.timeout(30000),
      });
    } catch { throw new AtlassianError(`Could not reach ${new URL(this.auth.mcp).host}.`); }
    this.session = r.headers.get('mcp-session-id') || this.session;
    return r;
  }

  // One JSON-RPC call. A refused token is renewed once; an expired session is reopened once.
  async rpc(method, params, retried = false) {
    if (!this.ready) await this.open();
    const r = await this.post({ jsonrpc: '2.0', id: this.id++, method, params });
    if ((r.status === 401 || r.status === 404) && !retried) {
      if (r.status === 401) await this.renew();
      this.session = '';
      this.ready = false;
      await this.open();
      return this.rpc(method, params, true);
    }
    const text = await r.text();
    if (r.status === 401) throw new AtlassianError(ENDED, 401);
    if (!r.ok) throw new AtlassianError(`Atlassian answered ${r.status}.`, r.status);
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('event-stream') ? text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean).pop() : text;
    let m;
    try { m = JSON.parse(data); } catch { throw new AtlassianError('Atlassian gave an answer Ally cannot read.'); }
    if (m.error) throw new AtlassianError(m.error.message || 'Atlassian refused the request.', 400);
    return m.result;
  }

  async open() {
    const r = await this.post({ jsonrpc: '2.0', id: this.id++, method: 'initialize', params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'ally', version: '1' } } });
    if (r.status === 401) { await this.renew(); return this.open(); }
    if (!r.ok) throw new AtlassianError(`Atlassian answered ${r.status}.`, r.status);
    await r.text();
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' }).then((x) => x.text()).catch(() => {});
    this.ready = true;
  }

  // A tool's answer: its text, parsed, with the { data } wrapper taken off.
  async tool(name, args) {
    const res = await this.rpc('tools/call', { name, arguments: args });
    const text = (res?.content || []).map((c) => c.text || '').join('\n');
    let v = res?.structuredContent ?? null;
    if (v == null) { try { v = JSON.parse(text); } catch { v = text; } }
    if (res?.isError) {
      const msg = (v && typeof v === 'object' && (v.error?.message || v.message || v.error)) || text || `${name} failed`;
      throw new AtlassianError(/scope|permission|forbidden|not allowed|unauthori[sz]ed/i.test(String(msg)) && !canWrite(this.auth.scopes) ? NO_WRITE : String(msg).slice(0, 300), 400);
    }
    return v && typeof v === 'object' && 'data' in v ? v.data : v;
  }
}

// Your Atlassian sites, as [{ id, url, name }].
async function sites(conn) {
  const v = await conn.tool('getAccessibleAtlassianResources', {});
  const list = Array.isArray(v) ? v : v?.resources || [];
  return list.filter((s) => s && (s.id || s.cloudId) && s.url).map((s) => ({ id: s.id || s.cloudId, url: String(s.url).replace(/\/$/, ''), name: s.name || new URL(s.url).host }));
}

// ---- jira.js's requests, as MCP tools. Anything else is refused, so nothing slips through.
const WRITES = new Set(['transition', 'watch', 'create', 'edit']);
function route(method, path, body) {
  const u = new URL(path, 'https://x');
  const p = u.pathname;
  let m;
  if (method === 'GET' && p === '/rest/api/3/myself') return { tool: 'atlassianUserInfo', args: {} };
  if (method === 'GET' && p === '/rest/api/3/field') return { none: true };
  if (method === 'POST' && p === '/rest/api/3/search/jql') return { tool: 'searchJiraIssuesUsingJql', args: { jql: body.jql, fields: body.fields, maxResults: body.maxResults, ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}) } };
  if ((m = /^\/rest\/api\/3\/issue\/([^/]+)\/transitions$/.exec(p))) {
    const key = decodeURIComponent(m[1]);
    return method === 'GET'
      ? { tool: 'executeRead', args: { name: 'listJiraIssueTransitions', inputs: { issueIdOrKey: key } } }
      : { tool: 'transitionJiraIssue', args: { issueIdOrKey: key, transitionId: String(body.transition.id) }, write: 'transition' };
  }
  if ((m = /^\/rest\/api\/3\/issue\/([^/]+)\/watchers$/.exec(p))) {
    return { tool: 'executeWrite', args: { name: 'watchJiraIssue', inputs: { issueIdOrKey: decodeURIComponent(m[1]), action: method === 'DELETE' ? 'unwatch' : 'watch' } }, write: 'watch' };
  }
  if (method === 'GET' && (m = /^\/rest\/api\/3\/issue\/createmeta\/([^/]+)\/issuetypes(?:\/([^/]+))?$/.exec(p))) {
    const project = decodeURIComponent(m[1]);
    return m[2]
      ? { tool: 'executeRead', args: { name: 'getJiraIssueTypeMetaWithFields', inputs: { projectIdOrKey: project, issueTypeId: decodeURIComponent(m[2]), requiredFieldsOnly: false, maxResults: 200 } } }
      : { tool: 'executeRead', args: { name: 'listJiraProjectIssueTypesMetadata', inputs: { projectIdOrKey: project, maxResults: 200 } } };
  }
  if (method === 'GET' && (m = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(p))) {
    const fields = (u.searchParams.get('fields') || '').split(',').filter(Boolean);
    return { tool: 'getJiraIssue', args: { issueIdOrKey: decodeURIComponent(m[1]), ...(fields.length ? { fields, fieldsByKeys: true } : {}), responseContentFormat: 'markdown' } };
  }
  if (method === 'PUT' && (m = /^\/rest\/api\/3\/issue\/([^/]+)$/.exec(p))) {
    return { tool: 'editJiraIssue', args: { issueIdOrKey: decodeURIComponent(m[1]), fields: body.fields }, write: 'edit' };
  }
  if (method === 'POST' && p === '/rest/api/3/issue') {
    const f = body.fields;
    const extra = {};
    if (f.duedate) extra.duedate = f.duedate;
    return { tool: 'createJiraIssue', write: 'create', args: {
      projectKey: f.project.key, summary: f.summary, issueType: f.issuetype.name || f.issuetype.id,
      ...(f.assignee?.accountId ? { assignee: f.assignee.accountId } : {}),
      ...(f.priority?.name ? { priority: f.priority.name } : {}),
      ...(f.parent?.key ? { parent: f.parent.key } : {}),
      ...(Object.keys(extra).length ? { additional_fields: extra } : {}),
    } };
  }
  return null;
}

// jira.js's `request`, when you signed in with Atlassian.
async function rest(conn, cloudId, method, path, body) {
  const r = route(method, path, body);
  if (!r) throw new AtlassianError(`Ally cannot do ${method} ${path.split('?')[0]} through Atlassian sign-in.`, 400);
  if (r.none) throw new AtlassianError('Not available through Atlassian sign-in.', 404);
  if (r.write && !canWrite(conn.auth.scopes)) throw new AtlassianError(NO_WRITE, 403);
  const v = await conn.tool(r.tool, { cloudId, ...r.args });
  if (r.write === 'create') return { key: v?.key || v?.issue?.key || (typeof v === 'string' ? (/\b[A-Z][A-Z0-9_]*-\d+\b/.exec(v) || [])[0] : undefined) };
  return v;
}

module.exports = { MCP_URL, SCOPES, WRITE, NO_WRITE, AtlassianError, canWrite, discover, signIn, Connection, sites, route, rest };
