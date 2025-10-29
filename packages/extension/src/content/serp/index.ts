interface SerpResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === 'collectSerpHighlights') {
    const highlights = collectSearchResults(message.query as string);
    sendResponse({ highlights });
    return true;
  }
});

function collectSearchResults(_query: string): SerpResult[] {
  const results: SerpResult[] = [];
  const url = window.location.href.toLowerCase();

  if (url.includes('google.com/search')) {
    results.push(...scrapeGoogleResults());
  } else if (url.includes('bing.com/search')) {
    results.push(...scrapeBingResults());
  } else if (url.includes('duckduckgo.com')) {
    results.push(...scrapeDuckDuckGoResults());
  }

  return results;
}

function scrapeGoogleResults(): SerpResult[] {
  const results: SerpResult[] = [];
  const searchResults = document.querySelectorAll('div.g, div[data-sokoban-container]');

  for (const result of Array.from(searchResults)) {
    try {
      const titleLink = result.querySelector('a[href^="http"]') as HTMLAnchorElement | null;
      if (!titleLink) continue;

      const url = titleLink.href;
      const title = titleLink.querySelector('h3')?.textContent?.trim() || titleLink.textContent?.trim() || '';

      const snippetEl = result.querySelector('[data-snc], .VwiC3b, div[style*="-webkit-line-clamp"]');
      const snippet = snippetEl?.textContent?.trim() || '';

      if (url && title) {
        results.push({
          title,
          url,
          snippet,
          source: 'google-dom'
        });
      }
    } catch {
      continue;
    }
  }

  return results;
}

function scrapeBingResults(): SerpResult[] {
  const results: SerpResult[] = [];
  const searchResults = document.querySelectorAll('li.b_algo, div.b_algo');

  for (const result of Array.from(searchResults)) {
    try {
      const titleLink = result.querySelector('h2 a') as HTMLAnchorElement | null;
      if (!titleLink) continue;

      const url = titleLink.href;
      const title = titleLink.textContent?.trim() || '';

      const snippetEl = result.querySelector('.b_caption p, .b_attribution, .b_algoSlug');
      const snippet = snippetEl?.textContent?.trim() || '';

      if (url && title) {
        results.push({
          title,
          url,
          snippet,
          source: 'bing-dom'
        });
      }
    } catch {
      continue;
    }
  }

  return results;
}

function scrapeDuckDuckGoResults(): SerpResult[] {
  const results: SerpResult[] = [];
  const searchResults = document.querySelectorAll('article[data-testid="result"], li[data-layout="organic"]');

  for (const result of Array.from(searchResults)) {
    try {
      const titleLink = result.querySelector('a[data-testid="result-title-a"], h2 a') as HTMLAnchorElement | null;
      if (!titleLink) continue;

      const url = titleLink.href;
      const title = titleLink.textContent?.trim() || '';

      const snippetEl = result.querySelector('[data-result="snippet"], .result__snippet');
      const snippet = snippetEl?.textContent?.trim() || '';

      if (url && title) {
        results.push({
          title,
          url,
          snippet,
          source: 'ddg-dom'
        });
      }
    } catch {
      continue;
    }
  }

  return results;
}

function detectSearchPage() {
  const url = window.location.href.toLowerCase();
  if (
    url.includes('google.com/search') ||
    url.includes('bing.com/search') ||
    url.includes('duckduckgo.com')
  ) {
    chrome.runtime.sendMessage({
      type: 'venmail-search-page-detected',
      url: window.location.href,
      engine: url.includes('google') ? 'google' : url.includes('bing') ? 'bing' : 'duckduckgo'
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', detectSearchPage);
} else {
  detectSearchPage();
}
