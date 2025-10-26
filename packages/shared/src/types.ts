export type ScrapeTaskId =
  | 'serp-scan'
  | 'maps-scan'
  | 'profile-scan'
  | 'contact-page-scan'
  | 'email-verification'
  | 'contactout-capture';

export interface SearchResultHighlight {
  title: string;
  url: string;
  score: number;
  snippet?: string;
  source?: string;
}

export interface ContactChannel {
  url: string;
  emails?: string[];
  phones?: string[];
  hasForm?: boolean;
  notes?: string;
}

export interface ScrapeTaskConfig {
  enabled: boolean;
  rateLimitMs?: number;
  cacheTtlMs?: number;
}

export interface MapReputationSummary {
  name?: string;
  rating?: number;
  reviewCount?: number;
  categories?: string[];
  address?: string;
  website?: string;
  phone?: string;
  statusText?: string;
  sourceUrl?: string;
}

export interface ExtensionSettings {
  apiBaseUrl?: string;
  scraping: {
    serp: ScrapeTaskConfig;
    maps: ScrapeTaskConfig;
    profile: ScrapeTaskConfig;
    contact: ScrapeTaskConfig;
  };
  detection: {
    enabled: boolean;
    polling: {
      intervalMs: number;
      timeoutMs: number;
    };
  };
  fallbacks: {
    hunter?: {
      enabled: boolean;
      apiKey?: string;
    };
    contactOut?: {
      enabled: boolean;
      polling?: {
        intervalMs?: number;
        timeoutMs?: number;
      };
    };
  };
  cacheTtlOverrides?: Partial<Record<ScrapeTaskId, number>>;
  taskRateLimits?: Partial<Record<ScrapeTaskId, number>>;
}

export type ExtensionAction =
  | 'ping'
  | 'fetchContactInfo'
  | 'getSettings'
  | 'saveSettings'
  | 'registerDetectedContacts'
  | 'getDetectedContacts'
  | 'getLastContextLookup';

export interface ContactLookup {
  email?: string;
  name?: string;
  domain?: string;
  company?: string;
}

export interface PingMessage {
  action: 'ping';
}

export interface FetchContactInfoMessage extends ContactLookup {
  action: 'fetchContactInfo';
  context?: {
    selection?: SelectionContext;
    pageUrl?: string;
    pageTitle?: string;
    tabId?: number;
    mapSummary?: MapReputationSummary;
    mapsQuery?: string;
  };
}

export interface GetSettingsMessage {
  action: 'getSettings';
}

export interface SaveSettingsMessage {
  action: 'saveSettings';
  settings: Partial<ExtensionSettings>;
}

export interface GetSelectionContextMessage {
  action: 'getSelectionContext';
}

export interface DetectedContact {
  type: 'email' | 'phone';
  value: string;
  context?: string;
}

export interface DetectedContactSnapshot {
  contacts: DetectedContact[];
  url?: string;
  title?: string;
  source?: 'auto' | 'manual';
  collectedAt?: string;
  selectionContext?: SelectionContext;
}

export interface SelectionContext {
  text: string;
  surroundingText?: string;
  keyPhrases?: string[];
  emails?: string[];
  phones?: string[];
  signatureBlock?: string;
}

export interface RegisterDetectedContactsMessage {
  action: 'registerDetectedContacts';
  snapshot: DetectedContactSnapshot;
}

export interface GetDetectedContactsMessage {
  action: 'getDetectedContacts';
  tabId?: number;
}

export interface GetLastContextLookupMessage {
  action: 'getLastContextLookup';
}

export type ExtensionMessage =
  | PingMessage
  | FetchContactInfoMessage
  | GetSettingsMessage
  | SaveSettingsMessage
  | RegisterDetectedContactsMessage
  | GetDetectedContactsMessage
  | GetLastContextLookupMessage
  | GetSelectionContextMessage;

export type ContactRequestMessage = FetchContactInfoMessage;

export type ReputationStatus = 'verified' | 'caution' | 'unknown';

export interface ReputationBreakdown {
  score: number;
  status: ReputationStatus;
  sources: string[];
}

export interface ReputationSignals {
  emailVerified?: boolean;
  linkedinProfile?: string;
  companyWebsite?: string;
  socialProfiles?: string[];
  professionalListings?: string[];
  spamReportsFound?: boolean;
  domainAgeYears?: number;
  sslEnabled?: boolean;
  searchConfidence?: number;
  socialPresenceScore?: number;
  contactConfidence?: number;
  negativeSignalsScore?: number;
  positiveSignalsScore?: number;
  breachAlerts?: boolean;
  dataFreshnessDays?: number;
  trustedDomains?: string[];
  highAuthorityScore?: number;
  mapRating?: number;
  mapReviewCount?: number;
  mapStatus?: string;
}

export interface ReputationResponse {
  reputation: ReputationBreakdown;
  socialProfiles: {
    linkedin?: string;
    twitter?: string;
    facebook?: string;
    [platform: string]: string | undefined;
  };
  companyInfo: {
    name: string;
    website: string;
    industry?: string;
    size?: string;
    founded?: string;
  };
  additionalData: {
    phoneNumbers?: string[];
    locations?: string[];
    jobTitle?: string;
    verifiedEmail: boolean;
    notes?: string;
    searchHighlights?: SearchResultHighlight[];
    socialLinks?: Record<string, string>;
    contactChannels?: ContactChannel[];
    confidenceScores?: {
      search?: number;
      social?: number;
      contact?: number;
    };
    negativeMentions?: string[];
    positiveMentions?: string[];
    trustedSources?: string[];
    selectionInsights?: SelectionContext;
    mapSummary?: MapReputationSummary;
  };
  tasksUsed?: ScrapeTaskId[];
  generatedAt?: string;
  error?: string;
}

export interface ScrapeResult {
  task: ScrapeTaskId;
  signals: Partial<ReputationSignals>;
  socialProfiles?: Partial<ReputationResponse['socialProfiles']>;
  companyInfo?: Partial<ReputationResponse['companyInfo']>;
  additionalData?: Partial<ReputationResponse['additionalData']>;
  notes?: string[];
  error?: string;
  fetchedAt?: string;
}

export interface CacheEnvelope<TPayload> {
  key: string;
  createdAt: number;
  expiresAt: number;
  payload: TPayload;
}

export interface ReputationCacheEntry extends CacheEnvelope<ReputationResponse> {
  tasks: ScrapeTaskId[];
}

export interface ScrapeCacheEntry extends CacheEnvelope<ScrapeResult> {
  task: ScrapeTaskId;
}

export interface ScrapeExecutionContext {
  lookup: ContactLookup;
  signal: AbortSignal;
  attempt: number;
  settings: ExtensionSettings;
  cachedResult?: ScrapeCacheEntry;
  selection?: SelectionContext;
  pageUrl?: string;
  pageTitle?: string;
  tabId?: number;
  mapSummary?: MapReputationSummary | null;
  mapsQuery?: string;
}

export interface EnrichmentJob {
  id: string;
  lookup: ContactLookup;
  startedAt: number;
  status: 'pending' | 'running' | 'completed' | 'failed';
  results: ScrapeResult[];
  error?: string;
}

export interface ExtensionResponseMeta {
  fromCache?: boolean;
  notes?: string[];
  [key: string]: unknown;
}

export interface ExtensionResponseMessage {
  success: boolean;
  data?: ReputationResponse;
  settings?: ExtensionSettings;
  meta?: ExtensionResponseMeta;
  detection?: {
    tabId?: number;
    snapshot?: DetectedContactSnapshot | null;
  };
  contextLookup?: {
    request?: ContactLookup;
    response?: ReputationResponse;
    error?: string;
    updatedAt?: string;
    context?: FetchContactInfoMessage['context'];
  };
  error?: string;
}
