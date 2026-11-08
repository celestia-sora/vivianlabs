// Gemini embedding client for memory recall — server-side only.
//
// Additive and optional: every failure (no key, timeout, API error,
// malformed output) returns undefined and the recall path degrades to
// BM25-only, exactly like OpenAmika's "BM25" fallback when no vector
// backend is available. No embedding is ever required for chat to work.
//
// Model is env-driven (GEMINI_EMBEDDING_MODEL); document/query task types
// follow the Gemini convention for retrieval.

const DEFAULT_TIMEOUT_MS = 3500;

async function embedTexts(texts: string[], task: "RETRIEVAL_QUERY" | "RETRIEVAL_DOCUMENT"): Promise<number[][] | undefined> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey || !texts.length) return undefined;
  const model = process.env.GEMINI_EMBEDDING_MODEL?.trim() || "text-embedding-004";
  const batch = texts.slice(0, 8); // at most the 8 facts we can store per turn
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        body: JSON.stringify({
          model: `models/${model}`,
          content: { parts: batch.map((text) => ({ text })) },
          taskType: task,
        }),
      }
    );
    if (!response.ok) return undefined;
    const data = (await response.json()) as {
      embedding?: { values?: number[] };
      embeddings?: Array<{ values?: number[] }>;
    };
    if (Array.isArray(data.embeddings)) {
      const out = data.embeddings.map((item) => item?.values).filter((v): v is number[] => Array.isArray(v) && v.length > 0);
      return out.length ? out : undefined;
    }
    if (Array.isArray(data.embedding?.values) && data.embedding.values.length) return [data.embedding.values];
    return undefined;
  } catch {
    return undefined;
  }
}

/** Embed one query against stored documents. */
export function embedQuery(text: string): Promise<number[] | undefined> {
  return embedTexts([text.trim()], "RETRIEVAL_QUERY").then((rows) => rows?.[0]);
}

/** Embed extracted facts for storage next to their row. */
export function embedDocuments(texts: string[]): Promise<number[][] | undefined> {
  return embedTexts(texts, "RETRIEVAL_DOCUMENT");
}
