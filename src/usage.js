'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const { StringDecoder } = require('string_decoder');

const CREDENTIALS = path.join(os.homedir(), '.claude', '.credentials.json');
// Undocumented endpoint used by Claude Code's /usage. Read-only; we never refresh the
// token ourselves, since rotating it could log Claude Code out.
const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const HOUR = 3600 * 1000;
const CHUNK = 256 * 1024;

function labelFor(l) {
  if (l.kind === 'session') return 'Session · 5h';
  if (l.kind === 'weekly_all') return 'Weekly · all models';
  if (l.kind === 'weekly_scoped') return 'Weekly · ' + (l.scope?.model?.display_name || 'scoped');
  return l.kind;
}

function toLimits(json) {
  if (Array.isArray(json.limits)) {
    return json.limits.map((l) => ({ label: labelFor(l), percent: l.percent, severity: l.severity, resetsAt: l.resets_at }));
  }
  return [['Session · 5h', json.five_hour], ['Weekly · all models', json.seven_day]]
    .filter(([, v]) => v)
    .map(([label, v]) => ({ label, percent: Math.round(v.utilization), resetsAt: v.resets_at }));
}

// macOS keeps the Claude Code login in the Keychain instead of the credentials file.
function keychainCredentials() {
  return new Promise((resolve) => {
    execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 30000 }, (err, out) => {
      try { resolve(err ? null : JSON.parse(out).claudeAiOauth); } catch { resolve(null); }
    });
  });
}

async function fetchLimits() {
  let cred;
  try { cred = JSON.parse(fs.readFileSync(CREDENTIALS, 'utf8')).claudeAiOauth; } catch {}
  if (!cred && process.platform === 'darwin') cred = await keychainCredentials();
  if (!cred?.accessToken) return { error: 'Log in to Claude Code to see your limits.' };
  if (cred.expiresAt && cred.expiresAt < Date.now()) return { error: 'Login expired. Open Claude Code to refresh it.', plan: cred.subscriptionType };
  try {
    const r = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${cred.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const retryAfter = r.status === 429 ? Number(r.headers.get('retry-after')) || 300 : 0;
      return { error: `Limits unavailable (HTTP ${r.status}).`, plan: cred.subscriptionType, retryAfter };
    }
    return { plan: cred.subscriptionType, limits: toLimits(await r.json()), at: Date.now() };
  } catch (e) {
    return { error: 'Limits unavailable (offline?).', plan: cred.subscriptionType };
  }
}

// One entry per assistant message. Claude Code writes one line per content block with the
// same usage, so callers must dedupe on the returned key.
function entryFromLine(line) {
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  const u = o?.message?.usage;
  if (o.type !== 'assistant' || !u) return null;
  const ts = Date.parse(o.timestamp);
  if (!ts) return null;
  return {
    key: o.message.id || o.requestId,
    ts,
    // Cache reads are excluded: they re-count the same context on every turn.
    tokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0),
  };
}

function startOfDay(now) { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); }

function summarize(entries, now) {
  const today = startOfDay(now);
  const hours = new Array(12).fill(0);
  let tokens = 0;
  let messages = 0;
  for (const e of entries) {
    if (e.ts >= today) { tokens += e.tokens; messages++; }
    const h = Math.floor((now - e.ts) / HOUR);
    if (h >= 0 && h < 12) hours[11 - h] += e.tokens;
  }
  return { tokens, messages, hours };
}

class LogScanner {
  constructor(root = path.join(os.homedir(), '.claude', 'projects')) {
    this.root = root;
    this.offsets = new Map();
    this.entries = new Map();
  }

  files(dir, since, out = []) {
    let list = [];
    try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
    for (const d of list) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) this.files(p, since, out);
      else if (d.name.endsWith('.jsonl')) {
        try { const st = fs.statSync(p); if (st.mtimeMs >= since) out.push([p, st.size]); } catch {}
      }
    }
    return out;
  }

  readNew(file, size) {
    let { offset = 0, rest = '' } = this.offsets.get(file) || {};
    if (size < offset) { offset = 0; rest = ''; }
    if (size === offset) return;
    const fd = fs.openSync(file, 'r');
    try {
      // Fixed-size chunks: a first scan of a multi-MB log must not load it whole.
      const buf = Buffer.alloc(Math.min(CHUNK, size - offset));
      const decoder = new StringDecoder('utf8');
      while (offset < size) {
        const n = fs.readSync(fd, buf, 0, Math.min(buf.length, size - offset), offset);
        if (!n) break;
        offset += n;
        const lines = (rest + decoder.write(buf.subarray(0, n))).split('\n');
        rest = lines.pop();
        for (const line of lines) {
          if (!line.includes('"usage"')) continue;
          const e = entryFromLine(line);
          if (e && !this.entries.has(e.key)) this.entries.set(e.key, e);
        }
      }
    } finally { fs.closeSync(fd); }
    this.offsets.set(file, { offset, rest });
  }

  scan(now = Date.now()) {
    const since = Math.min(startOfDay(now), now - 12 * HOUR);
    for (const [file, size] of this.files(this.root, since)) {
      try { this.readNew(file, size); } catch {}
    }
    for (const [k, e] of this.entries) if (e.ts < since) this.entries.delete(k);
    return summarize(this.entries.values(), now);
  }
}

module.exports = { fetchLimits, toLimits, entryFromLine, summarize, LogScanner };
