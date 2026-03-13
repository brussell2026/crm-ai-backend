(function () {
  'use strict';

  if (window.__crmAiLoaded) return;
  window.__crmAiLoaded = true;

  const API_BASE_URL = 'https://crm-ai-backend-production-b046.up.railway.app';
  const LOGIN_ENDPOINT = '/auth/login';
  const ANALYZE_ENDPOINT = '/analyze-thread';
  const SAVE_MEMORY_ENDPOINT = '/lead-memory/save';
  const LOAD_MEMORY_ENDPOINT = '/lead-memory/';
  const NOTE_ENDPOINT_SUFFIX = '/note';
  const EXTENSION_API_KEY = 'lt_9f3c7d1a4b8e2f6h1k9m3p7r5t8v2x6z';

  const PANEL_ID = 'crm-ai-panel';
  const STYLE_ID = 'crm-ai-style';
  const BODY_OPEN_CLASS = 'crm-ai-open';
  const STORAGE_TOKEN_KEY = 'crm_ai_token';
  const STORAGE_USER_KEY = 'crm_ai_user';

  let lastSignature = '';
  let isAnalyzing = false;
  let analyzeTimer = null;
  let observerStarted = false;
  let booted = false;
  let currentMode = 'unknown';
  let latestAnalysis = null;
  let latestLeadMemory = null;

  function cleanText(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function qs(selector, root = document) {
    try {
      return root.querySelector(selector);
    } catch {
      return null;
    }
  }

  function qsa(selector, root = document) {
    try {
      return Array.from(root.querySelectorAll(selector));
    } catch {
      return [];
    }
  }

  function getText(node) {
    return cleanText(node?.innerText || node?.textContent || '');
  }

  function textById(id, root = document) {
    return cleanText(root.getElementById(id)?.innerText || '');
  }

  function dataAttrById(id, attr, root = document) {
    const el = root.getElementById(id);
    return cleanText(el?.dataset?.[attr] || '');
  }

  function firstText(selectors, root = document) {
    for (const selector of selectors) {
      const el = qs(selector, root);
      const txt = getText(el);
      if (txt) return txt;
    }
    return '';
  }

  function isTextPage() {
    const url = location.href.toLowerCase();
    return (
      url.includes('communication') ||
      url.includes('texting') ||
      url.includes('vinwftexting') ||
      !!qs('.sms__container') ||
      !!qs('.sms_container') ||
      !!qs('#SMSMessageInput')
    );
  }

  function isLeadPage() {
    return (
      !!qs('#customer-info-container') &&
      !!qs('#ActiveLeadPanelWONotesAndHistory1_m_AutoLeadEdit') &&
      !!qs('#ActiveLeadPanelWONotesAndHistory1__VehicleInfoPanel')
    );
  }

  function detectMode() {
    if (isTextPage()) return 'text';
    if (isLeadPage()) return 'lead';
    return 'unknown';
  }

  function getStoredToken() {
    return localStorage.getItem(STORAGE_TOKEN_KEY) || '';
  }

  function setStoredToken(token) {
    if (token) localStorage.setItem(STORAGE_TOKEN_KEY, token);
    else localStorage.removeItem(STORAGE_TOKEN_KEY);
  }

  function getStoredUser() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_USER_KEY) || 'null');
    } catch {
      return null;
    }
  }

  function setStoredUser(user) {
    if (user) localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
    else localStorage.removeItem(STORAGE_USER_KEY);
  }

  function clearStoredAuth() {
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    localStorage.removeItem(STORAGE_USER_KEY);
  }

  function authHeaders(extra = {}) {
    const token = getStoredToken();
    return {
      'Content-Type': 'application/json',
      'x-extension-key': EXTENSION_API_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extra
    };
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        background: #ffffff;
        border: 1px solid #d9d9d9;
        border-radius: 14px;
        box-shadow: 0 12px 34px rgba(0,0,0,0.18);
        font-family: Arial, sans-serif;
        color: #111827;
      }

      #${PANEL_ID}.crm-ai-floating {
        position: fixed;
        right: 12px;
        top: 92px;
        width: 320px;
        max-height: 76vh;
        overflow-y: auto;
        z-index: 2147483646;
      }

      #${PANEL_ID}.crm-ai-docked {
        position: static;
        width: 100%;
        height: 100%;
        max-height: none;
        overflow-y: auto;
        box-shadow: none;
        border-radius: 0;
        border: 0;
        border-left: 1px solid #d9d9d9;
      }

      #${PANEL_ID} .crm-ai-header {
        background: #111827;
        color: #fff;
        padding: 12px 14px;
        font-size: 15px;
        font-weight: 700;
      }

      #${PANEL_ID}.crm-ai-floating .crm-ai-header {
        border-radius: 14px 14px 0 0;
      }

      #${PANEL_ID} .crm-ai-userline {
        margin-top: 4px;
        font-size: 12px;
        color: #d1d5db;
        font-weight: 400;
      }

      #${PANEL_ID} .crm-ai-body {
        padding: 12px 14px;
      }

      #${PANEL_ID} .crm-ai-label {
        margin-top: 10px;
        margin-bottom: 5px;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        color: #666;
      }

      #${PANEL_ID} .crm-ai-box {
        background: #f7f7f7;
        border: 1px solid #e2e2e2;
        border-radius: 8px;
        padding: 9px 10px;
        font-size: 13px;
        line-height: 1.4;
        white-space: pre-wrap;
        word-break: break-word;
      }

      #${PANEL_ID} .crm-ai-reply-card {
        background: #f7f7f7;
        border: 1px solid #dfe3e8;
        border-radius: 10px;
        padding: 10px 10px;
        cursor: pointer;
        transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.05s ease;
      }

      #${PANEL_ID} .crm-ai-reply-card:hover {
        border-color: #16a34a;
        box-shadow: 0 0 0 2px rgba(22,163,74,0.12);
      }

      #${PANEL_ID} .crm-ai-reply-card:active {
        transform: translateY(1px);
      }

      #${PANEL_ID} .crm-ai-reply-text {
        font-size: 13px;
        line-height: 1.4;
        white-space: pre-wrap;
        word-break: break-word;
        color: #111827;
      }

      #${PANEL_ID} .crm-ai-reply-translation {
        margin-top: 7px;
        padding-top: 7px;
        border-top: 1px solid #e5e7eb;
        font-size: 12px;
        line-height: 1.35;
        white-space: pre-wrap;
        color: #4b5563;
      }

      #${PANEL_ID} .crm-ai-actions {
        margin-top: 10px;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
      }

      #${PANEL_ID} button {
        border: none;
        border-radius: 8px;
        padding: 8px 10px;
        cursor: pointer;
        font-weight: 700;
        font-size: 12px;
      }

      #crm-ai-login-btn,
      #crm-ai-save-memory,
      #crm-ai-add-note {
        background: #16a34a;
        color: white;
      }

      #crm-ai-refresh,
      #crm-ai-logout,
      #crm-ai-reload-memory {
        background: #e5e7eb;
        color: #111827;
      }

      #crm-ai-status {
        margin-top: 10px;
        font-size: 12px;
        color: #666;
      }

      .crm-ai-input {
        width: 100%;
        box-sizing: border-box;
        margin-top: 6px;
        padding: 9px 10px;
        font-size: 12px;
        border: 1px solid #d1d5db;
        border-radius: 8px;
        font-family: Arial, sans-serif;
      }

      .crm-ai-textarea {
        min-height: 70px;
        resize: vertical;
      }

      body.${BODY_OPEN_CLASS} .sms__container,
      body.${BODY_OPEN_CLASS} .sms_container {
        width: calc(100% - 340px) !important;
        max-width: calc(100% - 340px) !important;
        margin-right: 340px !important;
        box-sizing: border-box !important;
      }

      body.${BODY_OPEN_CLASS} #SMSMessageInput,
      body.${BODY_OPEN_CLASS} textarea[id*="SMS"] {
        width: calc(100% - 340px) !important;
        max-width: calc(100% - 340px) !important;
        box-sizing: border-box !important;
      }

      #crm-ai-dock-cell {
        width: 22%;
        min-width: 300px;
        max-width: 360px;
        vertical-align: top;
        padding-left: 8px;
        box-sizing: border-box;
      }

      #crm-ai-dock-cell .crm-ai-dock-wrap {
        height: 725px;
        max-height: 725px;
        overflow: hidden;
        background: #fff;
        border: 1px solid #d9d9d9;
        border-radius: 14px;
        box-shadow: 0 12px 34px rgba(0,0,0,0.12);
      }

      .crm-ai-kv-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }

      .crm-ai-muted {
        color: #6b7280;
      }
    `;
    document.head.appendChild(style);
  }

  function getDockRow() {
    try {
      const parentDoc = window.parent && window.parent.document ? window.parent.document : null;
      if (!parentDoc) return null;

      const leftCell = parentDoc.getElementById('leftpaneframecell');
      const rightCell = parentDoc.getElementById('rightpaneframecell');
      if (!leftCell || !rightCell) return null;

      const row = leftCell.closest('tr');
      if (!row) return null;

      return { parentDoc, leftCell, rightCell, row };
    } catch {
      return null;
    }
  }

  function ensureDockLayout() {
    const dock = getDockRow();
    if (!dock) return false;

    const { parentDoc, leftCell, rightCell, row } = dock;

    leftCell.style.width = '40%';
    rightCell.style.width = '38%';

    let dockCell = parentDoc.getElementById('crm-ai-dock-cell');
    if (!dockCell) {
      dockCell = parentDoc.createElement('td');
      dockCell.id = 'crm-ai-dock-cell';
      dockCell.innerHTML = `<div class="crm-ai-dock-wrap"><div id="${PANEL_ID}" class="crm-ai-docked"></div></div>`;
      row.appendChild(dockCell);
    }

    return true;
  }

  function getPanelElement() {
    return document.getElementById(PANEL_ID) || (function () {
      try {
        return window.parent?.document?.getElementById(PANEL_ID) || null;
      } catch {
        return null;
      }
    })();
  }

  function createPanel() {
    const existing = getPanelElement();
    if (existing) return existing;

    const useDock = currentMode === 'lead' && ensureDockLayout();
    let panel;

    if (useDock) {
      const parentDoc = window.parent.document;
      panel = parentDoc.getElementById(PANEL_ID);
      if (!panel) {
        const dockCell = parentDoc.getElementById('crm-ai-dock-cell');
        if (dockCell) {
          dockCell.innerHTML = `<div class="crm-ai-dock-wrap"><div id="${PANEL_ID}" class="crm-ai-docked"></div></div>`;
          panel = parentDoc.getElementById(PANEL_ID);
        }
      }
    } else {
      panel = document.createElement('div');
      panel.id = PANEL_ID;
      panel.className = 'crm-ai-floating';
      document.body.appendChild(panel);
    }

    if (!panel) return null;

    panel.innerHTML = `
      <div class="crm-ai-header">
        CRM AI Assistant
        <div id="crm-ai-userline" class="crm-ai-userline"></div>
      </div>
      <div class="crm-ai-body" id="crm-ai-body"></div>
    `;

    if (currentMode === 'text') {
      document.body.classList.add(BODY_OPEN_CLASS);
    }

    return panel;
  }

  function renderLogin(body) {
    body.innerHTML = `
      <div class="crm-ai-label">Login</div>
      <input id="crm-ai-username" class="crm-ai-input" type="text" placeholder="Username" />
      <input id="crm-ai-password" class="crm-ai-input" type="password" placeholder="Password" />
      <div class="crm-ai-actions">
        <button id="crm-ai-login-btn">Login</button>
      </div>
      <div id="crm-ai-status">Please log in.</div>
    `;

    qs('#crm-ai-login-btn', body)?.addEventListener('click', login);
    qs('#crm-ai-password', body)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') login();
    });
    qs('#crm-ai-username', body)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        qs('#crm-ai-password', body)?.focus();
      }
    });
  }

  function renderLeadPanel(body) {
    body.innerHTML = `
      <div class="crm-ai-label">Lead Memory Status</div>
      <div id="crm-ai-memory-status" class="crm-ai-box">Waiting...</div>

      <div class="crm-ai-label">Customer</div>
      <div id="crm-ai-customer-summary" class="crm-ai-box">Waiting...</div>

      <div class="crm-ai-label">Vehicle</div>
      <div id="crm-ai-vehicle-summary" class="crm-ai-box">Waiting...</div>

      <div class="crm-ai-label">Lead / Contact</div>
      <div id="crm-ai-lead-summary" class="crm-ai-box">Waiting...</div>

      <div class="crm-ai-label">History Snapshot</div>
      <div id="crm-ai-history-summary" class="crm-ai-box">Waiting...</div>

      <div class="crm-ai-actions">
        <button id="crm-ai-save-memory">Save Lead Memory</button>
        <button id="crm-ai-refresh">Refresh</button>
        <button id="crm-ai-logout">Logout</button>
      </div>

      <div id="crm-ai-status">Loaded.</div>
    `;

    qs('#crm-ai-save-memory', body)?.addEventListener('click', () => saveLeadMemory());
    qs('#crm-ai-refresh', body)?.addEventListener('click', () => refreshLeadPanel(true));
    qs('#crm-ai-logout', body)?.addEventListener('click', logout);
  }

  function renderTextPanel(body) {
    body.innerHTML = `
      <div class="crm-ai-label">Saved Lead Memory</div>
      <div id="crm-ai-memory-status" class="crm-ai-box">Waiting...</div>

      <div class="crm-ai-label">Strategy</div>
      <div id="crm-ai-strategy" class="crm-ai-box">Waiting...</div>

      <div class="crm-ai-label">Next Best Action</div>
      <div id="crm-ai-next-action" class="crm-ai-box">Waiting...</div>

      <div class="crm-ai-label">Suggested Replies</div>

      <div id="crm-ai-reply-soft-card" class="crm-ai-reply-card">
        <div class="crm-ai-reply-text" id="crm-ai-reply-soft">Waiting...</div>
        <div class="crm-ai-reply-translation" id="crm-ai-reply-soft-translation" style="display:none;"></div>
      </div>

      <div style="height:8px;"></div>

      <div id="crm-ai-reply-direct-card" class="crm-ai-reply-card">
        <div class="crm-ai-reply-text" id="crm-ai-reply-direct">Waiting...</div>
        <div class="crm-ai-reply-translation" id="crm-ai-reply-direct-translation" style="display:none;"></div>
      </div>

      <div style="height:8px;"></div>

      <div id="crm-ai-reply-close-card" class="crm-ai-reply-card">
        <div class="crm-ai-reply-text" id="crm-ai-reply-close">Waiting...</div>
        <div class="crm-ai-reply-translation" id="crm-ai-reply-close-translation" style="display:none;"></div>
      </div>

      <div class="crm-ai-label">Tell AI More</div>
      <textarea id="crm-ai-sales-note" class="crm-ai-input crm-ai-textarea" placeholder="Example: customer is payment sensitive, using own financing, wants to come Saturday..."></textarea>

      <div class="crm-ai-actions">
        <button id="crm-ai-add-note">Save Note</button>
        <button id="crm-ai-refresh">Refresh</button>
        <button id="crm-ai-reload-memory">Reload Memory</button>
        <button id="crm-ai-logout">Logout</button>
      </div>

      <div id="crm-ai-status">Loaded.</div>
    `;

    qs('#crm-ai-reply-soft-card', body)?.addEventListener('click', () => insertReply('soft'));
    qs('#crm-ai-reply-direct-card', body)?.addEventListener('click', () => insertReply('direct'));
    qs('#crm-ai-reply-close-card', body)?.addEventListener('click', () => insertReply('appointment_close'));
    qs('#crm-ai-add-note', body)?.addEventListener('click', () => saveSalespersonNote());
    qs('#crm-ai-refresh', body)?.addEventListener('click', () => scheduleAnalyze(true));
    qs('#crm-ai-reload-memory', body)?.addEventListener('click', () => loadLeadMemory(true));
    qs('#crm-ai-logout', body)?.addEventListener('click', logout);
  }

  function renderPanel() {
    const panel = createPanel();
    if (!panel) return;

    const body = qs('#crm-ai-body', panel);
    if (!body) return;

    const token = getStoredToken();
    const user = getStoredUser();
    const userline = qs('#crm-ai-userline', panel);

    if (userline) {
      userline.textContent = token && user ? (user.name || user.username || '') : '';
    }

    if (!token) {
      renderLogin(body);
      return;
    }

    if (currentMode === 'lead') {
      renderLeadPanel(body);
      refreshLeadPanel(false);
      return;
    }

    if (currentMode === 'text') {
      renderTextPanel(body);
      loadLeadMemory(false).then(() => scheduleAnalyze(true)).catch(() => {});
      return;
    }

    body.innerHTML = `<div id="crm-ai-status">AI assistant not active on this page.</div>`;
  }

  function setStatus(text) {
    const panel = getPanelElement();
    if (!panel) return;
    const el = qs('#crm-ai-status', panel);
    if (el) el.textContent = text;
  }

  function setBox(id, value) {
    const panel = getPanelElement();
    if (!panel) return;
    const el = qs(`#${id}`, panel);
    if (!el) return;
    el.textContent = value || '—';
  }

  function setTranslationBox(id, value) {
    const panel = getPanelElement();
    if (!panel) return;
    const el = qs(`#${id}`, panel);
    if (!el) return;

    if (!value) {
      el.style.display = 'none';
      el.textContent = '';
      return;
    }

    el.style.display = 'block';
    el.textContent = value;
  }

  function getInputBox() {
    return qs('#SMSMessageInput') || qs('textarea');
  }

  function insertReply(which) {
    const input = getInputBox();
    if (!input) {
      setStatus('Could not find message box.');
      return;
    }

    let id = 'crm-ai-reply-soft';
    if (which === 'direct') id = 'crm-ai-reply-direct';
    if (which === 'appointment_close') id = 'crm-ai-reply-close';

    const text = cleanText(qs(`#${id}`, getPanelElement())?.textContent || '');
    if (!text || text === 'Waiting...' || text === '—') {
      setStatus('No reply available yet.');
      return;
    }

    input.focus();
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setStatus('Reply inserted.');
  }

  async function login() {
    const panel = getPanelElement();
    if (!panel) return;

    const username = cleanText(qs('#crm-ai-username', panel)?.value || '');
    const password = cleanText(qs('#crm-ai-password', panel)?.value || '');

    if (!username || !password) {
      setStatus('Enter username and password.');
      return;
    }

    setStatus('Logging in...');

    try {
      const response = await fetch(`${API_BASE_URL}${LOGIN_ENDPOINT}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-extension-key': EXTENSION_API_KEY
        },
        body: JSON.stringify({ username, password })
      });

      if (!response.ok) {
        throw new Error(`Login failed: HTTP ${response.status}`);
      }

      const data = await response.json();
      setStoredToken(data.token || '');
      setStoredUser(data.user || { username });

      renderPanel();

      if (currentMode === 'lead') {
        refreshLeadPanel(true);
      } else if (currentMode === 'text') {
        loadLeadMemory(true).then(() => scheduleAnalyze(true));
      }
    } catch (error) {
      console.error('CRM AI login error:', error);
      setStatus(error.message || 'Login failed.');
    }
  }

  function logout() {
    clearStoredAuth();
    latestAnalysis = null;
    latestLeadMemory = null;
    lastSignature = '';
    renderPanel();
  }

  function parseCustomerDetail() {
    const detail = qs('#ContentPlaceHolder1_m_CustomerAndTaskInfo_m_CustomerInfo__CustomerDetail');
    if (!detail) {
      return {
        phone: '',
        email: '',
        address_line1: '',
        city: '',
        state: '',
        zip: '',
        full_address: '',
        postal_code: ''
      };
    }

    const fullText = cleanText(detail.innerText || '');
    const phoneMatch = fullText.match(/\(\d{3}\)\s?\d{3}-\d{4}/);
    const phone = phoneMatch ? phoneMatch[0] : '';

    const email =
      dataAttrById('customer-email-span', 'email') ||
      dataAttrById('customer-email2-span', 'email') ||
      '';

    const zipOnly = (fullText.match(/\b\d{5}(?:-\d{4})?\b/) || [])[0] || '';

    return {
      phone,
      email,
      address_line1: '',
      city: '',
      state: '',
      zip: zipOnly,
      full_address: zipOnly,
      postal_code: zipOnly
    };
  }

  function parseVehicleTitle(rawTitle) {
    const title = cleanText(rawTitle);
    const match = title.match(/^(\d{4})\s+([A-Za-z]+)\s+(.+?)(?:\s+\((New|Used)\))?$/i);
    if (!match) {
      return {
        year: '',
        make: '',
        model: '',
        trim: '',
        condition: '',
        raw_title: title
      };
    }

    const year = cleanText(match[1]);
    const make = cleanText(match[2]);
    const rest = cleanText(match[3]);
    const condition = cleanText(match[4]);
    const parts = rest.split(' ');

    return {
      year,
      make,
      model: parts[0] || '',
      trim: parts.slice(1).join(' '),
      condition,
      raw_title: title
    };
  }

  function extractLeadIdentifiers() {
    const debug = qs('.vindebug-section[data-globalcustomerid][data-autoleadid]');
    if (!debug) {
      return {
        customer_id: '',
        auto_lead_id: '',
        dealer_id: ''
      };
    }

    return {
      customer_id: cleanText(debug.getAttribute('data-globalcustomerid')),
      auto_lead_id: cleanText(debug.getAttribute('data-autoleadid')),
      dealer_id: cleanText(debug.getAttribute('data-dealerid'))
    };
  }

  function extractLeadInfoTable() {
    const table = qs('#ActiveLeadPanelWONotesAndHistory1_m_AutoLeadEdit');
    const result = {
      status: '',
      salesperson_assigned: '',
      bd_agent_assigned: '',
      manager_assigned: '',
      created_at: '',
      lead_source: '',
      lead_type: '',
      contacted_status: '',
      attempted_contact: ''
    };

    if (!table) return result;

    qsa('tr', table).forEach((row) => {
      const tds = qsa('td', row);
      if (tds.length < 2) return;

      const label = cleanText(tds[0].innerText || '').replace(/:$/, '').toLowerCase();
      const value = cleanText(tds[1].innerText || '');

      if (label === 'status') result.status = value;
      else if (label === 'sales rep') result.salesperson_assigned = value;
      else if (label === 'bd agent') result.bd_agent_assigned = value;
      else if (label === 'manager') result.manager_assigned = value;
      else if (label === 'created') result.created_at = value;
      else if (label === 'source') {
        result.lead_source = cleanText(qs('#ActiveLeadPanelWONotesAndHistory1__LeadSourceName', row)?.innerText || value);
        result.lead_type = cleanText(qs('#ActiveLeadPanelWONotesAndHistory1_m_LeadTypeLabel', row)?.innerText || '');
      } else if (label === 'contacted') result.contacted_status = value;
      else if (label === 'attempted') result.attempted_contact = value;
    });

    return result;
  }

  function extractVehicleInfo() {
    const title = textById('ActiveLeadPanelWONotesAndHistory1_m_VehicleInfo');
    const parsedTitle = parseVehicleTitle(title);

    const lines = qsa('#ActiveLeadPanelWONotesAndHistory1_m_VehicleDetails td')
      .map((el) => cleanText(el.innerText || ''))
      .filter(Boolean);

    return {
      ...parsedTitle,
      stock: cleanText((lines.find((l) => /^Stock\s*#:/i.test(l)) || '').replace(/^Stock\s*#:\s*/i, '')),
      vin: cleanText(lines.find((l) => /^[A-HJ-NPR-Z0-9]{17}$/i.test(l)) || ''),
      odometer: cleanText((lines.find((l) => /^Odom:/i.test(l)) || '').replace(/^Odom:\s*/i, '')),
      color: cleanText((lines.find((l) => /^Color:/i.test(l)) || '').replace(/^Color:\s*/i, '')),
      location: cleanText((lines.find((l) => /^Location:/i.test(l)) || '').replace(/^Location:\s*/i, '')),
      body_style: cleanText(lines[0] || ''),
      engine: cleanText(lines.find((l) => /Turbo|Gas|Diesel|Hybrid|Electric|L\/|V\d|I\d/i.test(l)) || ''),
      transmission: cleanText(lines.find((l) => /Automatic|Manual|CVT/i.test(l)) || ''),
      listed_date: cleanText(textById('ActiveLeadPanelWONotesAndHistory1_atcSpotlight_CreatedDiv').replace(/^Listed:\s*/i, ''))
    };
  }

  function extractTradeInfo() {
    const raw = textById('ActiveLeadPanelWONotesAndHistory1_m_TradeDetails');
    const empty = /\(none entered\)/i.test(raw);
    return {
      has_trade: !!raw && !empty,
      raw,
      empty
    };
  }

  function extractNotesHistoryItems() {
    return qsa('#NotesAndHistoryList .notes-and-history-item, #notes-and-history .notes-and-history-item')
      .map((item) => {
        const date = getText(qs('.notes-and-hsitory-item-date', item));
        const title = getText(qs('.legacy-notes-and-history-title', item));
        const content = getText(qs('.notes-and-history-item-content', item));

        return {
          id: cleanText(item.id),
          date,
          title,
          body: content,
          direction: cleanText(item.getAttribute('data-direction')),
          tags: cleanText(item.getAttribute('data-tags'))
        };
      })
      .filter((item) => item.date || item.title || item.body)
      .slice(0, 25);
  }

  function summarizeHistory(items) {
    const summary = {
      total_items: items.length,
      text_count: 0,
      inbound_text_count: 0,
      outbound_text_count: 0,
      call_count: 0,
      note_count: 0,
      latest_activity_at: items[0]?.date || ''
    };

    items.forEach((item) => {
      if (/text message/i.test(item.title)) {
        summary.text_count += 1;
        if (/inbound/i.test(item.direction || item.title)) summary.inbound_text_count += 1;
        else summary.outbound_text_count += 1;
      } else if (/phone call/i.test(item.title)) {
        summary.call_count += 1;
      } else {
        summary.note_count += 1;
      }
    });

    return summary;
  }

  function extractLeadPayload() {
    const ids = extractLeadIdentifiers();
    const customerDetail = parseCustomerDetail();
    const leadInfo = extractLeadInfoTable();
    const vehicleInfo = extractVehicleInfo();
    const tradeInfo = extractTradeInfo();
    const historyItems = extractNotesHistoryItems();
    const customerName =
      textById('ContentPlaceHolder1_m_CustomerAndTaskInfo_m_CustomerInfo__CustomerName') ||
      firstText(['#customer-info-container .CustomerInfo_CustomerName']);

    return {
      leadKey: ids.auto_lead_id ? `lead:${ids.auto_lead_id}` : ids.customer_id ? `customer:${ids.customer_id}` : '',
      lead: {
        customer_name: customerName,
        customer_type: '',
        phone: customerDetail.phone,
        email: customerDetail.email,
        postal_code: customerDetail.postal_code,
        zip: customerDetail.zip,
        customer_id: ids.customer_id,
        auto_lead_id: ids.auto_lead_id,
        dealer_id: ids.dealer_id,
        ...leadInfo
      },
      lead_details: leadInfo,
      vehicle_interest: vehicleInfo,
      trade: tradeInfo,
      history: {
        ...summarizeHistory(historyItems),
        recent_items: historyItems
      },
      messages: [],
      meta: {
        url: location.href,
        title: document.title,
        page_mode: 'lead_page',
        customer_id: ids.customer_id,
        auto_lead_id: ids.auto_lead_id,
        dealer_id: ids.dealer_id
      },
      is_first_contact: true
    };
  }

  function getLiveThreadMessages() {
    const container = qs('.sms__container') || qs('.sms_container');
    if (!container) return [];

    return qsa('.sms__customer, .sms__user', container)
      .map((node) => {
        const sender = node.classList.contains('sms__customer') ? 'customer' : 'salesperson';
        const text = cleanText(node.innerText || node.textContent || '');
        return { sender, text, timestamp: '' };
      })
      .filter((m) => m.text)
      .slice(-30);
  }

  function getThreadLeadIdentifiers() {
    try {
      const openerDoc =
        window.opener &&
        !window.opener.closed &&
        window.opener.document &&
        window.opener.location.origin === window.location.origin
          ? window.opener.document
          : null;

      if (!openerDoc) {
        return { customer_id: '', auto_lead_id: '', dealer_id: '' };
      }

      const debug = openerDoc.querySelector('.vindebug-section[data-globalcustomerid][data-autoleadid]');
      if (!debug) {
        return { customer_id: '', auto_lead_id: '', dealer_id: '' };
      }

      return {
        customer_id: cleanText(debug.getAttribute('data-globalcustomerid')),
        auto_lead_id: cleanText(debug.getAttribute('data-autoleadid')),
        dealer_id: cleanText(debug.getAttribute('data-dealerid'))
      };
    } catch {
      return { customer_id: '', auto_lead_id: '', dealer_id: '' };
    }
  }

  function getThreadCustomerAndVehicle() {
    try {
      const openerDoc =
        window.opener &&
        !window.opener.closed &&
        window.opener.document &&
        window.opener.location.origin === window.location.origin
          ? window.opener.document
          : null;

      if (!openerDoc) {
        return {
          customer_name: '',
          phone: '',
          email: '',
          vehicle_interest: {}
        };
      }

      const name = cleanText(
        openerDoc.querySelector('#ContentPlaceHolder1_m_CustomerAndTaskInfo_m_CustomerInfo__CustomerName')?.innerText ||
        openerDoc.querySelector('#customer-info-container .CustomerInfo_CustomerName')?.innerText ||
        ''
      );

      const email =
        cleanText(openerDoc.querySelector('#customer-email-span')?.getAttribute('data-email') || '') ||
        cleanText(openerDoc.querySelector('#customer-email2-span')?.getAttribute('data-email') || '');

      const detailText = cleanText(
        openerDoc.querySelector('#ContentPlaceHolder1_m_CustomerAndTaskInfo_m_CustomerInfo__CustomerDetail')?.innerText || ''
      );
      const phoneMatch = detailText.match(/\(\d{3}\)\s?\d{3}-\d{4}/);

      const vehicleTitle = cleanText(openerDoc.querySelector('#ActiveLeadPanelWONotesAndHistory1_m_VehicleInfo')?.innerText || '');
      const vehicle = parseVehicleTitle(vehicleTitle);

      return {
        customer_name: name,
        phone: phoneMatch ? phoneMatch[0] : '',
        email,
        vehicle_interest: vehicle
      };
    } catch {
      return {
        customer_name: '',
        phone: '',
        email: '',
        vehicle_interest: {}
      };
    }
  }

  function getThreadPayload() {
    const ids = getThreadLeadIdentifiers();
    const base = getThreadCustomerAndVehicle();
    const noteText = cleanText(qs('#crm-ai-sales-note', getPanelElement())?.value || '');

    return {
      leadKey: ids.auto_lead_id ? `lead:${ids.auto_lead_id}` : ids.customer_id ? `customer:${ids.customer_id}` : '',
      lead: {
        customer_name: base.customer_name,
        phone: base.phone,
        email: base.email,
        customer_id: ids.customer_id,
        auto_lead_id: ids.auto_lead_id,
        dealer_id: ids.dealer_id
      },
      vehicle_interest: base.vehicle_interest || {},
      trade: {},
      history: {},
      messages: getLiveThreadMessages(),
      salesperson_context: noteText,
      meta: {
        url: location.href,
        title: document.title,
        page_mode: 'text_thread',
        customer_id: ids.customer_id,
        auto_lead_id: ids.auto_lead_id,
        dealer_id: ids.dealer_id
      },
      is_first_contact: getLiveThreadMessages().length === 0
    };
  }

  async function fetchJson(url, options = {}, allow401Reset = true) {
    const response = await fetch(url, options);

    if (response.status === 401 && allow401Reset) {
      clearStoredAuth();
      renderPanel();
      throw new Error('Session expired. Please log in again.');
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.json();
  }

  async function saveLeadMemory() {
    const payload = extractLeadPayload();
    if (!payload.leadKey) {
      setStatus('Could not find lead ID.');
      return;
    }

    setStatus('Saving lead memory...');

    try {
      const data = await fetchJson(`${API_BASE_URL}${SAVE_MEMORY_ENDPOINT}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });

      latestLeadMemory = data;
      setBox('crm-ai-memory-status', `Saved\nLead Key: ${data.leadKey}\nUpdated: ${cleanText(data.updatedAt)}`);
      setStatus('Lead memory saved.');
    } catch (error) {
      console.error('Save lead memory error:', error);
      setStatus(error.message || 'Could not save lead memory.');
    }
  }

  async function refreshLeadPanel(autoSave = false) {
    const payload = extractLeadPayload();

    setBox(
      'crm-ai-customer-summary',
      [
        payload.lead.customer_name,
        payload.lead.phone,
        payload.lead.email,
        payload.lead.postal_code
      ].filter(Boolean).join('\n') || 'No customer data found.'
    );

    setBox(
      'crm-ai-vehicle-summary',
      [
        payload.vehicle_interest.raw_title,
        payload.vehicle_interest.stock ? `Stock: ${payload.vehicle_interest.stock}` : '',
        payload.vehicle_interest.vin ? `VIN: ${payload.vehicle_interest.vin}` : '',
        payload.vehicle_interest.odometer ? `Odometer: ${payload.vehicle_interest.odometer}` : ''
      ].filter(Boolean).join('\n') || 'No vehicle found.'
    );

    setBox(
      'crm-ai-lead-summary',
      [
        payload.lead.status ? `Status: ${payload.lead.status}` : '',
        payload.lead.salesperson_assigned ? `Sales Rep: ${payload.lead.salesperson_assigned}` : '',
        payload.lead.manager_assigned ? `Manager: ${payload.lead.manager_assigned}` : '',
        payload.lead.created_at ? `Created: ${payload.lead.created_at}` : '',
        payload.lead.lead_source ? `Source: ${payload.lead.lead_source}` : '',
        payload.lead.contacted_status ? `Contacted: ${payload.lead.contacted_status}` : ''
      ].filter(Boolean).join('\n') || 'No lead info found.'
    );

    setBox(
      'crm-ai-history-summary',
      [
        `Items: ${payload.history.total_items || 0}`,
        `Texts: ${payload.history.text_count || 0}`,
        `Calls: ${payload.history.call_count || 0}`,
        `Notes: ${payload.history.note_count || 0}`,
        payload.history.latest_activity_at ? `Latest: ${payload.history.latest_activity_at}` : ''
      ].filter(Boolean).join('\n')
    );

    setBox(
      'crm-ai-memory-status',
      payload.leadKey ? `Ready to save\nLead Key: ${payload.leadKey}` : 'Could not determine lead key.'
    );

    if (autoSave && getStoredToken()) {
      await saveLeadMemory();
    } else {
      setStatus('Lead data loaded.');
    }
  }

  async function loadLeadMemory(showStatus = true) {
    const payload = getThreadPayload();
    if (!payload.leadKey) {
      if (showStatus) setStatus('Could not match this thread to a lead.');
      return null;
    }

    if (showStatus) setStatus('Loading saved lead memory...');

    try {
      const data = await fetchJson(`${API_BASE_URL}${LOAD_MEMORY_ENDPOINT}${encodeURIComponent(payload.leadKey)}`, {
        method: 'GET',
        headers: authHeaders()
      });

      latestLeadMemory = data;
      setBox(
        'crm-ai-memory-status',
        data.memory
          ? [
              `Loaded`,
              data.memory?.customer_summary?.customer_name || '',
              data.memory?.vehicle_interest?.raw_title || '',
              data.updatedAt ? `Updated: ${data.updatedAt}` : ''
            ].filter(Boolean).join('\n')
          : 'No saved memory found.'
      );

      if (Array.isArray(data.salespersonNotes) && data.salespersonNotes.length) {
        const latestNote = data.salespersonNotes[data.salespersonNotes.length - 1];
        const noteBox = qs('#crm-ai-sales-note', getPanelElement());
        if (noteBox && !cleanText(noteBox.value)) {
          noteBox.value = cleanText(latestNote.text);
        }
      }

      if (showStatus) setStatus('Lead memory loaded.');
      return data;
    } catch (error) {
      console.error('Load lead memory error:', error);
      setBox('crm-ai-memory-status', 'No saved lead memory found yet.');
      if (showStatus) setStatus(error.message || 'Could not load lead memory.');
      return null;
    }
  }

  async function saveSalespersonNote() {
    const payload = getThreadPayload();
    const leadKey = payload.leadKey;
    const noteText = cleanText(qs('#crm-ai-sales-note', getPanelElement())?.value || '');

    if (!leadKey) {
      setStatus('Could not match this thread to a lead.');
      return;
    }

    if (!noteText) {
      setStatus('Type a note first.');
      return;
    }

    setStatus('Saving note...');

    try {
      await fetchJson(`${API_BASE_URL}${LOAD_MEMORY_ENDPOINT}${encodeURIComponent(leadKey)}${NOTE_ENDPOINT_SUFFIX}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ text: noteText })
      });

      setStatus('Note saved.');
      await loadLeadMemory(false);
      scheduleAnalyze(true);
    } catch (error) {
      console.error('Save note error:', error);
      setStatus(error.message || 'Could not save note.');
    }
  }

  function looksSpanish(text) {
    const t = (text || '').toLowerCase();
    const markers = [
      'hola', 'gracias', 'precio', 'camioneta', 'camión', 'cita', 'financiamiento',
      'hablar', 'explicarte', 'entiendo', 'puedo', 'quieres', 'porque', 'cómo',
      'dónde', 'qué', 'estás', 'español', 'intereses', 'pago', 'mensual', 'hoy',
      'mañana', 'si', 'sí'
    ];
    const accented = /[áéíóúñ¿¡]/i.test(t);
    const hits = markers.filter((word) => t.includes(word)).length;
    return accented || hits >= 2;
  }

  function getReplyObject(replies, label) {
    return Array.isArray(replies) ? replies.find((r) => r.label === label) || null : null;
  }

  function getReplyTranslation(replyObj, replyText) {
    if (!looksSpanish(replyText)) return '';
    return cleanText(replyObj?.english_translation || '');
  }

  function renderAnalysis(data) {
    latestAnalysis = data;

    setBox('crm-ai-strategy', cleanText(data.strategy || 'No strategy returned.'));
    setBox('crm-ai-next-action', cleanText(data.next_best_action || 'No next action returned.'));

    const soft = getReplyObject(data.replies, 'soft');
    const direct = getReplyObject(data.replies, 'direct');
    const close = getReplyObject(data.replies, 'appointment_close');

    const softText = cleanText(soft?.text || 'No reply returned.');
    const directText = cleanText(direct?.text || 'No reply returned.');
    const closeText = cleanText(close?.text || 'No reply returned.');

    setBox('crm-ai-reply-soft', softText);
    setBox('crm-ai-reply-direct', directText);
    setBox('crm-ai-reply-close', closeText);

    setTranslationBox('crm-ai-reply-soft-translation', getReplyTranslation(soft, softText));
    setTranslationBox('crm-ai-reply-direct-translation', getReplyTranslation(direct, directText));
    setTranslationBox('crm-ai-reply-close-translation', getReplyTranslation(close, closeText));

    setStatus('Analysis complete.');
  }

  function buildAnalyzeSignature(payload) {
    return JSON.stringify({
      leadKey: payload.leadKey,
      note: cleanText(payload.salesperson_context),
      messages: (payload.messages || []).map((m) => ({ s: m.sender, t: m.text }))
    });
  }

  async function analyzeThread(force = false) {
    if (currentMode !== 'text') return;
    if (!getStoredToken()) return;
    if (isAnalyzing && !force) return;

    const payload = getThreadPayload();
    if (!payload.leadKey) {
      setStatus('Could not match this thread to a lead.');
      return;
    }

    const signature = buildAnalyzeSignature(payload);
    if (!force && signature === lastSignature) return;
    lastSignature = signature;

    isAnalyzing = true;
    setStatus('Analyzing thread...');

    try {
      const data = await fetchJson(`${API_BASE_URL}${ANALYZE_ENDPOINT}`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload)
      });

      renderAnalysis(data);
    } catch (error) {
      console.error('Analyze thread error:', error);
      setStatus(error.message || 'Could not analyze thread.');
    } finally {
      isAnalyzing = false;
    }
  }

  function scheduleAnalyze(force = false) {
    clearTimeout(analyzeTimer);
    analyzeTimer = setTimeout(() => analyzeThread(force), 700);
  }

  function startObserver() {
    if (observerStarted) return;
    observerStarted = true;

    const observer = new MutationObserver(() => {
      if (currentMode === 'text' && getStoredToken()) {
        scheduleAnalyze(false);
      } else if (currentMode === 'lead') {
        refreshLeadPanel(false);
      }
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function boot() {
    if (booted) return;
    booted = true;

    currentMode = detectMode();
    if (currentMode === 'unknown') return;

    ensureStyles();
    createPanel();
    renderPanel();
    startObserver();

    if (currentMode === 'lead' && getStoredToken()) {
      refreshLeadPanel(false);
    }

    if (currentMode === 'text' && getStoredToken()) {
      loadLeadMemory(false).then(() => scheduleAnalyze(true));
    }
  }

  const readyTimer = setInterval(() => {
    if (document.body) {
      clearInterval(readyTimer);
      boot();
    }
  }, 250);
})();