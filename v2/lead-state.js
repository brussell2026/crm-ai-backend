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

function normalizeMessages(messages = []) {
  return safeArray(messages)
    .map((message) => ({
      sender: safeString(message.sender || message.role || 'system').toLowerCase(),
      text: safeString(message.text || message.body || message.message || ''),
      timestamp: safeString(message.timestamp || message.time || ''),
      channel: normalizeChannel(message.channel || '')
    }))
    .filter((message) => message.text);
}

function createEmptyLeadState() {
  return {
    ids: {
      lead_id: '',
      crm_lead_id: '',
      customer_id: ''
    },
    customer: {
      name: '',
      phone: '',
      email: '',
      address: '',
      city: '',
      state: '',
      zip: ''
    },
    assignment: {
      salesperson: '',
      bd_agent: '',
      manager: ''
    },
    source: {
      lead_source: '',
      lead_type: '',
      created_at: '',
      created_age_days: ''
    },
    lifecycle: {
      status: '',
      process: '',
      contacted: '',
      attempted: '',
      stage: ''
    },
    vehicles: {
      primary: {
        summary: '',
        year: '',
        make: '',
        model: '',
        trim: '',
        stock: '',
        vin: '',
        color: '',
        odometer: '',
        location: ''
      },
      discussed: [],
      trade_in: '',
      historical: []
    },
    communications: {
      channels_used: [],
      last_contact_at: '',
      last_customer_message: '',
      messages: [],
      notes: [],
      calls: [],
      texts: [],
      emails: []
    },
    opportunity: {
      appointment_status: '',
      appointment_set: false,
      appointment_shown: false,
      urgency_score: 0,
      engagement_score: 0,
      close_risk: '',
      objections: [],
      buying_signals: [],
      risk_flags: []
    },
    coaching: {
      suggested_channel: '',
      suggested_playbook: '',
      confidence: 0
    },
    meta: {
      captured_from: [],
      captured_at: '',
      data_quality: ''
    }
  };
}

function normalizeLeadState(input = {}) {
  const base = createEmptyLeadState();

  const state = {
    ...base,
    ids: {
      ...base.ids,
      ...input.ids,
      lead_id: safeString(input.ids?.lead_id || input.leadId || input.lead_id),
      crm_lead_id: safeString(input.ids?.crm_lead_id || input.crmLeadId || input.crm_lead_id),
      customer_id: safeString(input.ids?.customer_id || input.customerId || input.customer_id)
    },
    customer: {
      ...base.customer,
      ...input.customer,
      name: safeString(input.customer?.name || input.customerName || input.customer_name),
      phone: safeString(input.customer?.phone || input.phone),
      email: safeString(input.customer?.email || input.email),
      address: safeString(input.customer?.address || input.address),
      city: safeString(input.customer?.city || input.city),
      state: safeString(input.customer?.state || input.state),
      zip: safeString(input.customer?.zip || input.zip)
    },
    assignment: {
      ...base.assignment,
      ...input.assignment,
      salesperson: safeString(input.assignment?.salesperson || input.salespersonName || input.salesperson),
      bd_agent: safeString(input.assignment?.bd_agent || input.bd_agent),
      manager: safeString(input.assignment?.manager || input.manager)
    },
    source: {
      ...base.source,
      ...input.source,
      lead_source: safeString(input.source?.lead_source || input.leadSource || input.lead_source),
      lead_type: safeString(input.source?.lead_type || input.leadType || input.lead_type),
      created_at: safeString(input.source?.created_at || input.createdAt || input.created_at),
      created_age_days: safeString(input.source?.created_age_days || input.createdAgeDays || input.created_age_days)
    },
    lifecycle: {
      ...base.lifecycle,
      ...input.lifecycle,
      status: safeString(input.lifecycle?.status || input.status),
      process: safeString(input.lifecycle?.process || input.process),
      contacted: safeString(input.lifecycle?.contacted || input.contacted),
      attempted: safeString(input.lifecycle?.attempted || input.attempted),
      stage: safeString(input.lifecycle?.stage || input.stage)
    },
    vehicles: {
      ...base.vehicles,
      ...input.vehicles,
      primary: {
        ...base.vehicles.primary,
        ...input.vehicles?.primary,
        summary: safeString(input.vehicles?.primary?.summary || input.vehicleInfo || input.vehicleSummary)
      },
      discussed: dedupeStrings(input.vehicles?.discussed),
      historical: dedupeStrings(input.vehicles?.historical),
      trade_in: safeString(input.vehicles?.trade_in || input.tradeIn || input.trade_in)
    },
    communications: {
      ...base.communications,
      ...input.communications,
      channels_used: dedupeStrings(input.communications?.channels_used),
      last_contact_at: safeString(input.communications?.last_contact_at || input.lastContactAt || input.last_contact_at),
      last_customer_message: safeString(input.communications?.last_customer_message || input.lastCustomerMessage || input.last_customer_message),
      messages: normalizeMessages(input.communications?.messages || input.messages),
      notes: dedupeStrings(input.communications?.notes),
      calls: dedupeStrings(input.communications?.calls),
      texts: dedupeStrings(input.communications?.texts),
      emails: dedupeStrings(input.communications?.emails)
    },
    opportunity: {
      ...base.opportunity,
      ...input.opportunity,
      appointment_status: safeString(input.opportunity?.appointment_status || input.appointmentStatus || input.appointment_status),
      appointment_set: Boolean(input.opportunity?.appointment_set || input.appointmentSet),
      appointment_shown: Boolean(input.opportunity?.appointment_shown || input.appointmentShown),
      urgency_score: Number(input.opportunity?.urgency_score || input.urgencyScore || 0) || 0,
      engagement_score: Number(input.opportunity?.engagement_score || input.engagementScore || 0) || 0,
      close_risk: safeString(input.opportunity?.close_risk || input.closeRisk || input.close_risk),
      objections: dedupeStrings(input.opportunity?.objections),
      buying_signals: dedupeStrings(input.opportunity?.buying_signals),
      risk_flags: dedupeStrings(input.opportunity?.risk_flags)
    },
    coaching: {
      ...base.coaching,
      ...input.coaching,
      suggested_channel: normalizeChannel(input.coaching?.suggested_channel || input.suggestedChannel),
      suggested_playbook: safeString(input.coaching?.suggested_playbook || input.suggestedPlaybook || input.playbook),
      confidence: Number(input.coaching?.confidence || input.confidence || 0) || 0
    },
    meta: {
      ...base.meta,
      ...input.meta,
      captured_from: dedupeStrings(input.meta?.captured_from || input.capturedFrom),
      captured_at: safeString(input.meta?.captured_at || input.capturedAt),
      data_quality: safeString(input.meta?.data_quality || input.dataQuality)
    }
  };

  return state;
}

function summarizeLeadState(stateInput = {}) {
  const state = normalizeLeadState(stateInput);
  const lines = [
    state.customer.name ? `Customer: ${state.customer.name}` : '',
    state.assignment.salesperson ? `Salesperson: ${state.assignment.salesperson}` : '',
    state.source.lead_source ? `Lead Source: ${state.source.lead_source}` : '',
    state.lifecycle.status ? `Status: ${state.lifecycle.status}` : '',
    state.vehicles.primary.summary ? `Primary Vehicle: ${state.vehicles.primary.summary}` : '',
    state.communications.last_customer_message ? `Last Customer Message: ${state.communications.last_customer_message}` : '',
    state.opportunity.objections.length ? `Objections: ${state.opportunity.objections.join(', ')}` : '',
    state.opportunity.risk_flags.length ? `Risk Flags: ${state.opportunity.risk_flags.join(', ')}` : ''
  ].filter(Boolean);

  return lines.join('\n');
}

module.exports = {
  CHANNELS,
  createEmptyLeadState,
  normalizeLeadState,
  summarizeLeadState
};
