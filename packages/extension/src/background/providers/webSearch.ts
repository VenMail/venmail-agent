// Define types previously imported from '@venmail/shared'
interface ProviderModule {
  definition: ProviderDefinition;
  execute: (context: ExecuteContext) => Promise<ProviderResult>;
}

interface ProviderDefinition {
  id: string;
  name: string;
  cacheTtlMs: number;
  minimumConsent: string;
  enabled: (settings: Settings) => boolean;
}

interface ProviderResult {
  provider: string;
  signals: {
    linkedinProfile?: string;
    companyWebsite?: string;
    socialProfiles?: string[];
    professionalListings?: string[];
    spamReportsFound: boolean;
    searchConfidence: number;
    positiveSignalsScore: number;
    negativeSignalsScore: number;
  };
  socialProfiles: Record<string, string>;
  companyInfo: {
    name: string;
    website: string;
  };
  notes: string[];
  additionalData: {
    verifiedEmail: boolean;
    searchHighlights: {
      title: string;
      url: string;
      snippet: string;
      score: number;
      source: string;
    }[];
    confidenceScores: {
      search: number;
    };
  };
  fetchedAt: string;
}

type Settings = {
  consent: {
    search: boolean;
  };
};

interface LookupInfo {
  name?: string;
  email?: string;
  domain?: string;
  company?: string;
}

interface ExecuteContext {
  lookup: LookupInfo;
  cachedResult?: {
    payload: ProviderResult;
  };
  signal?: AbortSignal;
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  relevanceScore: number;
}

interface DuckDuckGoTopic {
  Text?: string;
  FirstURL?: string;
  Topics?: DuckDuckGoTopic[];
}

interface DuckDuckGoResponse {
  Results?: Array<{
    FirstURL?: string;
    Text?: string;
  }>;
  RelatedTopics?: DuckDuckGoTopic[];
}

// FIX 2: Actually search instead of generating fake URLs
const webSearchProvider: ProviderModule = {
  definition: {
    id: 'web-search',
    name: 'Open Web Search',
    cacheTtlMs: 1000 * 60 * 60 * 6,
    minimumConsent: 'search',
    enabled: (settings: Settings) => Boolean(settings.consent.search)
  },
  async execute({ lookup, cachedResult, signal }: ExecuteContext): Promise<ProviderResult> {
    if (cachedResult) {
      return cachedResult.payload;
    }

    const { name = '', email = '', domain = '', company = '' } = lookup;
    const normalizedName = name.trim();
    const normalizedDomain = domain.trim();
    const normalizedCompany = company.trim();

    // Build search query
    const searchTerms: string[] = [];
    if (normalizedName) searchTerms.push(normalizedName);
    if (normalizedCompany) searchTerms.push(normalizedCompany);
    if (normalizedDomain) searchTerms.push(normalizedDomain);

    const query = searchTerms.join(' ');
    
    if (!query) {
      return generateEmptyResult();
    }

    try {
      // Perform actual DuckDuckGo search
      const searchResults = await performDuckDuckGoSearch(query, signal);
      
      // Extract social profiles and company website from real results
      const socialProfiles = extractSocialProfiles(searchResults, normalizedName);
      const companyWebsite = extractCompanyWebsite(searchResults, normalizedDomain, normalizedCompany);
      const linkedInProfile = findLinkedInProfile(searchResults, normalizedName);
      
      // Analyze search results for spam/scam indicators
      const spamIndicators = checkSpamIndicators(searchResults);
      
      const result: ProviderResult = {
        provider: 'web-search',
        signals: {
          linkedinProfile: linkedInProfile,
          companyWebsite: companyWebsite,
          socialProfiles: socialProfiles.length > 0 ? socialProfiles : undefined,
          professionalListings: extractProfessionalListings(searchResults),
          spamReportsFound: spamIndicators.found,
          searchConfidence: calculateConfidence(searchResults, { name: normalizedName, domain: normalizedDomain }),
          positiveSignalsScore: spamIndicators.positiveScore,
          negativeSignalsScore: spamIndicators.negativeScore
        },
        socialProfiles: buildSocialProfilesMap(socialProfiles),
        companyInfo: {
          name: normalizedCompany || deriveCompanyName(companyWebsite, normalizedDomain),
          website: companyWebsite || ''
        },
        notes: [
          `Found ${searchResults.length} search results for "${query}"`,
          linkedInProfile ? 'LinkedIn profile located' : 'No LinkedIn profile found',
          spamIndicators.found ? 'Warning: Potential spam indicators detected' : 'No spam reports found',
          `Confidence score: ${calculateConfidence(searchResults, { name: normalizedName, domain: normalizedDomain })}/100`
        ],
        additionalData: {
          verifiedEmail: false,
          searchHighlights: searchResults.slice(0, 10).map(r => ({
            title: r.title,
            url: r.url,
            snippet: r.snippet,
            score: r.relevanceScore,
            source: 'duckduckgo'
          })),
          confidenceScores: {
            search: calculateConfidence(searchResults, { name: normalizedName, domain: normalizedDomain })
          }
        },
        fetchedAt: new Date().toISOString()
      };

      return result;
    } catch (error) {
      console.error('[web-search] Search failed:', error);
      return generateEmptyResult([
        'Search failed - falling back to basic inference',
        error instanceof Error ? error.message : 'Unknown error'
      ]);
    }
  }
};

async function performDuckDuckGoSearch(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const endpoint = 'https://api.duckduckgo.com/';
  const url = `${endpoint}?q=${encodeURIComponent(query)}&format=json&no_redirect=1&no_html=1&kl=us-en`;

  const response = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal
  });

  if (!response.ok) {
    throw new Error(`DuckDuckGo API returned ${response.status}`);
  }

  const data = await response.json() as DuckDuckGoResponse;
  const results: SearchResult[] = [];

  // Process instant answer results
  if (Array.isArray(data.Results)) {
    for (const result of data.Results) {
      if (result.FirstURL && result.Text) {
        results.push({
          title: result.Text,
          url: result.FirstURL,
          snippet: result.Text,
          relevanceScore: 90
        });
      }
    }
  }

  // Process related topics (more comprehensive)
  if (Array.isArray(data.RelatedTopics)) {
    const topicResults = flattenTopics(data.RelatedTopics);
    results.push(...topicResults);
  }

  // Calculate relevance scores based on query match
  const queryTokens = query.toLowerCase().split(/\s+/);
  for (const result of results) {
    const textToScore = `${result.title} ${result.snippet}`.toLowerCase();
    const matches = queryTokens.filter(token => textToScore.includes(token)).length;
    result.relevanceScore = Math.min(100, (matches / queryTokens.length) * 100);
  }

  // Sort by relevance and dedupe
  return dedupeByUrl(results)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, 20);
}

function flattenTopics(topics: DuckDuckGoTopic[]): SearchResult[] {
  const results: SearchResult[] = [];
  
  for (const topic of topics) {
    if (Array.isArray(topic.Topics)) {
      results.push(...flattenTopics(topic.Topics));
    } else if (topic.FirstURL && topic.Text) {
      results.push({
        title: topic.Text,
        url: topic.FirstURL,
        snippet: topic.Text,
        relevanceScore: 70
      });
    }
  }
  
  return results;
}

function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  return results.filter(result => {
    const normalized = result.url.toLowerCase().replace(/\/$/, '');
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

function extractSocialProfiles(results: SearchResult[], name: string): string[] {
  const socialDomains = [
    'linkedin.com',
    'twitter.com', 
    'x.com',
    'facebook.com',
    'instagram.com',
    'github.com',
    'medium.com'
  ];

  const profiles: string[] = [];
  
  for (const result of results) {
    try {
      const url = new URL(result.url);
      const hostname = url.hostname.replace(/^www\./, '');
      
      if (socialDomains.includes(hostname)) {
        // Verify it's relevant to the person/company
        const isRelevant = name 
          ? result.title.toLowerCase().includes(name.toLowerCase()) ||
            result.snippet.toLowerCase().includes(name.toLowerCase())
          : true;
          
        if (isRelevant) {
          profiles.push(result.url);
        }
      }
    } catch {
      continue;
    }
  }

  return [...new Set(profiles)].slice(0, 10);
}

function findLinkedInProfile(results: SearchResult[], name: string): string | undefined {
  // FIX 3: Find actual LinkedIn profile, not just search page
  for (const result of results) {
    if (result.url.includes('linkedin.com/in/')) {
      // Verify it matches the person
      if (name && result.title.toLowerCase().includes(name.toLowerCase())) {
        return result.url;
      }
    }
  }

  // Fallback: return search link if no direct profile found
  if (name) {
    return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name)}`;
  }

  return undefined;
}

function extractCompanyWebsite(
  results: SearchResult[], 
  domain: string, 
  company: string
): string | undefined {
  // If domain provided, prioritize it
  if (domain) {
    const normalized = domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
    
    for (const result of results) {
      try {
        const url = new URL(result.url.startsWith('http') ? result.url : `https://${result.url}`);
        const hostname = url.hostname.replace(/^www\./, '');
        
        if (hostname === normalized || hostname.endsWith(`.${normalized}`)) {
          return result.url;
        }
      } catch {
        continue;
      }
    }
    
    return `https://${normalized}`;
  }

  // Try to find company website from results
  if (company) {
    for (const result of results) {
      const matchesCompany = 
        result.title.toLowerCase().includes(company.toLowerCase()) ||
        result.snippet.toLowerCase().includes(company.toLowerCase());
        
      if (matchesCompany) {
        try {
          const url = new URL(result.url);
          // Exclude social media and listing sites
          const excludedDomains = ['linkedin.com', 'facebook.com', 'twitter.com', 'yelp.com', 'yellowpages.com'];
          const hostname = url.hostname.replace(/^www\./, '');
          
          if (!excludedDomains.some(excluded => hostname.includes(excluded))) {
            return result.url;
          }
        } catch {
          continue;
        }
      }
    }
  }

  return undefined;
}

function extractProfessionalListings(results: SearchResult[]): string[] | undefined {
  const listingSites = [
    'crunchbase.com',
    'apollo.io',
    'zoominfo.com',
    'rocketreach.com',
    'pitchbook.com'
  ];

  const listings: string[] = [];
  
  for (const result of results) {
    try {
      const url = new URL(result.url);
      const hostname = url.hostname.replace(/^www\./, '');
      
      if (listingSites.some(site => hostname.includes(site))) {
        listings.push(result.url);
      }
    } catch {
      continue;
    }
  }

  return listings.length > 0 ? listings : undefined;
}

function checkSpamIndicators(results: SearchResult[]): {
  found: boolean;
  positiveScore: number;
  negativeScore: number;
} {
  const negativeKeywords = ['scam', 'fraud', 'complaint', 'spam', 'phishing', 'lawsuit', 'breach'];
  const positiveKeywords = ['award', 'recognized', 'leader', 'certified', 'trusted', 'verified'];

  let negativeCount = 0;
  let positiveCount = 0;

  for (const result of results.slice(0, 10)) {
    const text = `${result.title} ${result.snippet}`.toLowerCase();
    
    negativeCount += negativeKeywords.filter(kw => text.includes(kw)).length;
    positiveCount += positiveKeywords.filter(kw => text.includes(kw)).length;
  }

  return {
    found: negativeCount > 0,
    positiveScore: Math.min(100, positiveCount * 15),
    negativeScore: Math.min(100, negativeCount * 20)
  };
}

function calculateConfidence(
  results: SearchResult[], 
  context: { name: string; domain: string }
): number {
  if (results.length === 0) return 10;

  const { name, domain } = context;
  let score = 0;

  // Base confidence on result count
  score += Math.min(30, results.length * 2);

  // Boost for exact name matches
  const nameMatches = results.filter(r => 
    name && r.title.toLowerCase().includes(name.toLowerCase())
  ).length;
  score += Math.min(30, nameMatches * 10);

  // Boost for domain matches
  if (domain) {
    const domainMatches = results.filter(r => r.url.includes(domain)).length;
    score += Math.min(20, domainMatches * 10);
  }

  // Boost for high relevance scores
  const avgRelevance = results.slice(0, 5).reduce((sum, r) => sum + r.relevanceScore, 0) / Math.min(5, results.length);
  score += Math.min(20, avgRelevance / 5);

  return Math.min(100, Math.max(15, score));
}

function buildSocialProfilesMap(profiles: string[]): Record<string, string> {
  const map: Record<string, string> = {};

  for (const url of profiles) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, '');
      const platform = hostname.split('.')[0];
      
      if (platform && !map[platform]) {
        map[platform] = url;
      }
    } catch {
      continue;
    }
  }

  return map;
}

function deriveCompanyName(website: string | undefined, domain: string): string {
  if (!website && !domain) return 'Unknown';
  
  const source = website || domain;
  try {
    const hostname = new URL(source.startsWith('http') ? source : `https://${source}`).hostname;
    const name = hostname.replace(/^www\./, '').split('.')[0];
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : 'Unknown';
  } catch {
    return domain ? domain.split('.')[0]?.toUpperCase() || 'Unknown' : 'Unknown';
  }
}

function generateEmptyResult(notes: string[] = []): ProviderResult {
  return {
    provider: 'web-search',
    signals: {
      linkedinProfile: undefined,
      companyWebsite: undefined,
      socialProfiles: undefined,
      professionalListings: undefined,
      spamReportsFound: false,
      searchConfidence: 0,
      positiveSignalsScore: 0,
      negativeSignalsScore: 0
    },
    socialProfiles: {},
    companyInfo: {
      name: '',
      website: ''
    },
    notes: notes.length > 0 ? notes : ['No search results available'],
    additionalData: {
      verifiedEmail: false,
      searchHighlights: [],
      confidenceScores: {
        search: 0
      }
    },
    fetchedAt: new Date().toISOString()
  };
}

export default webSearchProvider;