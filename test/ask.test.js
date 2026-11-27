'use strict';
const test = require('node:test');
const assert = require('node:assert');
const Ask = require('../src/ask');

const q1 = { question: 'Which store?', header: 'Store', options: [{ label: 'Redis', description: 'Shared' }, { label: 'Memory' }, { label: 'Postgres' }], multiSelect: false };
const q2 = { question: 'Which checks?', header: 'Checks', options: [{ label: 'Lint' }, { label: 'Tests' }, { label: 'Types' }], multiSelect: true };
const rule = { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' };
const bash = { at: 1, tool: 'Bash', title: 'Run the tests', detail: 'npm test', suggestions: [rule] };

test('each question is a step with its options', () => {
  const [a, b] = Ask.steps({ questions: [q1, q2] });
  assert.equal(a.question, 'Which store?');
  assert.deepEqual(a.options[0], { value: 'Redis', label: 'Redis', description: 'Shared' });
  assert.equal(a.multi, false);
  assert.equal(b.multi, true);
});

test('answers map each question to the picked label, the free text, or both joined', () => {
  const d = Ask.decision({ questions: [q1, q2] }, [{ picks: [], text: 'etcd' }, { picks: ['Lint', 'Tests'], text: 'docs' }]);
  assert.equal(d.behavior, 'allow');
  assert.deepEqual(d.updatedInput.questions, [q1, q2]);
  assert.deepEqual(d.updatedInput.answers, { 'Which store?': 'etcd', 'Which checks?': 'Lint, Tests, docs' });
});

test('a permission offers yes, always when a rule is suggested, and no', () => {
  const [step] = Ask.steps(bash);
  assert.equal(step.question, 'Run the tests');
  assert.equal(step.detail, 'npm test');
  assert.deepEqual(step.options.map((o) => o.value), ['yes', 'always', 'no']);
  assert.equal(step.options[1].description, 'Always allow npm test');
  assert.deepEqual(Ask.steps({ tool: 'Bash', suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] })[0].options.map((o) => o.value), ['yes', 'no']);
  assert.equal(Ask.steps({ tool: 'Bash', suggestions: [{ type: 'addDirectories', directories: ['/data'] }] })[0].options[1].description, 'Always allow access to /data');
  assert.equal(Ask.steps({ tool: 'Bash' })[0].question, 'Allow Bash?');
});

test('permission replies become allow, allow with the rule, or deny with the reason', () => {
  assert.deepEqual(Ask.decision(bash, [{ picks: ['yes'], text: '' }]), { behavior: 'allow' });
  assert.deepEqual(Ask.decision(bash, [{ picks: ['always'], text: '' }]), { behavior: 'allow', updatedPermissions: [rule] });
  assert.deepEqual(Ask.decision(bash, [{ picks: ['no'], text: '' }]), { behavior: 'deny', message: 'The user declined this action.' });
  assert.deepEqual(Ask.decision(bash, [{ picks: [], text: 'use pnpm' }]), { behavior: 'deny', message: 'use pnpm' });
});
