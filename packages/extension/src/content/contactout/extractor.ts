import type { ScrapeResult } from '@venmail/shared';

export interface ExtractionOptions {
  root?: Document | Element;
  targetLabel?: string;
  timestamp?: () => string;
}

export function extractContactOutResult(options: ExtractionOptions = {}): ScrapeResult {
  const { root = document, targetLabel, timestamp = () => new Date().toISOString() } = options;
  const scope = root instanceof Document ? root : root.ownerDocument ?? document;
  const queryRoot: Document | Element = root;

  const name = pickFirstText(queryRoot, [
    '[data-testid="profile-name"]',
    '.contact-card [data-e2e="name"]',
    'h1',
    'header h2'
  ]);

  const email = (pickFirstText(queryRoot, [
    '[data-testid="email"]',
    '[data-e2e="email"]',
    'a[href^="mailto:"]'
  ])?.replace(/^mailto:/, '') || findEmailInDocument(scope)) ?? undefined;

  const jobTitle = pickFirstText(queryRoot, [
    '[data-testid="headline"]',
    '[data-testid="job-title"]',
    '.contact-card [data-e2e="headline"]'
  ]);

  const companyName = pickFirstText(queryRoot, [
    '[data-testid="company"]',
    '.contact-card [data-e2e="company"]',
    '[data-testid="current-employer"]'
  ]);

  const companyWebsite = pickFirstLink(queryRoot, [
    '[data-testid="company"] a',
    '.contact-card [data-e2e="company"] a'
  ]);

  const linkedinProfile = pickFirstLink(queryRoot, [
    'a[href*="linkedin.com/in/"]',
    'a[href*="linkedin.com/company/"]'
  ]);

  const socialProfiles: ScrapeResult['socialProfiles'] = linkedinProfile ? { linkedin: linkedinProfile } : {};

  const phoneNumbers = collectUniqueText(queryRoot, [
    '[data-testid="phone"]',
    '[data-e2e="phone"]'
  ]);

  const locations = collectUniqueText(queryRoot, [
    '[data-testid="location"]',
    '.contact-card [data-e2e="location"]'
  ]);

  const notes: string[] = [`Captured ContactOut data at ${timestamp()}`];
  if (targetLabel && name && targetLabel.toLowerCase() !== name.toLowerCase()) {
    notes.push(`Requested target "${targetLabel}" differs from captured name "${name}".`);
  }

  if (!name && !email) {
    throw new Error('No contact details detected on ContactOut page');
  }

  return {
    task: 'contactout-capture',
    signals: {
      emailVerified: Boolean(email),
      linkedinProfile: linkedinProfile ?? undefined,
      companyWebsite: companyWebsite ?? undefined
    },
    socialProfiles,
    companyInfo: {
      name: companyName ?? '',
      website: companyWebsite ?? ''
    },
    additionalData: {
      verifiedEmail: Boolean(email),
      jobTitle: jobTitle ?? undefined,
      locations: locations.length ? locations : undefined,
      phoneNumbers: phoneNumbers.length ? phoneNumbers : undefined,
      notes: notes.join('\n')
    },
    notes,
    fetchedAt: timestamp(),
    error: undefined
  } satisfies ScrapeResult;
}

export function pickFirstText(root: Document | Element, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const element = root.querySelector(selector);
    if (element) {
      const text = element.textContent?.trim();
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

export function pickFirstLink(root: Document | Element, selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const link = root.querySelector<HTMLAnchorElement>(selector);
    const href = link?.href?.trim();
    if (href) {
      return href;
    }
  }
  return undefined;
}

export function collectUniqueText(root: Document | Element, selectors: string[]): string[] {
  const values = new Set<string>();
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((node) => {
      const text = node.textContent?.trim();
      if (text) {
        values.add(text);
      }
    });
  }
  return Array.from(values);
}

export function findEmailInDocument(doc: Document): string | undefined {
  const emailRegex = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
  const bodyText = doc.body?.innerText ?? doc.body?.textContent ?? '';
  const match = bodyText.match(emailRegex);
  return match?.[0] ?? undefined;
}
