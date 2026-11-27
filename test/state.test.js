'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { applyEvent } = require('../hook/state');

const ev = (hook_event_name, extra = {}) => ({ session_id: 's1', cwd: '/p/app', hook_event_name, ...extra });

test('a new prompt marks the session working with the prompt as message', () => {
  const s = applyEvent(null, ev('UserPromptSubmit', { prompt: 'fix\nthe   tests' }), 10);
  assert.equal(s.state, 'working');
  assert.equal(s.message, 'fix the tests');
  assert.equal(s.since, 10);
});

test('a permission notification marks the session as needing input', () => {
  const working = applyEvent(null, ev('UserPromptSubmit', { prompt: 'x' }), 10);
  const s = applyEvent(working, ev('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }), 20);
  assert.equal(s.state, 'input');
  assert.equal(s.message, 'Claude needs your permission to use Bash');
  assert.equal(s.since, 20);
});

test('the idle reminder does not raise an alert', () => {
  const idle = applyEvent(null, ev('Stop'), 10);
  assert.equal(applyEvent(idle, ev('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' }), 20), null);
  const old = applyEvent(idle, ev('Notification', { message: 'Claude is waiting for your input' }), 20);
  assert.equal(old, null);
});

test('a tool finishing after an approval goes back to working, and is a no-op while already working', () => {
  const input = { id: 's1', state: 'input', message: 'Allow?', since: 5 };
  assert.equal(applyEvent(input, ev('PostToolUse'), 30).state, 'working');
  assert.equal(applyEvent({ ...input, state: 'working' }, ev('PostToolUse'), 30), null);
});

test('stop marks idle, session end removes the record', () => {
  const working = { id: 's1', state: 'working', message: 'x', since: 5 };
  assert.equal(applyEvent(working, ev('Stop'), 40).state, 'idle');
  assert.deepEqual(applyEvent(working, ev('SessionEnd'), 40), { remove: true });
});

test('long prompts are cut to one short line', () => {
  const s = applyEvent(null, ev('UserPromptSubmit', { prompt: 'a'.repeat(200) }), 1);
  assert.equal(s.message.length, 90);
});

const question = { question: 'Which store?', header: 'Store', options: [{ label: 'Redis' }, { label: 'Memory' }, { label: 'Postgres' }], multiSelect: false };
const asked = () => applyEvent(
  { id: 's1', state: 'working', message: 'x', since: 5 },
  ev('PermissionRequest', { tool_name: 'AskUserQuestion', tool_input: { questions: [question] } }), 50);

test('a question marks the session as needing input and keeps the question for the widget', () => {
  const s = asked();
  assert.equal(s.state, 'input');
  assert.equal(s.message, 'Which store?');
  assert.deepEqual(s.ask, { at: 50, tool: 'AskUserQuestion', questions: [question] });
});

test('a permission prompt keeps the command and the suggested rules', () => {
  const suggestions = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }], behavior: 'allow', destination: 'localSettings' }];
  const s = applyEvent(null, ev('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the tests' }, permission_suggestions: suggestions }), 50);
  assert.equal(s.message, 'Allow Bash?');
  assert.deepEqual(s.ask, { at: 50, tool: 'Bash', title: 'Run the tests', detail: 'npm test', suggestions });
});

test('the permission notice that follows a question keeps it', () => {
  const s = applyEvent(asked(), ev('Notification', { notification_type: 'permission_prompt', message: 'Claude needs your permission' }), 56);
  assert.equal(s.ask.at, 50);
  assert.equal(s.message, 'Which store?');
});

test('the asked tool finishing, a stop or a new prompt clears the question; another tool does not', () => {
  assert.equal(applyEvent(asked(), ev('PostToolUse', { tool_name: 'Read' }), 60), null);
  const done = applyEvent(asked(), ev('PostToolUse', { tool_name: 'AskUserQuestion' }), 60);
  assert.equal(done.state, 'working');
  assert.equal(done.ask, undefined);
  assert.equal(applyEvent(asked(), ev('Stop'), 60).ask, undefined);
  assert.equal(applyEvent(asked(), ev('UserPromptSubmit', { prompt: 'y' }), 60).ask, undefined);
});
