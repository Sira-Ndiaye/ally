'use strict';

// Idle reminders ("Claude is waiting for your input") fire about 60s after a reply ends.
// They mean the session is done, not blocked, so they must not raise an alert.
function isIdleReminder(input) {
  if (input.notification_type) return input.notification_type === 'idle_prompt';
  return /waiting for your input/i.test(input.message || '');
}

// What the widget needs to show a pending prompt and answer it. `at` identifies this
// prompt: an answer written for an older one is ignored.
function buildAsk(input, now) {
  const ti = input.tool_input || {};
  if (input.tool_name === 'AskUserQuestion') return { at: now, tool: input.tool_name, questions: ti.questions || [] };
  return {
    at: now,
    tool: input.tool_name,
    title: ti.description || '',
    detail: ti.command || ti.file_path || ti.url || JSON.stringify(ti),
    suggestions: input.permission_suggestions || [],
  };
}

// Returns the new session record, or null when the session file should be removed.
function applyEvent(prev, input, now) {
  const base = prev || {
    id: input.session_id,
    cwd: input.cwd,
    state: 'idle',
    message: 'Started',
    since: now,
  };
  const next = { ...base, cwd: input.cwd || base.cwd, updated: now };
  const ask = base.ask;
  delete next.ask;
  const set = (state, message) => {
    if (next.state !== state) next.since = now;
    next.state = state;
    next.message = message;
    return next;
  };

  switch (input.hook_event_name) {
    case 'SessionStart':
      return set('idle', 'Started');
    case 'UserPromptSubmit':
      return set('working', oneLine(input.prompt) || 'Working');
    case 'PostToolUse':
      // Another tool of the same session (a subagent) finishing does not answer the prompt.
      if (ask && input.tool_name !== ask.tool) return null;
      return base.state === 'working' ? null : set('working', 'Working');
    case 'PermissionRequest': {
      next.ask = buildAsk(input, now);
      const q = next.ask.questions ? (next.ask.questions[0] || {}).question : `Allow ${input.tool_name}?`;
      return set('input', oneLine(q) || 'Needs your input');
    }
    case 'Notification':
      if (isIdleReminder(input)) return base.state === 'idle' ? null : set('idle', 'Waiting for your next prompt');
      // The permission notice follows the prompt itself by a few seconds: keep the prompt.
      if (ask) { next.ask = ask; return next; }
      return set('input', oneLine(input.message) || 'Needs your input');
    case 'Stop':
      return set('idle', 'Finished');
    case 'SessionEnd':
      return { remove: true };
    default:
      return null;
  }
}

function oneLine(s) {
  if (!s) return '';
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > 90 ? t.slice(0, 89) + '…' : t;
}

module.exports = { applyEvent };
