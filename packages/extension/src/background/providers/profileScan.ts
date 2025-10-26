import type { ScrapeExecutionContext } from '@venmail/shared';

import { registerScrapeTask, type ScrapeTaskOutput } from '../taskMap';

const HIGH_AUTHORITY_HOSTS: Record<string, number> = {
  'linkedin.com': 35,
  'scholar.google.com': 30,
  'scholar.googleusercontent.com': 20,
  'researchgate.net': 25,
  'github.com': 20,
  'medium.com': 10,
  'angel.co': 15,
  'crunchbase.com': 25,
  'behance.net': 15,
  'dribbble.com': 12
};

const HIGH_AUTHORITY_TLDS = ['.edu', '.gov', '.gov.ng', '.ac', '.org', '.mil'];

const SOCIAL_HOST_KEYS: Record<string, string> = {
  'linkedin.com': 'linkedin',
  'www.linkedin.com': 'linkedin',
  'twitter.com': 'twitter',
  'x.com': 'twitter',
  'facebook.com': 'facebook',
  'instagram.com': 'instagram',
  'github.com': 'github',
  'dribbble.com': 'dribbble',
  'behance.net': 'behance',
  'angel.co': 'angellist',
  'medium.com': 'medium',
  'youtube.com': 'youtube'
};

registerScrapeTask('profile-scan', {
  async run(context: ScrapeExecutionContext): Promise<ScrapeTaskOutput> {
    const { cachedResult, lookup, signal, selection, pageUrl } = context;

    if (cachedResult?.payload) {
      return cachedResult.payload;
    }

    const profileUrls = buildProfileHints(lookup, selection, pageUrl);

    if (!profileUrls.length) {
      return {
        signals: {},
        additionalData: {
          verifiedEmail: false,
          notes: 'No profile hints available – provide a name or domain to enhance scanning.'
        },
        notes: ['No profile hints available for scanning.'],
        fetchedAt: new Date().toISOString()
      } satisfies ScrapeTaskOutput;
    }

    const notes: string[] = [];
    const social: Record<string, string> = {};
    const trustedDomains = new Set<string>();
    const trustedSources = new Set<string>();
    let highAuthorityScore = 0;

    for (const hint of profileUrls) {
      const { platform, url } = hint;
      const normalizedUrl = normalizeProfileUrl(url);

      try {
        const headResponse = await fetch(normalizedUrl, { method: 'HEAD', redirect: 'follow', signal });

        if (headResponse.ok) {
          registerProfile(platform, normalizedUrl, social, trustedDomains, trustedSources, notes);
          highAuthorityScore += scoreAuthority(normalizedUrl);
          continue;
        }

        if (headResponse.status === 405 || headResponse.status === 403) {
          const getResponse = await fetch(normalizedUrl, { method: 'GET', redirect: 'follow', signal });
          if (getResponse.ok) {
            registerProfile(platform, normalizedUrl, social, trustedDomains, trustedSources, notes);
            highAuthorityScore += scoreAuthority(normalizedUrl);
            continue;
          }
          notes.push(`Hint ${normalizedUrl} returned HTTP ${getResponse.status}`);
          continue;
        }

        notes.push(`Hint ${normalizedUrl} returned HTTP ${headResponse.status}`);
      } catch (error) {
        if (signal.aborted) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        notes.push(`Failed to resolve ${normalizedUrl}: ${message}`);
      }
    }

    const socialProfiles = Object.keys(social).length ? social : undefined;
    const uniqueSocialLinks = socialProfiles ? Object.values(socialProfiles) : undefined;
    const socialPresenceScore = computeSocialPresence(uniqueSocialLinks);

    const signals: ScrapeTaskOutput['signals'] = {
      socialProfiles: uniqueSocialLinks,
      linkedinProfile: social.linkedin,
      socialPresenceScore: socialPresenceScore ?? undefined,
      highAuthorityScore: highAuthorityScore ? Math.min(100, highAuthorityScore) : undefined,
      trustedDomains: trustedDomains.size ? Array.from(trustedDomains) : undefined
    };

    const additionalData: ScrapeTaskOutput['additionalData'] = {
      verifiedEmail: false,
      notes: notes.join('\n'),
      socialLinks: socialProfiles,
      confidenceScores: {
        social: socialPresenceScore ?? undefined
      },
      trustedSources: trustedSources.size ? Array.from(trustedSources).slice(0, 12) : undefined
    };

    return {
      signals,
      socialProfiles,
      additionalData,
      notes,
      fetchedAt: new Date().toISOString()
    } satisfies ScrapeTaskOutput;
  }
});

interface ProfileHint {
  platform: string;
  url: string;
}

function buildProfileHints(
  lookup: ScrapeExecutionContext['lookup'],
  selection?: ScrapeExecutionContext['selection'],
  pageUrl?: string
): ProfileHint[] {
  const name = lookup.name?.trim();
  const domain = lookup.domain?.trim();
  const company = lookup.company?.trim();
  const hints: ProfileHint[] = [];

  if (name) {
    hints.push({
      platform: 'linkedin',
      url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(name)}`
    });
    hints.push({
      platform: 'twitter',
      url: `https://twitter.com/search?q=${encodeURIComponent(name)}`
    });
  }

  if (company) {
    hints.push({
      platform: 'linkedin',
      url: `https://www.linkedin.com/search/results/companies/?keywords=${encodeURIComponent(company)}`
    });
    hints.push({
      platform: 'crunchbase',
      url: `https://www.crunchbase.com/search/organization.companies/field/organizations/full_text/${encodeURIComponent(
        company
      )}`
    });
  }

  if (domain) {
    hints.push({
      platform: 'github',
      url: `https://github.com/search?q=${encodeURIComponent(domain)}`
    });
    hints.push({
      platform: 'linkedin',
      url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(domain)}`
    });
  }

  if (selection?.text) {
    hints.push({
      platform: 'linkedin',
      url: `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(selection.text)}`
    });
    hints.push({
      platform: 'google',
      url: `https://www.google.com/search?q=${encodeURIComponent(`${selection.text} linkedin`)}`
    });
  }

  if (pageUrl) {
    try {
      const host = new URL(pageUrl).hostname.replace(/^www\./, '');
      if (SOCIAL_HOST_KEYS[host]) {
        hints.push({ platform: SOCIAL_HOST_KEYS[host], url: pageUrl });
      }
    } catch {
      // ignore invalid pageUrl
    }
  }

  return Array.from(
    new Map(hints.map((hint) => [`${hint.platform}:${hint.url}`, hint])).values()
  );
}

function registerProfile(
  platform: string,
  url: string,
  social: Record<string, string>,
  trustedDomains: Set<string>,
  trustedSources: Set<string>,
  notes: string[]
): void {
  const host = extractHost(url);
  const socialKey = SOCIAL_HOST_KEYS[host] ?? platform;
  if (!social[socialKey]) {
    social[socialKey] = url;
    notes.push(`Detected ${socialKey} profile via ${url}`);
  }

  if (isHighAuthorityHost(host) || isHighAuthorityTld(url)) {
    trustedDomains.add(host);
  }

  trustedSources.add(url);
}

function scoreAuthority(url: string): number {
  const host = extractHost(url);
  let score = HIGH_AUTHORITY_HOSTS[host] ?? 0;

  if (isHighAuthorityTld(url)) {
    score += 15;
  }

  return score;
}

function computeSocialPresence(links?: string[]): number | undefined {
  if (!links || !links.length) {
    return undefined;
  }
  return Math.min(100, 25 * links.length);
}

function normalizeProfileUrl(url: string): string {
  try {
    const normalized = new URL(url);
    return normalized.toString();
  } catch {
    if (url.startsWith('http')) {
      return url;
    }
    return `https://${url}`;
  }
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function isHighAuthorityHost(host: string): boolean {
  return Boolean(HIGH_AUTHORITY_HOSTS[host]);
}

function isHighAuthorityTld(url: string): boolean {
  return HIGH_AUTHORITY_TLDS.some((suffix) => url.toLowerCase().includes(suffix));
}
