import { ReputationBreakdown, ReputationStatus, ReputationSignals, ScrapeTaskId } from './types';

export const REPUTATION_WEIGHTS = {
  emailVerified: 30,
  linkedinProfile: 20,
  companyWebsite: 15,
  multipleSocialProfiles: 10,
  professionalListings: 10,
  cleanReputation: 15,
  spamPenalty: -50,
  domainAge: 10,
  sslEnabled: 5,
  searchConfidence: 15,
  socialPresence: 15,
  contactConfidence: 15,
  positiveSignals: 10,
  negativeSignalsPenalty: -20,
  breachPenalty: -25,
  trustedDomain: 20,
  highAuthority: 15,
  dataFreshness: 10,
  mapRating: 20,
  mapReviewVolume: 15,
  mapStatus: 10
} as const;

export const SIGNAL_TASK_SOURCES: Partial<Record<keyof ReputationSignals, ScrapeTaskId>> = {
  emailVerified: 'email-verification',
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

export const REPUTATION_THRESHOLDS: Record<ReputationStatus, [number, number]> = {
  verified: [80, 100],
  caution: [50, 79],
  unknown: [0, 49]
};

export function computeReputationScore(signals: ReputationSignals): ReputationBreakdown {
  let score = 0;
  const sources: string[] = [];

  if (signals.emailVerified) {
    score += REPUTATION_WEIGHTS.emailVerified;
    sources.push(SIGNAL_TASK_SOURCES.emailVerified ?? 'email-verification');
  }

  if (signals.linkedinProfile) {
    score += REPUTATION_WEIGHTS.linkedinProfile;
    sources.push(SIGNAL_TASK_SOURCES.linkedinProfile ?? 'serp-scan');
  }

  if (signals.companyWebsite) {
    score += REPUTATION_WEIGHTS.companyWebsite;
    sources.push(SIGNAL_TASK_SOURCES.companyWebsite ?? 'serp-scan');
  }

  if ((signals.socialProfiles?.length ?? 0) > 1) {
    score += REPUTATION_WEIGHTS.multipleSocialProfiles;
    sources.push(SIGNAL_TASK_SOURCES.socialProfiles ?? 'profile-scan');
  }

  if ((signals.professionalListings?.length ?? 0) > 0) {
    score += REPUTATION_WEIGHTS.professionalListings;
    sources.push(SIGNAL_TASK_SOURCES.professionalListings ?? 'profile-scan');
  }

  if (signals.spamReportsFound === false) {
    score += REPUTATION_WEIGHTS.cleanReputation;
    sources.push(SIGNAL_TASK_SOURCES.spamReportsFound ?? 'serp-scan');
  } else if (signals.spamReportsFound === true) {
    score += REPUTATION_WEIGHTS.spamPenalty;
    sources.push(SIGNAL_TASK_SOURCES.spamReportsFound ?? 'serp-scan');
  }

  if ((signals.domainAgeYears ?? 0) > 1) {
    score += REPUTATION_WEIGHTS.domainAge;
    sources.push(SIGNAL_TASK_SOURCES.domainAgeYears ?? 'profile-scan');
  }

  if (signals.sslEnabled) {
    score += REPUTATION_WEIGHTS.sslEnabled;
    sources.push(SIGNAL_TASK_SOURCES.sslEnabled ?? 'profile-scan');
  }

  if (typeof signals.searchConfidence === 'number' && signals.searchConfidence > 0) {
    score += Math.min(1, signals.searchConfidence / 100) * REPUTATION_WEIGHTS.searchConfidence;
    sources.push(SIGNAL_TASK_SOURCES.searchConfidence ?? 'serp-scan');
  }

  if (typeof signals.socialPresenceScore === 'number' && signals.socialPresenceScore > 0) {
    score += Math.min(1, signals.socialPresenceScore / 100) * REPUTATION_WEIGHTS.socialPresence;
    sources.push(SIGNAL_TASK_SOURCES.socialPresenceScore ?? 'profile-scan');
  }

  if (typeof signals.contactConfidence === 'number' && signals.contactConfidence > 0) {
    score += Math.min(1, signals.contactConfidence / 100) * REPUTATION_WEIGHTS.contactConfidence;
    sources.push(SIGNAL_TASK_SOURCES.contactConfidence ?? 'contact-page-scan');
  }

  if (typeof signals.positiveSignalsScore === 'number' && signals.positiveSignalsScore > 0) {
    score += Math.min(1, signals.positiveSignalsScore / 100) * REPUTATION_WEIGHTS.positiveSignals;
    sources.push(SIGNAL_TASK_SOURCES.positiveSignalsScore ?? 'serp-scan');
  }

  if (typeof signals.negativeSignalsScore === 'number' && signals.negativeSignalsScore > 0) {
    score += Math.max(
      REPUTATION_WEIGHTS.negativeSignalsPenalty,
      -Math.min(1, signals.negativeSignalsScore / 100) * Math.abs(REPUTATION_WEIGHTS.negativeSignalsPenalty)
    );
    sources.push(SIGNAL_TASK_SOURCES.negativeSignalsScore ?? 'serp-scan');
  }

  if (signals.breachAlerts) {
    score += REPUTATION_WEIGHTS.breachPenalty;
    sources.push(SIGNAL_TASK_SOURCES.breachAlerts ?? 'serp-scan');
  }

  const trustedDomainCount = signals.trustedDomains?.length ?? 0;
  if (trustedDomainCount > 0) {
    score += Math.min(trustedDomainCount, 3) * (REPUTATION_WEIGHTS.trustedDomain / 3);
    sources.push(SIGNAL_TASK_SOURCES.trustedDomains ?? 'serp-scan');
  }

  if (typeof signals.highAuthorityScore === 'number' && signals.highAuthorityScore > 0) {
    score += Math.min(1, signals.highAuthorityScore / 100) * REPUTATION_WEIGHTS.highAuthority;
    sources.push(SIGNAL_TASK_SOURCES.highAuthorityScore ?? 'serp-scan');
  }

  if (typeof signals.dataFreshnessDays === 'number') {
    const freshness = Math.max(0, 45 - signals.dataFreshnessDays);
    if (freshness > 0) {
      score += Math.min(1, freshness / 45) * REPUTATION_WEIGHTS.dataFreshness;
      sources.push(SIGNAL_TASK_SOURCES.dataFreshnessDays ?? 'serp-scan');
    }
  }

  if (typeof signals.mapRating === 'number' && signals.mapRating > 0) {
    score += Math.min(1, signals.mapRating / 5) * REPUTATION_WEIGHTS.mapRating;
    sources.push(SIGNAL_TASK_SOURCES.mapRating ?? 'maps-scan');
  }

  if (typeof signals.mapReviewCount === 'number' && signals.mapReviewCount > 0) {
    const normalized = Math.min(1, signals.mapReviewCount / 100);
    score += normalized * REPUTATION_WEIGHTS.mapReviewVolume;
    sources.push(SIGNAL_TASK_SOURCES.mapReviewCount ?? 'maps-scan');
  }

  if (signals.mapStatus) {
    const lowered = signals.mapStatus.toLowerCase();
    if (lowered.includes('temporarily closed') || lowered.includes('permanently closed')) {
      score -= REPUTATION_WEIGHTS.mapStatus;
    } else if (lowered.includes('open')) {
      score += REPUTATION_WEIGHTS.mapStatus / 2;
    }
    sources.push(SIGNAL_TASK_SOURCES.mapStatus ?? 'maps-scan');
  }

  score = Math.max(0, Math.min(100, score));
  const status = mapScoreToStatus(score);

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
