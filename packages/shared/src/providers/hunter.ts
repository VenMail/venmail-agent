import type { ScrapeResult } from '../types';

export interface HunterApiSource {
  domain?: string;
  uri?: string;
  extracted_on?: string;
  last_seen_on?: string;
}

export interface HunterApiData {
  email?: string;
  result?: 'deliverable' | 'undeliverable' | 'risky' | 'unknown';
  score?: number;
  status?: 'valid' | 'invalid' | 'accept_all' | 'disposable' | 'webmail';
  regexp?: boolean;
  mx_records?: boolean;
  smtp_server?: boolean;
  smtp_check?: boolean;
  disposable?: boolean;
  webmail?: boolean;
  accept_all?: boolean;
  block?: boolean;
  sources?: HunterApiSource[];
}

export interface HunterApiErrorItem {
  key: string;
  value: string;
}

export interface HunterApiResponse {
  data?: HunterApiData;
  errors?: HunterApiErrorItem[];
}

export function mapHunterResponseToScrapeResult(
  payload: HunterApiResponse
): Omit<ScrapeResult, 'task'> | null {
  if (!payload.data) {
    return null;
  }

  const { data } = payload;
  const sources = data.sources ?? [];
  const baseNotes = buildHunterNotes(data);
  let notes = baseNotes;

  const result: Omit<ScrapeResult, 'task'> = {
    signals: {
      emailVerified: data.status === 'valid' || data.result === 'deliverable',
      spamReportsFound: data.status === 'disposable' || data.status === 'invalid',
      socialProfiles: undefined
    },
    additionalData: {
      verifiedEmail: data.status === 'valid' || data.result === 'deliverable',
      notes: `Hunter.io score ${data.score ?? 'n/a'} (${data.result ?? 'unknown'})`
    },
    notes,
    companyInfo: undefined,
    socialProfiles: {}
  };

  if (sources.length > 0) {
    notes = [...notes, `Sources found: ${sources.length}`];
    result.notes = notes;
  }

  return result;
}

export function buildHunterNotes(data: HunterApiData): string[] {
  const notes: string[] = [];

  if (typeof data.score === 'number') {
    notes.push(`Confidence score: ${data.score}`);
  }

  if (data.status) {
    notes.push(`Status: ${data.status}`);
  }

  if (data.result) {
    notes.push(`Result: ${data.result}`);
  }

  if (data.accept_all) {
    notes.push('Domain is accept-all.');
  }

  if (data.disposable) {
    notes.push('Disposable email address detected.');
  }

  return notes;
}

export function buildHunterFallbackError(message: string, detail?: string): Omit<ScrapeResult, 'task'> {
  const notes = detail ? [message, detail] : [message];

  return {
    signals: {},
    socialProfiles: {},
    companyInfo: undefined,
    additionalData: {
      verifiedEmail: false,
      notes: message
    },
    notes,
    error: 'provider_error',
    fetchedAt: new Date().toISOString()
  };
}
