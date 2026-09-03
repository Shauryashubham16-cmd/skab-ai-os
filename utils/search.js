const axios = require('axios');

// Both searches are optional and independent — if a key is missing, that
// source is silently skipped rather than breaking chat. This lets you add
// either or both providers whenever you're ready.
//
// The `{ http }` param is a dependency-injection seam: it defaults to the
// real axios module so production code is unchanged, but tests can pass a
// fake with the same `.post()` shape instead of hitting the real Tavily/Exa
// APIs. Previously these functions called `axios.post` directly with no
// seam, so exercising the response-mapping and failure-handling logic
// required either a live network call or mocking the axios module itself.

async function searchTavily(query, maxResults = 4, { http = axios } = {}) {
  if (!process.env.TAVILY_API_KEY) return [];
  try {
    const { data } = await http.post(
      'https://api.tavily.com/search',
      {
        query,
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: false,
      },
      {
        headers: { Authorization: `Bearer ${process.env.TAVILY_API_KEY}` },
        timeout: 8000,
      }
    );
    return (data.results || []).map((r) => ({
      source: 'Tavily',
      title: r.title,
      url: r.url,
      snippet: (r.content || '').slice(0, 400),
    }));
  } catch (err) {
    console.warn('[search] Tavily lookup failed:', err.response?.data?.error || err.message);
    return [];
  }
}

async function searchExa(query, maxResults = 4, { http = axios } = {}) {
  if (!process.env.EXA_API_KEY) return [];
  try {
    const { data } = await http.post(
      'https://api.exa.ai/search',
      {
        query,
        numResults: maxResults,
        contents: { text: { maxCharacters: 400 } },
      },
      {
        headers: {
          'x-api-key': process.env.EXA_API_KEY,
          'Content-Type': 'application/json',
        },
        timeout: 8000,
      }
    );
    return (data.results || []).map((r) => ({
      source: 'Exa',
      title: r.title,
      url: r.url,
      snippet: (r.text || '').slice(0, 400),
    }));
  } catch (err) {
    console.warn('[search] Exa lookup failed:', err.response?.data?.error || err.message);
    return [];
  }
}

// Runs both providers in parallel and merges results. Either or both may be
// empty (missing key, request failure, or no results) — callers should treat
// an empty array as "no extra context," not an error.
async function augmentedSearch(query, opts = {}) {
  const [tavily, exa] = await Promise.all([searchTavily(query, 4, opts), searchExa(query, 4, opts)]);
  return [...tavily, ...exa];
}

// Turns search results into a single system-role message to slot into the
// Perplexity request for this turn only. Returns null when there's nothing
// to add, so callers can skip it cleanly.
function buildContextMessage(results) {
  if (!results.length) return null;
  const lines = results
    .slice(0, 8)
    .map((r, i) => `[${i + 1}] (${r.source}) ${r.title} — ${r.snippet} — ${r.url}`);
  return {
    role: 'system',
    content:
      'Supplementary web search results for the user\'s latest message. Use them alongside ' +
      'your own knowledge and real-time search, and cite sources naturally when you rely on them:\n' +
      lines.join('\n'),
  };
}

module.exports = { searchTavily, searchExa, augmentedSearch, buildContextMessage };
