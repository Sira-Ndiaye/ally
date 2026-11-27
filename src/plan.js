'use strict';
// Plan with Claude: which skill, which folder, which mode, and the prompt. Everything is
// read from local files, so deciding costs no Claude tokens and takes milliseconds.
// Rules (docs/jira-projects-design.html, 1b), each taking the first that answers:
//   skill   the one chosen with Change for this Jira project; else a skill whose name, then
//           description, says Jira or ticket (repository first, then yours, then plugins);
//           else the built-in planning prompt.
//   folder  the one chosen with Change; else a folder where Claude Code ran with a git branch
//           named after this ticket, then after the project's tickets; else a folder named
//           like the project; else the home folder, and the prompt says it is unknown.
//   mode    built-in prompt: plan mode. A skill: normal mode, so it can write its plan file.
const fs = require('fs');
const os = require('os');
const path = require('path');

const readHead = (file, bytes = 8192) => {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(bytes);
    return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, bytes, 0));
  } catch { return ''; } finally { if (fd !== undefined) fs.closeSync(fd); }
};
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const list = (p) => { try { return fs.readdirSync(p); } catch { return []; } };

// ---- folders where Claude Code ran, most recent first
// Each ~/.claude/projects/<folder> holds session logs whose lines carry the real `cwd`.
function claudeFolders(claudeDir = path.join(os.homedir(), '.claude')) {
  const seen = new Map();
  const root = path.join(claudeDir, 'projects');
  for (const sub of list(root)) {
    const logs = list(path.join(root, sub)).filter((f) => f.endsWith('.jsonl'))
      .map((f) => { const p = path.join(root, sub, f); try { return { p, at: fs.statSync(p).mtimeMs }; } catch { return null; } })
      .filter(Boolean).sort((a, b) => b.at - a.at);
    if (!logs.length) continue;
    const m = /"cwd":("(?:[^"\\]|\\.)*")/.exec(readHead(logs[0].p, 65536));
    if (!m) continue;
    let dir;
    try { dir = JSON.parse(m[1]); } catch { continue; }
    if (isDir(dir) && (seen.get(dir) || 0) < logs[0].at) seen.set(dir, logs[0].at);
  }
  return [...seen].map(([dir, at]) => ({ dir, at })).sort((a, b) => b.at - a.at);
}

// Local branch names, read from the repository's files (no git process).
function branches(dir) {
  let gd = path.join(dir, '.git');
  try {
    if (fs.statSync(gd).isFile()) {
      const m = /gitdir:\s*(.+)/.exec(fs.readFileSync(gd, 'utf8'));
      if (!m) return null;
      gd = path.resolve(dir, m[1].trim());
    }
  } catch { return null; }
  // A worktree keeps its branches in the main repository.
  let common = gd;
  try { common = path.resolve(gd, fs.readFileSync(path.join(gd, 'commondir'), 'utf8').trim()); } catch {}
  const names = new Set();
  const walk = (d, prefix) => {
    for (const n of list(d)) {
      const p = path.join(d, n);
      if (isDir(p)) walk(p, prefix + n + '/');
      else names.add(prefix + n);
    }
  };
  walk(path.join(common, 'refs', 'heads'), '');
  for (const line of readHead(path.join(common, 'packed-refs'), 1 << 20).split('\n')) {
    const m = /^[0-9a-f]{40,64} refs\/heads\/(.+)$/.exec(line.trim());
    if (m) names.add(m[1]);
  }
  return [...names];
}

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function chooseFolder({ folders, project, ticketKey, remembered, home = os.homedir() }) {
  if (remembered && isDir(remembered)) return { dir: remembered, why: 'your choice', known: true };
  if (project?.key) {
    const forProject = new RegExp(`(^|[/_-])${escRe(project.key)}-\\d+`, 'i');
    const forTicket = ticketKey ? new RegExp(`(^|[/_-])${escRe(ticketKey)}(?!\\d)`, 'i') : null;
    // A branch for this very ticket first, then the most branches for the project, then the latest used.
    const [best] = folders.map((f) => {
      const b = branches(f.dir) || [];
      return { f, exact: !!forTicket && b.some((x) => forTicket.test(x)), count: b.filter((x) => forProject.test(x)).length };
    }).filter((c) => c.count).sort((a, b) => b.exact - a.exact || b.count - a.count || b.f.at - a.f.at);
    if (best) return { dir: best.f.dir, why: best.exact ? `has a ${ticketKey} branch` : `has ${project.key} branches`, known: true };
    const named = folders.find((f) => [project.key, project.name].some((n) => n && norm(path.basename(f.dir)) === norm(n)));
    if (named) return { dir: named.dir, why: `named like ${project.key}`, known: true };
  }
  return { dir: home, why: 'repository unknown', known: false };
}

// ---- skills
// Reads `name:` and `description:` from a SKILL.md or command file's front matter.
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (v === '>' || v === '|' || v === '>-' || v === '|-') {
      const more = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) more.push(lines[++i].trim());
      v = more.join(' ');
    }
    out[kv[1]] = v.replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

function skillsIn(base, source, prefix = '') {
  const out = [];
  for (const n of list(path.join(base, 'skills'))) {
    const fm = frontMatter(readHead(path.join(base, 'skills', n, 'SKILL.md')));
    if (fm.name || fs.existsSync(path.join(base, 'skills', n, 'SKILL.md'))) out.push({ name: prefix + (fm.name || n), description: fm.description || '', source });
  }
  for (const n of list(path.join(base, 'commands')).filter((f) => f.endsWith('.md'))) {
    const fm = frontMatter(readHead(path.join(base, 'commands', n)));
    out.push({ name: prefix + n.slice(0, -3), description: fm.description || '', source });
  }
  return out;
}

function pluginSkills(claudeDir) {
  let installed = {};
  try { installed = JSON.parse(fs.readFileSync(path.join(claudeDir, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {}; } catch {}
  const out = [];
  for (const [id, copies] of Object.entries(installed)) {
    const dir = (copies || [])[0]?.installPath;
    if (dir) out.push(...skillsIn(dir, 'plugin', id.split('@')[0] + ':'));
  }
  return out;
}

// Repository first, then yours, then plugins.
function allSkills(repo, claudeDir = path.join(os.homedir(), '.claude')) {
  return [
    ...(repo ? skillsIn(path.join(repo, '.claude'), 'repo') : []),
    ...skillsIn(claudeDir, 'own'),
    ...pluginSkills(claudeDir),
  ];
}

const JIRA_WORD = /\b(jira|tickets?)\b/i;

// remembered: a skill name, '' for the built-in prompt chosen with Change, undefined for none.
function chooseSkill(skills, remembered) {
  if (remembered === '') return null;
  if (remembered) {
    const s = skills.find((x) => x.name === remembered);
    if (s) return s;
  }
  return skills.find((s) => JIRA_WORD.test(s.name.replace(/[-_:]/g, ' '))) || skills.find((s) => JIRA_WORD.test(s.description)) || null;
}

// ---- the prompt
const MAX_DESCRIPTION = 2500;

function ticketBlock(t) {
  const lines = [`Title: ${t.summary}`, `Status: ${[t.status, t.p, t.due && 'due ' + t.due].filter(Boolean).join(' · ')}`];
  if (t.type) lines.push(`Type: ${t.type}`);
  if (t.parent) lines.push(`Parent: ${t.parent}`);
  if (t.labels?.length) lines.push(`Labels: ${t.labels.join(', ')}`);
  if (t.links?.length) lines.push(`Links: ${t.links.join(', ')}`);
  if (t.description) {
    const d = t.description.length > MAX_DESCRIPTION ? t.description.slice(0, MAX_DESCRIPTION) + '…' : t.description;
    lines.push('Description:', d);
  }
  return lines.join('\n');
}

const UNKNOWN_REPO = 'The repository for this is unknown: you are in the home folder. Ask which repository to use before reading code.';

// Arguments for `claude`: the session is named after the ticket so it shows in Sessions.
function planArgs({ ticket, todo, skill, folder }) {
  const name = ticket ? ticket.key : 'todo-' + norm(todo.text).slice(0, 24);
  const unknown = folder.known ? '' : '\n\n' + UNKNOWN_REPO;
  if (ticket && skill) {
    return ['-n', name, `/${skill.name} ${ticket.key}\n\nTicket, so you need not fetch it:\n${ticketBlock(ticket)}${unknown}`];
  }
  const what = ticket
    ? `Plan the work for Jira ticket ${ticket.key}. Here it is, so you need not fetch it:\n${ticketBlock(ticket)}`
    : `Plan this task: ${todo.text}\n${[todo.p, todo.due && 'due ' + todo.due].filter(Boolean).join(' · ')}`;
  return ['--permission-mode', 'plan', '-n', name, `${what}\n\nRead the code you need, then write a step-by-step plan. Do not edit files.${unknown}`];
}

module.exports = { claudeFolders, branches, chooseFolder, frontMatter, skillsIn, allSkills, chooseSkill, ticketBlock, planArgs, UNKNOWN_REPO };
