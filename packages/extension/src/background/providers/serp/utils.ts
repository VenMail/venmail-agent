import type { SearchResultHighlight } from '@venmail/shared';

export function sanitizeSnippet(text: string): string {
  return text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

export function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2)
  );
}

export function computeRelevanceScore(queryTerms: Set<string>, title?: string, snippet?: string): number {
  const tokens = new Set<string>();

  if (title) {
    tokenize(title).forEach((token) => tokens.add(token));
  }

  if (snippet) {
    tokenize(snippet).forEach((token) => tokens.add(token));
  }

  if (!queryTerms.size || !tokens.size) {
    return 0;
  }

  let overlap = 0;
  for (const token of tokens) {
    if (queryTerms.has(token)) {
      overlap += 1;
    }
  }

  const ratio = Math.min(1, overlap / queryTerms.size);
  const baseScore = ratio * 70;
  const titleBonus = Math.min(30, (title?.length ?? 0) / 4);

  return Math.round(baseScore + titleBonus);
}

export function dedupeByUrl(items: SearchResultHighlight[]): SearchResultHighlight[] {
  const seen = new Set<string>();
  const output: SearchResultHighlight[] = [];

  for (const item of items) {
    const key = item.url.split('#')[0]?.toLowerCase();
    if (key && !seen.has(key)) {
      seen.add(key);
      output.push(item);
    }
  }

  return output;
}
