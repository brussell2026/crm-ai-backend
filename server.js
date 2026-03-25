require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const OpenAI = require('openai');

const app = express();

app.use(cors());
app.use(express.json({ limit: '2mb' }));

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
  try {
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

    return res.status(error.status || 500).json({
      error: 'Failed to analyze thread.',
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
