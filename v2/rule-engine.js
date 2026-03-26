const { normalizeLeadState } = require('./lead-state');

function safeString(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function uniqueStrings(values = []) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = safeString(value);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

function containsAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function getLastCustomerMessage(state) {
  return (
    state.communications.last_customer_message ||
    [...state.communications.messages].reverse().find((message) => message.sender === 'customer')?.text ||
    ''
  );
}

function buildSignalsText(state) {
  return [
    getLastCustomerMessage(state),
    ...(state.communications.messages || []).map((message) => message.text),
    ...(state.communications.notes || []),
    ...(state.communications.calls || []),
    ...(state.communications.texts || []),
    ...(state.communications.emails || []),
    safeString(state.lifecycle.status),
    safeString(state.lifecycle.process),
    safeString(state.source.lead_source),
    safeString(state.vehicles.primary.summary),
    ...(state.vehicles.historical || []),
    ...(state.opportunity.objections || [])
  ]
    .filter(Boolean)
    .join('\n');
}

function deriveRuleSignals(stateInput = {}) {
  const state = normalizeLeadState(stateInput);
  const lastCustomerMessage = getLastCustomerMessage(state);
  const combinedText = buildSignalsText(state);
  const objectionText = [lastCustomerMessage, combinedText].join('\n');
  const activeMessageCount = (state.communications.messages || []).length;
  const noteCount = (state.communications.notes || []).length;

  const signals = {
    has_recent_text_engagement:
      state.communications.messages.some((message) => message.sender === 'customer') ||
      /yes|ok|okay|interested|price|payment|available|miles|sunroof|trade|appointment/i.test(lastCustomerMessage),
    has_phone_history:
      state.communications.calls.length > 0 ||
      /phone call|call notes|voicemail|no contact|duration:\d{1,2}:\d{2}/i.test(combinedText),
    has_email_history:
      state.communications.emails.length > 0 ||
      /email/i.test(combinedText),
    has_price_objection: containsAny(objectionText, [
      /\bprice\b/i,
      /\bpayment\b/i,
      /\bfees?\b/i,
      /\botd\b/i,
      /\bout the door\b/i,
      /\bdiscount\b/i,
      /\bcheaper\b/i
    ]),
    has_trade_objection: containsAny(objectionText, [
      /\btrade\b/i,
      /\bmy truck\b/i,
      /\bmy car\b/i,
      /\bpayoff\b/i,
      /\bappraisal\b/i
    ]),
    has_inventory_question: containsAny(objectionText, [
      /\bavailable\b/i,
      /\bstill there\b/i,
      /\bin stock\b/i,
      /\bsunroof\b/i,
      /\bmiles?\b/i,
      /\bcolor\b/i,
      /\b4x4\b/i,
      /\bfeature\b/i,
      /\bvin\b/i,
      /\bstock\b/i
    ]),
    has_identity_confusion: containsAny(objectionText, [
      /\bwho is this\b/i,
      /\bwhat number is this\b/i,
      /\bwho dis\b/i
    ]),
    has_competitive_shopping: containsAny(objectionText, [
      /\bcompared\b/i,
      /\bother truck\b/i,
      /\banother one\b/i,
      /\bdifferent truck\b/i,
      /\bother dealer\b/i,
      /\bdeal on\b/i
    ]),
    appointment_recovery_needed: containsAny(objectionText, [
      /\bappointment was cancelled\b/i,
      /\breschedule\b/i,
      /\bmissed appointment\b/i,
      /\bno show\b/i,
      /\bcome in for an appt\b/i
    ]),
    appointment_confirmed: containsAny(objectionText, [
      /\bcoming tomorrow\b/i,
      /\bcoming today\b/i,
      /\bcome tomorrow\b/i,
      /\bcome today\b/i,
      /\bbetween\s+\d{1,2}(?::\d{2})?\s*(?:-|to)\s*\d{1,2}(?::\d{2})?\b/i,
      /\b(?:tomorrow|today|saturday|monday|tuesday|wednesday|thursday|friday|sunday)\s+between\b/i,
      /\bon my way\b/i,
      /\bsee you tomorrow\b/i,
      /\bsee you then\b/i,
      /\bappointment confirmed\b/i,
      /\bconfirmed appointment\b/i,
      /\bwill be there\b/i,
      /\bbe there at\b/i
    ]),
    has_appointment_opportunity: containsAny(objectionText, [
      /\bcome in\b/i,
      /\btoday\b/i,
      /\btomorrow\b/i,
      /\bappointment\b/i,
      /\bavailable\b/i,
      /\bfree now\b/i
    ]),
    is_stale: !activeMessageCount && !state.communications.calls.length,
    has_vehicle_context: Boolean(state.vehicles.primary.summary),
    contact_confirmed:
      /\byes\b/i.test(safeString(state.lifecycle.contacted)) ||
      state.communications.messages.some((message) => message.sender === 'customer') ||
      state.communications.calls.length > 0,
    thin_data:
      !safeString(state.vehicles.primary.summary) &&
      !safeString(state.source.lead_source) &&
      noteCount < 1,
    playbook: '',
    priority: '',
    primary_goal: '',
    suggested_channel: '',
    objections_detected: [],
    risk_flags: []
  };

  signals.objections_detected = uniqueStrings([
    signals.has_price_objection ? 'Price or payment objection' : '',
    signals.has_trade_objection ? 'Trade or payoff objection' : '',
    signals.has_inventory_question ? 'Vehicle detail or availability question' : '',
    signals.has_identity_confusion ? 'Identity or trust confusion' : '',
    signals.has_competitive_shopping ? 'Competitive shopping pressure' : ''
  ]);

  signals.risk_flags = uniqueStrings([
    signals.appointment_confirmed ? 'Appointment appears scheduled' : '',
    signals.appointment_recovery_needed ? 'Appointment recovery needed' : '',
    signals.has_competitive_shopping ? 'Customer comparing other inventory' : '',
    signals.is_stale ? 'Lead lacks meaningful response history' : '',
    signals.thin_data ? 'Thin CRM data quality' : '',
    !signals.has_vehicle_context ? 'Primary vehicle unclear' : ''
  ]);

  if (signals.appointment_confirmed && !signals.appointment_recovery_needed) {
    signals.playbook = 'APPOINTMENT_CONFIRMATION';
    signals.priority = 'HOT';
    signals.primary_goal = 'Confirm the scheduled visit, protect the appointment, and reduce no-show risk.';
    signals.suggested_channel =
      signals.has_recent_text_engagement && !signals.has_phone_history ? 'TEXT' : 'CALL';
  } else if (signals.appointment_recovery_needed) {
    signals.playbook = 'APPOINTMENT_RECOVERY';
    signals.priority = 'HOT';
    signals.primary_goal = 'Recover the appointment and get a firm reschedule or commitment.';
    signals.suggested_channel =
      signals.has_recent_text_engagement && !signals.has_phone_history ? 'TEXT' : 'CALL';
  } else if (signals.has_identity_confusion) {
    signals.playbook = 'IDENTITY_RESET';
    signals.priority = 'HIGH';
    signals.primary_goal = 'Rebuild trust fast and re-anchor the conversation around the active lead.';
    signals.suggested_channel = 'TEXT';
  } else if (signals.has_price_objection || signals.has_trade_objection || signals.has_competitive_shopping) {
    signals.playbook = 'OBJECTION_CLARIFICATION';
    signals.priority = 'HIGH';
    signals.primary_goal = 'Clarify the objection live, protect gross when possible, and move toward an appointment.';
    signals.suggested_channel = 'CALL';
  } else if (signals.has_inventory_question && signals.has_recent_text_engagement) {
    signals.playbook = 'PRODUCT_CONFIRMATION';
    signals.priority = 'HIGH';
    signals.primary_goal = 'Answer the specific question, confirm the vehicle fit, and earn the next commitment.';
    signals.suggested_channel = 'TEXT';
  } else if (signals.is_stale) {
    signals.playbook = 'REVIVE_STALLED_LEAD';
    signals.priority = 'MEDIUM';
    signals.primary_goal = 'Restart the conversation with a low-friction message and requalify interest.';
    signals.suggested_channel = signals.has_phone_history ? 'CALL' : 'TEXT';
  } else if (signals.has_recent_text_engagement) {
    signals.playbook = 'ENGAGED_TEXT_THREAD';
    signals.priority = 'HIGH';
    signals.primary_goal = 'Keep momentum and turn engagement into a commitment or appointment.';
    signals.suggested_channel = 'TEXT';
  } else if (signals.has_email_history && !signals.has_recent_text_engagement) {
    signals.playbook = 'DOCUMENTED_FOLLOW_UP';
    signals.priority = 'MEDIUM';
    signals.primary_goal = 'Deliver a clean written follow-up that sets up the next live touch.';
    signals.suggested_channel = 'EMAIL';
  } else {
    signals.playbook = 'NEW_LEAD_OPENER';
    signals.priority = 'MEDIUM';
    signals.primary_goal = 'Open strong, confirm the right vehicle, and move toward a response.';
    signals.suggested_channel = 'TEXT';
  }

  return signals;
}

module.exports = {
  deriveRuleSignals
};
