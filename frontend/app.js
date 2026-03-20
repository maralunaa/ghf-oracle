// GHF Oracle — frontend app
// Replace WORKER_URL after deploying the Cloudflare Worker

const WORKER_URL = "https://ghf-oracle.mara-9ba.workers.dev";

const conversationHistory = [];

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
    renderShopifyMetrics(data.shopify || {});
    renderMetaMetrics(data.meta || {});
    setStatus("live");

    const updated = document.getElementById("brief-updated");
    if (updated) {
      updated.textContent = `Updated ${new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`;
    }
  } catch (e) {
    console.error("Brief load failed:", e);
    setStatus("error");
    renderFallback("shopify-metrics", "Could not load Shopify data");
    renderFallback("meta-metrics", "Could not load Meta data");
    renderFallback("meta-7d-metrics", "");
  }
}

function renderShopifyMetrics(data) {
  const el = document.getElementById("shopify-metrics");
  if (!el) return;

  const metrics = [
    { label: "Order Revenue",  key: "Order Revenue" },
    { label: "Gross Sales",    key: "Gross Sales" },
    { label: "Orders",         key: "Orders" },
    { label: "Discounts",      key: "Discounts" },
    { label: "Returns",        key: "(-) Returns" },
    { label: "Memberships",    key: "Membership renewals" },
    { label: "New Customers",  key: "New" },
  ];

  el.innerHTML = metrics
    .filter(m => data[m.key])
    .slice(0, 6)
    .map(m => metricCard(m.label, data[m.key]))
    .join("");
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
    { label: "Spend 7d",  key: "Spend (7d)" },
    { label: "ROAS 7d",   key: "ROAS (7d)" },
    { label: "CPA 7d",    key: "CPA (7d)" },
    { label: "Purchases", key: "Purchases (7d)" },
  ];

  el1.innerHTML = yesterday
    .filter(m => data[m.key])
    .map(m => metricCard(m.label, data[m.key]))
    .join("") || "<p style='color:var(--text-muted);font-size:12px'>No data</p>";

  el7.innerHTML = sevenDay
    .filter(m => data[m.key])
    .map(m => metricCard(m.label, data[m.key]))
    .join("") || "<p style='color:var(--text-muted);font-size:12px'>No data</p>";
}

function metricCard(label, value) {
  return `
    <div class="metric-card">
      <div class="label">${label}</div>
      <div class="value">${value}</div>
    </div>`;
}

function renderFallback(id, message) {
  const el = document.getElementById(id);
  if (el && message) {
    el.innerHTML = `<p style="color:var(--text-muted);font-size:12px">${message}</p>`;
  } else if (el) {
    el.innerHTML = "";
  }
}

function setStatus(state) {
  const dot  = document.getElementById("status-dot");
  const text = document.getElementById("status-text");
  if (!dot || !text) return;
  if (state === "live")    { dot.className = "status live"; text.textContent = "Live"; }
  if (state === "loading") { dot.className = "status";      text.textContent = "Loading..."; }
  if (state === "error")   { dot.className = "status";      text.textContent = "Offline"; }
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

    conversationHistory.push({ role: "user",      content: question });
    conversationHistory.push({ role: "assistant",  content: data.answer });

    // Keep history to last 10 turns
    if (conversationHistory.length > 20) conversationHistory.splice(0, 2);

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

  let html = `<div class="message-content">${escapeHtml(content)}</div>`;
  if (sources && sources.length > 0) {
    html += `<div class="message-sources">Sources: ${sources.join(", ")}</div>`;
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
