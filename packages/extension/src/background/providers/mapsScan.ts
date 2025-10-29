import type { ScrapeExecutionContext } from '@venmail/shared';
import { registerScrapeTask, type ScrapeTaskOutput } from '../taskMap';

const inFlightMaps = new Set<string>();

registerScrapeTask('maps-scan', {
  async run(context: ScrapeExecutionContext): Promise<ScrapeTaskOutput> {
    const { cachedResult, lookup, signal } = context;

    if (cachedResult?.payload) {
      return cachedResult.payload;
    }

    const company = lookup.company?.trim() ?? '';
    const domain = lookup.domain?.trim() ?? '';
    const name = lookup.name?.trim() ?? '';
    
    if (!company && !domain && !name) {
      return buildEmptyResult(['No company or domain provided for Maps scan']);
    }

    const query = buildMapsQuery({ company, domain, name });
    const notes: string[] = [];

    try {
      const mapsData = await scrapeMapsData(query, signal);

      if (!mapsData) {
        notes.push('No Google Maps results found');
        return buildEmptyResult(notes);
      }

      notes.push(`Found business: ${mapsData.name}`);
      if (mapsData.address) notes.push(`Address: ${mapsData.address}`);
      if (mapsData.phone) notes.push(`Phone: ${mapsData.phone}`);
      if (mapsData.website) notes.push(`Website: ${mapsData.website}`);
      if (mapsData.rating) notes.push(`Rating: ${mapsData.rating} (${mapsData.reviewCount} reviews)`);

      const signals: ScrapeTaskOutput['signals'] = {
        companyWebsite: mapsData.website,
        searchConfidence: 85,
        positiveSignalsScore: mapsData.rating && mapsData.rating >= 4.0 ? 80 : 50,
        negativeSignalsScore: mapsData.rating && mapsData.rating < 3.0 ? 60 : 0
      };

      const additionalData: ScrapeTaskOutput['additionalData'] = {
        verifiedEmail: false,
        notes: notes.join('\n'),
        searchHighlights: [],
        confidenceScores: {
          search: 85
        }
      };

      return {
        signals,
        socialProfiles: {},
        companyInfo: {
          name: mapsData.name || company,
          website: mapsData.website || ''
        },
        additionalData,
        notes,
        fetchedAt: new Date().toISOString()
      } satisfies ScrapeTaskOutput;

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`Maps scan error: ${message}`);
      return buildEmptyResult(notes);
    }
  }
});

interface MapsData {
  name: string;
  address?: string;
  phone?: string;
  website?: string;
  rating?: number;
  reviewCount?: number;
  hours?: string[];
  category?: string;
}

function buildMapsQuery(context: { company?: string; domain?: string; name?: string }): string {
  if (context.company) {
    return context.company;
  }
  
  if (context.domain) {
    const domainName = context.domain.replace(/^https?:\/\//, '').replace(/^www\./, '').split('.')[0];
    return domainName || context.domain;
  }

  return context.name || 'business';
}

async function scrapeMapsData(query: string, signal: AbortSignal): Promise<MapsData | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Maps scan aborted'));
      return;
    }

    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
    const key = `maps:${query}`;
    if (inFlightMaps.has(key)) {
      resolve(null);
      return;
    }
    inFlightMaps.add(key);

    chrome.tabs.create(
      {
        url: mapsUrl,
        active: false
      },
      (tab) => {
        if (!tab.id) {
          inFlightMaps.delete(key);
          reject(new Error('Failed to create Maps tab'));
          return;
        }

        const tabId = tab.id;
        const timeout = setTimeout(() => {
          chrome.tabs.remove(tabId, () => {});
          inFlightMaps.delete(key);
          reject(new Error('Maps scraping timeout'));
        }, 20000);

        chrome.tabs.onUpdated.addListener(function listener(updatedTabId, changeInfo) {
          if (updatedTabId !== tabId) return;

          if (changeInfo.status === 'complete') {
            chrome.tabs.onUpdated.removeListener(listener);
            clearTimeout(timeout);

            // Wait for Maps to fully load and render
            setTimeout(() => {
              chrome.scripting.executeScript(
                {
                  target: { tabId },
                  func: scrapeMapsPage
                },
                (injectionResults) => {
                  chrome.tabs.remove(tabId, () => {});

                  if (chrome.runtime.lastError) {
                    inFlightMaps.delete(key);
                    reject(new Error(`Maps script injection failed: ${chrome.runtime.lastError.message}`));
                    return;
                  }

                  const data = injectionResults?.[0]?.result as MapsData | null | undefined;
                  inFlightMaps.delete(key);
                  resolve(data ?? null);
                }
              );
            }, 3000); // Maps needs more time to load
          }
        });
      }
    );
  });
}

// This function runs in the context of the Google Maps page
function scrapeMapsPage(): MapsData | null {
  try {
    // Wait for and click the first search result to open the details panel
    const firstResult = document.querySelector('a[href*="/maps/place/"]');
    if (firstResult instanceof HTMLElement) {
      firstResult.click();
      
      // Wait a moment for panel to open
      const startTime = Date.now();
      while (Date.now() - startTime < 2000) {
        // Busy wait
      }
    }

    const data: MapsData = {
      name: '',
      address: undefined,
      phone: undefined,
      website: undefined,
      rating: undefined,
      reviewCount: undefined,
      hours: undefined,
      category: undefined
    };

    // Try multiple selectors for business name
    const nameSelectors = [
      'h1.DUwDvf',
      'h2.qrShPb',
      '[data-item-id] h1',
      'div[role="main"] h1'
    ];

    for (const selector of nameSelectors) {
      const nameEl = document.querySelector(selector);
      if (nameEl?.textContent?.trim()) {
        data.name = nameEl.textContent.trim();
        break;
      }
    }

    // Address
    const addressSelectors = [
      'button[data-item-id="address"]',
      'div[data-item-id="address"]',
      '[aria-label*="Address"]'
    ];

    for (const selector of addressSelectors) {
      const addressEl = document.querySelector(selector);
      if (addressEl?.textContent?.trim()) {
        data.address = addressEl.textContent.trim().replace(/^Address\s*/, '');
        break;
      }
    }

    // Phone
    const phoneSelectors = [
      'button[data-item-id*="phone"]',
      'div[data-item-id*="phone"]',
      '[aria-label*="Phone"]',
      'a[href^="tel:"]'
    ];

    for (const selector of phoneSelectors) {
      const phoneEl = document.querySelector(selector);
      if (phoneEl?.textContent?.trim()) {
        data.phone = phoneEl.textContent.trim().replace(/^Phone\s*/, '');
        break;
      } else if (phoneEl instanceof HTMLAnchorElement && phoneEl.href.startsWith('tel:')) {
        data.phone = phoneEl.href.replace('tel:', '');
        break;
      }
    }

    // Website
    const websiteSelectors = [
      'a[data-item-id="authority"]',
      'a[aria-label*="Website"]',
      'a[href^="http"]:not([href*="google.com"]):not([href*="maps"])'
    ];

    for (const selector of websiteSelectors) {
      const websiteEl = document.querySelector(selector);
      if (websiteEl instanceof HTMLAnchorElement && websiteEl.href) {
        const url = websiteEl.href;
        if (!url.includes('google.com') && !url.includes('maps')) {
          data.website = url;
          break;
        }
      }
    }

    // Rating and review count
    const ratingEl = document.querySelector('div.F7nice span[aria-label*="star"]');
    if (ratingEl) {
      const ratingText = ratingEl.textContent?.trim();
      const ratingMatch = ratingText?.match(/([\d.]+)/);
      if (ratingMatch) {
        data.rating = parseFloat(ratingMatch[1] || '0');
      }
    }

    const reviewCountEl = document.querySelector('div.F7nice span[aria-label*="review"]');
    if (reviewCountEl) {
      const reviewText = reviewCountEl.textContent?.trim();
      const reviewMatch = reviewText?.match(/([\d,]+)/);
      if (reviewMatch) {
        data.reviewCount = parseInt(reviewMatch[1]?.replace(/,/g, '') || '0', 10);
      }
    }

    // Category
    const categoryEl = document.querySelector('button[jsaction*="category"]');
    if (categoryEl?.textContent?.trim()) {
      data.category = categoryEl.textContent.trim();
    }

    // Hours
    const hoursButton = document.querySelector('button[aria-label*="Hours"]');
    if (hoursButton instanceof HTMLElement) {
      hoursButton.click();
      
      // Wait for hours to expand
      const hoursWaitStart = Date.now();
      while (Date.now() - hoursWaitStart < 500) {
        // Busy wait
      }

      const hoursElements = document.querySelectorAll('table[aria-label*="Hours"] tr');
      const hours: string[] = [];

      for (const row of Array.from(hoursElements)) {
        const text = row.textContent?.trim();
        if (text) {
          hours.push(text);
        }
      }
      
      if (hours.length > 0) {
        data.hours = hours;
      }
    }

    // Return null if we didn't get at least a name
    if (!data.name) {
      return null;
    }

    return data;
  } catch (error) {
    console.error('Error scraping Maps page:', error);
    return null;
  }
}

function buildEmptyResult(notes: string[]): ScrapeTaskOutput {
  return {
    signals: {
      searchConfidence: 0
    },
    socialProfiles: {},
    companyInfo: {
      name: '',
      website: ''
    },
    additionalData: {
      verifiedEmail: false,
      notes: notes.join('\n'),
      searchHighlights: [],
      confidenceScores: {
        search: 0
      }
    },
    notes,
    fetchedAt: new Date().toISOString()
  };
}
