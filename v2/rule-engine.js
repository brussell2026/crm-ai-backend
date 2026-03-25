const { normalizeLeadState } = require('./lead-state');

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

function deriveRuleSignals(stateInput = {}) {
  const state = normalizeLeadState(stateInput);
  const lastCustomerMessage = getLastCustomerMessage(state);
  const combinedMessages = state.communications.messages.map((message) => message.text).join('\n');
  const objectionText = [lastCustomerMessage, combinedMessages].join('\n');

  const signals = {
    has_recent_text_engagement:
      state.communications.messages.some((message) => message.sender === 'customer') ||
      /yes|ok|interested|price|payment|available/i.test(lastCustomerMessage),
    has_phone_history:
      state.communications.calls.length > 0 ||
      /phone call|call notes|voicemail|no contact/i.test(combinedMessages),
    has_price_objection: containsAny(objectionText, [/price/i, /payment/i, /fees/i, /trade/i]),
    has_appointment_opportunity: containsAny(objectionText, [/come in/i, /today/i, /tomorrow/i, /appointment/i, /available/i]),
    is_stale: !state.communications.messages.length && !state.communications.calls.length,
    has_vehicle_context: Boolean(state.vehicles.primary.summary),
    suggested_channel: ''
  };

  if (signals.has_price_objection || signals.has_phone_history) {
    signals.suggested_channel = 'CALL';
  } else if (signals.has_recent_text_engagement) {
    signals.suggested_channel = 'TEXT';
  } else if (signals.is_stale) {
    signals.suggested_channel = 'TEXT';
  } else {
    signals.suggested_channel = 'EMAIL';
  }

  return signals;
}

module.exports = {
  deriveRuleSignals
};
