// helper module to improve query building
export interface LookupContext {
  name?: string;
  email?: string;
  domain?: string;
  company?: string;
}

export interface SearchStrategy {
  type: 'individual' | 'company' | 'mixed';
  primaryQuery: string;
  secondaryQueries: string[];
  searchEngines: string[];
  includeMaps: boolean;
}

export function determineSearchStrategy(context: LookupContext): SearchStrategy {
  const hasName = Boolean(context.name?.trim());
  const hasCompany = Boolean(context.company?.trim());
  const hasDomain = Boolean(context.domain?.trim());
  const hasEmail = Boolean(context.email?.trim());

  // Determine if this is an individual or company lookup
  let type: 'individual' | 'company' | 'mixed';
  
  if (hasName && !hasCompany && !hasDomain) {
    type = 'individual';
  } else if ((hasCompany || hasDomain) && !hasName) {
    type = 'company';
  } else {
    type = 'mixed';
  }

  const queries: string[] = [];
  let includeMaps = false;

  // Build queries based on type
  if (type === 'individual') {
    // Individual person lookup
    if (hasName) {
      queries.push(`"${context.name}" linkedin profile`);
      queries.push(`"${context.name}" professional contact`);
      
      if (hasEmail) {
        const emailDomain = context.email!.split('@')[1];
        if (emailDomain) {
          queries.push(`"${context.name}" site:${emailDomain}`);
        }
      }
    }
  } else if (type === 'company') {
    // Company lookup
    includeMaps = true;
    
    if (hasCompany) {
      queries.push(`"${context.company}" official website`);
      queries.push(`"${context.company}" company contact`);
      queries.push(`"${context.company}" linkedin company`);
      queries.push(`"${context.company}" address phone`);
    }
    
    if (hasDomain) {
      queries.push(`site:${context.domain}`);
      queries.push(`${context.domain} company info`);
    }
  } else {
    // Mixed: person at company
    includeMaps = true;
    
    if (hasName && hasCompany) {
      queries.push(`"${context.name}" "${context.company}"`);
      queries.push(`"${context.name}" linkedin ${context.company}`);
      queries.push(`"${context.name}" site:linkedin.com ${context.company}`);
    }
    
    if (hasName && hasDomain) {
      queries.push(`"${context.name}" site:${context.domain}`);
      queries.push(`"${context.name}" @${context.domain}`);
    }
    
    if (hasCompany) {
      queries.push(`"${context.company}" official website contact`);
    }
  }

  // Default query if nothing else works
  const primaryQuery = queries[0] || buildFallbackQuery(context);

  // Choose search engines based on type
  const searchEngines = type === 'company' 
    ? ['google', 'bing'] // Google and Bing are better for companies
    : ['google', 'bing', 'duckduckgo']; // All three for individuals

  return {
    type,
    primaryQuery,
    secondaryQueries: queries.slice(1, 4),
    searchEngines,
    includeMaps
  };
}

function buildFallbackQuery(context: LookupContext): string {
  const parts: string[] = [];
  
  if (context.name) parts.push(context.name);
  if (context.company) parts.push(context.company);
  if (context.domain) parts.push(context.domain);
  
  return parts.join(' ') || 'contact lookup';
}

export function buildMapsQuery(context: LookupContext): string {
  // For Maps, prioritize company name and physical location
  if (context.company) {
    return context.company;
  }
  
  if (context.domain) {
    // Extract likely company name from domain
    const domainName = context.domain
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .split('.')[0];
    
    return domainName || context.domain;
  }
  
  if (context.name && !context.name.includes('@')) {
    // If name looks like a company (e.g., "FINGO Consulting Ltd")
    const hasCompanyIndicators = /\b(ltd|llc|inc|corp|consulting|services|group|solutions)\b/i.test(context.name);
    if (hasCompanyIndicators) {
      return context.name;
    }
  }
  
  return '';
}

export function shouldSearchMaps(strategy: SearchStrategy): boolean {
  return strategy.includeMaps && strategy.type !== 'individual';
}

// Enhanced result filtering based on search type
export function filterResultsByType(
  results: Array<{ url: string; title: string; snippet: string }>,
  strategy: SearchStrategy,
  context: LookupContext
): Array<{ url: string; title: string; snippet: string; relevance: number }> {
  
  const scored = results.map(result => {
    let relevance = 50; // Base score
    
    const text = `${result.title} ${result.snippet}`.toLowerCase();
    const url = result.url.toLowerCase();
    
    // Boost for relevant platforms
    if (strategy.type === 'individual') {
      if (url.includes('linkedin.com/in/')) relevance += 30;
      if (url.includes('twitter.com') || url.includes('x.com')) relevance += 15;
      if (url.includes('github.com')) relevance += 15;
      
      // Penalize company listings for individual searches
      if (url.includes('linkedin.com/company/')) relevance -= 20;
      if (url.includes('crunchbase.com')) relevance -= 10;
      
    } else if (strategy.type === 'company') {
      if (url.includes('linkedin.com/company/')) relevance += 30;
      if (url.includes('crunchbase.com')) relevance += 25;
      if (url.includes('b2bhint.com')) relevance += 20;
      if (url.includes('bloomberg.com')) relevance += 20;
      
      // Penalize individual profiles for company searches
      if (url.includes('linkedin.com/in/')) relevance -= 15;
    }
    
    // Boost for exact name matches
    if (context.name && text.includes(context.name.toLowerCase())) {
      relevance += 20;
    }
    
    // Boost for company name matches
    if (context.company && text.includes(context.company.toLowerCase())) {
      relevance += 25;
    }
    
    // Boost for domain matches
    if (context.domain) {
      const cleanDomain = context.domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
      if (url.includes(cleanDomain)) {
        relevance += 30;
      }
    }
    
    // Penalize spam/scam indicators
    if (/scam|fraud|complaint|lawsuit/i.test(text)) {
      relevance -= 30;
    }
    
    return {
      ...result,
      relevance: Math.max(0, Math.min(100, relevance))
    };
  });
  
  // Sort by relevance
  return scored.sort((a, b) => b.relevance - a.relevance);
}
