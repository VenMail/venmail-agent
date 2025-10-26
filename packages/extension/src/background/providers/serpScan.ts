import type { ScrapeExecutionContext } from '@venmail/shared';

import { registerScrapeTask, type ScrapeTaskOutput } from '../taskMap';
import { computeRelevanceScore, dedupeByUrl, sanitizeSnippet, tokenize } from './serp/utils';

const DUCK_DUCK_GO_ENDPOINT = 'https://api.duckduckgo.com/';
const NEGATIVE_KEYWORDS = ['scam', 'fraud', 'lawsuit', 'complaint', 'breach', 'spam', 'phishing'];
const POSITIVE_KEYWORDS = ['award', 'recognized', 'leader', 'best', 'top', 'partnership', 'growth'];

registerScrapeTask('serp-scan', {
  async run(context: ScrapeExecutionContext): Promise<ScrapeTaskOutput> {
    const { cachedResult, lookup, signal } = context;

    if (cachedResult?.payload) {
      return cachedResult.payload;
    }

    const name = lookup.name?.trim() ?? '';
    const domain = lookup.domain?.trim() ?? '';
    const companyWebsite = domain ? ensureUrl(domain) : undefined;
    const query = buildQuery({ name, domain, company: lookup.company });

    const domHighlights = await fetchDomHighlights(query, context).catch(() => []);
    const ddgHighlights = await fetchSearchHighlights(query, signal).catch(() => []);

    const highlights = rankHighlights(query, [...domHighlights, ...ddgHighlights]);
    const { confidence, positiveMentions, negativeMentions, breachDetected, spamFlag, derivedWebsite } = analyzeHighlights(
      highlights,
      { name, domain }
    );

    const resolvedWebsite = companyWebsite ?? derivedWebsite ?? undefined;
    const socialProfiles = extractInlineSocial(highlights);
    const notes: string[] = [];

    if (highlights.length) {
      notes.push(`SERP scan gathered ${highlights.length} relevant references.`);
      notes.push(
        ...highlights.slice(0, 3).map((item) => `• ${item.title} (${item.source ?? 'result'}) → ${item.url}`)
      );
    } else {
      notes.push('SERP scan returned no strong matches.');
    }

    if (breachDetected) {
      notes.push('Potential breach or negative security report detected in search snippets.');
    }

    const signals: ScrapeTaskOutput['signals'] = {
      companyWebsite: resolvedWebsite,
      searchConfidence: confidence,
      spamReportsFound: spamFlag || undefined,
      negativeSignalsScore: negativeMentions.length ? negativeMentions.length * 10 : undefined,
      positiveSignalsScore: positiveMentions.length ? positiveMentions.length * 8 : undefined,
      breachAlerts: breachDetected || undefined,
      socialProfiles: socialProfiles.list.length ? socialProfiles.list : undefined,
      dataFreshnessDays: computeFreshness(highlights)
    };

    const socialProfilesMap: ScrapeTaskOutput['socialProfiles'] = socialProfiles.map;
    const additionalData: ScrapeTaskOutput['additionalData'] = {
      verifiedEmail: false,
      notes: notes.join('\n'),
      searchHighlights: highlights,
      socialLinks: socialProfiles.map,
      confidenceScores: {
        search: confidence
      },
      positiveMentions: positiveMentions.slice(0, 5),
      negativeMentions: negativeMentions.slice(0, 5)
    };

    if (resolvedWebsite) {
      additionalData.notes = `${additionalData.notes}\nLikely website inferred: ${resolvedWebsite}`.trim();
    }

    return {
      signals,
      socialProfiles: socialProfilesMap,
      companyInfo: resolvedWebsite
        ? {
            name: deriveCompanyName(resolvedWebsite, lookup.company),
            website: resolvedWebsite
          }
        : { name: lookup.company ?? '', website: '' },
      additionalData,
      notes,
      fetchedAt: new Date().toISOString()
    } satisfies ScrapeTaskOutput;
  }
});

interface QueryParts {
  name?: string;
  domain?: string;
  company?: string;
}

function buildQuery(parts: QueryParts): string {
  const tokens = [parts.name, parts.company, parts.domain && `"${parts.domain}"`].filter(Boolean) as string[];
  if (!tokens.length) {
    return 'professional contact lookup';
  }
  return tokens.join(' ');
}

async function fetchSearchHighlights(query: string, signal: AbortSignal): Promise<SearchResultHighlight[]> {
  const url = `${DUCK_DUCK_GO_ENDPOINT}?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&kl=us-en`;
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    },
    signal
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo API failed with status ${response.status}`);
  }

  const payload = (await response.json()) as DuckDuckGoResponse;
  const items: SearchResultHighlight[] = [];

  if (Array.isArray(payload.Results)) {
    for (const result of payload.Results) {
      if (result.FirstURL) {
        items.push({
          title: result.Text ?? result.FirstURL,
          url: result.FirstURL,
          snippet: sanitizeSnippet(result.Text ?? ''),
          score: 0,
          source: 'ddg'
        });
      }
    }
  }

  if (Array.isArray(payload.RelatedTopics)) {
    items.push(...flattenTopics(payload.RelatedTopics));
  }

  const deduped = dedupeByUrl(items).slice(0, 15);
  const queryTerms = tokenize(query);

  for (const item of deduped) {
    item.score = computeRelevanceScore(queryTerms, item.title, item.snippet);
  }

  return deduped
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((item, index) => ({
      ...item,
      score: Math.min(100, (item.score ?? 0) - index * 3)
    }))
    .slice(0, 12);
}

function analyzeHighlights(
  highlights: SearchResultHighlight[],
  context: { name?: string; domain?: string }
): {
  confidence: number;
  positiveMentions: string[];
  negativeMentions: string[];
  breachDetected: boolean;
  spamFlag: boolean;
  derivedWebsite?: string;
} {
  if (!highlights.length) {
    return {
      confidence: 10,
      positiveMentions: [],
      negativeMentions: [],
      breachDetected: false,
      spamFlag: false
    };
  }

  const topScores = highlights.slice(0, 5).map((item) => item.score ?? 0);
  const confidence = Math.min(100, Math.round(topScores.reduce((sum, value) => sum + value, 0) / topScores.length));
  const positiveMentions: string[] = [];
  const negativeMentions: string[] = [];
  let breachDetected = false;
  let spamFlag = false;
  let derivedWebsite: string | undefined;

  for (const item of highlights.slice(0, 10)) {
    const snippet = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
    if (!derivedWebsite && item.url && matchesCompanyDomain(item.url, context.domain)) {
      derivedWebsite = ensureUrl(item.url);
    }

    for (const keyword of POSITIVE_KEYWORDS) {
      if (snippet.includes(keyword)) {
        positiveMentions.push(item.title);
        break;
      }
    }

    for (const keyword of NEGATIVE_KEYWORDS) {
      if (snippet.includes(keyword)) {
        negativeMentions.push(item.title);
        if (keyword === 'breach') {
          breachDetected = true;
        }
        if (keyword === 'spam' || keyword === 'scam') {
          spamFlag = true;
        }
        break;
      }
    }
  }

  return {
    confidence: Math.max(15, confidence),
    positiveMentions,
    negativeMentions,
    breachDetected,
    spamFlag,
    derivedWebsite
  };
}

function extractInlineSocial(highlights: SearchResultHighlight[]): { list: string[]; map: Record<string, string> } {
  const socialHosts = ['linkedin.com', 'twitter.com', 'facebook.com', 'instagram.com', 'github.com', 'medium.com'];
  const list: string[] = [];
  const map: Record<string, string> = {};

  for (const item of highlights) {
    try {
      const host = new URL(item.url).hostname.replace(/^www\./, '');
      if (socialHosts.includes(host)) {
        list.push(item.url);
        const key = host.split('.')[0];
        if (!map[key]) {
          map[key] = item.url;
        }
      }
    } catch {
      continue;
    }
  }

  return {
    list: Array.from(new Set(list)).slice(0, 10),
    map
  };
}

function matchesCompanyDomain(url: string, domain?: string): boolean {
  if (!domain) {
    return false;
  }
  try {
    const host = new URL(ensureUrl(url)).hostname.replace(/^www\./, '');
    const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
    return host.endsWith(normalizedDomain);
  } catch {
    return false;
  }
}

function ensureUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return `https://${value}`;
}

function deriveCompanyName(website: string, fallback?: string): string {
  if (fallback) {
    return fallback;
  }
  try {
    const host = new URL(website).hostname.replace(/^www\./, '');
    return host.split('.')[0]?.toUpperCase() ?? '';
  } catch {
    return '';
  }
}

function computeFreshness(highlights: SearchResultHighlight[]): number | undefined {
  const now = Date.now();
  let bestDelta: number | undefined;

  for (const item of highlights) {
    const candidate = extractDate(item.snippet ?? '') || extractDate(item.title ?? '');
    if (candidate) {
      const delta = Math.abs(now - candidate.getTime());
      if (!bestDelta || delta < bestDelta) {
        bestDelta = delta;
      }
    }
  }

  if (bestDelta) {
    return Math.round(bestDelta / (1000 * 60 * 60 * 24));
  }
  return undefined;
}

function extractDate(text: string): Date | undefined {
  const match = text.match(/(20\d{2}|19\d{2})/);
  if (match) {
    const year = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isNaN(year)) {
      return new Date(`${year}-01-01T00:00:00Z`);
    }
  }
  return undefined;
}

async function fetchDomHighlights(query: string, context: ScrapeExecutionContext): Promise<SearchResultHighlight[]> {
  if (typeof context.tabId !== 'number') {
    return [];
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(context.tabId as number, { action: 'collectSerpHighlights', query }, (response) => {
      if (chrome.runtime.lastError) {
        resolve([]);
        return;
      }

      const raw = response?.highlights;
      if (!Array.isArray(raw)) {
        resolve([]);
        return;
      }

      const queryTerms = tokenize(query);
      const normalized: SearchResultHighlight[] = [];

      for (const entry of raw) {
        if (!entry || typeof entry !== 'object') {
          continue;
        }

        const candidate = entry as Partial<SearchResultHighlight>;
        if (!candidate.url || !candidate.title || typeof candidate.url !== 'string' || typeof candidate.title !== 'string') {
          continue;
        }

        const snippet = candidate.snippet ? sanitizeSnippet(candidate.snippet) : undefined;
        normalized.push({
          title: candidate.title,
          url: candidate.url,
          snippet,
          score: computeRelevanceScore(queryTerms, candidate.title, snippet),
          source: candidate.source ?? 'serp-dom'
        });
      }

      resolve(dedupeByUrl(normalized).slice(0, 15));
    });
  });
}

function rankHighlights(query: string, items: SearchResultHighlight[]): SearchResultHighlight[] {
  const queryTerms = tokenize(query);
  const scored = items.map((item) => {
    const snippet = item.snippet ? sanitizeSnippet(item.snippet) : undefined;
    return {
      ...item,
      snippet,
      score: computeRelevanceScore(queryTerms, item.title, snippet)
    } satisfies SearchResultHighlight;
  });

  return dedupeByUrl(scored)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 15);
}

interface DuckDuckGoTopic {
  Text?: string;
  FirstURL?: string;
  Icon?: { URL?: string };
  Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoResponse {
  Results?: Array<{
    FirstURL?: string;
    Text?: string;
  }>;
  RelatedTopics?: DuckDuckGoTopic[];
}

function flattenTopics(topics: DuckDuckGoTopic[]): SearchResultHighlight[] {
  const output: SearchResultHighlight[] = [];
  for (const topic of topics) {
    if (topic.Topics) {
      output.push(...flattenTopics(topic.Topics));
    } else if (topic.FirstURL) {
      output.push({
        title: topic.Text ?? topic.FirstURL,
        url: topic.FirstURL,
        snippet: sanitizeSnippet(topic.Text ?? ''),
        score: 0,
        source: 'ddg'
      });
    }
  }
  return output;
}

type SearchResultHighlight = import('@venmail/shared').SearchResultHighlight;
