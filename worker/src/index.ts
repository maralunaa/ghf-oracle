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

    if (url.pathname === "/api/chat" && request.method === "POST") {
      return handleChat(request, env);
    }
    if (url.pathname === "/api/brief" && request.method === "GET") {
      return handleBrief(env);
    }

    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
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

  // 2. Retrieve relevant chunks
  const chunks = await matchChunks(embedding, 10, null, env);

  // 3. Build context
  const context = chunks
    .map((c) => `[${c.metadata.file_name}]\n${c.content}`)
    .join("\n\n---\n\n");

  // 4. Call Claude
  const answer = await callClaude(question, context, history, env);

  // 5. Unique source file names
  const sources = [...new Set(chunks.map((c) => c.metadata.file_name))];

  return jsonResponse({ answer, sources });
}

// ---------------------------------------------------------------------------
// /api/brief — returns structured metrics for the dashboard left panel
// ---------------------------------------------------------------------------

async function handleBrief(env: Env): Promise<Response> {
  // Pull the most recent snapshot JSON chunks (label = snapshots)
  const embedding = await embed("daily brief shopify meta ads revenue ROAS spend orders", env);
  const chunks = await matchChunks(embedding, 5, "snapshots", env);

  // Find the meta_ads.json chunk if present
  let metaData: Record<string, string> = {};
  let shopifyData: Record<string, string> = {};

  for (const chunk of chunks) {
    try {
      const parsed = JSON.parse(chunk.content);
      if (parsed.tool === "Meta Ads" && parsed.data) {
        metaData = parsed.data;
      }
    } catch {
      // not JSON — might be daily brief text
      if (chunk.metadata.folder_label === "daily_brief") {
        shopifyData = parseBriefText(chunk.content);
      }
    }
  }

  // Also try to get daily brief text chunks directly
  if (Object.keys(shopifyData).length === 0) {
    const briefEmbedding = await embed("gross sales order revenue discounts returns membership", env);
    const briefChunks = await matchChunks(briefEmbedding, 5, "daily_brief", env);
    for (const chunk of briefChunks) {
      const parsed = parseBriefText(chunk.content);
      if (Object.keys(parsed).length > 0) {
        shopifyData = { ...shopifyData, ...parsed };
        break;
      }
    }
  }

  return jsonResponse({ shopify: shopifyData, meta: metaData });
}

// Parse key: value lines from the daily brief text
function parseBriefText(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const match = line.match(/^([^:]+):\s+(.+)$/);
    if (match) {
      result[match[1].trim()] = match[2].trim();
    }
  }
  return result;
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

Today's date: ${new Date().toLocaleDateString("en-GB", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`;

async function callClaude(
  question: string,
  context: string,
  history: ChatMessage[],
  env: Env
): Promise<string> {
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

  if (!resp.ok) throw new Error(`Claude API failed: ${resp.status}`);
  const data: { content: { text: string }[] } = await resp.json();
  return data.content[0].text;
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
