import type { ScrapeExecutionContext } from '@venmail/shared';

import { registerScrapeTask, type ScrapeTaskOutput } from '../taskMap';

const GOOGLE_SEARCH_BASE = 'https://www.google.com/search?q=';
const VENMAIL_LOOKUP_BASE = 'https://api.venmail.io/lookup/';
const CONTACTOUT_HINT = 'ContactOut';

const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

registerScrapeTask('venmail-lookup', {
  async run(context: ScrapeExecutionContext): Promise<ScrapeTaskOutput> {
    const { cachedResult, lookup, signal, settings } = context;

    if (cachedResult?.payload) {
      return cachedResult.payload;
    }

    const notes: string[] = [];

    const contactOutQuery = buildContactOutQuery(lookup);
    if (contactOutQuery) {
      const googleResult = await searchContactOut(contactOutQuery, signal).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        notes.push(`ContactOut search failed: ${message}`);
        return null;
      });

      if (googleResult?.emails.length) {
        const deduped = dedupeEmails(googleResult.emails);
        notes.push(`ContactOut search produced ${deduped.length} email candidate(s).`);
        if (googleResult.sources.length) {
          notes.push(`Sources inspected: ${googleResult.sources.slice(0, 3).join(', ')}`);
        }

        return buildResult({
          emails: deduped,
          notes,
          verified: true
        });
      }

      if (googleResult?.notes.length) {
        notes.push(...googleResult.notes);
      }
    } else {
      notes.push('ContactOut search skipped – insufficient name/company context.');
    }

    const venmailKey = settings.fallbacks?.venmail?.apiKey?.trim();
    if (!venmailKey) {
      notes.push('Venmail API key not configured – skipping Venmail lookup.');
      return buildResult({ emails: [], notes, verified: false });
    }

    const venmailQuery = buildVenmailQuery(lookup);
    if (!venmailQuery) {
      notes.push('Unable to derive Venmail lookup query – provide a name or company.');
      return buildResult({ emails: [], notes, verified: false });
    }

    const venmailResult = await callVenmailApi({
      apiKey: venmailKey,
      query: venmailQuery,
      lookup,
      settings,
      signal
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      notes.push(`Venmail API request failed: ${message}`);
      return null;
    });

    if (venmailResult?.email) {
      notes.push(venmailResult.notes ?? 'Venmail API returned an email match.');
      return buildResult({
        emails: [venmailResult.email],
        notes,
        verified: true,
        source: 'venmail-api'
      });
    }

    notes.push(venmailResult?.notes ?? 'Venmail lookup did not return an email match.');
    return buildResult({ emails: [], notes, verified: false });
  }
});

async function searchContactOut(query: string, signal: AbortSignal) {
  const url = `${GOOGLE_SEARCH_BASE}${encodeURIComponent(query)}`;
  const response = await fetch(url, {
    method: 'GET',
    signal,
    headers: {
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
    }
  });

  if (!response.ok) {
    return {
      emails: [],
      notes: [`ContactOut search returned HTTP ${response.status}`],
      sources: [] as string[]
    };
  }

  const html = await response.text();
  const emails = Array.from(html.matchAll(EMAIL_REGEX)).map((match) => match[0]);

  const urlMatches = Array.from(html.matchAll(/https?:\/\/[\w./%-]+/gi)).map((match) => match[0]);
  return {
    emails,
    notes: emails.length ? [] : ['No email found in ContactOut search results.'],
    sources: urlMatches.slice(0, 5)
  };
}

function buildContactOutQuery(lookup: ScrapeExecutionContext['lookup']): string | null {
  const terms = [lookup.name, lookup.company]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(' ');

  if (!terms) {
    return null;
  }

  return `${terms} ${CONTACTOUT_HINT}`;
}

function buildVenmailQuery(lookup: ScrapeExecutionContext['lookup']): string | null {
  const parts = [lookup.name, lookup.company, lookup.domain]
    .map((value) => value?.trim())
    .filter(Boolean);

  if (!parts.length) {
    return null;
  }

  return parts.join(' ');
}

async function callVenmailApi(params: {
  apiKey: string;
  query: string;
  lookup: ScrapeExecutionContext['lookup'];
  settings: ScrapeExecutionContext['settings'];
  signal: AbortSignal;
}): Promise<{ email?: string; notes?: string } | null> {
  const { apiKey, query, lookup, settings, signal } = params;
  const baseUrl = settings.apiBaseUrl ? settings.apiBaseUrl.replace(/\/$/, '') : null;

  const url = baseUrl
    ? `${baseUrl}/api/venmail/lookup`
    : `${VENMAIL_LOOKUP_BASE}${encodeURIComponent(query)}`;

  const requestInit: RequestInit = {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      query,
      name: lookup.name,
      domain: lookup.domain,
      company: lookup.company
    })
  };

  const response = await fetch(url, requestInit);

  if (!response.ok) {
    const payload = await safeReadJson(response);
    return {
      notes: `Venmail API responded with ${response.status}: ${payload?.error ?? 'request failed'}`
    };
  }

  const payload = await safeReadJson(response);
  if (!payload) {
    return { notes: 'Venmail API returned an empty response.' };
  }

  if (payload.found && typeof payload.email === 'string') {
    return {
      email: payload.email,
      notes: payload.notes ?? 'Venmail confirmed an email match.'
    };
  }

  return {
    notes: payload.notes ?? 'Venmail lookup completed without an email match.'
  };
}

async function safeReadJson(response: Response): Promise<any | null> {
  try {
    const text = await response.text();
    if (!text) {
      return null;
    }
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function buildResult(params: {
  emails: string[];
  notes: string[];
  verified: boolean;
  source?: string;
}): ScrapeTaskOutput {
  const { emails, notes, verified, source } = params;
  const uniqueEmails = dedupeEmails(emails);

  return {
    signals: {
      emailVerified: verified && uniqueEmails.length > 0 ? true : undefined
    },
    additionalData: {
      verifiedEmail: verified && uniqueEmails.length > 0,
      emailAddresses: uniqueEmails.length ? uniqueEmails : undefined,
      notes: notes.join('\n'),
      searchHighlights: undefined,
      trustedSources: source ? [source] : undefined
    },
    notes,
    fetchedAt: new Date().toISOString()
  } satisfies ScrapeTaskOutput;
}

function dedupeEmails(emails: string[]): string[] {
  return Array.from(new Set(emails.map((email) => email.trim().toLowerCase()).filter(Boolean))).slice(0, 5);
}
