// GHF Oracle — frontend app
// Replace WORKER_URL after deploying the Cloudflare Worker

const WORKER_URL = "https://ghf-oracle.mara-9ba.workers.dev";

const conversationHistory = JSON.parse(sessionStorage.getItem("ghf_history") || "[]");

marked.setOptions({ breaks: true, gfm: true });

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  setTodayDate();
  loadBrief();
});

function setTodayDate() {
  const el = document.getElementById("today-date");
  if (el) {
    el.textContent = new Date().toLocaleDateString("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric"
    });
  }
}

// ---------------------------------------------------------------------------
// Daily Brief — left panel
// ---------------------------------------------------------------------------

async function loadBrief() {
  setStatus("loading");
  try {
    const resp = await fetch(`${WORKER_URL}/api/brief`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    const shopify = data.shopify || {};
    renderShopifyMetrics(shopify.yesterday || {}, shopify["7d"] || {});
    renderMetaMetrics(data.meta || {});
    setStatus("live");

    document.getElementById('freshness').textContent = 'Updated ' + new Date().toLocaleTimeString('en-GB', {hour:'2-digit',minute:'2-digit'});
    document.getElementById('sync-status').textContent = 'Data as of ' + new Date().toLocaleDateString('en-GB', {weekday:'short',day:'numeric',month:'short'});
  } catch (e) {
    console.error("Brief load failed:", e);
    setStatus("error");
    renderFallback("shopify-metrics", "Could not load Shopify data");
    renderFallback("shopify-7d-metrics", "");
    renderFallback("meta-metrics", "Could not load Meta data");
    renderFallback("meta-7d-metrics", "");
  }
}

function kpiCard(label, value, delta) {
  const deltaHtml = delta
    ? `<div class="kpi-delta ${delta.startsWith('+') ? 'up' : delta.startsWith('-') ? 'down' : ''}">${delta}</div>`
    : '';
  return `<div class="kpi-card">
    <div class="kpi-label">${label}</div>
    <div class="kpi-value">${value}</div>
    ${deltaHtml}
  </div>`;
}

function renderShopifyMetrics(yd, sevenD) {
  const el  = document.getElementById("shopify-metrics");
  const el7 = document.getElementById("shopify-7d-metrics");

  function buildCards(data) {
    const metrics = [
      { label: "Revenue",     key: "Order Revenue" },
      { label: "Gross Sales", key: "Gross Sales" },
      { label: "Orders",      key: "Orders" },
      { label: "Memberships", key: "Membership renewals" },
      { label: "Discounts",   key: "Discounts" },
      { label: "Returns",     key: "(-) Returns" },
    ];
    return metrics
      .map(m => data[m.key] ? kpiCard(m.label, data[m.key]) : null)
      .filter(Boolean)
      .slice(0, 6)
      .join("");
  }

  if (el) el.innerHTML = buildCards(yd) || `<div class="kpi-error">⚠ No Shopify data</div>`;
  if (el7) el7.innerHTML = buildCards(sevenD) || `<div class="kpi-error">⚠ No 7-day data</div>`;
}

function renderMetaMetrics(data) {
  const el1 = document.getElementById("meta-metrics");
  const el7 = document.getElementById("meta-7d-metrics");
  if (!el1 || !el7) return;

  const yesterday = [
    { label: "Spend",     key: "Spend" },
    { label: "Revenue",   key: "Revenue (attributed)" },
    { label: "ROAS",      key: "ROAS" },
    { label: "CPA",       key: "CPA" },
    { label: "Purchases", key: "Purchases" },
  ];

  const sevenDay = [
    { label: "Spend 7d",    key: "Spend (7d)" },
    { label: "ROAS 7d",     key: "ROAS (7d)" },
    { label: "CPA 7d",      key: "CPA (7d)" },
    { label: "Purchases 7d",key: "Purchases (7d)" },
  ];

  const ydCards = yesterday
    .filter(m => data[m.key])
    .map(m => kpiCard(m.label, data[m.key]));

  el1.innerHTML = ydCards.join("") || `<div class="kpi-error">⚠ No Meta data</div>`;

  const sdCards = sevenDay
    .filter(m => data[m.key])
    .map(m => kpiCard(m.label, data[m.key]));

  el7.innerHTML = sdCards.join("") || `<div class="kpi-error">⚠ No 7-day Meta data</div>`;
}

function renderFallback(id, message) {
  const el = document.getElementById(id);
  if (!el) return;
  if (message) {
    el.innerHTML = `<div class="kpi-error">⚠ ${message}</div>`;
  } else {
    el.innerHTML = '';
  }
}

function setStatus(state) {
  const dot  = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  if (!dot || !text) return;
  if (state === "live")    { dot.className = "status-dot live";    text.textContent = "Live"; }
  if (state === "loading") { dot.className = "status-dot loading"; text.textContent = "Loading..."; }
  if (state === "error")   { dot.className = "status-dot error";   text.textContent = "Offline"; }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

async function sendMessage() {
  const input = document.getElementById("question-input");
  const question = input.value.trim();
  if (!question) return;

  // Hide suggestions after first message
  const suggestions = document.getElementById("suggestions");
  if (suggestions) suggestions.style.display = "none";

  // Clear follow-ups
  const followUpsEl = document.getElementById("follow-ups");
  if (followUpsEl) followUpsEl.innerHTML = '';

  appendMessage("user", question);
  input.value = "";
  autoResize(input);

  const btn = document.getElementById("send-btn");
  btn.disabled = true;

  const thinkingId = appendThinking();

  try {
    const resp = await fetch(`${WORKER_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, history: conversationHistory }),
    });

    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();

    removeThinking(thinkingId);
    appendMessage("assistant", data.answer, data.sources);

    if (data.followUps && data.followUps.length > 0) {
      renderFollowUps(data.followUps);
    }

    conversationHistory.push({ role: "user",      content: question });
    conversationHistory.push({ role: "assistant",  content: data.answer });

    // Keep history to last 10 turns
    if (conversationHistory.length > 20) conversationHistory.splice(0, 2);
    sessionStorage.setItem("ghf_history", JSON.stringify(conversationHistory));

  } catch (e) {
    removeThinking(thinkingId);
    appendMessage("assistant", "Sorry, something went wrong. Please try again.");
    console.error(e);
  }

  btn.disabled = false;
  input.focus();
}

function appendMessage(role, content, sources) {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  div.className = `message ${role}`;

  const renderedContent = role === "assistant"
    ? marked.parse(content)
    : `<p>${escapeHtml(content)}</p>`;

  let html = `<div class="message-content markdown">${renderedContent}</div>`;
  if (sources && sources.length > 0) {
    html += `<div class="message-sources">${sources.map(s => `<span class="source-pill">${escapeHtml(s)}</span>`).join('')}</div>`;
  }

  div.innerHTML = html;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return div.id;
}

function appendThinking() {
  const container = document.getElementById("chat-messages");
  const div = document.createElement("div");
  const id  = "thinking-" + Date.now();
  div.id = id;
  div.className = "message assistant";
  div.innerHTML = `<div class="message-content thinking">Thinking<span class="thinking-dots"></span></div>`;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
  return id;
}

function removeThinking(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

function renderFollowUps(questions) {
  const container = document.getElementById('follow-ups');
  if (!container) return;
  container.innerHTML = questions.map(q =>
    `<button class="follow-up-btn" onclick="askFollowUp(this)">${escapeHtml(q)}</button>`
  ).join('');
}

function askFollowUp(btn) {
  const input = document.getElementById('question-input');
  input.value = btn.textContent;
  document.getElementById('follow-ups').innerHTML = '';
  sendMessage();
}

function askSuggestion(btn) {
  const input = document.getElementById("question-input");
  input.value = btn.textContent;
  sendMessage();
}

// ---------------------------------------------------------------------------
// Input helpers
// ---------------------------------------------------------------------------

function handleKey(event) {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 160) + "px";
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
