import { ReputationBreakdown, ReputationStatus, ReputationSignals, ScrapeTaskId } from './types';

// Rebalanced weights for more accurate scoring
export const REPUTATION_WEIGHTS = {
  emailVerified: 25,              // Reduced from 30 - important but not everything
  linkedinProfile: 15,            // Reduced from 20 - common nowadays
  companyWebsite: 12,             // Reduced from 15 - expected baseline
  multipleSocialProfiles: 8,      // Reduced from 10 - nice to have
  professionalListings: 10,       // Kept same - valuable signal
  cleanReputation: 20,            // Increased from 15 - very important
  spamPenalty: -60,               // Increased penalty from -50
  domainAge: 8,                   // Reduced from 10 - less critical
  sslEnabled: 3,                  // Reduced from 5 - standard nowadays
  searchConfidence: 18,           // Increased from 15 - quality indicator
  socialPresence: 12,             // Reduced from 15 - normalize weight
  contactConfidence: 15,          // Kept same - important
  positiveSignals: 12,            // Increased from 10 - valuable
  negativeSignalsPenalty: -30,    // Increased penalty from -20
  breachPenalty: -35,             // Increased penalty from -25
  trustedDomain: 15,              // Reduced from 20 - normalize
  highAuthority: 12,              // Reduced from 15 - normalize
  dataFreshness: 8,               // Reduced from 10 - nice bonus
  mapRating: 15,                  // Reduced from 20 - business-specific
  mapReviewVolume: 10,            // Reduced from 15 - normalize
  mapStatus: 8                    // Reduced from 10 - minor signal
} as const;

export const SIGNAL_TASK_SOURCES: Partial<Record<keyof ReputationSignals, ScrapeTaskId>> = {
  emailVerified: 'venmail-lookup',
  linkedinProfile: 'serp-scan',
  companyWebsite: 'serp-scan',
  socialProfiles: 'profile-scan',
  professionalListings: 'profile-scan',
  domainAgeYears: 'whois-scan' as ScrapeTaskId,
  sslEnabled: 'profile-scan',
  spamReportsFound: 'serp-scan',
  searchConfidence: 'serp-scan',
  socialPresenceScore: 'profile-scan',
  contactConfidence: 'contact-page-scan',
  positiveSignalsScore: 'serp-scan',
  negativeSignalsScore: 'serp-scan',
  breachAlerts: 'serp-scan',
  trustedDomains: 'serp-scan',
  highAuthorityScore: 'serp-scan',
  dataFreshnessDays: 'serp-scan',
  mapRating: 'maps-scan',
  mapReviewCount: 'maps-scan',
  mapStatus: 'maps-scan'
};

// Adjusted thresholds for better distribution
export const REPUTATION_THRESHOLDS: Record<ReputationStatus, [number, number]> = {
  verified: [75, 100],    // Increased from 80 - more achievable
  caution: [40, 74],      // Changed from [50, 79] - broader middle range
  unknown: [0, 39]        // Changed from [0, 49] - stricter low end
};

export function computeReputationScore(signals: ReputationSignals): ReputationBreakdown {
  let score = 0;
  const sources: string[] = [];
  const appliedSignals: string[] = [];

  // Email verification
  if (signals.emailVerified) {
    score += REPUTATION_WEIGHTS.emailVerified;
    sources.push(SIGNAL_TASK_SOURCES.emailVerified ?? 'venmail-lookup');
    appliedSignals.push('emailVerified');
  }

  // LinkedIn profile - validate it's a real profile URL
  if (signals.linkedinProfile) {
    const isRealProfile = /linkedin\.com\/(in|pub)\//i.test(signals.linkedinProfile);
    if (isRealProfile) {
      score += REPUTATION_WEIGHTS.linkedinProfile;
      sources.push(SIGNAL_TASK_SOURCES.linkedinProfile ?? 'serp-scan');
      appliedSignals.push('linkedinProfile');
    } else {
      // Reduced score for search pages
      score += REPUTATION_WEIGHTS.linkedinProfile * 0.3;
      sources.push(SIGNAL_TASK_SOURCES.linkedinProfile ?? 'serp-scan');
      appliedSignals.push('linkedinSearch');
    }
  }

  // Company website
  if (signals.companyWebsite) {
    score += REPUTATION_WEIGHTS.companyWebsite;
    sources.push(SIGNAL_TASK_SOURCES.companyWebsite ?? 'serp-scan');
    appliedSignals.push('companyWebsite');
  }

  // Multiple social profiles
  const socialCount = signals.socialProfiles?.length ?? 0;
  if (socialCount > 1) {
    // Scale bonus based on number of profiles (diminishing returns)
    const profileBonus = Math.min(
      REPUTATION_WEIGHTS.multipleSocialProfiles,
      Math.log2(socialCount) * (REPUTATION_WEIGHTS.multipleSocialProfiles / 2)
    );
    score += profileBonus;
    sources.push(SIGNAL_TASK_SOURCES.socialProfiles ?? 'profile-scan');
    appliedSignals.push(`socialProfiles(${socialCount})`);
  }

  // Professional listings
  const listingCount = signals.professionalListings?.length ?? 0;
  if (listingCount > 0) {
    // Scale bonus based on number of listings
    const listingBonus = Math.min(
      REPUTATION_WEIGHTS.professionalListings,
      Math.sqrt(listingCount) * (REPUTATION_WEIGHTS.professionalListings / 2)
    );
    score += listingBonus;
    sources.push(SIGNAL_TASK_SOURCES.professionalListings ?? 'profile-scan');
    appliedSignals.push(`professionalListings(${listingCount})`);
  }

  // Spam reports - binary and heavily weighted
  if (signals.spamReportsFound === false) {
    score += REPUTATION_WEIGHTS.cleanReputation;
    sources.push(SIGNAL_TASK_SOURCES.spamReportsFound ?? 'serp-scan');
    appliedSignals.push('cleanReputation');
  } else if (signals.spamReportsFound === true) {
    score += REPUTATION_WEIGHTS.spamPenalty;
    sources.push(SIGNAL_TASK_SOURCES.spamReportsFound ?? 'serp-scan');
    appliedSignals.push('spamFound');
  }

  // Domain age - bonus for established domains
  const domainAge = signals.domainAgeYears ?? 0;
  if (domainAge > 1) {
    // Diminishing returns after 5 years
    const ageBonus = Math.min(
      REPUTATION_WEIGHTS.domainAge,
      (Math.log(domainAge) / Math.log(5)) * REPUTATION_WEIGHTS.domainAge
    );
    score += ageBonus;
    sources.push(SIGNAL_TASK_SOURCES.domainAgeYears ?? 'profile-scan');
    appliedSignals.push(`domainAge(${domainAge}y)`);
  }

  // SSL enabled - minor bonus
  if (signals.sslEnabled) {
    score += REPUTATION_WEIGHTS.sslEnabled;
    sources.push(SIGNAL_TASK_SOURCES.sslEnabled ?? 'profile-scan');
    appliedSignals.push('sslEnabled');
  }

  // Search confidence - scaled score
  if (typeof signals.searchConfidence === 'number' && signals.searchConfidence > 0) {
    const normalized = Math.min(100, Math.max(0, signals.searchConfidence)) / 100;
    score += normalized * REPUTATION_WEIGHTS.searchConfidence;
    sources.push(SIGNAL_TASK_SOURCES.searchConfidence ?? 'serp-scan');
    appliedSignals.push(`searchConfidence(${signals.searchConfidence})`);
  }

  // Social presence score
  if (typeof signals.socialPresenceScore === 'number' && signals.socialPresenceScore > 0) {
    const normalized = Math.min(100, Math.max(0, signals.socialPresenceScore)) / 100;
    score += normalized * REPUTATION_WEIGHTS.socialPresence;
    sources.push(SIGNAL_TASK_SOURCES.socialPresenceScore ?? 'profile-scan');
    appliedSignals.push(`socialPresence(${signals.socialPresenceScore})`);
  }

  // Contact confidence
  if (typeof signals.contactConfidence === 'number' && signals.contactConfidence > 0) {
    const normalized = Math.min(100, Math.max(0, signals.contactConfidence)) / 100;
    score += normalized * REPUTATION_WEIGHTS.contactConfidence;
    sources.push(SIGNAL_TASK_SOURCES.contactConfidence ?? 'contact-page-scan');
    appliedSignals.push(`contactConfidence(${signals.contactConfidence})`);
  }

  // Positive signals
  if (typeof signals.positiveSignalsScore === 'number' && signals.positiveSignalsScore > 0) {
    const normalized = Math.min(100, Math.max(0, signals.positiveSignalsScore)) / 100;
    score += normalized * REPUTATION_WEIGHTS.positiveSignals;
    sources.push(SIGNAL_TASK_SOURCES.positiveSignalsScore ?? 'serp-scan');
    appliedSignals.push(`positiveSignals(${signals.positiveSignalsScore})`);
  }

  // Negative signals - penalty scaled by severity
  if (typeof signals.negativeSignalsScore === 'number' && signals.negativeSignalsScore > 0) {
    const normalized = Math.min(100, Math.max(0, signals.negativeSignalsScore)) / 100;
    const penalty = normalized * Math.abs(REPUTATION_WEIGHTS.negativeSignalsPenalty);
    score -= penalty;
    sources.push(SIGNAL_TASK_SOURCES.negativeSignalsScore ?? 'serp-scan');
    appliedSignals.push(`negativeSignals(-${signals.negativeSignalsScore})`);
  }

  // Breach alerts - significant penalty
  if (signals.breachAlerts) {
    score += REPUTATION_WEIGHTS.breachPenalty;
    sources.push(SIGNAL_TASK_SOURCES.breachAlerts ?? 'serp-scan');
    appliedSignals.push('breachAlert');
  }

  // Trusted domains - bonus scales with count
  const trustedDomainCount = signals.trustedDomains?.length ?? 0;
  if (trustedDomainCount > 0) {
    // Diminishing returns after 3 domains
    const trustedBonus = Math.min(
      REPUTATION_WEIGHTS.trustedDomain,
      (trustedDomainCount / 3) * REPUTATION_WEIGHTS.trustedDomain
    );
    score += trustedBonus;
    sources.push(SIGNAL_TASK_SOURCES.trustedDomains ?? 'serp-scan');
    appliedSignals.push(`trustedDomains(${trustedDomainCount})`);
  }

  // High authority score
  if (typeof signals.highAuthorityScore === 'number' && signals.highAuthorityScore > 0) {
    const normalized = Math.min(100, Math.max(0, signals.highAuthorityScore)) / 100;
    score += normalized * REPUTATION_WEIGHTS.highAuthority;
    sources.push(SIGNAL_TASK_SOURCES.highAuthorityScore ?? 'serp-scan');
    appliedSignals.push(`highAuthority(${signals.highAuthorityScore})`);
  }

  // Data freshness - bonus for recent data
  if (typeof signals.dataFreshnessDays === 'number') {
    // Full bonus for data within 30 days, diminishing after
    const daysOld = Math.max(0, signals.dataFreshnessDays);
    const freshness = Math.max(0, 30 - daysOld);
    if (freshness > 0) {
      const freshnessBonus = (freshness / 30) * REPUTATION_WEIGHTS.dataFreshness;
      score += freshnessBonus;
      sources.push(SIGNAL_TASK_SOURCES.dataFreshnessDays ?? 'serp-scan');
      appliedSignals.push(`dataFreshness(${daysOld}d)`);
    }
  }

  // Google Maps rating
  if (typeof signals.mapRating === 'number' && signals.mapRating > 0) {
    // Non-linear scaling: 4.0+ gets full weight, below that scales down
    const ratingNormalized = Math.min(5, Math.max(0, signals.mapRating)) / 5;
    const ratingBonus = Math.pow(ratingNormalized, 1.5) * REPUTATION_WEIGHTS.mapRating;
    score += ratingBonus;
    sources.push(SIGNAL_TASK_SOURCES.mapRating ?? 'maps-scan');
    appliedSignals.push(`mapRating(${signals.mapRating.toFixed(1)})`);
  }

  // Google Maps review count
  if (typeof signals.mapReviewCount === 'number' && signals.mapReviewCount > 0) {
    // Logarithmic scaling: more reviews = better, but diminishing returns
    const reviewCount = Math.max(1, signals.mapReviewCount);
    const reviewBonus = Math.min(
      REPUTATION_WEIGHTS.mapReviewVolume,
      (Math.log10(reviewCount) / 2) * REPUTATION_WEIGHTS.mapReviewVolume
    );
    score += reviewBonus;
    sources.push(SIGNAL_TASK_SOURCES.mapReviewCount ?? 'maps-scan');
    appliedSignals.push(`mapReviews(${signals.mapReviewCount})`);
  }

  // Google Maps status
  if (signals.mapStatus) {
    const lowered = signals.mapStatus.toLowerCase();
    if (lowered.includes('permanently closed')) {
      score -= REPUTATION_WEIGHTS.mapStatus * 1.5; // Stronger penalty
      appliedSignals.push('permanentlyClosed');
    } else if (lowered.includes('temporarily closed')) {
      score -= REPUTATION_WEIGHTS.mapStatus;
      appliedSignals.push('temporarilyClosed');
    } else if (lowered.includes('open')) {
      score += REPUTATION_WEIGHTS.mapStatus * 0.5;
      appliedSignals.push('open');
    }
    sources.push(SIGNAL_TASK_SOURCES.mapStatus ?? 'maps-scan');
  }

  // Clamp score to valid range
  score = Math.max(0, Math.min(100, Math.round(score)));
  const status = mapScoreToStatus(score);

  // Log applied signals for debugging (optional)
  if (typeof window !== 'undefined' && (window as any).__VENMAIL_DEBUG__) {
    console.log('[venmail] Reputation breakdown:', {
      score,
      status,
      appliedSignals,
      sources: Array.from(new Set(sources))
    });
  }

  return {
    score,
    status,
    sources: Array.from(new Set(sources))
  };
}

export function mapScoreToStatus(score: number): ReputationStatus {
  if (score >= REPUTATION_THRESHOLDS.verified[0]) {
    return 'verified';
  }

  if (score >= REPUTATION_THRESHOLDS.caution[0]) {
    return 'caution';
  }

  return 'unknown';
}

/**
 * Validates that reputation signals are reasonable
 * Helps catch bugs in signal extraction
 */
export function validateSignals(signals: ReputationSignals): {
  valid: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];

  // Check for conflicting signals
  if (signals.emailVerified && signals.spamReportsFound === true) {
    warnings.push('Conflicting signals: verified email but spam reports found');
  }

  // Validate score ranges
  const scoreFields: Array<keyof ReputationSignals> = [
    'searchConfidence',
    'socialPresenceScore',
    'contactConfidence',
    'positiveSignalsScore',
    'negativeSignalsScore',
    'highAuthorityScore'
  ];

  for (const field of scoreFields) {
    const value = signals[field];
    if (typeof value === 'number' && (value < 0 || value > 100)) {
      warnings.push(`${field} out of range: ${value} (expected 0-100)`);
    }
  }

  // Validate URLs
  if (signals.linkedinProfile && !isValidUrl(signals.linkedinProfile)) {
    warnings.push(`Invalid LinkedIn URL: ${signals.linkedinProfile}`);
  }

  if (signals.companyWebsite && !isValidUrl(signals.companyWebsite)) {
    warnings.push(`Invalid company website: ${signals.companyWebsite}`);
  }

  // Validate arrays
  if (signals.socialProfiles && !Array.isArray(signals.socialProfiles)) {
    warnings.push('socialProfiles should be an array');
  }

  if (signals.trustedDomains && !Array.isArray(signals.trustedDomains)) {
    warnings.push('trustedDomains should be an array');
  }

  return {
    valid: warnings.length === 0,
    warnings
  };
}

function isValidUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generates a human-readable explanation of the reputation score
 */
export function explainReputation(
  breakdown: ReputationBreakdown,
  signals: ReputationSignals
): string[] {
  const explanations: string[] = [];

  explanations.push(`Overall reputation: ${breakdown.status} (${breakdown.score}/100)`);

  // Positive factors
  if (signals.emailVerified) {
    explanations.push('✓ Email verified');
  }

  if (signals.linkedinProfile && /linkedin\.com\/(in|pub)\//i.test(signals.linkedinProfile)) {
    explanations.push('✓ LinkedIn profile found');
  }

  if (signals.companyWebsite) {
    explanations.push('✓ Company website identified');
  }

  if ((signals.socialProfiles?.length ?? 0) > 1) {
    explanations.push(`✓ ${signals.socialProfiles?.length} social profiles`);
  }

  if ((signals.trustedDomains?.length ?? 0) > 0) {
    explanations.push(`✓ Found on ${signals.trustedDomains?.length} trusted sources`);
  }

  // Negative factors
  if (signals.spamReportsFound === true) {
    explanations.push('⚠ Spam reports detected');
  }

  if (signals.breachAlerts) {
    explanations.push('⚠ Security breach alerts found');
  }

  if (typeof signals.negativeSignalsScore === 'number' && signals.negativeSignalsScore > 20) {
    explanations.push('⚠ Negative mentions in search results');
  }

  // Neutral/contextual factors
  if (typeof signals.searchConfidence === 'number') {
    explanations.push(`Search confidence: ${signals.searchConfidence}/100`);
  }

  if (typeof signals.mapRating === 'number' && signals.mapRating > 0) {
    explanations.push(`Google Maps: ${signals.mapRating.toFixed(1)}★ (${signals.mapReviewCount || 0} reviews)`);
  }

  return explanations;
}