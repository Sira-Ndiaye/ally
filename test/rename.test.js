'use strict';
// Upgrading from Claude Meter, Ally's former name: data, hooks and launch entries.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { migrate } = require('../src/home');

const SCRIPTS = path.resolve(__dirname, '..', 'scripts');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ally-rename-'));
const put = (f, s = '') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const read = (f) => fs.readFileSync(f, 'utf8');
const run = (home, script, ...args) => spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
  env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData') },
  encoding: 'utf8',
});

test('migrate moves the old data folder when there is no new one', () => {
  const t = tmp();
  const from = path.join(t, '.claude-meter');
  const to = path.join(t, '.ally');
  put(path.join(from, 'todos.json'), '[1]');
  put(path.join(from, 'sessions', 'a.json'), '{}');
  assert.equal(migrate(from, to), true);
  assert.equal(read(path.join(to, 'todos.json')), '[1]');
  assert.ok(fs.existsSync(path.join(to, 'sessions', 'a.json')));
  assert.ok(!fs.existsSync(from));
});

test('migrate merges into a new folder the hooks already created, keeping its files', () => {
  const t = tmp();
  const from = path.join(t, '.claude-meter');
  const to = path.join(t, '.ally');
  put(path.join(from, 'todos.json'), 'old todos');
  put(path.join(from, 'sessions', 'a.json'), 'old a');
  put(path.join(from, 'sessions', 'b.json'), 'old b');
  put(path.join(to, 'sessions', 'b.json'), 'new b');
  migrate(from, to);
  assert.equal(read(path.join(to, 'todos.json')), 'old todos');
  assert.equal(read(path.join(to, 'sessions', 'a.json')), 'old a');
  assert.equal(read(path.join(to, 'sessions', 'b.json')), 'new b');
  // The old copy of b lost to the new one; nothing of the old folder stays behind.
  assert.ok(!fs.existsSync(from));
});

test('migrate does nothing without an old folder', () => {
  const t = tmp();
  assert.equal(migrate(path.join(t, '.claude-meter'), path.join(t, '.ally')), false);
  assert.ok(!fs.existsSync(path.join(t, '.ally')));
});

test('the hooks installer replaces Claude Meter hooks and leaves others alone', () => {
  const t = tmp();
  const settings = path.join(t, '.claude', 'settings.json');
  const group = (command) => ({ hooks: [{ type: 'command', command }] });
  put(settings, JSON.stringify({ hooks: {
    Stop: [group('"node" "/old/claude-meter/hook/hook.js"'), group('say done')],
    SessionEnd: [group('"node" "C:/old/claude-meter/hook/hook.js"')],
  } }));
  assert.equal(run(t, 'install-hooks.js', '--apply').status, 0);
  const hooks = JSON.parse(read(settings)).hooks;
  const commands = (ev) => hooks[ev].map((g) => g.hooks[0].command);
  assert.equal(commands('Stop').length, 2);
  assert.equal(commands('Stop')[0], 'say done');
  assert.match(commands('Stop')[1], /hook[\\/]hook\.js" ally$/);
  assert.equal(commands('SessionEnd').length, 1);

  // Running it again changes nothing; removing it leaves only the user's own hook.
  assert.match(run(t, 'install-hooks.js', '--apply').stdout, /Nothing to change/);
  assert.equal(run(t, 'install-hooks.js', '--remove', '--apply').status, 0);
  assert.deepStrictEqual(JSON.parse(read(settings)).hooks, { Stop: [group('say done')] });
});

test('removing launch entries also removes the Claude Meter ones', () => {
  const t = tmp();
  const legacy = {
    linux: [['.local', 'share', 'applications', 'claude-meter.desktop'], ['.config', 'autostart', 'claude-meter.desktop']],
    darwin: [['Library', 'LaunchAgents', 'com.claude-meter.plist']],
    win32: [['AppData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Claude Meter.lnk'],
      ['AppData', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'Claude Meter.lnk']],
  }[process.platform].map((p) => path.join(t, ...p));
  const launcher = path.join(t, '.local', 'bin', 'claude-meter');
  const other = path.join(t, '.local', 'bin', 'other');
  legacy.forEach((f) => put(f));
  put(launcher, '#!/bin/sh\nexec "/usr/bin/node" "/old/claude-meter/bin/cli.js" "$@"\n');
  put(other);
  assert.equal(run(t, 'install-desktop.js', '--remove').status, 0);
  for (const f of [...legacy, launcher]) assert.ok(!fs.existsSync(f), f);
  assert.ok(fs.existsSync(other));
});
