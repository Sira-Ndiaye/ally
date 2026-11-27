'use strict';
// A stand-in for Atlassian on this computer: the MCP endpoint's metadata, a sign-in
// server (registration, consent, PKCE-checked tokens, rotating refresh tokens) and the
// MCP server with the Jira tools Ally calls. Used by the unit tests and the smoke test.
const http = require('http');
const crypto = require('crypto');

function fakeAtlassian({ scopes = 'read:me read:account offline_access read:jira:agent-interface search:jira:agent-interface write:jira:agent-interface', issues = [], deny = false } = {}) {
  const state = { calls: [], codes: new Map(), access: new Set(), refresh: new Set(), clients: new Set(), registered: [], expire: false, issues };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    let body = '';
    for await (const c of req) body += c;
    const send = (status, obj, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(typeof obj === 'string' ? obj : JSON.stringify(obj)); };
    const base = `http://127.0.0.1:${server.address().port}`;
    if (u.pathname === '/.well-known/oauth-protected-resource/v2/mcp') return send(200, { resource: `${base}/v2/mcp`, authorization_servers: [`${base}/tenant`] });
    if (u.pathname === '/.well-known/oauth-authorization-server/tenant') {
      return send(200, { issuer: `${base}/tenant`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/tenant/dcr/register`, code_challenge_methods_supported: ['S256'] });
    }
    if (u.pathname === '/tenant/dcr/register' && req.method === 'POST') {
      const b = JSON.parse(body);
      state.registered.push(b);
      const id = 'client-' + state.registered.length;
      state.clients.add(id);
      return send(201, { client_id: id, redirect_uris: b.redirect_uris, token_endpoint_auth_method: 'none' });
    }
    // Consent: answered at once, as if you clicked Allow (or Deny).
    if (u.pathname === '/authorize') {
      const back = new URL(u.searchParams.get('redirect_uri'));
      if (deny) back.searchParams.set('error', 'access_denied');
      else {
        const code = 'code-' + crypto.randomBytes(4).toString('hex');
        state.codes.set(code, { challenge: u.searchParams.get('code_challenge'), client: u.searchParams.get('client_id'), redirect: u.searchParams.get('redirect_uri') });
        back.searchParams.set('code', code);
      }
      back.searchParams.set('state', u.searchParams.get('state'));
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (u.pathname === '/oauth/token' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      const issue = () => {
        const access = 'acc-' + crypto.randomBytes(4).toString('hex');
        const refresh = 'ref-' + crypto.randomBytes(4).toString('hex');
        state.access.add(access);
        state.refresh.add(refresh);
        return send(200, { access_token: access, refresh_token: refresh, expires_in: 28800, scope: scopes, token_type: 'Bearer' });
      };
      if (f.get('grant_type') === 'authorization_code') {
        const c = state.codes.get(f.get('code'));
        const ok = c && c.client === f.get('client_id') && c.redirect === f.get('redirect_uri') &&
          crypto.createHash('sha256').update(f.get('code_verifier') || '').digest('base64url') === c.challenge;
        state.codes.delete(f.get('code'));
        return ok ? issue() : send(400, { error: 'invalid_grant' });
      }
      if (f.get('grant_type') === 'refresh_token') {
        // Each refresh token works once: a new one comes with each renewal.
        if (!state.refresh.delete(f.get('refresh_token')) || !state.clients.has(f.get('client_id'))) return send(400, { error: 'invalid_grant' });
        return issue();
      }
      return send(400, { error: 'unsupported_grant_type' });
    }
    if (u.pathname === '/v2/mcp' && req.method === 'POST') {
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (!state.access.has(token) || state.expire) { state.expire = false; state.access.delete(token); return send(401, { error: 'invalid_token' }); }
      const m = JSON.parse(body);
      if (!m.id) { res.writeHead(202); return res.end(); }
      const reply = (result) => send(200, { jsonrpc: '2.0', id: m.id, result }, { 'mcp-session-id': 's1' });
      if (m.method === 'initialize') return reply({ protocolVersion: '2025-06-18', serverInfo: { name: 'fake-atlassian', version: '0' }, capabilities: { tools: {} } });
      if (m.method !== 'tools/call') return send(200, { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no such method' } });
      const { name, arguments: a } = m.params;
      state.calls.push({ name, args: a });
      const text = (data) => reply({ content: [{ type: 'text', text: JSON.stringify({ data }) }] });
      const op = name === 'executeRead' || name === 'executeWrite' ? a.name : name;
      switch (op) {
        case 'getAccessibleAtlassianResources': return text({ resources: [{ id: 'cloud-1', url: 'https://acme.atlassian.net', name: 'acme' }] });
        case 'atlassianUserInfo': return text({ accountId: 'me' });
        case 'searchJiraIssuesUsingJql': return text({ issues: state.issues, isLast: true });
        case 'listJiraIssueTransitions': return text({ transitions: [{ id: '31', name: 'Done', to: { name: 'Terminé', statusCategory: { key: 'done' } } }] });
        case 'transitionJiraIssue': return text({ status: 'Terminé' });
        case 'watchJiraIssue': return text({ watching: a.inputs.action !== 'unwatch' });
        case 'listJiraProjectIssueTypesMetadata': return text({ issueTypes: [{ id: '10003', name: 'Tâche', subtask: false }, { id: '10000', name: 'Épopée', subtask: false }, { id: '10009', name: 'Sous-tâche', subtask: true }] });
        case 'getJiraIssueTypeMetaWithFields': return text({ fields: [{ fieldId: 'duedate' }, { fieldId: 'assignee' }, { fieldId: 'priority', allowedValues: [{ id: '2', name: 'Haute' }, { id: '3', name: 'Moyenne' }, { id: '4', name: 'Basse' }] }] });
        case 'createJiraIssue': return text({ key: `${a.projectKey}-77` });
        case 'getJiraIssue': return text({ key: a.issueIdOrKey, fields: { summary: 'Retry', status: { name: 'En cours' }, description: 'Line one.\n\n\n\nLine two.', project: { key: 'ACME', name: 'Acme' }, labels: [] } });
        default: return reply({ isError: true, content: [{ type: 'text', text: `unknown tool ${op}` }] });
      }
    }
    send(404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    resolve({ server, state, base, mcp: `${base}/v2/mcp`, close: () => new Promise((r) => server.close(r)) });
  }));
}

module.exports = { fakeAtlassian };
