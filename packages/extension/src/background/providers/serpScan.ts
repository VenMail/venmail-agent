import type { ContactChannel, ScrapeExecutionContext } from '@venmail/shared';
import { registerScrapeTask, type ScrapeTaskOutput } from '../taskMap';
import { computeRelevanceScore, dedupeByUrl, sanitizeSnippet, tokenize } from './serp/utils';
import { determineSearchStrategy, filterResultsByType } from './query-builder';

const NEGATIVE_KEYWORDS = ['scam', 'fraud', 'lawsuit', 'complaint', 'breach', 'spam', 'phishing'];
const POSITIVE_KEYWORDS = ['award', 'recognized', 'leader', 'best', 'top', 'partnership', 'growth'];

const LINKEDIN_PROFILE_PATTERNS = [
  /linkedin\.com\/in\/[\w-]+/i,
  /linkedin\.com\/pub\/[\w-]+/i,
  /linkedin\.com\/company\/[\w-]+/i
];

const SOCIAL_PATTERNS = {
  facebook: /facebook\.com\/[\w.]+/i,
  instagram: /instagram\.com\/[\w.]+/i,
  twitter: /twitter\.com\/[\w]+/i,
  x: /x\.com\/[\w]+/i
};

const TRUST_SITES = {
  wikipedia: /wikipedia\.org\//i,
  youtube: /youtube\.com\//i,
  tiktok: /tiktok\.com\//i
};

const inFlightScrapes = new Set<string>();
const CONTACT_PATH_HINTS = ['contact', 'contact-us', 'contactus', 'support', 'customer-service', 'get-in-touch'];
const CONTACT_SNIPPET_HINTS = [
  /contact/i,
  /support/i,
  /customer service/i,
  /get in touch/i,
  /reach us/i
];

function normalizeChannelUrl(url: string): string {
  try {
    const parsed = new URL(ensureUrl(url));
    parsed.hash = '';
    parsed.search = '';
    const host = parsed.hostname.replace(/^www\./, '');
    const path = parsed.pathname.replace(/\/$/, '');
    return `${parsed.protocol}//${host}${path || ''}`;
  } catch {
    return url.trim();
  }
}

function mergeContactChannels(base: ContactChannel, next: ContactChannel): ContactChannel {
  const emails = dedupeStrings([...(base.emails ?? []), ...(next.emails ?? [])], 8);
  const phones = dedupeStrings([...(base.phones ?? []), ...(next.phones ?? [])], 8);
  const notes = dedupeStrings([base.notes, next.notes].filter(Boolean) as string[], 2).join(' • ') || undefined;
  return {
    url: normalizeChannelUrl(next.url || base.url),
    emails: emails.length ? emails : undefined,
    phones: phones.length ? phones : undefined,
    hasForm: base.hasForm || next.hasForm,
    notes
  };
}

function dedupeStrings(values: string[] | undefined, limit = 10): string[] {
  if (!values?.length) return [];
  const normalized = values
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/\s{2,}/g, ' '));
  const unique = Array.from(new Map(normalized.map((value) => [value.toLowerCase(), value])).values());
  return unique.slice(0, limit);
}

function normalizeFollowerCount(raw?: string): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[,\s]/g, '').toUpperCase();
  const match = cleaned.match(/^(\d+(?:\.\d+)?)([KMB])?$/);
  if (!match) {
    const numeric = parseInt(cleaned, 10);
    if (Number.isFinite(numeric) && numeric > 0) {
      return formatFollowerNumber(numeric);
    }
    return raw.trim();
  }

  const value = parseFloat(match[1]);
  const suffix = match[2];

  if (!suffix) {
    return formatFollowerNumber(value);
  }

  const multipliers: Record<string, number> = { K: 1_000, M: 1_000_000, B: 1_000_000_000 };
  const resolved = value * (multipliers[suffix] ?? 1);
  return formatFollowerNumber(resolved);
}

function formatFollowerNumber(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return `${Math.round(value)}`;
}

interface SearchEngine {
  name: string;
  buildUrl: (query: string) => string;
  selector: string;
}

const SEARCH_ENGINES: SearchEngine[] = [
  {
    name: 'google',
    buildUrl: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
    selector: 'div.g, div[data-sokoban-container]'
  },
  {
    name: 'bing',
    buildUrl: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}`,
    selector: 'li.b_algo, div.b_algo'
  },
  {
    name: 'duckduckgo',
    buildUrl: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`,
    selector: 'article[data-testid="result"], li[data-layout="organic"]'
  }
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
    
    const queries = buildSearchQueries({ name, domain, company });
    const notes: string[] = [];

    try {
      const strategy = determineSearchStrategy({
        name: lookup.name,
        email: lookup.email,
        domain: lookup.domain,
        company: lookup.company
      });

      const enginesToUse = SEARCH_ENGINES.filter((e) => strategy.searchEngines.includes(e.name));
      const searchQueries = [strategy.primaryQuery, ...strategy.secondaryQueries].filter(Boolean);

      const allHighlights = await performAutomatedSearches(searchQueries, enginesToUse, signal);

      if (allHighlights.length === 0) {
        notes.push('⚠️ SERP scan returned no results from any search engine.');
        return buildEmptyResult(notes, { name, domain, company, companyWebsite });
      }

      const simple = allHighlights.map((h) => ({ url: h.url, title: h.title, snippet: h.snippet ?? '' }));
      const filtered = filterResultsByType(simple, strategy, {
        name: lookup.name,
        email: lookup.email,
        domain: lookup.domain,
        company: lookup.company
      });

      const sourceByUrl = new Map<string, string>();
      for (const h of allHighlights) {
        if (!sourceByUrl.has(h.url)) sourceByUrl.set(h.url, h.source ?? 'serp-auto');
      }

      const highlights = dedupeByUrl(
        filtered.map((f) => ({
          title: f.title,
          url: f.url,
          snippet: f.snippet,
          score: f.relevance,
          source: sourceByUrl.get(f.url) ?? 'serp-auto'
        }))
      )
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 30);
      
      // Extract data from results
      const linkedInProfile = extractLinkedInProfile(highlights, name, company);
      const socialProfiles = extractInlineSocial(highlights, name, company);
      
      const {
        confidence,
        positiveMentions,
        negativeMentions,
        breachDetected,
        spamFlag,
        derivedWebsite
      } = analyzeHighlights(highlights, { name, domain, company });

      const resolvedWebsite = companyWebsite ?? derivedWebsite ?? undefined;
      const trustedDomains = extractTrustedDomains(highlights);
      const trust = await enrichTrustIndicators(highlights, socialProfiles.map, signal);
      const contactChannel = resolvedWebsite ? detectContactChannel(resolvedWebsite, highlights) : null;
      const channelMap = new Map<string, ContactChannel>();

      const registerChannel = (channel: ContactChannel | null | undefined) => {
        if (!channel?.url) return;
        const key = normalizeChannelUrl(channel.url);
        const existing = channelMap.get(key);
        if (existing) {
          channelMap.set(key, mergeContactChannels(existing, channel));
        } else {
          channelMap.set(key, {
            ...channel,
            url: key
          });
        }
      };

      registerChannel(contactChannel);
      trust.socialChannels.forEach((channel) => registerChannel(channel));

      const contactChannels = Array.from(channelMap.values());
      
      notes.push(`SERP scan gathered ${highlights.length} results from automated searches.`);
      
      if (highlights.length > 0) {
        const sourceCounts = new Map<string, number>();
        highlights.forEach(h => {
          const count = sourceCounts.get(h.source ?? 'unknown') ?? 0;
          sourceCounts.set(h.source ?? 'unknown', count + 1);
        });
        notes.push(`Sources: ${Array.from(sourceCounts.entries()).map(([s, c]) => `${s}(${c})`).join(', ')}`);
        notes.push(
          ...highlights.slice(0, 3).map((item) => `• ${item.title.slice(0, 60)}...`)
        );
      }

      if (linkedInProfile) {
        notes.push(`✓ LinkedIn profile: ${linkedInProfile}`);
      }

      if (socialProfiles.list.length > 0) {
        notes.push(`✓ Social profiles: ${Object.keys(socialProfiles.map).join(', ')}`);
      }

      if (resolvedWebsite) {
        notes.push(`✓ Website: ${resolvedWebsite}`);
      }

      if (trust.wikipedia) {
        notes.push('✓ Wikipedia presence detected');
      }

      if (Object.keys(trust.followers).length) {
        notes.push(
          `✓ Social reach: ${Object.entries(trust.followers)
            .map(([k, v]) => `${k}:${v}`)
            .join(', ')}`
        );
      }

      if (trust.phones.length) {
        notes.push(`✓ Phones found on socials: ${trust.phones.join(', ')}`);
      }
      if (trust.emails.length) {
        notes.push(`✓ Emails found on socials: ${trust.emails.join(', ')}`);
      }

      if (contactChannel) {
        notes.push(`✓ Contact page: ${contactChannel.url}${contactChannel.notes ? ` — ${contactChannel.notes}` : ''}`);
      }

      if (trust.socialChannels.length) {
        const socialHostHints = dedupeStrings(
          trust.socialChannels.map((channel) => safeParseUrl(channel.url)?.hostname.replace(/^www\./, '') || channel.url),
          4
        );
        if (socialHostHints.length) {
          notes.push(`✓ Social contact channels: ${socialHostHints.join(', ')}`);
        }
      }

      if (breachDetected) {
        notes.push('⚠️ Potential security breach detected in results.');
      }

      if (spamFlag) {
        notes.push('⚠️ Spam/scam indicators found.');
      }

      const hasRelevantData = linkedInProfile || socialProfiles.list.length > 0 || resolvedWebsite || trustedDomains.length > 0;
      const finalConfidence = hasRelevantData ? confidence : Math.max(10, confidence - 40);

      const contactScore = contactChannels.length
        ? Math.min(
            95,
            60 + contactChannels.length * 10 + (trust.phones.length ? 8 : 0) + (trust.emails.length ? 5 : 0)
          )
        : undefined;

      const signals: ScrapeTaskOutput['signals'] = {
        companyWebsite: resolvedWebsite,
        linkedinProfile: linkedInProfile,
        searchConfidence: Math.min(100, finalConfidence + (trust.wikipedia ? 10 : 0)),
        spamReportsFound: spamFlag || undefined,
        negativeSignalsScore: negativeMentions.length ? negativeMentions.length * 10 : undefined,
        positiveSignalsScore: Math.min(
          100,
          (positiveMentions.length ? positiveMentions.length * 8 : 0) +
            (Object.keys(trust.followers).length ? 10 : 0) +
            (trust.wikipedia ? 15 : 0)
        ),
        contactConfidence: contactScore,
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
        searchHighlights: highlights.slice(0, 20),
        socialLinks: socialProfiles.map,
        trustedSources: trustedDomains,
        confidenceScores: {
          search: finalConfidence
        },
        positiveMentions: positiveMentions.slice(0, 5),
        negativeMentions: negativeMentions.slice(0, 5),
        phoneNumbers: trust.phones.length ? trust.phones : undefined,
        contactChannels: contactChannels.length ? contactChannels : undefined
      };

      if (resolvedWebsite) {
        additionalData.notes = `${additionalData.notes}\nWebsite: ${resolvedWebsite}`.trim();
      }

      if (contactChannels.length && contactScore) {
        additionalData.confidenceScores = {
          ...additionalData.confidenceScores,
          contact: contactScore
        };
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

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`SERP scan error: ${message}`);
      return buildEmptyResult(notes, { name, domain, company, companyWebsite });
    }
  }
});

async function performAutomatedSearches(
  queries: string[],
  engines: SearchEngine[],
  signal: AbortSignal
): Promise<SearchResultHighlight[]> {
  const allResults: SearchResultHighlight[] = [];

  for (const q of queries) {
    for (const engine of engines) {
      if (signal.aborted) break;

      try {
        const results = await scrapeSearchEngine(engine, q, signal);
        allResults.push(...results);
      } catch (error) {
        console.warn(`[serp-scan] ${engine.name} failed:`, error);
        continue;
      }
    }

    if (allResults.length >= 25) break;
  }

  return dedupeByUrl(allResults);
}

async function scrapeSearchEngine(
  engine: SearchEngine,
  query: string,
  signal: AbortSignal
): Promise<SearchResultHighlight[]> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Search aborted'));
      return;
    }

    // Create a hidden tab for scraping
    const key = `${engine.name}:${query}`;
    if (inFlightScrapes.has(key)) {
      resolve([]);
      return;
    }
    inFlightScrapes.add(key);
    chrome.tabs.create(
      {
        url: engine.buildUrl(query),
        active: false
      },
      (tab) => {
        if (!tab.id) {
          inFlightScrapes.delete(key);
          reject(new Error(`Failed to create tab for ${engine.name}`));
          return;
        }

        const tabId = tab.id;
        const timeout = setTimeout(() => {
          chrome.tabs.remove(tabId, () => {});
          inFlightScrapes.delete(key);
          reject(new Error(`Timeout scraping ${engine.name}`));
        }, 15000);

        // Wait for page to load, then scrape
        chrome.tabs.onUpdated.addListener(function listener(updatedTabId, changeInfo) {
          if (updatedTabId !== tabId) return;

          if (changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timeout);

            // Give page a moment to render
            setTimeout(() => {
              chrome.scripting.executeScript(
                {
                  target: { tabId },
                  func: scrapeResultsFromPage,
                  args: [engine.name, engine.selector]
                },
                (injectionResults) => {
                  // Close the tab
                  chrome.tabs.remove(tabId, () => {});

                  if (chrome.runtime.lastError) {
                    inFlightScrapes.delete(key);
                    reject(new Error(`Script injection failed: ${chrome.runtime.lastError.message}`));
                    return;
                  }

                  const results = injectionResults?.[0]?.result as SearchResultHighlight[] | undefined;
                  inFlightScrapes.delete(key);
                  resolve(results ?? []);
                }
              );
            }, 1500); // Wait for dynamic content
          }
        });
      }
    );
  });
}

// This function runs in the context of the search results page
function scrapeResultsFromPage(engineName: string, selector: string): SearchResultHighlight[] {
  const results: SearchResultHighlight[] = [];

  try {
    const resultElements = document.querySelectorAll(selector);

    for (const element of Array.from(resultElements)) {
      try {
        let title = '';
        let url = '';
        let snippet = '';

        if (engineName === 'google') {
          const link = element.querySelector('a[href^="http"]') as HTMLAnchorElement;
          if (!link) continue;
          
          url = link.href;
          title = link.querySelector('h3')?.textContent?.trim() || link.textContent?.trim() || '';
          
          const snippetEl = element.querySelector('[data-snc], .VwiC3b, div[style*="-webkit-line-clamp"]');
          snippet = snippetEl?.textContent?.trim() || '';

        } else if (engineName === 'bing') {
          const link = element.querySelector('h2 a') as HTMLAnchorElement;
          if (!link) continue;
          
          url = link.href;
          title = link.textContent?.trim() || '';
          
          const snippetEl = element.querySelector('.b_caption p, .b_attribution, .b_algoSlug');
          snippet = snippetEl?.textContent?.trim() || '';

        } else if (engineName === 'duckduckgo') {
          const link = element.querySelector('a[data-testid="result-title-a"], h2 a, a[href]') as HTMLAnchorElement;
          if (!link) continue;
          
          url = link.href;
          title = link.textContent?.trim() || '';
          
          const snippetEl = element.querySelector('[data-result="snippet"], .result__snippet');
          snippet = snippetEl?.textContent?.trim() || '';
        }

        if (url && title) {
          // Clean up URLs
          if (url.includes('google.com/url?')) {
            const urlMatch = url.match(/[?&]url=([^&]+)/);
            if (urlMatch) {
              url = decodeURIComponent(urlMatch[1] || url);
            }
          }

          results.push({
            title: title.slice(0, 200),
            url,
            snippet: snippet.slice(0, 300),
            score: 0,
            source: `${engineName}-auto`
          });
        }
      } catch (e) {
        continue;
      }
    }
  } catch (error) {
    console.error(`Error scraping ${engineName}:`, error);
  }

  return results;
}

async function enrichTrustIndicators(
  highlights: SearchResultHighlight[],
  socialMap: Record<string, string | undefined>,
  signal: AbortSignal
): Promise<{
  wikipedia: boolean;
  followers: Record<string, string>;
  phones: string[];
  emails: string[];
  socialChannels: ContactChannel[];
}> {
  const followers: Record<string, string> = {};
  const phones = new Set<string>();
  const emails = new Set<string>();
  const socialChannels: ContactChannel[] = [];

  const candidateUrls: Array<{ url: string; platformHint?: string }> = [];
  const seen = new Set<string>();

  for (const [platform, url] of Object.entries(socialMap)) {
    if (!url) continue;
    const normalized = url.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    candidateUrls.push({ url: normalized, platformHint: platform });
  }

  for (const highlight of highlights) {
    const url = highlight.url;
    if (!url || seen.has(url)) continue;
    if (!/facebook\.com|instagram\.com|twitter\.com|x\.com/i.test(url)) continue;
    seen.add(url);
    candidateUrls.push({ url });
    if (candidateUrls.length >= 6) break;
  }

  const hasWikipedia = highlights.some((h) => TRUST_SITES.wikipedia.test(h.url));

  for (const candidate of candidateUrls) {
    if (signal.aborted) break;
    try {
      const { meta, contacts } = await scrapeSocialMeta(candidate.url, signal);
      const platform = meta?.platform ?? candidate.platformHint;
      const followerLabel = normalizeFollowerCount(meta?.followers);
      if (platform && followerLabel) {
        followers[platform] = followerLabel;
      } else if (platform && meta?.followers) {
        followers[platform] = meta.followers;
      }

      const channelPhones = contacts?.phones?.length ? dedupeStrings(contacts.phones, 8) : [];
      const channelEmails = contacts?.emails?.length ? dedupeStrings(contacts.emails, 8) : [];
      channelPhones.forEach((phone: string) => phones.add(phone));
      channelEmails.forEach((email: string) => emails.add(email));

      if (platform || channelPhones.length || channelEmails.length) {
        socialChannels.push({
          url: candidate.url,
          phones: channelPhones.length ? channelPhones : undefined,
          emails: channelEmails.length ? channelEmails : undefined,
          notes: platform
            ? `Social profile (${platform}${followerLabel ? ` • ${followerLabel}` : ''})`
            : followerLabel
            ? `Social profile • ${followerLabel}`
            : 'Social profile',
          hasForm: contacts?.hasForm ? true : undefined
        });
      }
    } catch {
      continue;
    }
  }

  return {
    wikipedia: hasWikipedia,
    followers,
    phones: Array.from(phones).slice(0, 8),
    emails: Array.from(emails).slice(0, 8),
    socialChannels
  };
}

async function scrapeSocialMeta(
  url: string,
  signal: AbortSignal
): Promise<{
  meta?: { platform?: string; followers?: string };
  contacts?: { phones?: string[]; emails?: string[]; hasForm?: boolean };
}> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }

    const key = `social:${url}`;
    if (inFlightScrapes.has(key)) {
      resolve({});
      return;
    }
    inFlightScrapes.add(key);

    chrome.tabs.create({ url, active: false }, (tab) => {
      if (!tab?.id) {
        inFlightScrapes.delete(key);
        reject(new Error('tab create failed'));
        return;
      }

      const tabId = tab.id;
      const timeout = setTimeout(() => {
        chrome.tabs.remove(tabId, () => {});
        inFlightScrapes.delete(key);
        resolve({});
      }, 15000);

      chrome.tabs.onUpdated.addListener(function listener(updatedTabId, changeInfo) {
        if (updatedTabId !== tabId) return;
        if (changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          clearTimeout(timeout);
          setTimeout(() => {
            chrome.scripting.executeScript(
              {
                target: { tabId },
                func: () => {
                  const text = document.body?.innerText || '';
                  const html = document.documentElement?.innerHTML || '';
                  const followersMatch = text.match(/([0-9.,]+\s*[MK]?)\s*(followers|Follower|Seguidores)/i);
                  let followers: string | undefined;
                  if (followersMatch) followers = followersMatch[1]?.trim();

                  let platform: string | undefined;
                  const host = location.hostname.replace(/^www\./, '');
                  if (host.includes('facebook.com')) platform = 'facebook';
                  else if (host.includes('instagram.com')) platform = 'instagram';
                  else if (host.includes('twitter.com') || host.includes('x.com')) platform = 'twitter';

                  const emails = Array.from(new Set(Array.from(html.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)).map(m => m[0]))).slice(0,5);
                  const phones = Array.from(new Set(Array.from(text.matchAll(/\+?[0-9][0-9\s().-]{6,}/g)).map(m => m[0]))).slice(0,5);
                  const hasForm = /contact form|submit|request|message us/i.test(text) || /<form/i.test(html);

                  return { meta: { platform, followers }, contacts: { phones, emails, hasForm } };
                }
              },
              (res) => {
                chrome.tabs.remove(tabId, () => {});
                inFlightScrapes.delete(key);
                const out = res?.[0]?.result as {
                  meta?: { platform?: string; followers?: string };
                  contacts?: { phones?: string[]; emails?: string[]; hasForm?: boolean };
                } | undefined;
                resolve(out ?? {});
              }
            );
          }, 1200);
        }
      });
    });
  });
}

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

  const primaryTokens = [
    company,
    name,
    domain
  ].filter(Boolean) as string[];

  const primary = primaryTokens.length 
    ? primaryTokens.join(' ')
    : 'professional contact lookup';

  queries.push(primary);

  if (company) {
    queries.push(`"${company}" contact`);
    if (name) {
      queries.push(`"${name}" "${company}"`);
    }
  }

  if (name) {
    queries.push(`"${name}" linkedin`);
  }

  return {
    primary,
    all: [...new Set(queries)].slice(0, 4)
  };
}

function extractLinkedInProfile(
  highlights: SearchResultHighlight[], 
  name: string, 
  company?: string
): string | undefined {
  for (const item of highlights) {
    for (const pattern of LINKEDIN_PROFILE_PATTERNS) {
      const match = item.url.match(pattern);
      if (match) {
        const text = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
        const isRelevant = 
          (!name || text.includes(name.toLowerCase())) ||
          (!company || text.includes(company.toLowerCase()));
        
        if (isRelevant) {
          return item.url;
        }
      }
    }
  }

  const linkedInResults = highlights
    .filter(h => h.url.includes('linkedin.com'))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

  if (linkedInResults.length > 0) {
    const topResult = linkedInResults[0];
    if (topResult && (topResult.url.includes('/in/') || topResult.url.includes('/company/'))) {
      return topResult.url;
    }
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
      confidence: 5,
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

  const exactMatches = highlights.filter(h => {
    const text = `${h.title} ${h.snippet ?? ''}`.toLowerCase();
    return (context.name && text.includes(context.name.toLowerCase())) ||
           (context.company && text.includes(context.company.toLowerCase()));
  }).length;
  
  confidence += Math.min(30, exactMatches * 10);

  for (const item of highlights.slice(0, 12)) {
    const snippet = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
    
    if (!derivedWebsite && item.url && matchesCompanyDomain(item.url, context.domain, context.company)) {
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
  name: string,
  company?: string
): { list: string[]; map: Record<string, string> } {
  const list: string[] = [];
  const map: Record<string, string> = {};

  for (const item of highlights) {
    for (const [platform, pattern] of Object.entries(SOCIAL_PATTERNS)) {
      const match = item.url.match(pattern);
      if (match) {
        const text = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
        const isRelevant = 
          (!name || text.includes(name.toLowerCase())) ||
          (!company || text.includes(company.toLowerCase()));
        
        if (isRelevant && !map[platform]) {
          list.push(item.url);
          map[platform] = item.url;
        }
      }
    }
  }

  return {
    list: Array.from(new Set(list)),
    map
  };
}

function detectContactChannel(website: string, highlights: SearchResultHighlight[]): ContactChannel | null {
  let baseUrl: URL;
  try {
    baseUrl = new URL(ensureUrl(website));
  } catch {
    return null;
  }

  const baseHost = baseUrl.hostname.replace(/^www\./, '');
  let best: { score: number; channel: ContactChannel } | null = null;

  for (const item of highlights) {
    const candidateUrl = safeParseUrl(item.url ?? '');
    if (!candidateUrl) continue;
    const host = candidateUrl.hostname.replace(/^www\./, '');
    const path = candidateUrl.pathname.toLowerCase();

    if (!(host === baseHost || host.endsWith(`.${baseHost}`))) {
      continue;
    }

    let score = 0;
    let hasForm = false;
    let notes: string | undefined;
    const combinedText = `${item.title} ${item.snippet ?? ''}`;

    for (const hint of CONTACT_PATH_HINTS) {
      if (path.includes(hint)) {
        score += 3;
        notes = 'Direct contact path';
        break;
      }
    }

    for (const regex of CONTACT_SNIPPET_HINTS) {
      if (regex.test(combinedText)) {
        score += 2;
        if (!notes) notes = 'SERP mentions contact details';
        break;
      }
    }

    if (/contact form|submit form|request form/i.test(combinedText)) {
      hasForm = true;
      score += 1;
    }

    const emails = extractEmails(combinedText);
    const phones = extractPhones(combinedText);
    if (emails.length || phones.length) {
      score += 1;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = {
        score,
        channel: {
          url: candidateUrl.href,
          emails: emails.length ? emails : undefined,
          phones: phones.length ? phones : undefined,
          hasForm: hasForm || undefined,
          notes
        }
      };
    }
  }

  if (best) {
    return best.channel;
  }

  const fallbackPath = CONTACT_PATH_HINTS.find((hint) => hint !== 'customer-service');
  if (fallbackPath) {
    const fallbackUrl = `${baseUrl.origin}/${fallbackPath}`;
    return {
      url: fallbackUrl,
      notes: 'Suggested contact URL'
    };
  }

  return null;
}

function extractEmails(text: string): string[] {
  if (!text) return [];
  const matches = Array.from(text.matchAll(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi)).map((match) => match[0].toLowerCase());
  return Array.from(new Set(matches)).slice(0, 5);
}

function extractPhones(text: string): string[] {
  if (!text) return [];
  const matches = Array.from(text.matchAll(/\+?[0-9][0-9\s().-]{6,}/g)).map((match) => match[0].trim());
  return Array.from(
    new Set(
      matches.map((phone) =>
        phone
          .replace(/[().-]/g, ' ')
          .replace(/\s{2,}/g, ' ')
          .trim()
      )
    )
  ).slice(0, 5);
}

function extractTrustedDomains(highlights: SearchResultHighlight[]): string[] {
  const trustedSources = [
    'crunchbase.com',
    'bloomberg.com',
    'forbes.com',
    'techcrunch.com',
    'reuters.com',
    'wsj.com',
    'ft.com',
    'b2bhint.com',
    'apollo.io',
    'zoominfo.com'
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

  return [...new Set(found)].slice(0, 8);
}

function calculateAuthorityScore(highlights: SearchResultHighlight[]): number {
  const highAuthoritySources = [
    'linkedin.com',
    'crunchbase.com',
    'bloomberg.com',
    'forbes.com',
    'techcrunch.com',
    'b2bhint.com',
    'facebook.com',
    'instagram.com'
  ];

  const authorityCount = highlights.filter(h => {
    try {
      const host = new URL(h.url).hostname.replace(/^www\./, '');
      return highAuthoritySources.some(auth => host.includes(auth));
    } catch {
      return false;
    }
  }).length;

  return Math.min(100, authorityCount * 15);
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
      const hostSlug = host.split('.')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
      
      if (hostSlug === companySlug || hostSlug.includes(companySlug) || companySlug.includes(hostSlug)) {
        return true;
      }
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

function safeParseUrl(candidate: string): URL | null {
  if (!candidate) {
    return null;
  }

  try {
    if (/^https?:\/\//i.test(candidate)) {
      return new URL(candidate);
    }
    return new URL(ensureUrl(candidate));
  } catch {
    return null;
  }
}

function deriveCompanyName(website: string | undefined, fallback?: string): string {
  if (fallback) return fallback;
  if (!website) return '';
  
  try {
    const url = new URL(ensureUrl(website));
    const host = url.hostname.replace(/^www\./, '');
    const [label] = host.split('.');
    if (label) {
      return label
        .split('-')
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(' ');
    }
  } catch {
    // ignore
  }

  return '';
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
    .slice(0, 30);
}

function buildEmptyResult(
  notes: string[], 
  context: { name?: string; domain?: string; company?: string; companyWebsite?: string }
): ScrapeTaskOutput {
  return {
    signals: {
      searchConfidence: 5,
      companyWebsite: context.companyWebsite
    },
    socialProfiles: {},
    companyInfo: context.company || context.domain
      ? {
          name: context.company || deriveCompanyName(context.companyWebsite, context.company),
          website: context.companyWebsite || ''
        }
      : { name: '', website: '' },
    additionalData: {
      verifiedEmail: false,
      notes: notes.join('\n'),
      searchHighlights: [],
      confidenceScores: {
        search: 5
      }
    },
    notes,
    fetchedAt: new Date().toISOString()
  };
}

type SearchResultHighlight = import('@venmail/shared').SearchResultHighlight;