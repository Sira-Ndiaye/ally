'use strict';
// ~/.ally/jira.json: the site, followed labels, and how Ally signs in to Jira: your
// Atlassian sign-in (auth: 'oauth', with its refresh token) or an email and API token.
// Secrets are encrypted with the system keychain (Electron safeStorage). Without a
// keychain (some Linux setups) they are kept as plain text and the settings form says so.
// `crypt` is Electron's safeStorage in the app and a stand-in in the tests.
const fs = require('fs');
const path = require('path');

// Secrets kept encrypted: the API token, or the Atlassian sign-in's refresh token.
const SECRETS = ['token', 'refresh'];

function load(file, crypt) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  const out = { ...raw, labels: Array.isArray(raw.labels) ? raw.labels : [] };
  let plain = false;
  for (const k of SECRETS) {
    let v = '';
    try {
      if (raw[k]?.enc) v = crypt.decryptString(Buffer.from(raw[k].enc, 'base64'));
      else if (raw[k]?.plain) { v = raw[k].plain; plain = true; }
    } catch { v = ''; }
    out[k] = v;
  }
  out.plain = plain;
  return out;
}

// `conn` (the live Atlassian connection) and `plain` are never written.
function save(file, cfg, crypt) {
  const { plain: _plain, conn: _conn, ...rest } = cfg;
  const encrypt = crypt.isEncryptionAvailable();
  let plain = false;
  for (const k of SECRETS) {
    if (!rest[k]) { delete rest[k]; continue; }
    rest[k] = encrypt ? { enc: crypt.encryptString(rest[k]).toString('base64') } : { plain: rest[k] };
    plain = plain || !encrypt;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(rest, null, 2), { mode: 0o600 });
  return { ...cfg, plain };
}

// What the widget may see: never a token. `write` is false when you signed in with
// Atlassian and did not allow write access.
const WRITE = 'write:jira:agent-interface';
const status = (cfg) => (cfg
  ? {
    configured: true, site: cfg.site, email: cfg.email || '', name: cfg.name || '', labels: cfg.labels, plain: cfg.plain,
    auth: cfg.auth === 'oauth' ? 'oauth' : 'token',
    write: cfg.auth === 'oauth' ? String(cfg.scopes || '').split(/\s+/).includes(WRITE) : true,
  }
  : { configured: false, labels: [] });

module.exports = { load, save, status };
