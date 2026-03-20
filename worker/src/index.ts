interface Env {
  SUPABASE_URL: string;
  CLAUDE_MODEL: string;
  OPENAI_EMBED_MODEL: string;
  SUPABASE_SERVICE_KEY: string;
  OPENAI_API_KEY: string;
  ANTHROPIC_API_KEY: string;
}

interface Chunk {
  id: string;
  drive_file_id: string;
  content: string;
  metadata: { file_name: string; folder_label: string };
  similarity: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/chat" && request.method === "POST") {
        return await handleChat(request, env);
      }
      if (url.pathname === "/api/brief" && request.method === "GET") {
        return await handleBrief(env);
      }
      if (url.pathname === "/api/debug" && request.method === "GET") {
        const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/ghf_documents?select=file_name,folder_label,chunk_count`, {
          headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` },
        });
        const data = await resp.json();
        return jsonResponse(data);
      }
      if (url.pathname === "/api/debug-brief" && request.method === "GET") {
        const briefChunks = await fetchChunksByLabel("daily_brief", 5, env);
        const fullText = briefChunks.map(c => c.content).join("\n");
        const briefOnly = fullText.split(/--\s*SHEETS & REPORTS\s*--/i)[0];
        const sections = parseBriefSections(briefOnly);
        return jsonResponse({ chunk_count: briefChunks.length, text_length: fullText.length, sections_keys: { yesterday: Object.keys(sections.yesterday), "7d": Object.keys(sections["7d"]) }, line_sample: briefOnly.split("\n").slice(10, 20) });
      }
      return new Response("Not found", { status: 404, headers: CORS_HEADERS });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Worker error:", message);
      return errorResponse(`Internal error: ${message}`, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// /api/chat
// ---------------------------------------------------------------------------

async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: { question: string; history?: ChatMessage[] };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  const { question, history = [] } = body;
  if (!question?.trim()) return errorResponse("question is required", 400);

  // 1. Embed the question
  const embedding = await embed(question, env);

  // 2. Retrieve relevant chunks — fetch more, then cap per document for diversity
  const [rawChunks, briefChunks] = await Promise.all([
    matchChunks(embedding, 30, null, env),
    fetchChunksByLabel("daily_brief", 3, env),
  ]);

  // Cap at 3 chunks per document, exclude daily brief drive_file_ids (we'll pin them)
  const briefIds = new Set(briefChunks.map(c => c.drive_file_id));
  const perDocCount: Record<string, number> = {};
  const retrievedChunks = rawChunks.filter(c => {
    if (briefIds.has(c.drive_file_id)) return false; // don't double-count brief
    perDocCount[c.drive_file_id] = (perDocCount[c.drive_file_id] || 0) + 1;
    return perDocCount[c.drive_file_id] <= 3;
  }).slice(0, 10);

  // Always pin the daily brief first so Claude always has current metrics
  const chunks = [...briefChunks, ...retrievedChunks];

  // 3. Build context
  const context = chunks
    .map((c) => `[${c.metadata.file_name}]\n${c.content}`)
    .join("\n\n---\n\n");

  // 4. Call Claude
  const { answer, followUps } = await callClaude(question, context, history, env);

  // 5. Unique source file names
  const sources = [...new Set(chunks.map((c) => c.metadata.file_name))];

  return jsonResponse({ answer, sources, followUps });
}

// ---------------------------------------------------------------------------
// /api/brief — returns structured metrics for the dashboard left panel
// ---------------------------------------------------------------------------

async function handleBrief(env: Env): Promise<Response> {
  const [metaChunks, briefChunks] = await Promise.all([
    fetchChunksByLabel("snapshots", 5, env),
    fetchChunksByLabel("daily_brief", 5, env),
  ]);

  // Meta: parse key metrics from all snapshot chunks
  const metaText = metaChunks.map(c => c.content).join("\n");
  const metaData = parseKVLines(metaText);

  // Shopify: reconstruct full brief text, stop at SHEETS & REPORTS section
  const fullBrief = briefChunks.map(c => c.content).join("\n");
  const briefOnly = fullBrief.split(/--\s*SHEETS & REPORTS\s*--/i)[0];
  const shopify = parseBriefSections(briefOnly);

  return jsonResponse({ shopify, meta: metaData, updated: new Date().toISOString() });
}

// Parse the daily brief into sections: yesterday, 7d, 30d
function parseBriefSections(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = { yesterday: {}, "7d": {}, "30d": {} };
  let current: string | null = null;

  for (const line of text.split("\n")) {
    if (/--\s*Yesterday\s*--/i.test(line))      { current = "yesterday"; continue; }
    if (/--\s*Last 7 days?\s*--/i.test(line))   { current = "7d"; continue; }
    if (/--\s*Last 30 days?\s*--/i.test(line))  { current = "30d"; continue; }
    if (/^--/.test(line.trim()))                { current = null; continue; }
    if (!current) continue;

    const match = line.match(/^\s*([^:|\n]+?)\s*:\s*(.+?)\s*$/);
    if (match) {
      const key = match[1].trim();
      const value = match[2].trim();
      if (key && value) sections[current][key] = value;
    }
  }
  return sections;
}

// Parse key: value lines (used for meta JSON chunks)
function parseKVLines(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^\s*"?([^":{}[\]]+)"?\s*:\s*"?([^"{}\[\]\n]+?)"?,?\s*$/);
    if (match) {
      const key = match[1].trim().replace(/^"|"$/g, "");
      const value = match[2].trim().replace(/^"|"$/g, "").replace(/,$/, "").trim();
      if (key && value && !key.startsWith("//") && value !== "{" && value !== "}") {
        result[key] = value;
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Direct Supabase chunk fetch by label
// ---------------------------------------------------------------------------

async function fetchChunksByLabel(label: string, count: number, env: Env): Promise<Chunk[]> {
  const docsResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/ghf_documents?select=drive_file_id&folder_label=eq.${encodeURIComponent(label)}`,
    { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  if (!docsResp.ok) {
    console.error(`fetchChunksByLabel docs query failed: ${docsResp.status} ${await docsResp.text()}`);
    return [];
  }
  const docs: { drive_file_id: string }[] = await docsResp.json();
  if (!docs.length) {
    console.error(`fetchChunksByLabel: no documents found for label=${label}`);
    return [];
  }

  const ids = docs.map(d => `"${d.drive_file_id}"`).join(",");
  const chunksResp = await fetch(
    `${env.SUPABASE_URL}/rest/v1/ghf_chunks?select=id,drive_file_id,content,metadata&drive_file_id=in.(${ids})&limit=${count}&order=chunk_index.asc`,
    { headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` } }
  );
  if (!chunksResp.ok) return [];
  const rows: { id: string; drive_file_id: string; content: string; metadata: Chunk["metadata"] }[] = await chunksResp.json();
  return rows.map(r => ({ ...r, similarity: 1 }));
}

// ---------------------------------------------------------------------------
// OpenAI embedding
// ---------------------------------------------------------------------------

async function embed(text: string, env: Env): Promise<number[]> {
  const resp = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model: env.OPENAI_EMBED_MODEL, input: text }),
  });

  if (!resp.ok) throw new Error(`OpenAI embed failed: ${resp.status}`);
  const data: { data: { embedding: number[] }[] } = await resp.json();
  return data.data[0].embedding;
}

// ---------------------------------------------------------------------------
// Supabase vector search
// ---------------------------------------------------------------------------

async function matchChunks(
  embedding: number[],
  count: number,
  filterLabel: string | null,
  env: Env
): Promise<Chunk[]> {
  const resp = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_ghf_chunks`, {
    method: "POST",
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query_embedding: embedding,
      match_count: count,
      filter_label: filterLabel,
    }),
  });

  if (!resp.ok) throw new Error(`Supabase query failed: ${resp.status}`);
  return resp.json();
}

// ---------------------------------------------------------------------------
// Claude API
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are the GHF Oracle — the internal AI assistant for Good Hill Farms (GHF), a direct-to-consumer exotic fruit e-commerce business.

You answer questions using ONLY the context documents provided. If the answer is not in the context, say so clearly — do not speculate or use general knowledge about other businesses.

When answering:
- Be direct and concise. Lead with the answer.
- Cite the source file name when referencing specific data.
- Flag risks or anomalies proactively.
- Frame everything through GHF's current focus: improving margins and efficiency.
- Keep recommendations actionable for a 3-person team.
- Ignore customer support email threads, phishing awareness templates, or copied communications — these are not operational risks.
- For current metrics (revenue, orders, ROAS, memberships), prioritise the GHF Daily Brief as the primary source — it has yesterday, 7-day, and 30-day Shopify data.
- For trends and deeper analysis, cross-reference GHF Daily Brief with GHF - Reports sheets.

Today's date: ${new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

At the end of every response, on a new line, write exactly:
FOLLOW-UP: [question 1] | [question 2] | [question 3]
These should be short, specific follow-up questions relevant to what was just discussed.`;

async function callClaude(
  question: string,
  context: string,
  history: ChatMessage[],
  env: Env
): Promise<{ answer: string; followUps: string[] }> {
  const messages = [
    ...history,
    {
      role: "user",
      content: `Here is the relevant context from GHF's knowledge base:\n\n${context}\n\n---\n\nQuestion: ${question}`,
    },
  ];

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: env.CLAUDE_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Claude API failed: ${resp.status} — ${body}`);
  }
  const data: { content: { text: string }[] } = await resp.json();
  const responseText = data.content[0].text;

  let answer = responseText;
  let followUps: string[] = [];

  if (responseText.includes("FOLLOW-UP:")) {
    const parts = responseText.split("FOLLOW-UP:");
    answer = parts[0].trim();
    followUps = parts[1].split("|").map(q => q.trim()).filter(q => q.length > 0);
  }

  return { answer, followUps };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function errorResponse(message: string, status = 500): Response {
  return jsonResponse({ error: message }, status);
}
