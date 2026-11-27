'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = path.join(__dirname, '..', 'board');

test('the board page loads projects.js, then its own script, and both compile', () => {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(scripts, ['projects.js', 'board.js']);
  assert.ok(html.includes('href="board.css"'));
  new vm.Script(fs.readFileSync(path.join(dir, 'board.js'), 'utf8'), { filename: 'board.js' });
});

test('the board reads the connector and the db paths the design names', () => {
  const js = fs.readFileSync(path.join(dir, 'board.js'), 'utf8');
  assert.ok(js.includes("const SERVER = 'Atlassian MCP'") && js.includes("const SEARCH = 'searchJiraIssuesUsingJql'"));
  assert.ok(js.includes('data/users/${me}/${name}'));
  assert.ok(/~paste\$/.test(js) && js.includes("history.replaceState(null, '', '#board')"));
});
