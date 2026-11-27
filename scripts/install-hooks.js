#!/usr/bin/env node
'use strict';
// Adds (or with --remove, removes) the Ally hooks in ~/.claude/settings.json.
// Without --apply it only prints what would change. Existing hooks are left untouched.
const fs = require('fs');
const os = require('os');
const path = require('path');

const EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop', 'SessionEnd'];
// The PermissionRequest hook stays alive until the prompt is answered, in the widget or the terminal.
const TIMEOUT = { PermissionRequest: 12 * 3600 };
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const hookPath = path.resolve(__dirname, '..', 'hook', 'hook.js');
// Claude Code runs hooks through Git Bash on Windows, where forward slashes are the safe form.
// Inside double quotes the shell still reads \ " $ and `: those are escaped.
const quote = (p) => `"${(process.platform === 'win32' ? p.replace(/\\/g, '/') : p).replace(/[\\"$`]/g, '\\$&')}"`;
// The trailing word marks the hook as Ally's, wherever the package or checkout lives.
const command = `${quote(process.execPath)} ${quote(hookPath)} ally`;

const apply = process.argv.includes('--apply');
const remove = process.argv.includes('--remove');

const raw = fs.existsSync(settingsPath) ? fs.readFileSync(settingsPath, 'utf8') : '{}';
const settings = JSON.parse(raw);
settings.hooks = settings.hooks || {};

// Claude Meter, Ally's former name, had no marker: its hooks are known by their path.
const isOursCommand = (c) => /hook[\\/]hook\.js" ally$/.test(c) || (c.includes('claude-meter') && /hook[\\/]hook\.js"?$/.test(c));
const isOurs = (group) => (group.hooks || []).some((h) => isOursCommand(h.command || ''));

for (const ev of EVENTS) {
  const groups = (settings.hooks[ev] || []).filter((g) => !isOurs(g));
  if (!remove) groups.push({ hooks: [{ type: 'command', command, timeout: TIMEOUT[ev] || 5 }] });
  if (groups.length) settings.hooks[ev] = groups;
  else delete settings.hooks[ev];
}

const out = JSON.stringify(settings, null, 2) + '\n';
if (out === raw) {
  console.log('Nothing to change.');
  process.exit(0);
}

console.log(`${remove ? 'Removing' : 'Adding'} Ally hooks for: ${EVENTS.join(', ')}`);
console.log(`Command: ${command}`);
if (!apply) {
  console.log(`\nPreview only. Run with --apply to write ${settingsPath} (a backup is made first).`);
  process.exit(0);
}

const backup = `${settingsPath}.bak-ally-${Date.now()}`;
const existed = fs.existsSync(settingsPath);
if (existed) fs.copyFileSync(settingsPath, backup);
// The folder is missing when Claude Code has not run yet on this machine.
fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
fs.writeFileSync(settingsPath, out);
console.log(existed ? `Written. Backup: ${backup}` : 'Written.');
