import type { MapReputationSummary, ScrapeExecutionContext } from '@venmail/shared';

import { registerScrapeTask, type ScrapeTaskOutput } from '../taskMap';

registerScrapeTask('maps-scan', {
  async run(context: ScrapeExecutionContext): Promise<ScrapeTaskOutput> {
    const { cachedResult, mapSummary, tabId, mapsQuery } = context;

    if (cachedResult?.payload) {
      return cachedResult.payload;
    }

    const summary = mapSummary ?? (await fetchMapSummaryFromTab(tabId, mapsQuery));

    if (!summary) {
      return buildNoSummaryResult(mapsQuery);
    }

    const notes: string[] = [];

    if (typeof summary.rating === 'number') {
      notes.push(`Google Maps rating: ${summary.rating.toFixed(2)}`);
    }

    if (typeof summary.reviewCount === 'number') {
      notes.push(`Review volume: ${summary.reviewCount.toLocaleString()}`);
    }

    if (summary.statusText) {
      notes.push(`Status: ${summary.statusText}`);
    }

    if (summary.categories?.length) {
      notes.push(`Categories: ${summary.categories.join(', ')}`);
    }

    const trustedSources = new Set<string>();
    if (summary.sourceUrl) {
      trustedSources.add(summary.sourceUrl);
    }

    const signals: ScrapeTaskOutput['signals'] = {
      mapRating: summary.rating,
      mapReviewCount: summary.reviewCount,
      mapStatus: summary.statusText,
      companyWebsite: summary.website ?? undefined
    };

    const additionalData: ScrapeTaskOutput['additionalData'] = {
      verifiedEmail: false,
      notes: notes.join('\n'),
      mapSummary: summary,
      trustedSources: trustedSources.size ? Array.from(trustedSources) : undefined
    };

    if (summary.phone) {
      additionalData.phoneNumbers = [summary.phone];
    }

    if (summary.address) {
      additionalData.locations = [summary.address];
    }

    return {
      signals,
      companyInfo: {
        name: summary.name ?? '',
        website: summary.website ?? ''
      },
      additionalData,
      notes,
      fetchedAt: new Date().toISOString()
    } satisfies ScrapeTaskOutput;
  }
});

async function fetchMapSummaryFromTab(
  tabId?: number,
  query?: string
): Promise<MapReputationSummary | null> {
  if (typeof tabId !== 'number') {
    return null;
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'getMapSummary', query }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }

      resolve((response?.summary as MapReputationSummary | null | undefined) ?? null);
    });
  });
}

function buildNoSummaryResult(query?: string): ScrapeTaskOutput {
  const notes = query
    ? [`No Google Maps summary available for query '${query}'.`]
    : ['No Google Maps summary available for this lookup.'];

  return {
    signals: {},
    additionalData: {
      verifiedEmail: false,
      notes: notes.join('\n')
    },
    notes,
    fetchedAt: new Date().toISOString()
  } satisfies ScrapeTaskOutput;
}
