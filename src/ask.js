'use strict';
// Shared by the renderer (as window.Ask) and the unit tests (as a CommonJS module).
(function (root) {
  // The "do not ask again" choice of the terminal prompt, when Claude Code offers one.
  const alwaysRule = (ask) => (ask.suggestions || []).find((s) => s.type === 'addRules' || s.type === 'addDirectories');

  function alwaysText(rule) {
    if (rule.type === 'addDirectories') return 'Always allow access to ' + rule.directories.join(', ');
    return 'Always allow ' + rule.rules.map((r) => r.ruleContent || r.toolName).join(', ');
  }

  // What the card shows, one step at a time: each question of a multiple-choice prompt,
  // or a single yes/no step for a permission.
  function steps(ask) {
    if (ask.questions) {
      return ask.questions.map((q) => ({
        header: q.header || '',
        question: q.question,
        multi: !!q.multiSelect,
        options: (q.options || []).map((o) => ({ value: o.label, label: o.label, description: o.description || '' })),
        placeholder: 'Other: type your answer',
      }));
    }
    const rule = alwaysRule(ask);
    return [{
      header: 'Permission',
      question: ask.title || `Allow ${ask.tool}?`,
      detail: ask.detail,
      multi: false,
      options: [
        { value: 'yes', label: 'Yes', description: '' },
        ...(rule ? [{ value: 'always', label: 'Yes, and do not ask again', description: alwaysText(rule) }] : []),
        { value: 'no', label: 'No', description: '' },
      ],
      placeholder: 'No, and tell Claude what to do instead',
    }];
  }

  // The PermissionRequest hook decision for the replies given, one { picks, text } per step.
  function decision(ask, replies) {
    if (ask.questions) {
      const answers = {};
      ask.questions.forEach((q, i) => {
        answers[q.question] = [...replies[i].picks, replies[i].text].filter(Boolean).join(', ');
      });
      return { behavior: 'allow', updatedInput: { questions: ask.questions, answers } };
    }
    const { picks, text } = replies[0];
    if (text) return { behavior: 'deny', message: text };
    if (picks[0] === 'yes') return { behavior: 'allow' };
    if (picks[0] === 'always') return { behavior: 'allow', updatedPermissions: [alwaysRule(ask)] };
    return { behavior: 'deny', message: 'The user declined this action.' };
  }

  const api = { steps, decision };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Ask = api;
})(this);
