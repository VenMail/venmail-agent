// Context-aware scoring system for prioritizing extracted contact information

export interface ContactScore {
  value: string;
  score: number;
  reasons: string[];
}

export interface ScoringContext {
  name?: string;
  company?: string;
  domain?: string;
  searchType: 'individual' | 'company' | 'mixed';
}

/**
 * Score emails based on relevance to the lookup context
 */
export function scoreEmails(
  emails: string[],
  context: ScoringContext,
  sourceUrl?: string
): ContactScore[] {
  return emails.map(email => {
    let score = 50; // Base score
    const reasons: string[] = [];
    const [localPart, emailDomain] = email.split('@');
    
    if (!localPart || !emailDomain) {
      return { value: email, score: 0, reasons: ['Invalid format'] };
    }

    // Domain matching
    if (context.domain) {
      const contextDomain = context.domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
      const normalizedEmailDomain = emailDomain.replace(/^www\./, '');
      
      if (normalizedEmailDomain === contextDomain || normalizedEmailDomain.endsWith(`.${contextDomain}`)) {
        score += 30;
        reasons.push('Domain match');
      }
    }

    // Company name in email
    if (context.company) {
      const companySlug = context.company.toLowerCase().replace(/[^a-z0-9]/g, '');
      const emailDomainSlug = emailDomain.split('.')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') || '';
      
      if (emailDomainSlug.includes(companySlug) || companySlug.includes(emailDomainSlug)) {
        score += 25;
        reasons.push('Company name match');
      }
    }

    // Name matching for individual lookups
    if (context.searchType === 'individual' && context.name) {
      const nameParts = context.name.toLowerCase().split(/\s+/);
      const localLower = localPart.toLowerCase();
      
      const nameMatches = nameParts.filter(part => 
        part.length > 2 && localLower.includes(part)
      ).length;
      
      if (nameMatches > 0) {
        score += nameMatches * 15;
        reasons.push(`Name match (${nameMatches} parts)`);
      }
    }

    // Penalize generic prefixes
    const genericPrefixes = ['info', 'contact', 'support', 'help', 'sales', 'admin', 'service'];
    const localLower = localPart.toLowerCase();
    
    if (genericPrefixes.some(prefix => localLower === prefix || localLower.startsWith(`${prefix}.`))) {
      score -= 15;
      reasons.push('Generic prefix');
    }

    // Boost for personal-looking emails (first.last pattern)
    if (/^[a-z]+\.[a-z]+$/i.test(localPart)) {
      score += 10;
      reasons.push('Personal format');
    }

    // Source URL relevance
    if (sourceUrl) {
      try {
        const sourceHost = new URL(sourceUrl).hostname.replace(/^www\./, '');
        if (sourceHost.includes('linkedin.com') || sourceHost.includes('about.me')) {
          score += 15;
          reasons.push('Professional profile source');
        }
      } catch {
        // Invalid URL, ignore
      }
    }

    return {
      value: email,
      score: Math.max(0, Math.min(100, score)),
      reasons
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Score phone numbers based on relevance and format quality
 */
export function scorePhones(
  phones: string[],
  context: ScoringContext,
  sourceUrl?: string
): ContactScore[] {
  return phones.map(phone => {
    let score = 50; // Base score
    const reasons: string[] = [];
    const digitsOnly = phone.replace(/\D/g, '');

    // International format bonus
    if (phone.startsWith('+')) {
      score += 10;
      reasons.push('International format');
    }

    // Length quality check
    if (digitsOnly.length === 10 || digitsOnly.length === 11) {
      score += 15;
      reasons.push('Standard length');
    } else if (digitsOnly.length < 10 || digitsOnly.length > 13) {
      score -= 10;
      reasons.push('Non-standard length');
    }

    // Source URL relevance
    if (sourceUrl) {
      try {
        const sourceHost = new URL(sourceUrl).hostname.replace(/^www\./, '');
        
        // Boost for contact pages
        if (sourceUrl.includes('/contact') || sourceUrl.includes('/about')) {
          score += 20;
          reasons.push('Contact page source');
        }
        
        // Boost for company domain
        if (context.domain) {
          const contextDomain = context.domain.replace(/^https?:\/\//, '').replace(/^www\./, '');
          if (sourceHost === contextDomain || sourceHost.endsWith(`.${contextDomain}`)) {
            score += 15;
            reasons.push('Company domain');
          }
        }
      } catch {
        // Invalid URL, ignore
      }
    }

    // Penalize if found on social media (often personal, not business)
    if (sourceUrl && /facebook|instagram|twitter|x\.com/i.test(sourceUrl)) {
      if (context.searchType === 'company') {
        score -= 5;
        reasons.push('Social media source');
      }
    }

    return {
      value: phone,
      score: Math.max(0, Math.min(100, score)),
      reasons
    };
  }).sort((a, b) => b.score - a.score);
}

/**
 * Filter and rank contacts by score threshold
 */
export function filterByScore<T extends ContactScore>(
  contacts: T[],
  minScore: number = 40
): T[] {
  return contacts.filter(c => c.score >= minScore);
}

/**
 * Get top N contacts by score
 */
export function getTopContacts<T extends ContactScore>(
  contacts: T[],
  limit: number = 5
): T[] {
  return contacts.slice(0, limit);
}
