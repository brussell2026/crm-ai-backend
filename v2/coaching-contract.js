const CHANNELS = ['TEXT', 'CALL', 'EMAIL', 'WAIT'];

function safeString(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeChannel(value) {
  const upper = safeString(value).toUpperCase();
  return CHANNELS.includes(upper) ? upper : '';
}

function dedupeStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of safeArray(values)) {
    const text = safeString(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function createEmptyCoachingPlan() {
  return {
    playbook: '',
    priority: '',
    primary_goal: '',
    best_next_action: '',
    primary_channel: '',
    why: '',
    manager_coaching: '',
    suggested_text: '',
    suggested_call_objective: '',
    suggested_email_objective: '',
    objections_detected: [],
    appointment_opportunity: false,
    risk_flags: [],
    confidence: 0
  };
}

function normalizeCoachingPlan(input = {}) {
  const base = createEmptyCoachingPlan();
  return {
    ...base,
    ...input,
    playbook: safeString(input.playbook || input.coaching_playbook),
    priority: safeString(input.priority),
    primary_goal: safeString(input.primary_goal || input.primaryGoal),
    best_next_action: safeString(input.best_next_action || input.bestNextAction),
    primary_channel: normalizeChannel(input.primary_channel || input.primaryChannel || input.next_step_channel),
    why: safeString(input.why || input.next_step_reason),
    manager_coaching: safeString(input.manager_coaching || input.strategy),
    suggested_text: safeString(input.suggested_text || input.recommended_reply),
    suggested_call_objective: safeString(input.suggested_call_objective),
    suggested_email_objective: safeString(input.suggested_email_objective),
    objections_detected: dedupeStrings(input.objections_detected || input.objections),
    appointment_opportunity: Boolean(input.appointment_opportunity),
    risk_flags: dedupeStrings(input.risk_flags),
    confidence: Number(input.confidence || 0) || 0
  };
}

module.exports = {
  CHANNELS,
  createEmptyCoachingPlan,
  normalizeCoachingPlan
};
