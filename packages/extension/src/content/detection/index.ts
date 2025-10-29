import type { DetectedContactSnapshot, ExtensionResponseMessage, RegisterDetectedContactsMessage } from '@venmail/shared';

import { throttle } from '../../shared/throttle';
import { safeSendMessage } from '../../shared/messaging';

// Enhanced regex patterns
const EMAIL_REGEX = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE_REGEX = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/g;

// Blacklist for common false positives
const EMAIL_BLACKLIST = new Set([
  'example@example.com',
  'test@test.com',
  'noreply@',
  'no-reply@',
  'donotreply@'
]);

const PHONE_BLACKLIST_PATTERNS = [
  /^0+$/,           // All zeros
  /^1{7,}$/,        // All ones
  /^1234567/,       // Sequential
  /^555-?1212$/,    // Fake directory assistance
  /^867-?5309$/     // Jenny's number
];

let detectionEnabled = false;
let lastSnapshot: DetectedContactSnapshot | null = null;

const dispatchDetection = throttle(() => {
  if (!detectionEnabled) {
    return;
  }

  const snapshot = collectSnapshot();
  
  // Only dispatch if snapshot has changed
  if (!hasSnapshotChanged(lastSnapshot, snapshot)) {
    return;
  }

  lastSnapshot = snapshot;

  const message: RegisterDetectedContactsMessage = {
    action: 'registerDetectedContacts',
    snapshot: {
      ...snapshot,
      source: 'auto'
    }
  };

  safeSendMessage(message);
}, 2000);

const observer = new MutationObserver((mutations) => {
  // Filter out irrelevant mutations
  const hasRelevantChanges = mutations.some(mutation => {
    if (mutation.type === 'characterData') {
      return true;
    }
    if (mutation.type === 'childList') {
      return mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0;
    }
    return false;
  });

  if (hasRelevantChanges) {
    dispatchDetection();
  }
});

function startObserving(): void {
  observer.observe(document.body ?? document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    // Optimize: ignore attributes and style changes
    attributes: false,
    attributeOldValue: false
  });
}

function initialize(): void {
  safeSendMessage({ action: 'getSettings' }, (response: ExtensionResponseMessage) => {
    if (chrome.runtime.lastError) {
      return;
    }

    if (response?.success && response.settings?.detection?.enabled) {
      enableDetection();
    }
  });
}

function enableDetection(): void {
  if (detectionEnabled) {
    return;
  }

  detectionEnabled = true;
  lastSnapshot = null;
  if (observer.takeRecords) {
    observer.takeRecords();
  }
  startObserving();
  dispatchDetection();
}

function disableDetection(): void {
  if (!detectionEnabled) {
    return;
  }

  detectionEnabled = false;
  lastSnapshot = null;
  observer.disconnect();
}

chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse): boolean | void => {
  if (!message || typeof message !== 'object') {
    return;
  }

  const payload = message as { 
    type?: string; 
    action?: string; 
    settings?: { detection?: { enabled?: boolean } } 
  };

  if (payload.type === 'venmail-settings-updated') {
    if (payload.settings?.detection?.enabled) {
      enableDetection();
    } else {
      disableDetection();
    }
  }

  if (payload.action === 'getSelectionContext') {
    const context = collectSelectionContext();
    sendResponse({ context });
    return true;
  }

  if (payload.action === 'getMapSummary') {
    const summary = collectMapSummary((payload as { query?: string }).query);
    sendResponse({ summary });
    return true;
  }

  if (payload.action === 'collectSerpHighlights') {
    const highlights = collectSerpHighlights((payload as { query?: string }).query);
    sendResponse({ highlights });
    return true;
  }
});

function hasSnapshotChanged(prev: DetectedContactSnapshot | null, next: DetectedContactSnapshot): boolean {
  if (!prev) {
    return true;
  }

  if (prev.url !== next.url) {
    return true;
  }

  if (prev.contacts.length !== next.contacts.length) {
    return true;
  }

  const prevSet = new Set(prev.contacts.map(c => `${c.type}:${c.value}`));
  const nextSet = new Set(next.contacts.map(c => `${c.type}:${c.value}`));

  if (prevSet.size !== nextSet.size) {
    return true;
  }

  for (const key of nextSet) {
    if (!prevSet.has(key)) {
      return true;
    }
  }

  return false;
}

function collectSelectionContext(): SelectionContext | undefined {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0) {
    return undefined;
  }

  const selectedText = selection.toString().trim();
  if (!selectedText) {
    return undefined;
  }

  const range = selection.getRangeAt(0).cloneRange();
  const surroundingText = extractSurroundingText(range);

  const emails = extractAndValidateEmails(selectedText);
  const phones = extractAndValidatePhones(selectedText);
  const signatureBlock = detectSignatureBlock(surroundingText ?? selectedText);
  const keyPhrases = extractKeyPhrases(surroundingText ?? selectedText, selectedText);

  return {
    text: selectedText,
    surroundingText,
    keyPhrases: keyPhrases.length ? keyPhrases.slice(0, 10) : undefined,
    emails: emails.length ? emails : undefined,
    phones: phones.length ? phones : undefined,
    signatureBlock: signatureBlock ?? undefined
  } satisfies SelectionContext;
}

function extractSurroundingText(range: Range): string | undefined {
  const contextRange = range.cloneRange();
  const contextNode = contextRange.commonAncestorContainer;

  if (contextNode && contextNode instanceof HTMLElement) {
    const text = contextNode.innerText?.trim();
    if (text) {
      return truncateText(text, 600);
    }
  }

  const fragment = contextRange.cloneContents();
  const temp = document.createElement('div');
  temp.append(fragment);
  const fallback = temp.innerText.trim();
  return fallback ? truncateText(fallback, 600) : undefined;
}

function extractAndValidateEmails(source: string): string[] {
  const matches = matchRegex(source, EMAIL_REGEX);
  const validated: string[] = [];

  for (const email of matches) {
    const normalized = email.toLowerCase().trim();
    
    // Skip blacklisted emails
    if (EMAIL_BLACKLIST.has(normalized)) {
      continue;
    }

    // Skip common false positives
    if (normalized.includes('noreply') || normalized.includes('no-reply')) {
      continue;
    }

    // Validate email structure more strictly
    if (!isValidEmail(normalized)) {
      continue;
    }

    validated.push(normalized);
  }

  return Array.from(new Set(validated));
}

function isValidEmail(email: string): boolean {
  // More strict validation
  const parts = email.split('@');
  if (parts.length !== 2) {
    return false;
  }

  const [local, domain] = parts;
  
  // Local part checks
  if (!local || local.length > 64) {
    return false;
  }

  // Domain checks
  if (!domain || domain.length > 255) {
    return false;
  }

  const domainParts = domain.split('.');
  if (domainParts.length < 2) {
    return false;
  }

  // TLD must be at least 2 characters
  const tld = domainParts[domainParts.length - 1];
  if (!tld || tld.length < 2) {
    return false;
  }

  return true;
}

function extractAndValidatePhones(source: string): string[] {
  const matches = matchRegex(source, PHONE_REGEX);
  const validated: string[] = [];

  for (const phone of matches) {
    const sanitized = sanitizePhone(phone);
    if (!sanitized) {
      continue;
    }

    // Check against blacklist patterns
    const digitsOnly = sanitized.replace(/\D/g, '');
    const isBlacklisted = PHONE_BLACKLIST_PATTERNS.some(pattern => pattern.test(digitsOnly));
    
    if (isBlacklisted) {
      continue;
    }

    validated.push(sanitized);
  }

  return Array.from(new Set(validated));
}

function matchRegex(source: string, regex: RegExp): string[] {
  const clone = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : `${regex.flags}g`);
  const matches: string[] = [];
  let result: RegExpExecArray | null;
  
  while ((result = clone.exec(source)) !== null) {
    if (result[0]) {
      matches.push(result[0]);
    }
  }
  
  return matches;
}

function detectSignatureBlock(text: string): string | null {
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const signatureHints = [
    'best regards',
    'kind regards', 
    'regards',
    'cheers',
    'sincerely',
    'thanks,',
    'thank you',
    'best,',
    'warmly',
    'respectfully'
  ];
  
  const startIndex = lines.findIndex((line) => 
    signatureHints.some((hint) => line.toLowerCase().startsWith(hint))
  );

  if (startIndex === -1) {
    return null;
  }

  const block = lines.slice(startIndex, startIndex + 6).join('\n');
  return block.length ? block : null;
}

function extractKeyPhrases(contextText: string, selectedText: string): string[] {
  const tokens = contextText
    .replace(/[^a-zA-Z0-9\s@\.\-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 3 && /[A-Z]/.test(token));

  const selectedTokens = selectedText.split(/\s+/).map((value) => value.trim());

  const phrases = new Set([...tokens, ...selectedTokens]);
  return Array.from(phrases).slice(0, 12);
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}…`;
}

type SelectionContext = import('@venmail/shared').SelectionContext;
type SearchResultHighlight = import('@venmail/shared').SearchResultHighlight;
type MapReputationSummary = import('@venmail/shared').MapReputationSummary;

function collectSerpHighlights(_query?: string): SearchResultHighlight[] {
  try {
    if (isGoogleSerp()) {
      return collectEngineHighlights(findGoogleRoot(), 'google');
    }

    if (isBingSerp()) {
      return collectEngineHighlights(findBingRoot(), 'bing');
    }
  } catch (error) {
    console.warn('[venmail] Failed to collect SERP highlights', error);
  }

  return [];
}

function isGoogleSerp(): boolean {
  const { hostname, pathname } = window.location;
  return /google\./i.test(hostname) && pathname.startsWith('/search');
}

function isBingSerp(): boolean {
  const { hostname, pathname } = window.location;
  return hostname.endsWith('bing.com') && pathname.startsWith('/search');
}

function findGoogleRoot(): Element {
  return (
    document.querySelector('#rso') ||
    document.querySelector('#search') ||
    document.querySelector('div[role="main"]') ||
    document.body
  );
}

function findBingRoot(): Element {
  return document.querySelector('#b_results') || document.querySelector('main') || document.body;
}

function collectEngineHighlights(root: Element, engine: 'google' | 'bing'): SearchResultHighlight[] {
  const anchors = Array.from(root.querySelectorAll('a[href]')) as HTMLAnchorElement[];
  const results: SearchResultHighlight[] = [];
  const seen = new Set<string>();

  for (const anchor of anchors) {
    if (!isEligibleResultAnchor(anchor, engine, root)) {
      continue;
    }

    const url = normalizeSerpUrl(anchor.href, engine);
    if (!url || seen.has(url)) {
      continue;
    }

    const title = extractAnchorTitle(anchor);
    if (!title) {
      continue;
    }

    const block = findResultBlock(anchor, root);
    const snippet = block ? extractBlockSnippet(block, title) : undefined;

    results.push({
      title,
      url,
      snippet,
      score: 0,
      source: `${engine}-dom`
    });

    seen.add(url);

    if (results.length >= 20) {
      break;
    }
  }

  return results;
}

function isEligibleResultAnchor(anchor: HTMLAnchorElement, engine: 'google' | 'bing', boundary: Element): boolean {
  const href = anchor.getAttribute('href');
  if (!href) {
    return false;
  }

  if (anchor.closest('header, nav, footer, aside')) {
    return false;
  }

  const heading = anchor.querySelector('h1, h2, h3, h4') || anchor.closest('h1, h2, h3, h4');
  if (!heading) {
    return false;
  }

  const title = extractAnchorTitle(anchor);
  if (!title || title.length < 5) {
    return false;
  }

  const url = normalizeSerpUrl(anchor.href, engine);
  if (!url) {
    return false;
  }

  if (!boundary.contains(anchor)) {
    return false;
  }

  return true;
}

function extractAnchorTitle(anchor: HTMLAnchorElement): string | null {
  const heading = anchor.querySelector('h1, h2, h3, h4') || anchor.closest('h1, h2, h3, h4');
  const raw = heading?.textContent ?? anchor.textContent ?? '';
  const title = collapseWhitespace(raw);
  return title.length ? title : null;
}

function findResultBlock(anchor: HTMLAnchorElement, root: Element): Element | null {
  const candidates: (HTMLElement | null)[] = [
    anchor.closest('[data-hveid]'),
    anchor.closest('[data-sok]'),
    anchor.closest('div[role="article"]'),
    anchor.closest('li'),
    anchor.closest('article'),
    anchor.closest('div')
  ];

  for (const candidate of candidates) {
    if (!candidate || candidate === document.body || !root.contains(candidate)) {
      continue;
    }

    if (candidate.querySelectorAll('a[href^="http"]').length > 12) {
      continue;
    }

    if (candidate.innerText.trim().length < 10) {
      continue;
    }

    return candidate;
  }

  let current: HTMLElement | null = anchor.parentElement;
  while (current && current !== root && current !== document.body) {
    const siblings = Array.from(current.parentElement?.children ?? []).filter((sibling) => sibling !== current) as HTMLElement[];
    const hasSiblingResults = siblings.some((sibling) => sibling.querySelector('h3, h2'));
    if (hasSiblingResults) {
      return current;
    }
    current = current.parentElement;
  }

  return anchor.parentElement;
}

function extractBlockSnippet(block: Element, title: string): string | undefined {
  const textSource = block instanceof HTMLElement ? block.innerText : block.textContent ?? '';
  const textSegments = textSource
    .split('\n')
    .map((segment: string) => collapseWhitespace(segment))
    .filter((segment: string) => segment && segment !== title && segment.length >= 25);

  for (const segment of textSegments) {
    if (segment.length <= 320 && !segment.toLowerCase().startsWith('cached') && !segment.toLowerCase().startsWith('translate')) {
      return segment;
    }
  }

  return textSegments[0];
}

function normalizeSerpUrl(raw: string, engine: 'google' | 'bing', depth = 0): string | null {
  if (depth > 2) {
    return null;
  }

  try {
    const url = new URL(raw, window.location.origin);

    if (engine === 'google' && /google\./i.test(url.hostname)) {
      if (url.pathname === '/url') {
        const target = url.searchParams.get('q') || url.searchParams.get('url');
        if (target && target !== raw) {
          return normalizeSerpUrl(target, engine, depth + 1);
        }
      }

      if (url.hostname.endsWith('google.com') || url.hostname.endsWith('googleapis.com')) {
        return null;
      }
    }

    if (engine === 'bing' && url.hostname.endsWith('bing.com')) {
      const encoded = url.searchParams.get('u');
      if (encoded) {
        const decoded = decodeURIComponent(encoded);
        if (decoded.startsWith('http')) {
          return normalizeSerpUrl(decoded, engine, depth + 1);
        }
        try {
          const base64 = atob(decoded.replace(/-/g, '+').replace(/_/g, '/'));
          if (base64.startsWith('http')) {
            return normalizeSerpUrl(base64, engine, depth + 1);
          }
        } catch (error) {
          console.debug('[venmail] Bing redirect decode failed', error);
        }
      }

      return null;
    }

    const paramsToStrip = ['ved', 'usg', 'ei', 'sa', 'source', 'cd', 'rct', 'cad', 'uact', 'aqs', 'sourceid', 'sxsrf', 'vqd'];
    paramsToStrip.forEach((param) => url.searchParams.delete(param));

    return url.toString();
  } catch {
    return null;
  }
}

function collapseWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function collectMapSummary(_query?: string): MapReputationSummary | null {
  const { hostname, pathname } = window.location;
  if (!hostname.includes('google') || !pathname.includes('/maps')) {
    return null;
  }

  const summary: MapReputationSummary = {
    sourceUrl: window.location.href
  };

  summary.name = extractText([
    'h1[class*="fontHeadlineLarge"]',
    'h1[role="presentation"]'
  ]) ?? undefined;

  summary.categories = extractList(
    Array.from(document.querySelectorAll('button[aria-label*="Category" i], div[aria-label*="Category" i]'))
      .map((node) => node.textContent ?? '')
      .filter(Boolean)
  );

  const ratingLabel = findAriaLabel(['div[aria-label*="stars"]', 'span[aria-label*="stars"]']);
  const ratingMatch = ratingLabel?.match(/([0-9,.]+)\s+stars/i);
  const metaRating = parseFloatSafe(document.querySelector('meta[itemprop="ratingValue"]')?.getAttribute('content'));
  summary.rating = metaRating ?? (ratingMatch ? parseFloatSafe(ratingMatch[1]) : undefined);

  const reviewLabel = findTextContent(['button', 'span'], /reviews?/i);
  const reviewMatch = reviewLabel?.replace(/[,()]/g, '').match(/([0-9,.]+)\s+reviews?/i);
  const metaReviews = parseIntSafe(document.querySelector('meta[itemprop="ratingCount"]')?.getAttribute('content'));
  summary.reviewCount = metaReviews ?? (reviewMatch ? parseIntSafe(reviewMatch[1]) : undefined);

  summary.address = extractText([
    'button[data-item-id*="address"] div',
    'div[aria-label*="Address" i] span:not([class])'
  ]) ?? undefined;

  summary.phone = extractText([
    'button[data-item-id*="phone"] div',
    'div[aria-label*="Phone" i] span'
  ]) ?? undefined;

  const website = extractHref([
    'a[data-item-id*="authority"]',
    'a[aria-label*="Website" i]'
  ]);
  summary.website = website ?? undefined;

  summary.statusText = extractText([
    'span[aria-label*="closed" i]',
    'span[aria-label*="Temporarily closed" i]',
    'div[aria-label*="Temporarily closed" i]'
  ]) ?? undefined;

  if (!summary.name && !summary.rating && !summary.reviewCount) {
    return null;
  }

  return summary;
}

function extractText(selectors: string[]): string | null {
  for (const selector of selectors) {
    const node = document.querySelector(selector);
    const text = node?.textContent?.trim();
    if (text) {
      return text;
    }
  }
  return null;
}

function extractHref(selectors: string[]): string | null {
  for (const selector of selectors) {
    const link = document.querySelector<HTMLAnchorElement>(selector);
    const href = link?.href?.trim();
    if (href) {
      return href;
    }
  }
  return null;
}

function parseFloatSafe(value?: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseFloat(value.replace(/,/g, '.'));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseIntSafe(value?: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const parsed = Number.parseInt(value.replace(/,/g, ''), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractList(values: string[]): string[] | undefined {
  const unique = Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
  return unique.length ? unique : undefined;
}

function findAriaLabel(selectors: string[]): string | undefined {
  for (const selector of selectors) {
    const node = document.querySelector<HTMLElement>(selector);
    const label = node?.getAttribute('aria-label');
    if (label) {
      return label;
    }
  }
  return undefined;
}

function findTextContent(selectors: string[], pattern: RegExp): string | undefined {
  for (const selector of selectors) {
    const nodes = document.querySelectorAll<HTMLElement>(selector);
    for (const node of Array.from(nodes)) {
      const text = node.textContent?.trim();
      if (text && pattern.test(text)) {
        return text;
      }
    }
  }
  return undefined;
}

initialize();

function collectSnapshot(): DetectedContactSnapshot {
  const contacts = new Map<string, { type: 'email' | 'phone'; context?: string }>();
  const processedNodes = new Set<Node>();

  // Use a more efficient approach: collect all text nodes first
  const textNodes: Node[] = [];
  const walker = document.createTreeWalker(
    document.body ?? document.documentElement, 
    NodeFilter.SHOW_TEXT,
    {
      acceptNode: (node) => {
        // Skip script, style, and hidden elements
        if (node.parentElement) {
          const style = window.getComputedStyle(node.parentElement);
          if (style.display === 'none' || style.visibility === 'hidden') {
            return NodeFilter.FILTER_REJECT;
          }
          
          const tag = node.parentElement.tagName.toUpperCase();
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') {
            return NodeFilter.FILTER_REJECT;
          }
        }
        
        return NodeFilter.FILTER_ACCEPT;
      }
    }
  );

  let node: Node | null = walker.nextNode();
  while (node) {
    textNodes.push(node);
    node = walker.nextNode();
  }

  // Process text nodes in batches
  for (const textNode of textNodes) {
    if (processedNodes.has(textNode)) {
      continue;
    }
    processedNodes.add(textNode);

    const text = textNode.textContent ?? '';
    if (!text || text.trim().length === 0) {
      continue;
    }

    // Extract emails
    const emailMatches = extractAndValidateEmails(text);
    for (const email of emailMatches) {
      if (!contacts.has(email)) {
        contacts.set(email, { 
          type: 'email', 
          context: extractContext(textNode) 
        });
      }
    }

    // Extract phones
    const phoneMatches = extractAndValidatePhones(text);
    for (const phone of phoneMatches) {
      if (!contacts.has(phone)) {
        contacts.set(phone, { 
          type: 'phone', 
          context: extractContext(textNode) 
        });
      }
    }

    // Limit total contacts to prevent performance issues
    if (contacts.size >= 50) {
      break;
    }
  }

  return {
    contacts: Array.from(contacts.entries()).map(([value, meta]) => ({
      type: meta.type,
      value,
      context: meta.context
    })),
    url: window.location.href,
    title: document.title,
    collectedAt: new Date().toISOString()
  } satisfies DetectedContactSnapshot;
}

function extractContext(node: Node): string | undefined {
  let parent = node.parentNode;
  let depth = 0;

  while (parent && depth < 4) {
    if (parent instanceof HTMLElement) {
      const ariaLabel = parent.getAttribute('aria-label');
      if (ariaLabel && ariaLabel.length <= 200) {
        return ariaLabel;
      }

      const text = parent.innerText?.trim();
      if (text && text.length > 10 && text.length <= 200) {
        return text;
      }
    }

    parent = parent.parentNode;
    depth += 1;
  }

  return undefined;
}

function sanitizePhone(raw: string): string | null {
  const digits = raw.replace(/[^0-9+]/g, '');
  
  // Must have at least 7 digits
  if (digits.replace(/\+/g, '').length < 7) {
    return null;
  }

  // Max reasonable length (international format)
  if (digits.length > 15) {
    return null;
  }

  return digits.startsWith('+') ? digits : normalizeLocalPhone(digits);
}

function normalizeLocalPhone(value: string): string {
  // US/Canada number
  if (value.length === 10) {
    return `+1${value}`;
  }

  // Already has country code
  if (value.length >= 11) {
    return `+${value}`;
  }

  return `+${value}`;
}
