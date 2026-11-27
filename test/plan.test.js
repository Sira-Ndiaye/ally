'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('../src/plan');

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ally-plan-')));
const put = (f, s = '') => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s); };
const SHA = 'a'.repeat(40);

// A repository with loose and packed branches.
function repo(dir, loose = [], packed = []) {
  for (const b of loose) put(path.join(dir, '.git', 'refs', 'heads', b), SHA);
  if (packed.length) put(path.join(dir, '.git', 'packed-refs'), '# pack-refs\n' + packed.map((b) => `${SHA} refs/heads/${b}`).join('\n'));
  else fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

test('folders where Claude Code ran come from the session logs, newest first', () => {
  const t = tmp();
  const a = repo(path.join(t, 'a'));
  const b = repo(path.join(t, 'b'));
  put(path.join(t, 'claude', 'projects', '-a', 's1.jsonl'), JSON.stringify({ type: 'x' }) + '\n' + JSON.stringify({ cwd: a }) + '\n');
  put(path.join(t, 'claude', 'projects', '-b', 's2.jsonl'), JSON.stringify({ cwd: b }) + '\n');
  put(path.join(t, 'claude', 'projects', '-gone', 's3.jsonl'), JSON.stringify({ cwd: path.join(t, 'deleted') }) + '\n');
  fs.utimesSync(path.join(t, 'claude', 'projects', '-a', 's1.jsonl'), new Date(1000), new Date(1000));
  assert.deepStrictEqual(P.claudeFolders(path.join(t, 'claude')).map((f) => f.dir), [b, a]);
});

test('branches: loose, nested and packed; a worktree reads its main repository', () => {
  const t = tmp();
  const main = repo(path.join(t, 'main'), ['dev', 'feature/ACME-12-x'], ['ACME-3-old']);
  assert.deepStrictEqual(P.branches(main).sort(), ['ACME-3-old', 'dev', 'feature/ACME-12-x']);
  const wt = path.join(t, 'wt');
  put(path.join(main, '.git', 'worktrees', 'wt', 'commondir'), '../..');
  put(path.join(wt, '.git'), `gitdir: ${path.join(main, '.git', 'worktrees', 'wt')}\n`);
  assert.deepStrictEqual(P.branches(wt).sort(), ['ACME-3-old', 'dev', 'feature/ACME-12-x']);
  assert.equal(P.branches(path.join(t, 'none')), null);
});

test('folder: your choice, then this ticket\'s branch, then most project branches, then the name, then home', () => {
  const t = tmp();
  const front = repo(path.join(t, 'front'), ['feature/ACME-1-a', 'feature/ACME-2-b', 'feature/ACME-3-c']);
  const back = repo(path.join(t, 'back'), ['ACME-12-api']);
  const named = repo(path.join(t, 'Acme'));
  const other = repo(path.join(t, 'other'), ['ACMEX-1', 'xACME-9']);
  const folders = [{ dir: other, at: 4 }, { dir: front, at: 3 }, { dir: back, at: 2 }, { dir: named, at: 1 }];
  const project = { key: 'ACME', name: 'Acme' };
  const pick = (o) => P.chooseFolder({ folders, project, home: '/h', ...o });
  assert.deepStrictEqual(pick({ ticketKey: 'ACME-12' }), { dir: back, why: 'has a ACME-12 branch', known: true });
  // ACME-1 must not match a ACME-12 branch.
  assert.deepStrictEqual(pick({ ticketKey: 'ACME-1' }), { dir: front, why: 'has a ACME-1 branch', known: true });
  assert.deepStrictEqual(pick({ ticketKey: 'ACME-99' }), { dir: front, why: 'has ACME branches', known: true });
  assert.equal(pick({ ticketKey: 'ACME-99', remembered: back }).dir, back);
  assert.deepStrictEqual(P.chooseFolder({ folders: [{ dir: named, at: 1 }], project, ticketKey: 'ACME-5', home: '/h' }), { dir: named, why: 'named like ACME', known: true });
  assert.deepStrictEqual(P.chooseFolder({ folders: [{ dir: other, at: 1 }], project, ticketKey: 'ACME-5', home: '/h' }), { dir: '/h', why: 'repository unknown', known: false });
});

test('front matter: plain, quoted and folded values', () => {
  assert.deepStrictEqual(P.frontMatter('---\nname: "jira-plan"\ndescription: >\n  Plans a Jira\n  ticket.\nother: x\n---\nbody'),
    { name: 'jira-plan', description: 'Plans a Jira ticket.' });
  assert.deepStrictEqual(P.frontMatter('no front matter'), {});
});

test('skills: repository, then yours, then plugins; name beats description; your choice wins', () => {
  const t = tmp();
  const r = path.join(t, 'repo');
  const c = path.join(t, 'claude');
  put(path.join(r, '.claude', 'skills', 'ui', 'SKILL.md'), '---\nname: ui-handler\ndescription: Delivers a Jira ticket end to end.\n---');
  put(path.join(c, 'skills', 'jira-plan', 'SKILL.md'), '---\nname: jira-plan\ndescription: Plans work.\n---');
  put(path.join(c, 'commands', 'review.md'), '---\ndescription: Reviews code.\n---');
  put(path.join(t, 'plug', 'skills', 'tickets', 'SKILL.md'), '---\nname: tickets\ndescription: x\n---');
  put(path.join(c, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'acme@market': [{ installPath: path.join(t, 'plug') }] } }));
  const skills = P.allSkills(r, c);
  assert.deepStrictEqual(skills.map((s) => [s.name, s.source]), [['ui-handler', 'repo'], ['jira-plan', 'own'], ['review', 'own'], ['acme:tickets', 'plugin']]);
  assert.equal(P.chooseSkill(skills).name, 'jira-plan');
  assert.equal(P.chooseSkill(skills.filter((s) => s.name !== 'jira-plan')).name, 'acme:tickets');
  assert.equal(P.chooseSkill(skills.filter((s) => s.source === 'repo')).name, 'ui-handler');
  assert.equal(P.chooseSkill(skills, 'review').name, 'review');
  assert.equal(P.chooseSkill(skills, ''), null);
  // "issues" in another sense is not a match.
  assert.equal(P.chooseSkill([{ name: 'lint', description: 'Fixes code issues.', source: 'own' }]), null);
});

const ticket = { key: 'ACME-12', summary: 'Retry the webhook', status: 'In Progress', p: 'P2', due: '2026-11-21', labels: ['mvp2'], links: ['blocks ACME-13'], description: 'Line one.\nLine two.', project: { key: 'ACME', name: 'Acme' } };
const known = { dir: '/r', known: true };

test('a skill runs in normal mode with the ticket after its name, so it need not fetch it', () => {
  const args = P.planArgs({ ticket, skill: { name: 'jira-plan' }, folder: known });
  assert.deepStrictEqual(args.slice(0, 2), ['-n', 'ACME-12']);
  assert.ok(!args.includes('--permission-mode'));
  assert.equal(args[2], '/jira-plan ACME-12\n\nTicket, so you need not fetch it:\nTitle: Retry the webhook\nStatus: In Progress · P2 · due 2026-11-21\nLabels: mvp2\nLinks: blocks ACME-13\nDescription:\nLine one.\nLine two.');
});

test('without a skill: plan mode and the built-in prompt; an unknown folder is said', () => {
  const args = P.planArgs({ ticket, skill: null, folder: { dir: '/h', known: false } });
  assert.deepStrictEqual(args.slice(0, 4), ['--permission-mode', 'plan', '-n', 'ACME-12']);
  assert.match(args[4], /^Plan the work for Jira ticket ACME-12\./);
  assert.match(args[4], /Do not edit files\./);
  assert.ok(args[4].endsWith(P.UNKNOWN_REPO));
  const todo = P.planArgs({ todo: { text: 'Book the dentist!', p: 'P2', due: '2026-11-17' }, folder: known });
  assert.deepStrictEqual(todo.slice(0, 4), ['--permission-mode', 'plan', '-n', 'todo-bookthedentist']);
  assert.match(todo[4], /^Plan this task: Book the dentist!\nP2 · due 2026-11-17/);
});

test('a long description is cut', () => {
  const block = P.ticketBlock({ ...ticket, description: 'x'.repeat(5000) });
  assert.ok(block.length < 2700 && block.endsWith('…'));
});
