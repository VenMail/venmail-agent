/**
 * Shared utilities for extracting and validating emails and phone numbers
 * Consolidates logic from serpScan, contactPage, and venmailLookup
 */

// Enhanced email regex with better Unicode support and stricter validation
const EMAIL_REGEX = /\b[a-z0-9][a-z0-9._%+\-]{0,63}@[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9\-]{0,61}[a-z0-9])?)*\.[a-z]{2,}\b/gi;

// Enhanced phone regex with better international format support
const PHONE_REGEX = /(?:\+?\d{1,3}[-.\s]?)?(?:\(?\d{1,4}\)?[-.\s]?)?\d{1,4}[-.\s]?\d{1,4}[-.\s]?\d{1,9}\b/g;

const EMAIL_BLACKLIST_PREFIXES = [
  'noreply', 'no-reply', 'donotreply', 'do-not-reply',
  'bounce', 'mailer-daemon', 'postmaster',
  'example', 'test', 'sample', 'demo',
  'webmaster', 'hostmaster', 'abuse'
];

const GENERIC_EMAIL_PREFIXES = [
  'info', 'contact', 'support', 'help', 'sales',
  'admin', 'service', 'hello', 'hi', 'team'
];

const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'guerrillamail.com', 'temp-mail.org',
  '10minutemail.com', 'throwaway.email', 'tempmail.com',
  'trashmail.com', 'getnada.com', 'maildrop.cc'
];

const PHONE_BLACKLIST_PATTERNS = [
  /^0+$/,
  /^1{7,}$/,
  /^(\d)\1{6,}$/,
  /^1234567/,
  /^555-?1212$/,
  /^867-?5309$/,
  /^(123|000|999)-?456-?7890$/
];

export interface ExtractionContext {
  name?: string;
  company?: string;
  domain?: string;
}

export interface ScoredContact {
  value: string;
  score: number;
  reason?: string;
}

/**
 * Strips HTML tags and extracts visible text content
 */
function extractVisibleText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, ' ')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, ' ')
    .replace(/<head\b[^<]*(?:(?!<\/head>)<[^<]*)*<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decodes common email obfuscation patterns
 */
function decodeObfuscatedEmail(text: string): string {
  return text
    .replace(/\[at\]/gi, '@')
    .replace(/\(at\)/gi, '@')
    .replace(/\s*at\s*/gi, '@')
    .replace(/\[dot\]/gi, '.')
    .replace(/\(dot\)/gi, '.')
    .replace(/\s+/g, '');
}

/**
 * Validates email structure and filters out invalid/unwanted emails
 */
export function isValidEmail(email: string): boolean {
  const parts = email.split('@');
  if (parts.length !== 2) return false;
  
  const [local, domain] = parts;
  
  if (!local || local.length > 64 || !domain || domain.length > 255) return false;
  
  const localLower = local.toLowerCase();
  if (EMAIL_BLACKLIST_PREFIXES.some(prefix => localLower.startsWith(prefix))) return false;
  
  if (DISPOSABLE_DOMAINS.includes(domain.toLowerCase())) return false;
  
  const domainParts = domain.split('.');
  if (domainParts.length < 2) return false;
  
  const tld = domainParts[domainParts.length - 1];
  if (!tld || tld.length < 2 || tld.length > 24) return false;
  
  if (email.includes('..') || local.startsWith('.') || local.endsWith('.')) return false;
  
  if (!/^[a-z0-9._%+\-]+$/i.test(local)) return false;
  
  return true;
}

/**
 * Checks if email is generic (lower priority)
 */
export function isGenericEmail(email: string): boolean {
  const localPart = email.split('@')[0]?.toLowerCase() || '';
  return GENERIC_EMAIL_PREFIXES.some(prefix => localPart === prefix || localPart.startsWith(`${prefix}.`));
}

/**
 * Extracts emails from text with HTML awareness
 */
export function extractEmails(text: string, isHtml = false): string[] {
  if (!text) return [];
  
  const searchText = isHtml ? extractVisibleText(text) : text;
  const decodedText = decodeObfuscatedEmail(searchText);
  
  const matches = Array.from(decodedText.matchAll(EMAIL_REGEX)).map((match) => match[0].toLowerCase());
  
  const validated: string[] = [];
  for (const email of matches) {
    if (!isValidEmail(email)) continue;
    validated.push(email);
  }
  
  return Array.from(new Set(validated));
}

/**
 * Extracts and scores emails based on context relevance
 */
export function extractEmailsWithScoring(
  text: string,
  context?: ExtractionContext,
  isHtml = false
): ScoredContact[] {
  const emails = extractEmails(text, isHtml);
  
  return emails.map(email => {
    let score = 50;
    const reasons: string[] = [];
    
    if (context?.domain) {
      const emailDomain = email.split('@')[1]?.toLowerCase();
      const contextDomain = context.domain.replace(/^https?:\/\//, '').replace(/^www\./, '').toLowerCase();
      
      if (emailDomain === contextDomain || emailDomain?.endsWith(`.${contextDomain}`)) {
        score += 30;
        reasons.push('domain-match');
      }
    }
    
    if (context?.name) {
      const nameParts = context.name.toLowerCase().split(/\s+/);
      const emailLocal = email.split('@')[0]?.toLowerCase() || '';
      
      if (nameParts.some(part => part.length > 2 && emailLocal.includes(part))) {
        score += 20;
        reasons.push('name-match');
      }
    }
    
    if (isGenericEmail(email)) {
      score -= 15;
      reasons.push('generic');
    }
    
    const tld = email.split('.').pop()?.toLowerCase();
    if (tld === 'edu' || tld === 'gov') {
      score += 10;
      reasons.push('trusted-tld');
    }
    
    return {
      value: email,
      score: Math.max(0, Math.min(100, score)),
      reason: reasons.length ? reasons.join(',') : undefined
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Validates phone number structure
 */
function isValidPhoneStructure(phone: string): boolean {
  const digitsOnly = phone.replace(/\D/g, '');
  
  if (digitsOnly.length < 7 || digitsOnly.length > 15) return false;
  
  if (PHONE_BLACKLIST_PATTERNS.some(pattern => pattern.test(digitsOnly))) return false;
  
  if (/^(\d)\1+$/.test(digitsOnly)) return false;
  
  return true;
}

/**
 * Sanitizes and formats phone number
 */
export function sanitizePhone(raw: string): string | null {
  const cleaned = raw.replace(/[^0-9+]/g, '');
  const digitCount = cleaned.replace(/\+/g, '').length;
  
  if (digitCount < 7 || digitCount > 15) return null;
  
  if (cleaned.startsWith('+')) {
    return cleaned;
  }
  
  if (digitCount === 10) {
    return `+1${cleaned}`;
  }
  
  if (digitCount >= 11) {
    return `+${cleaned}`;
  }
  
  return `+${cleaned}`;
}

/**
 * Extracts phone numbers from text with HTML awareness
 */
export function extractPhones(text: string, isHtml = false): string[] {
  if (!text) return [];
  
  const searchText = isHtml ? extractVisibleText(text) : text;
  
  const matches = Array.from(searchText.matchAll(PHONE_REGEX)).map((match) => match[0].trim());
  
  const validated: string[] = [];
  for (const phone of matches) {
    if (!isValidPhoneStructure(phone)) continue;
    
    const sanitized = sanitizePhone(phone);
    if (!sanitized) continue;
    
    validated.push(sanitized);
  }
  
  return Array.from(new Set(validated));
}

/**
 * Extracts and scores phones based on context
 */
export function extractPhonesWithScoring(
  text: string,
  context?: ExtractionContext,
  isHtml = false
): ScoredContact[] {
  const phones = extractPhones(text, isHtml);
  
  return phones.map(phone => {
    let score = 50;
    const reasons: string[] = [];
    
    const digitsOnly = phone.replace(/\D/g, '');
    
    if (digitsOnly.length >= 10 && digitsOnly.length <= 11) {
      score += 10;
      reasons.push('standard-length');
    }
    
    if (phone.startsWith('+')) {
      score += 5;
      reasons.push('international-format');
    }
    
    if (digitsOnly.length === 10 || (digitsOnly.length === 11 && digitsOnly.startsWith('1'))) {
      score += 10;
      reasons.push('us-format');
    }
    
    return {
      value: phone,
      score: Math.max(0, Math.min(100, score)),
      reason: reasons.length ? reasons.join(',') : undefined
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Deduplicates and limits contact list
 */
export function dedupeContacts(contacts: string[], limit = 10): string[] {
  if (!contacts?.length) return [];
  
  const normalized = contacts
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => value.replace(/\s{2,}/g, ' '));
  
  const unique = Array.from(new Map(normalized.map((value) => [value.toLowerCase(), value])).values());
  
  return unique.slice(0, limit);
}

/**
 * Extracts both emails and phones from HTML with context awareness
 */
export function extractContactsFromHtml(
  html: string,
  context?: ExtractionContext
): {
  emails: ScoredContact[];
  phones: ScoredContact[];
} {
  const emails = extractEmailsWithScoring(html, context, true);
  const phones = extractPhonesWithScoring(html, context, true);
  
  return { emails, phones };
}
