import type { ScrapeExecutionContext } from '@venmail/shared';

import { registerScrapeTask, type ScrapeTaskOutput } from '../taskMap';

const TRUSTED_FORM_PATTERNS = [/type="email"/i, /contact-form/i, /support-form/i];
const TRUSTED_TLDS = ['.edu', '.gov', '.gov.ng', '.org'];
const TRUSTED_HOSTS = ['zendesk.com', 'freshdesk.com', 'intercom.help'];

const EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE_REGEX = /(?:(?:\+?\d{1,3}[ \-.]?)?(?:\(\d{1,4}\)[ \-.]?)?\d{1,4}(?:[ \-.]\d{2,4}){2,4})/g;
const CONTACT_PATHS = [
  '',
  '/contact',
  '/contact-us',
  '/contactus',
  '/about',
  '/about-us',
  '/team',
  '/company',
  '/support'
];

registerScrapeTask('contact-page-scan', {
  async run(context: ScrapeExecutionContext): Promise<ScrapeTaskOutput> {
    const { cachedResult, lookup, signal } = context;

    if (cachedResult?.payload) {
      return cachedResult.payload;
    }

    const baseUrl = inferBaseUrl(lookup.domain, lookup.company);

    if (!baseUrl) {
      return buildNoteResult('No domain or company supplied to derive contact page.');
    }

    const emails = new Set<string>();
    const phones = new Set<string>();
    const contactChannels: ContactChannel[] = [];
    const visited: string[] = [];
    const notes: string[] = [];
    let contactConfidence = 0;
    const trustedDomains = new Set<string>();

    for (const path of CONTACT_PATHS) {
      const targetUrl = normalizeUrl(baseUrl, path);

      if (!targetUrl) {
        continue;
      }

      visited.push(targetUrl);

      try {
        const response = await fetch(targetUrl, { signal });
        if (!response.ok) {
          notes.push(`Skipped ${targetUrl} – HTTP ${response.status}`);
          continue;
        }

        const html = await response.text();
        const pageEmails = extractMatches(html, EMAIL_REGEX);
        const pagePhones = extractMatches(html, PHONE_REGEX)
          .map((value) => value.replace(/\s+/g, ' ').trim())
          .filter(Boolean);

        if (pageEmails.length || pagePhones.length) {
          const channel: ContactChannel = {
            url: targetUrl,
            emails: pageEmails.length ? Array.from(new Set(pageEmails)) : undefined,
            phones: pagePhones.length ? Array.from(new Set(pagePhones)) : undefined,
            hasForm: TRUSTED_FORM_PATTERNS.some((pattern) => pattern.test(html)) || undefined,
            notes: summarizeChannel(pageEmails, pagePhones, html)
          };

          if (channel.emails) {
            channel.emails.forEach((value) => emails.add(value));
          }
          if (channel.phones) {
            channel.phones.forEach((value) => phones.add(value));
          }

          contactChannels.push(channel);
          contactConfidence += evaluateConfidence(targetUrl, channel);
          const host = extractHost(targetUrl);
          if (isTrustedDomain(host)) {
            trustedDomains.add(host);
          }
        }

        if (emails.size && phones.size) {
          notes.push(`Found contact details on ${targetUrl}`);
          break;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (signal.aborted) {
          throw error;
        }
        notes.push(`Error fetching ${targetUrl}: ${message}`);
      }
    }

    if (!emails.size && !phones.size) {
      notes.push('No direct contact details extracted.');
    }

    const normalizedConfidence = contactConfidence ? Math.min(100, contactConfidence) : undefined;

    return {
      signals: {
        companyWebsite: baseUrl,
        contactConfidence: normalizedConfidence,
        trustedDomains: trustedDomains.size ? Array.from(trustedDomains) : undefined
      },
      companyInfo: {
        name: deriveCompanyName(baseUrl),
        website: baseUrl
      },
      additionalData: {
        verifiedEmail: false,
        phoneNumbers: phones.size ? Array.from(phones) : undefined,
        contactChannels: contactChannels.length ? contactChannels : undefined,
        confidenceScores: {
          contact: normalizedConfidence
        },
        notes: [...notes, `Visited paths: ${visited.join(', ')}`].join('\n')
      },
      notes,
      fetchedAt: new Date().toISOString()
    } satisfies ScrapeTaskOutput;
  }
});

function inferBaseUrl(domain?: string, company?: string): string | undefined {
  if (domain) {
    const trimmed = domain.trim();
    if (!trimmed) {
      return undefined;
    }
    return trimmed.startsWith('http') ? trimmed : `https://${trimmed}`;
  }

  if (company) {
    const slug = company.trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!slug) {
      return undefined;
    }
    return `https://${slug}.com`;
  }

  return undefined;
}

function normalizeUrl(base: string, path: string): string | undefined {
  try {
    const url = new URL(base);
    if (!path) {
      return url.toString();
    }
    return new URL(path, url).toString();
  } catch (error) {
    console.warn('[Venmail][contact-page] Invalid URL', base, path, error);
    return undefined;
  }
}

function deriveCompanyName(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./, '');
    return host.split('.')[0]?.toUpperCase() ?? '';
  } catch {
    return '';
  }
}

function extractMatches(source: string, regex: RegExp): string[] {
  const matches: string[] = [];
  regex.lastIndex = 0;
  let result: RegExpExecArray | null = null;
  while ((result = regex.exec(source)) !== null) {
    if (result[0]) {
      matches.push(result[0]);
    }
  }
  return matches;
}

function evaluateConfidence(url: string, channel: ContactChannel): number {
  let score = 10;
  if (channel.emails && channel.emails.some((email) => email.endsWith('.edu') || email.endsWith('.gov'))) {
    score += 20;
  }
  if (channel.hasForm) {
    score += 15;
  }
  if (channel.phones && channel.phones.length > 0) {
    score += 10;
  }

  const host = extractHost(url);
  if (isTrustedDomain(host)) {
    score += 15;
  }

  return score;
}

function extractHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function isTrustedDomain(host: string): boolean {
  if (!host) {
    return false;
  }
  if (TRUSTED_HOSTS.some((trusted) => host.endsWith(trusted))) {
    return true;
  }
  return TRUSTED_TLDS.some((suffix) => host.endsWith(suffix.replace(/^[.]/, '')) || host.includes(suffix));
}

function summarizeChannel(emails: string[], phones: string[], html: string): string | undefined {
  const hints: string[] = [];
  if (emails.length) {
    hints.push(`${emails.length} email(s)`);
  }
  if (phones.length) {
    hints.push(`${phones.length} phone(s)`);
  }
  if (TRUSTED_FORM_PATTERNS.some((pattern) => pattern.test(html))) {
    hints.push('contact form detected');
  }
  return hints.length ? hints.join(', ') : undefined;
}

type ContactChannel = import('@venmail/shared').ContactChannel;

function buildNoteResult(message: string): ScrapeTaskOutput {
  return {
    signals: {},
    additionalData: {
      verifiedEmail: false,
      notes: message
    },
    notes: [message],
    fetchedAt: new Date().toISOString()
  } satisfies ScrapeTaskOutput;
}
