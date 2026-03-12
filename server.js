require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');

const app = express();
app.set('trust proxy', 1);

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const EXTENSION_API_KEY = process.env.EXTENSION_API_KEY;
const JWT_SECRET = process.env.JWT_SECRET;
const PORT = process.env.PORT || 8080;
const DEALERSHIP_NAME = 'Hiley Chevrolet of Rockwall';

/**
 * MULTI-USER ACCOUNT LIST
 * Replace these passwords with the real ones you want to use.
 */
const USERS = [
  {
    username: 'brussell',
    password: 'Hileybr2026',
    name: 'Brandon Russell',
    role: 'admin',
    dealership: DEALERSHIP_NAME,
    isActive: true
  },
  {
    username: 'aaleman',
    password: 'Hileyaa2026',
    name: 'Al Aleman',
    role: 'sales',
    dealership: DEALERSHIP_NAME,
    isActive: true
  },
  {
    username: 'ERichey',
    password: 'Hileyer2026',
    name: 'Elizabeth Richey',
    role: 'sales',
    dealership: DEALERSHIP_NAME,
    isActive: true
  },
  {
    username: 'user3',
    password: 'SalesUser32026!',
    name: 'Sales User 3',
    role: 'sales',
    dealership: DEALERSHIP_NAME,
    isActive: true
  }
];

app.use(
  cors({
    origin: true,
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'x-extension-key', 'Authorization'],
    credentials: false
  })
);

app.use(express.json({ limit: '4mb' }));

if (!OPENAI_API_KEY) {
  console.error('❌ Missing OPENAI_API_KEY in environment');
  process.exit(1);
}

if (!EXTENSION_API_KEY) {
  console.error('❌ Missing EXTENSION_API_KEY in environment');
  process.exit(1);
}

if (!JWT_SECRET) {
  console.error('❌ Missing JWT_SECRET in environment');
  process.exit(1);
}

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' }
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Please try again later.' }
});

const analyzeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many analysis requests. Please slow down.' }
});

app.use(generalLimiter);

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}

function normalizeArray(values, limit = 25) {
  if (!Array.isArray(values)) return [];
  return values.map(cleanText).filter(Boolean).slice(0, limit);
}

function buildMessagesTranscript(messages = []) {
  if (!Array.isArray(messages) || !messages.length) {
    return 'No conversation messages were extracted.';
  }

  return messages
    .map((m) => {
      const senderRaw = cleanText(m.sender).toLowerCase();
      const sender =
        senderRaw.includes('customer') || senderRaw.includes('lead')
          ? 'Customer'
          : senderRaw.includes('sales')
          ? 'Salesperson'
          : 'Unknown';

      const timestamp = cleanText(m.timestamp);
      const title = cleanText(m.title);
      const text = cleanText(m.text);

      const extra = [
        cleanText(m.direction) ? `Direction: ${cleanText(m.direction)}` : '',
        cleanText(m.actor) ? `Actor: ${cleanText(m.actor)}` : '',
        cleanText(m.counterparty) ? `Counterparty: ${cleanText(m.counterparty)}` : '',
        title ? `Type: ${title}` : ''
      ]
        .filter(Boolean)
        .join(' | ');

      const prefix = timestamp ? `[${timestamp}] ` : '';
      return extra ? `${prefix}${sender}: ${text} (${extra})` : `${prefix}${sender}: ${text}`;
    })
    .join('\n');
}

function buildRecentHistory(history = {}) {
  const items = Array.isArray(history.recent_items) ? history.recent_items.slice(0, 20) : [];
  if (!items.length) return 'No recent notes/history items were extracted.';

  return items
    .map((item) => {
      const date = cleanText(item.date);
      const title = cleanText(item.title);
      const direction = cleanText(item.direction);
      const body = cleanText(item.body);
      return `${date} | ${title}${direction ? ` | ${direction}` : ''}${body ? ` | ${body}` : ''}`;
    })
    .join('\n');
}

function getLatestCustomerMessage(messages = []) {
  if (!Array.isArray(messages) || !messages.length) return '';

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const sender = cleanText(msg?.sender).toLowerCase();
    if (sender === 'customer') {
      return cleanText(msg?.text || '');
    }
  }

  return '';
}

function buildPrompt(payload = {}) {
  const lead = payload.lead || {};
  const vehicle = payload.vehicle_interest || {};
  const trade = payload.trade || {};
  const history = payload.history || {};
  const buyerInfo = payload.buyer_information || {};
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const latestCustomerMessage = getLatestCustomerMessage(messages);

  return `
You are a top-performing automotive salesperson and BDC expert at ${DEALERSHIP_NAME}.

Your job is to help the salesperson convert leads into:
• appointments
• showroom visits
• phone conversations
• sold vehicles

You must think like an experienced salesperson, not a chatbot.

The dealership name is exactly: ${DEALERSHIP_NAME}

If a customer asks what dealership this is, answer with that exact dealership name.

--------------------------------
HOW YOU SHOULD THINK
--------------------------------

Before writing replies you must determine:

1. What the customer is actually asking.
2. What the customer's likely buying intent is.
3. The current stage of the deal.
4. The biggest friction or obstacle right now.
5. The best next move for the salesperson.

Always prioritize the MOST RECENT customer message.

Never ignore a direct customer question.

Answer their question first, then move the deal forward naturally.

--------------------------------
SALES STRATEGY RULES
--------------------------------

Use these dealership sales principles:

• If the customer asks a direct question → answer it directly first.
• If the customer is local and engaged → move toward an appointment.
• If trade is mentioned → use the trade as leverage.
• If price is asked → avoid dumping too much info if an appointment would close better.
• If the customer is confused → remove friction.
• If the customer is hot → be direct.
• If the customer is cautious → be helpful and low pressure.
• If they ask basic info (hours, address, dealership name, directions) → answer immediately.

Avoid weak phrases like:
- "just checking in"
- "circling back"
- "touching base"
- "following up"

Replies must sound like a real salesperson texting.

--------------------------------
TONE RULES
--------------------------------

Tone should be:
• confident
• natural
• conversational
• helpful
• concise
• human

Never sound robotic or corporate.

--------------------------------
LANGUAGE RULES
--------------------------------

If the customer is Spanish-speaking:
Return replies in Spanish and include an English translation.

If the customer is speaking English:
Return replies in English only.

--------------------------------
REPLY STYLE
--------------------------------

Return three reply options:

soft → friendly / conversational
direct → confident / efficient
appointment_close → moves toward visit or next step

Replies should be short and text-message friendly.

--------------------------------
RESPONSE FORMAT
--------------------------------

Return JSON using this exact schema:

{
  "customer_summary": "",
  "buyer_type": "",
  "deal_stage": "",
  "hot_points": [],
  "missing_info": [],
  "strategy": "",
  "next_best_action": "",
  "why_this_action": "",
  "replies": [
    {
      "label": "soft",
      "language": "english or spanish",
      "text": "",
      "english_translation": ""
    },
    {
      "label": "direct",
      "language": "english or spanish",
      "text": "",
      "english_translation": ""
    },
    {
      "label": "appointment_close",
      "language": "english or spanish",
      "text": "",
      "english_translation": ""
    }
  ]
}

--------------------------------
LEAD DATA
--------------------------------

LEAD:
${JSON.stringify(lead, null, 2)}

VEHICLE OF INTEREST:
${JSON.stringify(vehicle, null, 2)}

TRADE:
${JSON.stringify(trade, null, 2)}

BUYER / CO-BUYER:
${JSON.stringify(buyerInfo, null, 2)}

HISTORY SUMMARY:
${JSON.stringify(
    {
      total_items: history.total_items,
      text_count: history.text_count,
      inbound_text_count: history.inbound_text_count,
      outbound_text_count: history.outbound_text_count,
      call_count: history.call_count,
      inbound_call_count: history.inbound_call_count,
      outbound_call_count: history.outbound_call_count,
      note_count: history.note_count,
      latest_activity_at: history.latest_activity_at,
      latest_customer_message_at: history.latest_customer_message_at,
      latest_salesperson_message_at: history.latest_salesperson_message_at,
      latest_text_direction: history.latest_text_direction
    },
    null,
    2
  )}

RECENT NOTES:
${buildRecentHistory(history)}

LATEST CUSTOMER MESSAGE:
${latestCustomerMessage || 'None found'}

FULL CONVERSATION:
${buildMessagesTranscript(messages)}
`.trim();
}

function buildFallbackResponse(payload = {}) {
  const lead = payload.lead || {};
  const vehicle = payload.vehicle_interest || {};
  const customerName = cleanText(lead.customer_name || 'the customer');
  const vehicleName =
    cleanText([vehicle.year, vehicle.make, vehicle.model, vehicle.trim].filter(Boolean).join(' ')) ||
    cleanText(vehicle.raw_title || 'the vehicle');

  return {
    customer_summary: `${customerName} is an active lead with recent communication history. AI fallback was used because the main analysis failed.`,
    buyer_type: 'info-gathering',
    deal_stage: 'engaged',
    hot_points: [
      vehicleName ? `Interested in ${vehicleName}` : 'Vehicle interest present',
      'Recent communication history exists'
    ],
    missing_info: ['Exact appointment commitment', 'Any additional trade / finance details'],
    strategy: 'Answer the customer directly, keep the tone natural, and move toward a clear next step.',
    next_best_action: 'Answer the latest customer question directly',
    why_this_action: 'The lead is engaged and the latest customer question should be handled first.',
    replies: [
      {
        label: 'soft',
        language: 'english',
        text: `This is ${DEALERSHIP_NAME}. If you want, I can also send you the address.`,
        english_translation: ''
      },
      {
        label: 'direct',
        language: 'english',
        text: `This is ${DEALERSHIP_NAME}. I can send you the address too so it pulls right up in maps.`,
        english_translation: ''
      },
      {
        label: 'appointment_close',
        language: 'english',
        text: `This is ${DEALERSHIP_NAME}. I can send you the address now so you’re all set for your appointment.`,
        english_translation: ''
      }
    ]
  };
}

function safeJsonParse(content) {
  try {
    return JSON.parse(content);
  } catch (err) {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;

    try {
      return JSON.parse(match[0]);
    } catch (err2) {
      return null;
    }
  }
}

function normalizeReplies(replies) {
  if (!Array.isArray(replies)) return [];

  return replies
    .map((reply, index) => ({
      label: cleanText(reply?.label) || (index === 0 ? 'soft' : index === 1 ? 'direct' : 'appointment_close'),
      language: cleanText(reply?.language || 'english').toLowerCase(),
      text: cleanText(reply?.text),
      english_translation: cleanText(reply?.english_translation)
    }))
    .filter((reply) => reply.text)
    .slice(0, 3);
}

function normalizeAiResult(data, payload = {}) {
  const fallback = buildFallbackResponse(payload);
  const replies = normalizeReplies(data?.replies);

  return {
    customer_summary: cleanText(data?.customer_summary) || fallback.customer_summary,
    buyer_type: cleanText(data?.buyer_type) || fallback.buyer_type,
    deal_stage: cleanText(data?.deal_stage) || fallback.deal_stage,
    hot_points: normalizeArray(data?.hot_points, 6).length
      ? normalizeArray(data?.hot_points, 6)
      : fallback.hot_points,
    missing_info: normalizeArray(data?.missing_info, 6).length
      ? normalizeArray(data?.missing_info, 6)
      : fallback.missing_info,
    strategy: cleanText(data?.strategy) || fallback.strategy,
    next_best_action: cleanText(data?.next_best_action) || fallback.next_best_action,
    why_this_action: cleanText(data?.why_this_action) || fallback.why_this_action,
    replies: replies.length ? replies : fallback.replies
  };
}

function applyHardRules(aiResult, payload = {}) {
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  const latestCustomerMessage = getLatestCustomerMessage(messages).toLowerCase();

  const asksDealershipName =
    latestCustomerMessage.includes('what dealership') ||
    latestCustomerMessage.includes('name of your dealership') ||
    latestCustomerMessage.includes('name of the dealership');

  const asksDirections =
    latestCustomerMessage.includes('directions') ||
    latestCustomerMessage.includes('address') ||
    latestCustomerMessage.includes('where are you located');

  const asksHours =
    latestCustomerMessage.includes('what time do y') ||
    latestCustomerMessage.includes('what time are y') ||
    latestCustomerMessage.includes('are yall open') ||
    latestCustomerMessage.includes("are y'all open") ||
    latestCustomerMessage.includes('what time do you open') ||
    latestCustomerMessage.includes('hours');

  if (asksDealershipName || asksDirections) {
    return {
      ...aiResult,
      next_best_action: 'Answer the dealership name directly',
      why_this_action: 'The customer’s latest message is asking for the dealership name or directions.',
      strategy: 'Answer the direct question first, then lightly support the appointment if natural.',
      replies: [
        {
          label: 'soft',
          language: 'english',
          text: `This is ${DEALERSHIP_NAME}. If you want, I can also send you the address.`,
          english_translation: ''
        },
        {
          label: 'direct',
          language: 'english',
          text: `This is ${DEALERSHIP_NAME}. I can send you the address too so it pulls right up in maps.`,
          english_translation: ''
        },
        {
          label: 'appointment_close',
          language: 'english',
          text: `This is ${DEALERSHIP_NAME}. I can send you the address now so you’re all set for your appointment.`,
          english_translation: ''
        }
      ]
    };
  }

  if (asksHours) {
    return {
      ...aiResult,
      next_best_action: 'Answer the store hours directly',
      why_this_action: 'The customer’s latest message is asking about store hours.',
      strategy: 'Answer the hours first, then lightly move toward the appointment if natural.',
      replies: [
        {
          label: 'soft',
          language: 'english',
          text: 'We’re open at 8:30 AM Monday through Saturday. If you want, I can also help you lock in a time.',
          english_translation: ''
        },
        {
          label: 'direct',
          language: 'english',
          text: 'We open at 8:30 AM Monday through Saturday. I can also help make sure you have the address and everything you need.',
          english_translation: ''
        },
        {
          label: 'appointment_close',
          language: 'english',
          text: 'We open at 8:30 AM Monday through Saturday. I can send you the address too so you’re all set.',
          english_translation: ''
        }
      ]
    };
  }

  return aiResult;
}

function requireExtensionApiKey(req, res, next) {
  const incomingKey = cleanText(req.headers['x-extension-key']);

  if (!incomingKey || incomingKey !== EXTENSION_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return next();
}

function signAuthToken(user) {
  return jwt.sign(
    {
      sub: user.username,
      username: user.username,
      name: user.name,
      dealership: user.dealership,
      role: user.role
    },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

function requireAuthToken(req, res, next) {
  const authHeader = cleanText(req.headers.authorization);

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }

  const token = authHeader.slice(7).trim();

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    return next();
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or expired auth token' });
  }
}

function findActiveUser(username, password) {
  return USERS.find(
    (user) =>
      user.isActive &&
      cleanText(user.username) === cleanText(username) &&
      cleanText(user.password) === cleanText(password)
  );
}

async function analyzeThreadWithOpenAI(payload) {
  const prompt = buildPrompt(payload);

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.35,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a high-performing automotive internet sales and BDC assistant.'
        },
        {
          role: 'user',
          content: prompt
        }
      ]
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content || '';

  const parsed = safeJsonParse(content);
  if (!parsed) {
    throw new Error(`Could not parse model JSON: ${content}`);
  }

  const normalized = normalizeAiResult(parsed, payload);
  return applyHardRules(normalized, payload);
}

app.get('/', (req, res) => {
  res.json({
    ok: true,
    service: 'crm-ai-backend'
  });
});

app.get('/health', (req, res) => {
  res.json({ ok: true });
});

app.post('/auth/login', loginLimiter, requireExtensionApiKey, (req, res) => {
  const username = cleanText(req.body?.username);
  const password = cleanText(req.body?.password);

  const user = findActiveUser(username, password);

  if (!user) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }

  const token = signAuthToken(user);

  return res.json({
    ok: true,
    token,
    user: {
      username: user.username,
      name: user.name,
      dealership: user.dealership,
      role: user.role
    }
  });
});

app.post('/analyze-thread', analyzeLimiter, requireExtensionApiKey, requireAuthToken, async (req, res) => {
  try {
    const payload = req.body || {};
    const result = await analyzeThreadWithOpenAI(payload);
    res.json(result);
  } catch (error) {
    console.error('❌ /analyze-thread failed:', error);
    res.json(buildFallbackResponse(req.body || {}));
  }
});

app.listen(PORT, () => {
  console.log(`✅ CRM AI backend listening on http://localhost:${PORT}`);
});