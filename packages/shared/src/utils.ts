import type { ContactLookup, ReputationResponse, ReputationSignals, ScrapeResult, ScrapeTaskId } from './types';
import { computeReputationScore } from './reputation';

export function buildRequestKey(lookup: ContactLookup): string {
  const parts = [lookup.email, lookup.name, lookup.domain, lookup.company]
    .map((value) => value?.trim().toLowerCase() ?? '')
    .map((value) => value.replace(/\|/g, ''));

  return parts.join('|');
}

export interface MergeResultPayload {
  signals: ReputationSignals;
  socialProfiles: ReputationResponse['socialProfiles'];
  companyInfo: ReputationResponse['companyInfo'];
  additionalData: ReputationResponse['additionalData'];
  notes: string[];
  tasksUsed: Set<ScrapeTaskId>;
}

export function mergeScrapeResults(results: ScrapeResult[]): MergeResultPayload {
  const merged: MergeResultPayload = {
    signals: {},
    socialProfiles: {},
    companyInfo: { name: '', website: '' },
    additionalData: {
      verifiedEmail: false,
      searchHighlights: [],
      socialLinks: {},
      contactChannels: [],
      confidenceScores: {}
    },
    notes: [],
    tasksUsed: new Set()
  };

  const confidenceTotals: Record<'search' | 'social' | 'contact', { value: number; weight: number }> = {
    search: { value: 0, weight: 0 },
    social: { value: 0, weight: 0 },
    contact: { value: 0, weight: 0 }
  };
  type ConfidenceKey = keyof typeof confidenceTotals;

  for (const result of results) {
    merged.tasksUsed.add(result.task);

    if (result.signals) {
      Object.assign(merged.signals, result.signals);
    }

    if (result.socialProfiles) {
      Object.assign(merged.socialProfiles, result.socialProfiles);
    }

    if (result.companyInfo) {
      merged.companyInfo = { ...merged.companyInfo, ...result.companyInfo };
    }

    if (result.additionalData) {
      if (result.additionalData.searchHighlights?.length) {
        merged.additionalData.searchHighlights = [
          ...(merged.additionalData.searchHighlights ?? []),
          ...result.additionalData.searchHighlights
        ]
          .filter(Boolean)
          .slice(0, 20);
      }

      if (result.additionalData.socialLinks) {
        merged.additionalData.socialLinks = {
          ...(merged.additionalData.socialLinks ?? {}),
          ...result.additionalData.socialLinks
        };
      }

      if (result.additionalData.contactChannels?.length) {
        merged.additionalData.contactChannels = [
          ...(merged.additionalData.contactChannels ?? []),
          ...result.additionalData.contactChannels
        ];
      }

      if (result.additionalData.confidenceScores) {
        for (const key of Object.keys(result.additionalData.confidenceScores) as ConfidenceKey[]) {
          const value = result.additionalData.confidenceScores?.[key];
          if (typeof value === 'number') {
            const bucket = confidenceTotals[key];
            bucket.value += value;
            bucket.weight += 1;
          }
        }
      }

      if (result.additionalData.negativeMentions?.length) {
        merged.additionalData.negativeMentions = [
          ...(merged.additionalData.negativeMentions ?? []),
          ...result.additionalData.negativeMentions
        ].slice(0, 10);
      }

      if (result.additionalData.positiveMentions?.length) {
        merged.additionalData.positiveMentions = [
          ...(merged.additionalData.positiveMentions ?? []),
          ...result.additionalData.positiveMentions
        ].slice(0, 10);
      }

      const { confidenceScores: _scores, ...restAdditionalData } = result.additionalData;
      merged.additionalData = {
        ...merged.additionalData,
        ...restAdditionalData,
        confidenceScores: merged.additionalData.confidenceScores
      };
    }

    if (result.notes) {
      merged.notes.push(...result.notes);
    }

    if (result.error) {
      merged.notes.push(`Task ${result.task} error: ${result.error}`);
    }
  }

  merged.additionalData.confidenceScores = {
    search:
      confidenceTotals.search.weight > 0
        ? Math.round(confidenceTotals.search.value / confidenceTotals.search.weight)
        : merged.additionalData.confidenceScores?.search,
    social:
      confidenceTotals.social.weight > 0
        ? Math.round(confidenceTotals.social.value / confidenceTotals.social.weight)
        : merged.additionalData.confidenceScores?.social,
    contact:
      confidenceTotals.contact.weight > 0
        ? Math.round(confidenceTotals.contact.value / confidenceTotals.contact.weight)
        : merged.additionalData.confidenceScores?.contact
  };

  if (merged.additionalData.searchHighlights) {
    merged.additionalData.searchHighlights = merged.additionalData.searchHighlights
      .filter((value, index, array) => array.findIndex((item) => item.url === value.url) === index)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 10);
  }

  if (merged.additionalData.contactChannels) {
    merged.additionalData.contactChannels = merged.additionalData.contactChannels.filter(
      (channel, index, array) => array.findIndex((item) => item.url === channel.url) === index
    );
  }

  if (!merged.companyInfo.name && merged.companyInfo.website) {
    try {
      const url = new URL(merged.companyInfo.website);
      const hostname = url.hostname.replace(/^www\./, '');
      merged.companyInfo.name = hostname.split('.')[0]?.toUpperCase() ?? '';
    } catch (error) {
      merged.notes.push(`Failed to derive company name: ${(error as Error).message}`);
    }
  }

  return merged;
}

export function buildReputationResponse(results: ScrapeResult[]): ReputationResponse {
  const merged = mergeScrapeResults(results);
  const breakdown = computeReputationScore(merged.signals);

  return {
    reputation: breakdown,
    reputationSignals: merged.signals,
    socialProfiles: merged.socialProfiles,
    companyInfo: merged.companyInfo,
    additionalData: {
      ...merged.additionalData,
      notes: merged.notes.length ? merged.notes.join('\n') : merged.additionalData.notes
    },
    tasksUsed: Array.from(merged.tasksUsed),
    generatedAt: new Date().toISOString()
  };
}
