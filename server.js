require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');
const {
  normalizeLeadState,
  summarizeLeadState,
  normalizeCoachingPlan,
  deriveRuleSignals,
} = require('./v2');

const app = express();

app.use(cors());
app.use(express.json({ limit: '4mb' }));

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

if (!OPENAI_API_KEY) {
  console.error('Missing OPENAI_API_KEY environment variable.');
  process.exit(1);
}

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const DEALERSHIP_NAME = 'Hiley Chevrolet of Rockwall';
const STORE_HOURS = '8:30 AM to 8:00 PM Monday through Saturday';

// Temporary in-memory lead memory.
// Important: this resets whenever the server restarts or redeploys.
const leadMemoryStore = new Map();

function safeString(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
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

function stringifyForPrompt(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return safeString(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return safeString(value);
  }
}

function normalizeMessages(messages) {
  if (!Array.isArray(messages)) return [];

  return messages
    .map((m) => ({
      sender: safeString(m.sender || m.role || 'unknown').toLowerCase(),
      text: safeString(m.text || m.message || m.body || ''),
      timestamp: safeString(m.timestamp || m.time || ''),
    }))
    .filter((m) => m.text);
}

function formatConversation(messages) {
  if (!messages.length) return 'No conversation messages provided.';

  return messages
    .map((m, index) => {
      const who =
        m.sender === 'customer'
          ? 'Customer'
          : m.sender === 'salesperson' || m.sender === 'agent'
          ? 'Salesperson'
          : 'Unknown';
      const ts = m.timestamp ? ` [${m.timestamp}]` : '';
      return `${index + 1}. ${who}${ts}: ${m.text}`;
    })
    .join('\n');
}

function extractLastCustomerMessage(messages) {
  const reversed = [...messages].reverse();
  const found = reversed.find((m) => m.sender === 'customer' && m.text);
  return found ? found.text : '';
}

function getLeadMemoryKey(req) {
  return (
    safeString(req.params.leadId) ||
    safeString(req.body.leadId) ||
    safeString(req.query.leadId)
  );
}

function getLeadMemory(leadId) {
  if (!leadId) return { notes: [], summary: '' };
  return (
    leadMemoryStore.get(leadId) || {
      notes: [],
      summary: '',
    }
  );
}

function setLeadMemory(leadId, payload) {
  leadMemoryStore.set(leadId, payload);
  return payload;
}

function cleanJsonText(text) {
  let cleaned = safeString(text);

  if (!cleaned) return '';

  cleaned = cleaned.replace(/```json/gi, '```');
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```/, '');
    cleaned = cleaned.replace(/```$/, '');
  }

  return cleaned.trim();
}

function parseAnalysisJson(text) {
  const cleaned = cleanJsonText(text);

  if (!cleaned) {
    throw new Error('Empty model response.');
  }

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      return JSON.parse(match[0]);
    }
    throw err;
  }
}

function buildSystemPrompt() {
  return `
You are an elite automotive sales strategist and sales manager coach for ${DEALERSHIP_NAME}.

Your job is to analyze the full lead context and tell the salesperson exactly what should happen next to move the deal forward.
You are not just writing text replies. You are deciding the best next move based on:
- text history
- email history
- call history
- tasks and notes
- objections
- trade / payoff / pricing context
- vehicle information
- appointment opportunity
- the customer's tone, urgency, and buying signals

Store information:
- Dealership: ${DEALERSHIP_NAME}
- Store hours: ${STORE_HOURS}

Core goals:
- move the deal forward
- create engagement
- get the customer in the door when appropriate
- avoid weak, robotic, needy, repetitive follow-up language
- sound confident, human, and professional
- coach the salesperson on what to do next
- choose the right channel based on the full CRM picture, not just the latest text

Rules:
1. Always pay close attention to the customer's latest message and the full history provided.
2. Do not ignore the customer's actual question or stated obstacle.
3. Do not recommend “just checking in” language.
4. If there is no conversation yet, suggest a strong opening text.
5. If the customer asks where the dealership is, mention the dealership name and tell the salesperson to send the store location/map link if available in the CRM.
6. If the conversation is in Spanish, return the suggested replies in Spanish.
7. If the conversation is in English, return the suggested replies in English.
8. Suggested replies must be concise, conversational, ready to send, and aligned with the best next action.
9. Do not use cheesy sales language.
10. If the best next action is CALL or EMAIL, still provide 3 short text options that support that next move when possible.
11. Use the lead memory to stay consistent with objections, preferences, trade info, payment goals, vehicle of interest, timeline, and next steps.
12. “Best Next Action” must explicitly state the best contact method next: CALL, TEXT, EMAIL, or WAIT.
13. “Strategy” must be salesperson coaching, not customer-facing copy. It should explain how to get the customer closer to an appointment or commitment.
14. If the provided vehicle info is weak or incomplete, infer what you can from the history and lead details, but do not invent specifics.
15. Use lead source, created date, contact attempts, manager/rep info, vehicle details, and notes/history to decide whether the salesperson should text, call, email, or pause.
16. If there is recent two-way text engagement, prefer tightening the conversation around the vehicle and next commitment unless a call is clearly stronger.
17. If there is confusion, friction, repeated back-and-forth, negotiation drag, or too much nuance for text, recommend CALL and explain the call objective.
18. If a detailed summary, quote, or documentation follow-up is best, recommend EMAIL and explain what the email should accomplish.
19. If the lead is being overworked or the timing is poor, WAIT must include what the salesperson should watch for next.

Return ONLY valid JSON with this exact shape:
{
  "buyer_type": "string",
  "deal_stage": "string",
  "best_next_action": "string",
  "next_step_channel": "CALL or TEXT or EMAIL or WAIT",
  "next_step_reason": "string",
  "strategy": "string",
  "recommended_reply": "string",
  "recommended_reply_2": "string",
  "recommended_reply_3": "string",
  "conversation_language": "English or Spanish",
  "customer_sentiment": "string",
  "hot_points": ["string"],
  "objections": ["string"],
  "appointment_opportunity": true,
  "memory_summary": "string",
  "memory_updates": ["string"]
}
`.trim();
}

function buildUserPrompt({
  messages,
  customerName,
  salespersonName,
  vehicleInfo,
  leadDetails,
  leadMemory,
}) {
  const conversation = formatConversation(messages);
  const lastCustomerMessage = extractLastCustomerMessage(messages);
  const normalizedVehicleInfo = safeString(vehicleInfo) || 'Unknown';
  const normalizedLeadDetails = safeString(leadDetails) || 'None provided';

  return `
Analyze this dealership lead and recommend the strongest next move.

Customer name: ${safeString(customerName) || 'Unknown'}
Salesperson name: ${safeString(salespersonName) || 'Unknown'}
Vehicle info: ${normalizedVehicleInfo}
Lead details, history, notes, tasks, call/email/text context:
${normalizedLeadDetails}

Existing lead memory summary: ${safeString(leadMemory.summary) || 'None'}
Existing lead memory notes:
${
  leadMemory.notes && leadMemory.notes.length
    ? leadMemory.notes.map((n, i) => `${i + 1}. ${n}`).join('\n')
    : 'None'
}

Last customer message:
${lastCustomerMessage || 'No customer message yet.'}

Conversation:
${conversation}

Think like a sharp desk manager / internet director.
Decide the actual best next move: should the salesperson CALL, TEXT, EMAIL, or WAIT?
Then coach the salesperson on how to move the customer toward the store visit, firm next step, or stronger commitment.
The lead details may include structured sections like Customer, Lead Summary, Vehicle, and Notes & History. Use all of them.
Return only valid JSON.
`.trim();
}

function mergeLeadMemory(existingMemory, analysis) {
  const existingNotes = Array.isArray(existingMemory.notes)
    ? existingMemory.notes
    : [];
  const updateNotes = Array.isArray(analysis.memory_updates)
    ? analysis.memory_updates
        .map((x) => safeString(x))
        .filter(Boolean)
    : [];

  const mergedNotes = [...existingNotes];

  for (const note of updateNotes) {
    if (!mergedNotes.some((n) => n.toLowerCase() === note.toLowerCase())) {
      mergedNotes.push(note);
    }
  }

  return {
    summary: safeString(analysis.memory_summary) || existingMemory.summary || '',
    notes: mergedNotes.slice(-25),
    updatedAt: new Date().toISOString(),
  };
}

function detectConversationLanguage(messages, leadDetails) {
  const haystack = `${formatConversation(messages)}\n${safeString(leadDetails)}`.toLowerCase();
  return /\b(hola|gracias|quiero|precio|camioneta|si|sí|puedo|hablar)\b/.test(haystack)
    ? 'Spanish'
    : 'English';
}

function buildFallbackReplies(lastCustomerMessage, customerName) {
  const name = safeString(customerName).split(/\s+/)[0] || 'there';
  const last = safeString(lastCustomerMessage).toLowerCase();

  if (!last) {
    return [
      `Hi ${name}, this is Brandon with Hiley Chevrolet of Rockwall. What questions can I answer for you on the vehicle?`,
      `Hi ${name}, I can help with pricing, availability, or trade details. What would you like to go over first?`,
      `Hi ${name}, I’m here to help with the next step on your vehicle search. Are you looking at one specific truck?`,
    ];
  }

  if (/\bprice|priced|32000|payment|payments|otd|out the door|difference\b/.test(last)) {
    return [
      `I can help with that. Are you talking about the red truck on the website at 32000?`,
      `Got it. If we're talking about that red truck, do you want me to confirm the exact numbers on that one?`,
      `I can narrow that down for you. Are you wanting the website truck at 32000 or a different one?`,
    ];
  }

  if (/\bavailable|still there|in stock\b/.test(last)) {
    return [
      `Yes, it looks available right now. Do you want to come see it today or would you like me to confirm details first?`,
      `It appears available. Are you looking to buy soon or still comparing a few options?`,
      `Yes, it should still be available. Want me to confirm the exact truck you're looking at?`,
    ];
  }

  if (/\bcall|talk|phone\b/.test(last)) {
    return [
      `I can do that. What’s the best number to reach you on right now?`,
      `Yes, I can call. Are you free now or in a few minutes?`,
      `I’m available to talk. Let me know the best number and time.`,
    ];
  }

  return [
    `I got you. What’s the main thing you want to lock down next so I can help move this forward?`,
    `That makes sense. What’s the biggest question you want answered first?`,
    `I can help with that. Are you wanting pricing, availability, or the next step on the truck?`,
  ];
}

function buildFallbackAnalysis({
  messages,
  customerName,
  leadDetails,
  vehicleInfo,
  existingMemory,
}) {
  const lastCustomerMessage = extractLastCustomerMessage(messages);
  const language = detectConversationLanguage(messages, leadDetails);
  const replies = buildFallbackReplies(lastCustomerMessage, customerName);
  const hasRecentCustomerMessage = !!safeString(lastCustomerMessage);
  const normalizedLeadDetails = safeString(leadDetails);
  const contactAlreadyMade = /\bContacted:\s*Yes\b/i.test(normalizedLeadDetails) || /\bPhone Contact:\s*Yes\b/i.test(normalizedLeadDetails) || /\bText Conversation:\s*Yes\b/i.test(normalizedLeadDetails);
  const activeConversation = hasRecentCustomerMessage || contactAlreadyMade;
  const vehicleSummary = safeString(vehicleInfo) || 'Vehicle details are limited.';
  const memorySummary =
    safeString(existingMemory.summary) ||
    `Fallback analysis used because OpenAI quota is currently unavailable. Vehicle: ${vehicleSummary}`;

  return {
    buyer_type: activeConversation ? 'Active shopper' : 'New inquiry',
    deal_stage: activeConversation ? 'Conversation in progress' : 'Initial contact',
    best_next_action: activeConversation
      ? 'TEXT the customer back with a clarifying question tied to the exact vehicle or numbers they mentioned.'
      : 'TEXT the customer with a strong opening message and identify the exact vehicle of interest.',
    next_step_channel: 'TEXT',
    next_step_reason:
      'OpenAI quota is unavailable, so a local fallback is guiding the next step based on the visible CRM lead details and recent conversation evidence.',
    strategy:
      activeConversation
        ? 'This is not a fresh lead. Continue from the existing relationship, acknowledge the prior contact, tighten the conversation around the exact truck or commitment, and avoid restarting discovery from scratch.'
        : 'Acknowledge the customer’s point, tighten the conversation around the exact truck or number they mentioned, and avoid broad back-and-forth until the vehicle and ask are confirmed.',
    recommended_reply: replies[0],
    recommended_reply_2: replies[1],
    recommended_reply_3: replies[2],
    conversation_language: language,
    customer_sentiment: activeConversation ? 'Engaged' : 'Unknown',
    hot_points: uniqueFallbackItems([
      safeString(lastCustomerMessage) ? `Latest customer message: ${safeString(lastCustomerMessage)}` : '',
      safeString(vehicleInfo) ? `Vehicle context: ${safeString(vehicleInfo)}` : '',
    ]),
    objections: uniqueFallbackItems([
      /\bprice|payment|otd|difference\b/i.test(lastCustomerMessage) ? 'Price/payment concern' : '',
    ]),
    appointment_opportunity: /\btoday|come in|available\b/i.test(lastCustomerMessage),
    memory_summary: memorySummary,
    memory_updates: uniqueFallbackItems([
      safeString(lastCustomerMessage) ? `Latest customer message: ${safeString(lastCustomerMessage)}` : '',
      'Fallback analysis used because OpenAI quota was exceeded.',
    ]),
    fallback_used: true,
  };
}

function uniqueFallbackItems(items) {
  const seen = new Set();
  return items.filter((item) => {
    const text = safeString(item);
    if (!text) return false;
    const key = text.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isQuotaError(error) {
  const message = safeString(error?.message).toLowerCase();
  return (
    Number(error?.status) === 429 ||
    message.includes('quota') ||
    message.includes('billing') ||
    message.includes('rate limit')
  );
}

function getSnapshotEvents(snapshotInput = {}) {
  return safeArray(snapshotInput.events || snapshotInput.network_events).map((event) => ({
    method: safeString(event.method || 'GET'),
    url: safeString(event.url),
    path: safeString(event.path),
    status: safeString(event.status),
    content_type: safeString(event.content_type || event.contentType),
    body_snippet: safeString(event.body_snippet || event.bodySnippet || event.body),
    request_body_snippet: safeString(
      event.request_body_snippet || event.requestBodySnippet || event.requestBody
    ),
    captured_at: safeString(event.captured_at || event.capturedAt),
  }));
}

function getSnapshotSections(snapshotInput = {}) {
  const sections = snapshotInput.sections || snapshotInput.snapshot_sections || {};
  return {
    customer_header_text: safeString(
      sections.customer_header_text || sections.customerHeaderText
    ),
    recent_activity_text: safeString(
      sections.recent_activity_text || sections.recentActivityText
    ),
    sales_history_text: safeString(
      sections.sales_history_text || sections.salesHistoryText
    ),
    lead_info_text: safeString(
      sections.lead_info_text || sections.leadInfoText
    ),
    vehicle_info_text: safeString(
      sections.vehicle_info_text || sections.vehicleInfoText
    ),
    notes_history_text: safeString(
      sections.notes_history_text || sections.notesHistoryText
    ),
  };
}

function getSnapshotSalesRows(snapshotInput = {}) {
  return safeArray(snapshotInput.sales_rows || snapshotInput.salesRows).map((row) => ({
    status: safeString(row.status),
    created: safeString(row.created),
    source: safeString(row.source),
    vehicle: safeString(row.vehicle),
    row_text: safeString(row.row_text || row.rowText),
  }));
}

function snapshotEventText(event) {
  return [event.url, event.path, event.body_snippet, event.request_body_snippet]
    .map((value) => safeString(value))
    .filter(Boolean)
    .join('\n');
}

function extractVehicleLinesFromSnapshotText(text = '') {
  const makePattern =
    /\b(Chevrolet|Ford|GMC|Buick|Cadillac|Toyota|Honda|Nissan|Jeep|Ram|Dodge|Hyundai|Kia|Subaru|Volkswagen|BMW|Mercedes|Audi|Lexus|Mazda|Chrysler|Lincoln|Volvo|Porsche|Acura|Infiniti|Mitsubishi|Tesla|Genesis)\b/i;
  const typePattern =
    /\b(Trax|Traverse|Tahoe|Suburban|Silverado|Colorado|Blazer|Equinox|Explorer|Expedition|Camry|Corolla|Civic|Accord|Ranger|Sierra|F-150|2500HD|1500|SUV|Pickup|Sport Utility|Crew Cab|Double Cab|Regular Cab)\b/i;

  return uniqueStrings(
    safeString(text)
      .split(/\n|\|/)
      .map((line) => safeString(line))
      .filter(Boolean)
      .filter((line) => /\b(?:19|20)\d{2}\b/.test(line))
      .filter((line) => makePattern.test(line) || typePattern.test(line))
      .filter(
        (line) =>
          !(
            /\b(?:dr|drive|rd|road|st|street|ave|avenue|blvd|boulevard|cir|circle|ct|court|ln|lane|apt|suite)\b/i.test(
              line
            ) && !makePattern.test(line)
          )
      )
    );
}

function buildSnapshotVehicleCandidates({
  events = [],
  sections = {},
  salesRows = [],
} = {}) {
  const makePattern =
    /\b(Chevrolet|Ford|GMC|Buick|Cadillac|Toyota|Honda|Nissan|Jeep|Ram|Dodge|Hyundai|Kia|Subaru|Volkswagen|BMW|Mercedes|Audi|Lexus|Mazda|Chrysler|Lincoln|Volvo|Porsche|Acura|Infiniti|Mitsubishi)\b/i;
  const typePattern =
    /\b(Trax|Traverse|Tahoe|Suburban|Silverado|Colorado|Blazer|Equinox|Explorer|Expedition|Camry|Corolla|Civic|Accord|Ranger|Sierra|F-150|2500HD|1500|SUV|Pickup|Sport Utility)\b/i;
  const candidates = [];

  const addCandidate = (line, score, source) => {
    const cleaned = safeString(line).replace(/\s+/g, ' ').trim();
    if (!cleaned) return;

    const existing = candidates.find(
      (candidate) => candidate.line.toLowerCase() === cleaned.toLowerCase()
    );
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.source = existing.source || source;
      return;
    }

    candidates.push({
      line: cleaned.slice(0, 240),
      score,
      source: safeString(source),
    });
  };

  extractVehicleLinesFromSnapshotText(sections.vehicle_info_text).forEach((line, index) => {
    addCandidate(line, 140 - index * 5, 'vehicle_info_text');
  });

  safeArray(salesRows).forEach((row, index) => {
    const status = safeString(row.status);
    const score = /\bactive\b/i.test(status)
      ? 110 - index
      : /\b(lost|duplicate|sold|delivered)\b/i.test(status)
      ? 45 - index
      : 80 - index;
    addCandidate(row.vehicle || row.row_text, score, 'sales_row');
  });

  extractVehicleLinesFromSnapshotText(sections.sales_history_text).forEach((line, index) => {
    addCandidate(line, 70 - index, 'sales_history_text');
  });

  extractVehicleLinesFromSnapshotText(sections.customer_header_text).forEach((line, index) => {
    addCandidate(line, 20 - index, 'customer_header_text');
  });

  for (const event of safeArray(events)) {
    const lines = uniqueStrings(
      [event.body_snippet, event.request_body_snippet]
        .filter(Boolean)
        .flatMap((text) => String(text).split(/\n|\|/))
        .map((line) => safeString(line))
        .filter(Boolean)
    );

    for (const line of lines) {
      if (!/\b(?:19|20)\d{2}\b/.test(line)) continue;
      if (!makePattern.test(line) && !typePattern.test(line)) continue;

      let score = 0;
      if (makePattern.test(line)) score += 4;
      if (typePattern.test(line)) score += 2;
      if (/\bvehicle info\b/i.test(event.body_snippet || '')) score += 5;
      if (/\bactive\b/i.test(line) || /\bactive\b/i.test(event.body_snippet || '')) score += 4;
      if (/\blost|duplicate|sold|delivered\b/i.test(line)) score -= 4;
      if (/\bstock|vin|color|location|pickup|sport utility|crew cab|lt|premier|custom\b/i.test(line)) score += 2;
      if (/CustomerDashboard|CarDashboard|vinconnect/i.test(event.url) || /CustomerDashboard|CarDashboard|vinconnect/i.test(event.path)) score += 2;

      addCandidate(line, score + 15, 'network_event');
    }
  }

  return candidates
    .sort((a, b) => b.score - a.score)
    .filter(
      (candidate, index, array) =>
        array.findIndex(
          (item) => item.line.toLowerCase() === candidate.line.toLowerCase()
        ) === index
    );
}

function extractSnapshotLeadState(snapshotInput = {}) {
  const events = getSnapshotEvents(snapshotInput);
  const sections = getSnapshotSections(snapshotInput);
  const salesRows = getSnapshotSalesRows(snapshotInput);
  const sectionText = Object.values(sections).filter(Boolean).join('\n');
  const combinedText = [sectionText, ...events.map(snapshotEventText)]
    .filter(Boolean)
    .join('\n');
  const vehicleCandidates = buildSnapshotVehicleCandidates({
    events,
    sections,
    salesRows,
  });
  const topVehicle = safeString(vehicleCandidates[0]?.line);
  const activeSalesRow =
    salesRows.find((row) => /\bactive\b/i.test(safeString(row.status))) || salesRows[0] || {};
  const leadSource =
    safeString(
      safeString((sections.lead_info_text.match(/\bSource\s*:?\s*([^\n]+)/i) || [])[1]) ||
        safeString(activeSalesRow.source) ||
      (combinedText.match(
        /\b(?:Di\s*-\s*[A-Za-z0-9 .-]+|700Credit\.Com|Cargurus|Cars\.com|Carfax, Inc|AutoTrader\.com|Dealers?\s+WebSite|Wholesale|Internet|Phone|Walk In|GM 3rd Party|Social\s*-\s*Facebook\/Instagram\/Etc)\b/i
      ) || [])[0]
    ) || '';
  const status =
    safeString(
      safeString((sections.lead_info_text.match(/\bStatus\s*:?\s*([^\n]+)/i) || [])[1]) ||
        safeString(activeSalesRow.status) ||
      (combinedText.match(
        /\b(Waiting for Prospect Response|Waiting for response|Active|Duplicate|Sold|Lost|Bad|Delivered|New Lead)\b/i
      ) || [])[0]
    ) || '';
  const contacted =
    safeString((sections.lead_info_text.match(/\bContacted\s*:\s*(Yes|No[^\n]*)/i) || [])[1]) ||
    safeString((combinedText.match(/\bContacted\s*:\s*(Yes|No[^\n]*)/i) || [])[1]) ||
    (/recent text\/call activity detected|text conversation/i.test(combinedText) ? 'Yes' : '');
  const attempted = safeString(
    (sections.lead_info_text.match(/\bAttempted\s*:\s*([^\n]+)/i) || [])[1] ||
      (combinedText.match(/\bAttempted\s*:\s*([^\n]+)/i) || [])[1]
  );
  const phoneCallDetected = /phone call|voicemail|no contact|duration:\d{1,2}:\d{2}/i.test(
    combinedText
  );
  const textDetected = /text message|sms|reply received|inbound text|outbound text/i.test(
    combinedText
  );
  const noteLines = uniqueStrings(
    [
      ...safeString(sections.notes_history_text).split('\n'),
      ...safeString(sections.recent_activity_text).split('\n'),
    ]
      .map((line) => safeString(line))
      .filter(Boolean)
  ).slice(0, 12);
  const sectionCount = Object.values(sections).filter(Boolean).length;

  return {
    vehicles: {
      primary: {
        summary: topVehicle,
      },
      discussed: vehicleCandidates.slice(1, 5).map((candidate) => candidate.line),
      historical: vehicleCandidates.slice(0, 8).map((candidate) => candidate.line),
    },
    source: {
      lead_source: leadSource,
    },
    lifecycle: {
      status,
      contacted,
      attempted,
    },
    communications: {
      channels_used: uniqueStrings([
        textDetected ? 'TEXT' : '',
        phoneCallDetected ? 'CALL' : '',
      ]),
      calls: phoneCallDetected ? ['CRM snapshot detected phone call history'] : [],
      texts: textDetected ? ['CRM snapshot detected text history'] : [],
      notes: uniqueStrings([
        ...noteLines,
        ...events
          .filter((event) => safeString(event.body_snippet))
          .slice(0, 10)
          .map((event) =>
            [safeString(event.method), safeString(event.status), safeString(event.path || event.url)]
              .filter(Boolean)
              .join(' ')
          ),
      ]),
    },
    opportunity: {
      risk_flags: uniqueStrings([
        !events.length && !sectionCount ? 'No CRM snapshot data captured' : '',
        !topVehicle && (events.length || sectionCount) ? 'CRM snapshot missing primary vehicle' : '',
      ]),
    },
    meta: {
      captured_from: uniqueStrings([
        events.length ? 'crm-snapshot-events' : '',
        sectionCount ? 'crm-snapshot-sections' : '',
      ]),
      data_quality:
        topVehicle && sectionCount
          ? 'high'
          : events.some((event) => safeString(event.body_snippet)) || sectionCount
          ? 'medium'
          : '',
    },
    snapshot: {
      event_count: events.length,
      section_count: sectionCount,
      vehicle_candidates: vehicleCandidates.slice(0, 6),
    },
  };
}

function coerceLeadStateFromRequest(body = {}) {
  const incomingLeadState = body.leadState || body.lead_state || {};
  const incomingSnapshot = body.crmSnapshot || body.crm_snapshot || {};
  const snapshotState = extractSnapshotLeadState(incomingSnapshot);
  const normalizedMessages = normalizeMessages(
    incomingLeadState.communications?.messages || body.messages
  );

  return normalizeLeadState({
    ...incomingLeadState,
    ids: {
      ...(incomingLeadState.ids || {}),
      lead_id:
        safeString(incomingLeadState.ids?.lead_id) ||
        safeString(body.leadId || body.lead_id),
    },
    customer: {
      ...(incomingLeadState.customer || {}),
      name:
        safeString(incomingLeadState.customer?.name) ||
        safeString(body.customerName || body.customer_name),
      phone:
        safeString(incomingLeadState.customer?.phone) ||
        safeString(body.phone),
      email:
        safeString(incomingLeadState.customer?.email) ||
        safeString(body.email),
      zip:
        safeString(incomingLeadState.customer?.zip) ||
        safeString(body.zip),
    },
    assignment: {
      ...(incomingLeadState.assignment || {}),
      salesperson:
        safeString(incomingLeadState.assignment?.salesperson) ||
        safeString(body.salespersonName || body.salesperson_name),
    },
    lifecycle: {
      ...(incomingLeadState.lifecycle || {}),
      ...(snapshotState.lifecycle || {}),
      status:
        safeString(incomingLeadState.lifecycle?.status) ||
        safeString(snapshotState.lifecycle?.status) ||
        safeString(body.statusValue || body.status),
      process:
        safeString(incomingLeadState.lifecycle?.process) ||
        safeString(body.processValue || body.process),
    },
    source: {
      ...(incomingLeadState.source || {}),
      ...(snapshotState.source || {}),
      lead_source:
        safeString(incomingLeadState.source?.lead_source) ||
        safeString(snapshotState.source?.lead_source) ||
        safeString(body.leadSource || body.lead_source),
    },
    vehicles: {
      ...(incomingLeadState.vehicles || {}),
      ...(snapshotState.vehicles || {}),
      primary: {
        ...(incomingLeadState.vehicles?.primary || {}),
        ...(snapshotState.vehicles?.primary || {}),
        summary:
          safeString(snapshotState.vehicles?.primary?.summary) ||
          safeString(incomingLeadState.vehicles?.primary?.summary) ||
          safeString(body.vehicleInfo || body.vehicleSummary),
      },
    },
    communications: {
      ...(incomingLeadState.communications || {}),
      ...(snapshotState.communications || {}),
      channels_used: uniqueStrings([
        ...(safeArray(incomingLeadState.communications?.channels_used)),
        ...(safeArray(snapshotState.communications?.channels_used)),
      ]),
      messages: normalizedMessages,
      notes: uniqueStrings([
        ...(safeArray(incomingLeadState.communications?.notes)),
        ...(safeArray(snapshotState.communications?.notes)),
      ]),
      calls: uniqueStrings([
        ...(safeArray(incomingLeadState.communications?.calls)),
        ...(safeArray(snapshotState.communications?.calls)),
      ]),
      texts: uniqueStrings([
        ...(safeArray(incomingLeadState.communications?.texts)),
        ...(safeArray(snapshotState.communications?.texts)),
      ]),
      last_customer_message:
        safeString(incomingLeadState.communications?.last_customer_message) ||
        extractLastCustomerMessage(normalizedMessages),
    },
    opportunity: {
      ...(incomingLeadState.opportunity || {}),
      ...(snapshotState.opportunity || {}),
      risk_flags: uniqueStrings([
        ...(safeArray(incomingLeadState.opportunity?.risk_flags)),
        ...(safeArray(snapshotState.opportunity?.risk_flags)),
      ]),
    },
    meta: {
      ...(incomingLeadState.meta || {}),
      ...(snapshotState.meta || {}),
      captured_from: uniqueStrings([
        ...(Array.isArray(incomingLeadState.meta?.captured_from)
          ? incomingLeadState.meta.captured_from
          : ['extension']),
        ...(safeArray(snapshotState.meta?.captured_from)),
      ]),
      captured_at:
        safeString(incomingLeadState.meta?.captured_at) ||
        new Date().toISOString(),
      data_quality:
        safeString(snapshotState.meta?.data_quality) ||
        safeString(incomingLeadState.meta?.data_quality) ||
        (safeString(body.leadDetails) ? 'mixed' : ''),
    },
  });
}

function buildV2SystemPrompt() {
  return `
You are LeadTorque, an elite automotive sales manager coach for ${DEALERSHIP_NAME}.

You are not just writing text replies. You are deciding the best next move for the salesperson based on a normalized lead state and rule-engine signals.

Your priorities:
- maximize engagement
- improve appointment set rate
- improve appointment show rate
- improve close rate
- choose the best contact channel next
- coach the salesperson like a strong internet director or desk manager

Instructions:
1. Treat the normalized lead state as the source of truth.
2. Respect the rule signals. Use them as guardrails, not suggestions to ignore.
3. Prefer the active vehicle and active lead context over historical or lost vehicles.
4. Keep coaching specific and practical.
5. Avoid generic "just checking in" language.
6. If rule signals indicate the appointment is already scheduled or confirmed, prioritize appointment confirmation and show-rate coaching over objection handling.
7. If CALL is best, explain the call objective.
8. If TEXT is best, provide a short text the rep can send.
9. If EMAIL is best, explain what the email should accomplish.
10. If WAIT is best, explain what should be monitored before the next action.

Return ONLY valid JSON with this exact shape:
{
  "playbook": "string",
  "priority": "string",
  "primary_goal": "string",
  "best_next_action": "string",
  "primary_channel": "TEXT or CALL or EMAIL or WAIT",
  "why": "string",
  "manager_coaching": "string",
  "suggested_text": "string",
  "suggested_call_objective": "string",
  "suggested_email_objective": "string",
  "objections_detected": ["string"],
  "appointment_opportunity": true,
  "risk_flags": ["string"],
  "confidence": 0.0
}
`.trim();
}

function buildV2UserPrompt({
  leadState,
  ruleSignals,
  leadMemory,
  supplementalLeadDetails,
}) {
  const summary = summarizeLeadState(leadState);
  const conversation = formatConversation(leadState.communications.messages || []);

  return `
Build the strongest coaching plan for this dealership lead.

Normalized lead state summary:
${summary || 'No normalized lead summary available.'}

Rule engine signals:
${JSON.stringify(ruleSignals, null, 2)}

Lead state JSON:
${JSON.stringify(leadState, null, 2)}

Existing lead memory summary:
${safeString(leadMemory.summary) || 'None'}

Existing lead memory notes:
${
  Array.isArray(leadMemory.notes) && leadMemory.notes.length
    ? leadMemory.notes.map((note, index) => `${index + 1}. ${note}`).join('\n')
    : 'None'
}

Supplemental raw lead details:
${stringifyForPrompt(supplementalLeadDetails) || 'None'}

Conversation:
${conversation}

Return only valid JSON.
`.trim();
}

function buildV2FallbackPlan({ leadState, ruleSignals, leadMemory }) {
  const primaryChannel = ruleSignals.suggested_channel || 'TEXT';
  const primaryVehicle =
    safeString(leadState.vehicles?.primary?.summary) || 'the vehicle';
  const customerFirstName =
    safeString(leadState.customer?.name).split(/\s+/)[0] || 'there';
  const lastCustomerMessage =
    safeString(leadState.communications?.last_customer_message);

  const textByChannel = {
    TEXT: `Hi ${customerFirstName}, I want to make sure I’m helping with the right next step on ${primaryVehicle}. What’s the biggest thing you want answered right now?`,
    CALL: `Hi ${customerFirstName}, I can help clear this up faster by phone. Are you free for a quick call now or in a few minutes?`,
    EMAIL: `Hi ${customerFirstName}, I can send a clean summary on ${primaryVehicle}. What details do you want me to make sure are included?`,
    WAIT: `I’ll stay ready on my side. If anything changes on timing or the vehicle, let me know and I’ll help with the next step.`
  };

  const whyByChannel = {
    TEXT: 'There is active engagement or a lightweight clarification is the best next step.',
    CALL: 'There is enough friction, nuance, or momentum that a call should move the deal forward faster than text.',
    EMAIL: 'A written summary or documentation follow-up is the cleanest next move.',
    WAIT: 'The lead appears overworked or timing-sensitive, so a pause is better than forcing another touch.'
  };

  return normalizeCoachingPlan({
    best_next_action: `${primaryChannel} the customer next regarding ${primaryVehicle}.`,
    primary_channel: primaryChannel,
    why: whyByChannel[primaryChannel] || whyByChannel.TEXT,
    manager_coaching:
      primaryChannel === 'CALL'
        ? `Use the call to clarify the customer's priorities, handle objections directly, and push toward a firm next commitment on ${primaryVehicle}.`
        : primaryChannel === 'EMAIL'
        ? `Use email to organize the details cleanly, reduce confusion, and create a strong handoff back into a call or appointment.`
        : primaryChannel === 'WAIT'
        ? 'Do not overwork the lead. Watch for the next meaningful engagement signal before re-entering the conversation.'
        : `Keep the conversation focused on the active vehicle, answer the real question, and move toward a specific next commitment.`,
    suggested_text: textByChannel[primaryChannel],
    suggested_call_objective:
      primaryChannel === 'CALL'
        ? `Clarify the objection, confirm the right vehicle, and move toward an appointment or commitment on ${primaryVehicle}.`
        : '',
    suggested_email_objective:
      primaryChannel === 'EMAIL'
        ? `Summarize the key details on ${primaryVehicle} and reduce confusion so the customer can take the next step.`
        : '',
    objections_detected: uniqueFallbackItems([
      /\bprice|payment|fees|trade\b/i.test(lastCustomerMessage)
        ? 'Price or payment objection'
        : '',
    ]),
    appointment_opportunity: Boolean(ruleSignals.has_appointment_opportunity),
    risk_flags: uniqueFallbackItems([
      !safeString(leadState.vehicles?.primary?.summary) ? 'Primary vehicle unclear' : '',
      !Array.isArray(leadState.communications?.messages) || !leadState.communications.messages.length
        ? 'Thin communication history'
        : '',
    ]),
    confidence: 0.45,
    fallback_used: true,
    lead_memory_summary:
      safeString(leadMemory.summary) ||
      summarizeLeadState(leadState),
  });
}

function buildV2LeadMemory(existingMemory, leadState, coachingPlan) {
  const notes = Array.isArray(existingMemory.notes)
    ? [...existingMemory.notes]
    : [];

  const additions = uniqueFallbackItems([
    safeString(leadState.vehicles?.primary?.summary)
      ? `Primary vehicle: ${safeString(leadState.vehicles.primary.summary)}`
      : '',
    safeString(leadState.communications?.last_customer_message)
      ? `Last customer message: ${safeString(leadState.communications.last_customer_message)}`
      : '',
    safeString(coachingPlan.primary_channel)
      ? `Recommended channel: ${safeString(coachingPlan.primary_channel)}`
      : '',
    safeString(coachingPlan.best_next_action)
      ? `Recommended action: ${safeString(coachingPlan.best_next_action)}`
      : '',
  ]);

  for (const note of additions) {
    if (!notes.some((existing) => safeString(existing).toLowerCase() === note.toLowerCase())) {
      notes.push(note);
    }
  }

  return {
    summary:
      safeString(coachingPlan.why) ||
      safeString(coachingPlan.manager_coaching) ||
      safeString(existingMemory.summary) ||
      summarizeLeadState(leadState),
    notes: notes.slice(-25),
    updatedAt: new Date().toISOString(),
  };
}

function buildV2FallbackPlan({ leadState, ruleSignals, leadMemory }) {
  const primaryChannel = safeString(ruleSignals.suggested_channel || 'TEXT').toUpperCase();
  const playbook = safeString(ruleSignals.playbook) || 'ENGAGED_TEXT_THREAD';
  const priority = safeString(ruleSignals.priority) || 'MEDIUM';
  const primaryGoal =
    safeString(ruleSignals.primary_goal) ||
    'Move the lead to the next meaningful commitment.';
  const primaryVehicle =
    safeString(leadState.vehicles?.primary?.summary) || 'the vehicle';
  const customerFirstName =
    safeString(leadState.customer?.name).split(/\s+/)[0] || 'there';
  const lastCustomerMessage =
    safeString(leadState.communications?.last_customer_message);
  const salesperson =
    safeString(leadState.assignment?.salesperson) || 'the assigned rep';

  const channelText = {
    TEXT: `Hi ${customerFirstName}, I want to make sure I'm helping with the right next step on ${primaryVehicle}. What's the biggest thing you want answered right now?`,
    CALL: `Hi ${customerFirstName}, I can help clear this up faster by phone. Are you free for a quick call now or in a few minutes?`,
    EMAIL: `Hi ${customerFirstName}, I can send a clean summary on ${primaryVehicle}. What details do you want me to make sure are included?`,
    WAIT: `I'll stay ready on my side. If anything changes on timing or the vehicle, let me know and I'll help with the next step.`
  };

  let why =
    'There is active engagement or a lightweight clarification is the best next step.';
  let managerCoaching =
    `Keep the conversation focused on ${primaryVehicle}, answer the real question, and move toward a specific next commitment.`;
  let suggestedText = channelText[primaryChannel] || channelText.TEXT;
  let suggestedCallObjective = '';
  let suggestedEmailObjective = '';

  switch (playbook) {
    case 'APPOINTMENT_CONFIRMATION':
      why =
        'The customer already appears scheduled, so the best move is confirming the appointment details and protecting the show.';
      managerCoaching =
        `Coach ${salesperson} to confirm the exact day and time, reinforce the value of the visit, and reduce no-show risk without reopening unnecessary negotiation on ${primaryVehicle}.`;
      suggestedText = `Hi ${customerFirstName}, I have you penciled in for ${primaryVehicle}. I just want to confirm we are still set for tomorrow between 10 and 11 and make sure you have everything you need before you head in.`;
      suggestedCallObjective =
        `Confirm the appointment window, verify the customer is still coming, and remove any last-minute friction that could cause a no-show on ${primaryVehicle}.`;
      suggestedEmailObjective =
        `Confirm the appointment details in writing, restate the vehicle, and make the visit feel easy to keep.`;
      break;
    case 'APPOINTMENT_RECOVERY':
      why =
        'The lead already had momentum, so the best move is recovering the missed or canceled appointment quickly.';
      managerCoaching =
        `Coach ${salesperson} to acknowledge the disruption, offer two concrete appointment options, and make it easy for the customer to recommit on ${primaryVehicle}.`;
      suggestedText = `Hi ${customerFirstName}, I know the appointment got thrown off. I still have ${primaryVehicle} in mind for you. Would later today or tomorrow work better to get you back in?`;
      suggestedCallObjective =
        `Recover the missed appointment, confirm timing, and leave the call with a firm visit plan on ${primaryVehicle}.`;
      break;
    case 'IDENTITY_RESET':
      why =
        'Trust needs to be rebuilt before the conversation will move forward cleanly.';
      managerCoaching =
        `Have ${salesperson} reintroduce themselves clearly, name the dealership, reference the exact lead source, and then re-anchor around ${primaryVehicle}.`;
      suggestedText = `Hi ${customerFirstName}, this is ${salesperson} with the dealership following up on your interest in ${primaryVehicle}. I want to make sure I'm helping with the right vehicle and next step.`;
      break;
    case 'OBJECTION_CLARIFICATION':
      why =
        'There is enough friction around pricing, trade, or comparison shopping that a live conversation should move the deal faster than back-and-forth text.';
      managerCoaching =
        `Use a live call to isolate the real objection, protect gross where possible, and move the customer toward an appointment instead of negotiating in circles.`;
      suggestedText = `Hi ${customerFirstName}, I can help clear up the details on ${primaryVehicle} faster by phone than by text. Are you available for a quick call?`;
      suggestedCallObjective =
        `Clarify whether the issue is price, trade, payment, or comparison shopping, and move toward an appointment on ${primaryVehicle}.`;
      break;
    case 'PRODUCT_CONFIRMATION':
      why =
        'The customer is asking specific product questions, so answering the exact question should earn the next commitment.';
      managerCoaching =
        `Coach ${salesperson} to answer the exact question first, avoid generic filler, and then convert that clarity into an appointment or next step on ${primaryVehicle}.`;
      suggestedText = `Hi ${customerFirstName}, yes, I can help with the exact details on ${primaryVehicle}. The biggest thing to confirm next is what matters most to you before you come in.`;
      break;
    case 'REVIVE_STALLED_LEAD':
      why =
        'The lead looks stalled, so the next touch should be short, low-friction, and easy to answer.';
      managerCoaching =
        `Keep the outreach short, specific, and centered on whether ${primaryVehicle} is still the right fit instead of pushing too hard too early.`;
      suggestedText = `Hi ${customerFirstName}, I wanted to circle back on ${primaryVehicle}. Is this still the right vehicle for what you're trying to accomplish?`;
      break;
    case 'DOCUMENTED_FOLLOW_UP':
      why =
        'A clean written follow-up is the best way to organize the details before the next live conversation.';
      managerCoaching =
        `Use email to reduce confusion, summarize the key facts on ${primaryVehicle}, and create a reason for the customer to reply or schedule the next live touch.`;
      suggestedText = `Hi ${customerFirstName}, I can send you a clean summary on ${primaryVehicle} so everything is in one place. I just want to make sure I include the details you care about most.`;
      suggestedEmailObjective =
        `Summarize the key facts on ${primaryVehicle}, reduce confusion, and create a reason for the customer to reply or schedule the next live touch.`;
      break;
    case 'NEW_LEAD_OPENER':
      why =
        'The lead needs a clear first move that confirms the right vehicle and starts momentum cleanly.';
      managerCoaching =
        `Open with confidence, confirm that ${primaryVehicle} is still the right fit, and guide the customer toward a real response or appointment.`;
      suggestedText = `Hi ${customerFirstName}, this is ${salesperson}. I'm reaching out about ${primaryVehicle} and want to make sure I help with the right next step for you.`;
      break;
    case 'ENGAGED_TEXT_THREAD':
    default:
      why =
        'The lead is actively engaging, so the best move is to keep momentum and convert it into a commitment.';
      managerCoaching =
        `Keep the conversation focused on ${primaryVehicle}, answer the real question, and move toward a specific next commitment.`;
      break;
  }

  if (primaryChannel === 'CALL' && !suggestedCallObjective) {
    suggestedCallObjective =
      `Clarify the customer's priorities, confirm the right vehicle, and move toward an appointment or commitment on ${primaryVehicle}.`;
  }

  if (primaryChannel === 'EMAIL' && !suggestedEmailObjective) {
    suggestedEmailObjective =
      `Summarize the key details on ${primaryVehicle} and reduce confusion so the customer can take the next step.`;
  }

  return normalizeCoachingPlan({
    playbook,
    priority,
    primary_goal: primaryGoal,
    best_next_action: `${primaryChannel} the customer next regarding ${primaryVehicle}.`,
    primary_channel: primaryChannel,
    why,
    manager_coaching: managerCoaching,
    suggested_text: suggestedText,
    suggested_call_objective: suggestedCallObjective,
    suggested_email_objective: suggestedEmailObjective,
    objections_detected: uniqueFallbackItems([
      ...safeArray(ruleSignals.objections_detected),
      /\bprice|payment|fees|trade\b/i.test(lastCustomerMessage)
        ? 'Price or payment objection'
        : '',
    ]),
    appointment_opportunity: Boolean(ruleSignals.has_appointment_opportunity),
    risk_flags: uniqueFallbackItems([
      ...safeArray(ruleSignals.risk_flags),
      !safeString(leadState.vehicles?.primary?.summary) ? 'Primary vehicle unclear' : '',
      !Array.isArray(leadState.communications?.messages) || !leadState.communications.messages.length
        ? 'Thin communication history'
        : '',
    ]),
    confidence: 0.45,
    fallback_used: true,
    lead_memory_summary:
      safeString(leadMemory.summary) ||
      summarizeLeadState(leadState),
  });
}

function buildV2LeadMemory(existingMemory, leadState, coachingPlan) {
  const notes = Array.isArray(existingMemory.notes)
    ? [...existingMemory.notes]
    : [];

  const additions = uniqueFallbackItems([
    safeString(coachingPlan.playbook)
      ? `Playbook: ${safeString(coachingPlan.playbook)}`
      : '',
    safeString(coachingPlan.priority)
      ? `Priority: ${safeString(coachingPlan.priority)}`
      : '',
    safeString(coachingPlan.primary_goal)
      ? `Primary goal: ${safeString(coachingPlan.primary_goal)}`
      : '',
    safeString(leadState.vehicles?.primary?.summary)
      ? `Primary vehicle: ${safeString(leadState.vehicles.primary.summary)}`
      : '',
    safeString(leadState.communications?.last_customer_message)
      ? `Last customer message: ${safeString(leadState.communications.last_customer_message)}`
      : '',
    safeString(coachingPlan.primary_channel)
      ? `Recommended channel: ${safeString(coachingPlan.primary_channel)}`
      : '',
    safeString(coachingPlan.best_next_action)
      ? `Recommended action: ${safeString(coachingPlan.best_next_action)}`
      : '',
  ]);

  for (const note of additions) {
    if (!notes.some((existing) => safeString(existing).toLowerCase() === note.toLowerCase())) {
      notes.push(note);
    }
  }

  return {
    summary:
      safeString(coachingPlan.primary_goal) ||
      safeString(coachingPlan.why) ||
      safeString(coachingPlan.manager_coaching) ||
      safeString(existingMemory.summary) ||
      summarizeLeadState(leadState),
    notes: notes.slice(-25),
    updatedAt: new Date().toISOString(),
  };
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'crm-ai-backend',
    timestamp: new Date().toISOString(),
  });
});

app.get('/lead-memory/:leadId', (req, res) => {
  const leadId = getLeadMemoryKey(req);

  if (!leadId) {
    return res.status(400).json({ error: 'Missing leadId.' });
  }

  return res.json({
    leadId,
    memory: getLeadMemory(leadId),
  });
});

app.post('/lead-memory/:leadId', (req, res) => {
  const leadId = getLeadMemoryKey(req);

  if (!leadId) {
    return res.status(400).json({ error: 'Missing leadId.' });
  }

  const incomingNotes = Array.isArray(req.body.notes)
    ? req.body.notes.map((n) => safeString(n)).filter(Boolean)
    : [];

  const memory = {
    summary: safeString(req.body.summary),
    notes: incomingNotes,
    updatedAt: new Date().toISOString(),
  };

  setLeadMemory(leadId, memory);

  return res.json({
    ok: true,
    leadId,
    memory,
  });
});

app.delete('/lead-memory/:leadId', (req, res) => {
  const leadId = getLeadMemoryKey(req);

  if (!leadId) {
    return res.status(400).json({ error: 'Missing leadId.' });
  }

  leadMemoryStore.delete(leadId);

  return res.json({
    ok: true,
    leadId,
    deleted: true,
  });
});

app.post('/analyze-thread', async (req, res) => {
  const messages = normalizeMessages(req.body.messages);
  const leadId = safeString(req.body.leadId);
  const customerName = safeString(req.body.customerName);
  const salespersonName = safeString(req.body.salespersonName);
  const vehicleInfo =
    typeof req.body.vehicleInfo === 'object'
      ? JSON.stringify(req.body.vehicleInfo)
      : safeString(req.body.vehicleInfo);
  const leadDetails =
    typeof req.body.leadDetails === 'object'
      ? JSON.stringify(req.body.leadDetails)
      : safeString(req.body.leadDetails);
  const existingMemory = getLeadMemory(leadId);

  try {
    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt({
      messages,
      customerName,
      salespersonName,
      vehicleInfo,
      leadDetails,
      leadMemory: existingMemory,
    });

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });

    const rawText = safeString(response.choices?.[0]?.message?.content);
    const analysis = parseAnalysisJson(rawText);

    const result = {
      buyer_type: safeString(analysis.buyer_type) || 'Unknown',
      deal_stage: safeString(analysis.deal_stage) || 'Unknown',
      best_next_action: safeString(analysis.best_next_action) || '',
      next_step_channel: safeString(analysis.next_step_channel).toUpperCase() || '',
      next_step_reason: safeString(analysis.next_step_reason) || '',
      strategy: safeString(analysis.strategy) || '',
      recommended_reply: safeString(analysis.recommended_reply) || '',
      recommended_reply_2: safeString(analysis.recommended_reply_2) || '',
      recommended_reply_3: safeString(analysis.recommended_reply_3) || '',
      conversation_language:
        safeString(analysis.conversation_language) || 'English',
      customer_sentiment: safeString(analysis.customer_sentiment) || '',
      hot_points: Array.isArray(analysis.hot_points) ? analysis.hot_points : [],
      objections: Array.isArray(analysis.objections) ? analysis.objections : [],
      appointment_opportunity: Boolean(analysis.appointment_opportunity),
      memory_summary: safeString(analysis.memory_summary) || '',
      memory_updates: Array.isArray(analysis.memory_updates)
        ? analysis.memory_updates
        : [],
    };

    if (leadId) {
      const mergedMemory = mergeLeadMemory(existingMemory, result);
      setLeadMemory(leadId, mergedMemory);
      result.lead_memory = mergedMemory;
    }

    return res.json(result);
  } catch (error) {
    console.error('Analyze thread error:', error);

    if (isQuotaError(error)) {
      const fallbackResult = buildFallbackAnalysis({
        messages,
        customerName,
        leadDetails,
        vehicleInfo,
        existingMemory,
      });

      if (leadId) {
        const mergedMemory = mergeLeadMemory(existingMemory, fallbackResult);
        setLeadMemory(leadId, mergedMemory);
        fallbackResult.lead_memory = mergedMemory;
      }

      return res.json(fallbackResult);
    }

    return res.status(error.status || 500).json({
      error: 'Failed to analyze thread.',
      message: error.message || 'Unknown error',
      details: error.message || 'Unknown error',
    });
  }
});

app.post('/v2/analyze-lead', async (req, res) => {
  const leadState = coerceLeadStateFromRequest(req.body);
  const leadId = safeString(
    leadState.ids?.lead_id || req.body.leadId || req.body.lead_id
  );
  const existingMemory = getLeadMemory(leadId);
  const ruleSignals = deriveRuleSignals(leadState);

  const supplementalLeadDetails =
    req.body.leadDetails && typeof req.body.leadDetails === 'object'
      ? req.body.leadDetails
      : req.body.lead_details && typeof req.body.lead_details === 'object'
      ? req.body.lead_details
      : {
          lead_details: safeString(req.body.leadDetails || req.body.lead_details),
          vehicle_info:
            typeof req.body.vehicleInfo === 'object'
              ? req.body.vehicleInfo
              : safeString(req.body.vehicleInfo),
          crm_snapshot: req.body.crmSnapshot || req.body.crm_snapshot || null,
          status: safeString(req.body.statusValue || req.body.status),
          process: safeString(req.body.processValue || req.body.process),
          customer_name: safeString(req.body.customerName || leadState.customer?.name),
          salesperson_name: safeString(
            req.body.salespersonName || leadState.assignment?.salesperson
          ),
        };

  const fallbackPlan = buildV2FallbackPlan({
    leadState,
    ruleSignals,
    leadMemory: existingMemory,
  });

  try {
    const systemPrompt = buildV2SystemPrompt();
    const userPrompt = buildV2UserPrompt({
      leadState,
      ruleSignals,
      leadMemory: existingMemory,
      supplementalLeadDetails,
    });

    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
    });

    const rawText = safeString(response.choices?.[0]?.message?.content);
    let parsedPlan = {};

    try {
      parsedPlan = rawText ? JSON.parse(rawText) : {};
    } catch (jsonError) {
      parsedPlan = parseAnalysisJson(rawText);
    }

    const coachingPlan = normalizeCoachingPlan({
      ...fallbackPlan,
      ...parsedPlan,
      playbook:
        safeString(parsedPlan.playbook || parsedPlan.coaching_playbook) ||
        fallbackPlan.playbook,
      priority:
        safeString(parsedPlan.priority) || fallbackPlan.priority,
      primary_goal:
        safeString(parsedPlan.primary_goal || parsedPlan.primaryGoal) ||
        fallbackPlan.primary_goal,
      best_next_action:
        safeString(parsedPlan.best_next_action || parsedPlan.bestNextAction) ||
        fallbackPlan.best_next_action,
      primary_channel:
        parsedPlan.primary_channel ||
        parsedPlan.primaryChannel ||
        parsedPlan.next_step_channel ||
        fallbackPlan.primary_channel,
      why:
        safeString(parsedPlan.why || parsedPlan.next_step_reason) ||
        fallbackPlan.why,
      manager_coaching:
        safeString(parsedPlan.manager_coaching || parsedPlan.strategy) ||
        fallbackPlan.manager_coaching,
      suggested_text:
        safeString(parsedPlan.suggested_text || parsedPlan.recommended_reply) ||
        fallbackPlan.suggested_text,
      suggested_call_objective:
        safeString(parsedPlan.suggested_call_objective) ||
        fallbackPlan.suggested_call_objective,
      suggested_email_objective:
        safeString(parsedPlan.suggested_email_objective) ||
        fallbackPlan.suggested_email_objective,
      appointment_opportunity:
        parsedPlan.appointment_opportunity !== undefined
          ? Boolean(parsedPlan.appointment_opportunity)
          : fallbackPlan.appointment_opportunity,
      objections_detected:
        Array.isArray(parsedPlan.objections_detected) ||
        Array.isArray(parsedPlan.objections)
          ? parsedPlan.objections_detected || parsedPlan.objections
          : fallbackPlan.objections_detected,
      risk_flags: Array.isArray(parsedPlan.risk_flags)
        ? parsedPlan.risk_flags
        : fallbackPlan.risk_flags,
      confidence:
        Number(parsedPlan.confidence || 0) ||
        Math.max(Number(fallbackPlan.confidence || 0), 0.75),
    });

    if (ruleSignals.appointment_confirmed && !ruleSignals.appointment_recovery_needed) {
      coachingPlan.playbook = fallbackPlan.playbook;
      coachingPlan.priority = fallbackPlan.priority;
      coachingPlan.primary_goal = fallbackPlan.primary_goal;
      coachingPlan.best_next_action = fallbackPlan.best_next_action;
      coachingPlan.primary_channel = fallbackPlan.primary_channel;
      coachingPlan.why = fallbackPlan.why;
      coachingPlan.manager_coaching = fallbackPlan.manager_coaching;
      coachingPlan.suggested_text = fallbackPlan.suggested_text;
      coachingPlan.suggested_call_objective = fallbackPlan.suggested_call_objective;
      coachingPlan.suggested_email_objective = fallbackPlan.suggested_email_objective;
      coachingPlan.appointment_opportunity = true;
      coachingPlan.risk_flags = uniqueFallbackItems([
        ...safeArray(coachingPlan.risk_flags),
        'Appointment appears scheduled',
      ]);
    }

    if (leadId) {
      const mergedMemory = buildV2LeadMemory(
        existingMemory,
        leadState,
        coachingPlan
      );
      setLeadMemory(leadId, mergedMemory);

      return res.json({
        ok: true,
        version: 'v2',
        lead_id: leadId,
        lead_state: leadState,
        rule_signals: ruleSignals,
        coaching_plan: coachingPlan,
        lead_memory: mergedMemory,
        fallback_used: false,
      });
    }

    return res.json({
      ok: true,
      version: 'v2',
      lead_id: leadId,
      lead_state: leadState,
      rule_signals: ruleSignals,
      coaching_plan: coachingPlan,
      lead_memory: existingMemory,
      fallback_used: false,
    });
  } catch (error) {
    console.error('Analyze lead v2 error:', error);

    if (isQuotaError(error)) {
      if (leadId) {
        const mergedMemory = buildV2LeadMemory(
          existingMemory,
          leadState,
          fallbackPlan
        );
        setLeadMemory(leadId, mergedMemory);

        return res.json({
          ok: true,
          version: 'v2',
          lead_id: leadId,
          lead_state: leadState,
          rule_signals: ruleSignals,
          coaching_plan: fallbackPlan,
          lead_memory: mergedMemory,
          fallback_used: true,
        });
      }

      return res.json({
        ok: true,
        version: 'v2',
        lead_id: leadId,
        lead_state: leadState,
        rule_signals: ruleSignals,
        coaching_plan: fallbackPlan,
        lead_memory: existingMemory,
        fallback_used: true,
      });
    }

    return res.status(error.status || 500).json({
      error: 'Failed to analyze lead.',
      message: error.message || 'Unknown error',
      details: error.message || 'Unknown error',
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found.' });
});

app.listen(PORT, () => {
  console.log(`CRM AI backend running on port ${PORT} with model ${OPENAI_MODEL}`);
});
