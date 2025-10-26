import type { ProviderModule, ProviderResult } from '@venmail/shared';

const webSearchProvider: ProviderModule = {
  definition: {
    id: 'web-search',
    name: 'Open Web Search',
    cacheTtlMs: 1000 * 60 * 60 * 6,
    minimumConsent: 'search',
    enabled: (settings) => Boolean(settings.consent.search)
  },
  async execute({ lookup, cachedResult }): Promise<ProviderResult> {
    if (cachedResult) {
      return cachedResult.payload;
    }

    const { name = '', domain = '' } = lookup;

    const normalizedName = name.trim();
    const inferredLinkedIn = normalizedName
      ? `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(normalizedName)}`
      : undefined;

    const inferredCompanyWebsite = domain ? `https://${domain}` : undefined;

    const result: ProviderResult = {
      provider: 'web-search',
      signals: {
        linkedinProfile: inferredLinkedIn,
        companyWebsite: inferredCompanyWebsite,
        socialProfiles: inferredLinkedIn ? [inferredLinkedIn] : undefined,
        professionalListings: undefined,
        spamReportsFound: false
      },
      socialProfiles: inferredLinkedIn ? { linkedin: inferredLinkedIn } : {},
      companyInfo: {
        name: domain ? domain.split('.')[0]?.toUpperCase() ?? 'Unknown' : '',
        website: inferredCompanyWebsite ?? ''
      },
      notes: [
        'Auto-generated search hints based on supplied name and domain.',
        'For richer results, integrate a SERP API via the Venmail web service.'
      ],
      additionalData: {
        verifiedEmail: false
      },
      fetchedAt: new Date().toISOString()
    };

    return result;
  }
};

export default webSearchProvider;
