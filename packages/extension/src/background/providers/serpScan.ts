import type { ScrapeExecutionContext } from '@venmail/shared';

import { registerScrapeTask, type ScrapeTaskOutput } from '../taskMap';
import { computeRelevanceScore, dedupeByUrl, sanitizeSnippet, tokenize } from './serp/utils';

const DUCK_DUCK_GO_ENDPOINT = 'https://api.duckduckgo.com/';
const NEGATIVE_KEYWORDS = ['scam', 'fraud', 'lawsuit', 'complaint', 'breach', 'spam', 'phishing'];
const POSITIVE_KEYWORDS = ['award', 'recognized', 'leader', 'best', 'top', 'partnership', 'growth'];

// LinkedIn-specific search patterns
const LINKEDIN_PROFILE_PATTERNS = [
  /linkedin\.com\/in\/[\w-]+/i,
  /linkedin\.com\/pub\/[\w-]+/i
];

registerScrapeTask('serp-scan', {
  async run(context: ScrapeExecutionContext): Promise<ScrapeTaskOutput> {
    const { cachedResult, lookup, signal } = context;

    if (cachedResult?.payload) {
      return cachedResult.payload;
    }

    const name = lookup.name?.trim() ?? '';
    const domain = lookup.domain?.trim() ?? '';
    const company = lookup.company?.trim() ?? '';
    const companyWebsite = domain ? ensureUrl(domain) : undefined;
    
    // Build optimized search queries
    const queries = buildSearchQueries({ name, domain, company });
    const notes: string[] = [];

    // Perform parallel searches
    const [domHighlights, ...ddgResults] = await Promise.all([
      fetchDomHighlights(queries.primary, context).catch(() => []),
      ...queries.all.map(q => fetchSearchHighlights(q, signal).catch(() => []))
    ]);

    // Merge and dedupe all results
    const allHighlights = [
      ...domHighlights,
      ...ddgResults.flat()
    ];

    const highlights = rankHighlights(queries.primary, allHighlights);
    
    // Extract LinkedIn profile with validation
    const linkedInProfile = extractLinkedInProfile(highlights, name);
    
    // Analyze results
    const {
      confidence,
      positiveMentions,
      negativeMentions,
      breachDetected,
      spamFlag,
      derivedWebsite
    } = analyzeHighlights(highlights, { name, domain, company });

    const resolvedWebsite = companyWebsite ?? derivedWebsite ?? undefined;
    const socialProfiles = extractInlineSocial(highlights, name);
    const trustedDomains = extractTrustedDomains(highlights);
    
    // Generate detailed notes
    if (highlights.length) {
      notes.push(`SERP scan gathered ${highlights.length} relevant references.`);
      notes.push(
        ...highlights.slice(0, 3).map((item) => `• ${item.title} (${item.source ?? 'result'}) → ${item.url}`)
      );
    } else {
      notes.push('SERP scan returned no strong matches.');
    }

    if (linkedInProfile) {
      notes.push(`LinkedIn profile found: ${linkedInProfile}`);
    }

    if (breachDetected) {
      notes.push('⚠️ Potential breach or negative security report detected in search snippets.');
    }

    if (spamFlag) {
      notes.push('⚠️ Spam or scam indicators found in results.');
    }

    const signals: ScrapeTaskOutput['signals'] = {
      companyWebsite: resolvedWebsite,
      linkedinProfile: linkedInProfile,
      searchConfidence: confidence,
      spamReportsFound: spamFlag || undefined,
      negativeSignalsScore: negativeMentions.length ? negativeMentions.length * 10 : undefined,
      positiveSignalsScore: positiveMentions.length ? positiveMentions.length * 8 : undefined,
      breachAlerts: breachDetected || undefined,
      socialProfiles: socialProfiles.list.length ? socialProfiles.list : undefined,
      trustedDomains: trustedDomains.length ? trustedDomains : undefined,
      dataFreshnessDays: computeFreshness(highlights),
      highAuthorityScore: calculateAuthorityScore(highlights)
    };

    const socialProfilesMap: ScrapeTaskOutput['socialProfiles'] = socialProfiles.map;
    const additionalData: ScrapeTaskOutput['additionalData'] = {
      verifiedEmail: false,
      notes: notes.join('\n'),
      searchHighlights: highlights,
      socialLinks: socialProfiles.map,
      trustedSources: trustedDomains,
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
      companyInfo: resolvedWebsite || company
        ? {
            name: company || deriveCompanyName(resolvedWebsite, lookup.company),
            website: resolvedWebsite || ''
          }
        : { name: '', website: '' },
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

interface SearchQueries {
  primary: string;
  all: string[];
}

function buildSearchQueries(parts: QueryParts): SearchQueries {
  const { name, domain, company } = parts;
  const queries: string[] = [];

  // Primary query: combination of all available info
  const primaryTokens = [
    name,
    company,
    domain && `site:${domain}`
  ].filter(Boolean) as string[];

  const primary = primaryTokens.length 
    ? primaryTokens.join(' ')
    : 'professional contact lookup';

  queries.push(primary);

  // Additional targeted queries for better coverage
  if (name && domain) {
    queries.push(`"${name}" site:linkedin.com`);
    queries.push(`${name} ${domain}`);
  }

  if (name && company) {
    queries.push(`"${name}" "${company}"`);
  }

  return {
    primary,
    all: [...new Set(queries)].slice(0, 3) // Limit to 3 queries max
  };
}

async function fetchSearchHighlights(query: string, signal: AbortSignal): Promise<SearchResultHighlight[]> {
  const url = `${DUCK_DUCK_GO_ENDPOINT}?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&kl=us-en`;
  
  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo API failed with status ${response.status}`);
  }

  const payload = (await response.json()) as DuckDuckGoResponse;
  const items: SearchResultHighlight[] = [];

  // Process instant answer results
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

  // Process related topics
  if (Array.isArray(payload.RelatedTopics)) {
    items.push(...flattenTopics(payload.RelatedTopics));
  }

  // Dedupe and score
  const deduped = dedupeByUrl(items).slice(0, 20);
  const queryTerms = tokenize(query);

  for (const item of deduped) {
    item.score = computeRelevanceScore(queryTerms, item.title, item.snippet);
  }

  return deduped
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .map((item, index) => ({
      ...item,
      score: Math.min(100, (item.score ?? 0) - index * 2)
    }))
    .slice(0, 15);
}

// FIX 3: Extract actual LinkedIn profile URLs
function extractLinkedInProfile(highlights: SearchResultHighlight[], name: string): string | undefined {
  // First pass: Look for direct profile links
  for (const item of highlights) {
    for (const pattern of LINKEDIN_PROFILE_PATTERNS) {
      const match = item.url.match(pattern);
      if (match) {
        // Validate it's relevant to the person
        const isRelevant = !name || 
          item.title.toLowerCase().includes(name.toLowerCase()) ||
          item.snippet?.toLowerCase().includes(name.toLowerCase());
        
        if (isRelevant) {
          return item.url;
        }
      }
    }
  }

  // Second pass: Look for LinkedIn mentions in high-scoring results
  const linkedInResults = highlights
    .filter(h => h.url.includes('linkedin.com'))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (linkedInResults.length > 0) {
    const topResult = linkedInResults[0];
    if (topResult && topResult.url.includes('/in/')) {
      return topResult.url;
    }
  }

  // Fallback: Generate search URL if name provided
  if (name) {
    return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name)}`;
  }

  return undefined;
}

function analyzeHighlights(
  highlights: SearchResultHighlight[],
  context: { name?: string; domain?: string; company?: string }
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
  let confidence = Math.min(100, Math.round(topScores.reduce((sum, value) => sum + value, 0) / topScores.length));
  
  const positiveMentions: string[] = [];
  const negativeMentions: string[] = [];
  let breachDetected = false;
  let spamFlag = false;
  let derivedWebsite: string | undefined;

  // Boost confidence if we have exact matches
  const exactMatches = highlights.filter(h => {
    const text = `${h.title} ${h.snippet ?? ''}`.toLowerCase();
    return (context.name && text.includes(context.name.toLowerCase())) ||
           (context.company && text.includes(context.company.toLowerCase()));
  }).length;
  
  confidence += Math.min(20, exactMatches * 5);

  for (const item of highlights.slice(0, 12)) {
    const snippet = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
    
    // Derive company website
    if (!derivedWebsite && item.url && matchesCompanyDomain(item.url, context.domain, context.company)) {
      derivedWebsite = ensureUrl(item.url);
    }

    // Check for positive signals
    for (const keyword of POSITIVE_KEYWORDS) {
      if (snippet.includes(keyword)) {
        positiveMentions.push(item.title);
        break;
      }
    }

    // Check for negative signals
    for (const keyword of NEGATIVE_KEYWORDS) {
      if (snippet.includes(keyword)) {
        negativeMentions.push(item.title);
        if (keyword === 'breach') breachDetected = true;
        if (keyword === 'spam' || keyword === 'scam') spamFlag = true;
        break;
      }
    }
  }

  return {
    confidence: Math.max(15, Math.min(100, confidence)),
    positiveMentions,
    negativeMentions,
    breachDetected,
    spamFlag,
    derivedWebsite
  };
}

function extractInlineSocial(
  highlights: SearchResultHighlight[], 
  name: string
): { list: string[]; map: Record<string, string> } {
  const socialHosts = ['linkedin.com', 'twitter.com', 'x.com', 'facebook.com', 'instagram.com', 'github.com', 'medium.com'];
  const list: string[] = [];
  const map: Record<string, string> = {};

  for (const item of highlights) {
    try {
      const host = new URL(item.url).hostname.replace(/^www\./, '');
      if (socialHosts.includes(host)) {
        // Validate relevance
        const isRelevant = !name || 
          item.title.toLowerCase().includes(name.toLowerCase()) ||
          item.snippet?.toLowerCase().includes(name.toLowerCase());
        
        if (isRelevant) {
          list.push(item.url);
          const key = host.split('.')[0] || host;
          if (!map[key]) {
            map[key] = item.url;
          }
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

function extractTrustedDomains(highlights: SearchResultHighlight[]): string[] {
  const trustedSources = [
    'crunchbase.com',
    'bloomberg.com',
    'forbes.com',
    'techcrunch.com',
    'reuters.com',
    'wsj.com',
    'ft.com'
  ];

  const found: string[] = [];

  for (const item of highlights) {
    try {
      const host = new URL(item.url).hostname.replace(/^www\./, '');
      if (trustedSources.some(trusted => host.includes(trusted))) {
        found.push(host);
      }
    } catch {
      continue;
    }
  }

  return [...new Set(found)].slice(0, 5);
}

function calculateAuthorityScore(highlights: SearchResultHighlight[]): number {
  const highAuthoritySources = [
    'linkedin.com',
    'crunchbase.com',
    'bloomberg.com',
    'forbes.com',
    'techcrunch.com'
  ];

  const authorityCount = highlights.filter(h => {
    try {
      const host = new URL(h.url).hostname.replace(/^www\./, '');
      return highAuthoritySources.some(auth => host.includes(auth));
    } catch {
      return false;
    }
  }).length;

  return Math.min(100, authorityCount * 20);
}

function matchesCompanyDomain(url: string, domain?: string, company?: string): boolean {
  if (!domain && !company) return false;
  
  try {
    const host = new URL(ensureUrl(url)).hostname.replace(/^www\./, '');
    
    if (domain) {
      const normalizedDomain = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
      if (host === normalizedDomain || host.endsWith(`.${normalizedDomain}`)) {
        return true;
      }
    }
    
    if (company) {
      const companySlug = company.toLowerCase().replace(/[^a-z0-9]/g, '');
      return host.includes(companySlug);
    }
    
    return false;
  } catch {
    return false;
  }
}

function ensureUrl(value: string): string {
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

function deriveCompanyName(website: string | undefined, fallback?: string): string {
  if (fallback) return fallback;
  if (!website) return '';
  
  try {
    const host = new URL(website).hostname.replace(/^www\./, '');
    const name = host.split('.')[0];
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : '';
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
        if (!entry || typeof entry !== 'object') continue;

        const candidate = entry as Partial<SearchResultHighlight>;
        if (!candidate.url || !candidate.title) continue;

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
    .slice(0, 20);
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