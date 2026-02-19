import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContactLookup,
  DetectedContactSnapshot,
  ExtensionResponseMessage,
  ExtensionSettings,
  FetchContactInfoMessage,
  LookupProgressUpdate,
  ReputationResponse,
  SaveSettingsMessage,
  SelectionContext
} from '@venmail/shared';

import './popupApp.css';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { safeSendMessage, safeSendTabsMessage } from '../shared/messaging';
import { ReputationBreakdown, ReputationSignals, buildRequestKey, explainReputation } from '@venmail/shared';
import { EditIcon, ExternalLink } from 'lucide-react';
import { DetectionSnapshot } from './components/DetectionSnapshot';
import { InsightSummary } from './components/InsightSummary';
import { LookupProgressTimeline } from './components/LookupProgressTimeline';
import { SearchView } from './components/SearchView';

type StatusVariant = 'info' | 'success' | 'warning' | 'error';

interface StatusMessage {
  label: string;
  variant: StatusVariant;
}

const DEFAULT_VENMAIL_WEB_BASE = 'https://app.venmail.io';

interface TaskConfigFormState {
  enabled: boolean;
  rateLimitMs: string;
  cacheTtlMs: string;
}

interface FormState {
  apiBaseUrl: string;
  scraping: {
    serp: TaskConfigFormState;
    maps: TaskConfigFormState;
    profile: TaskConfigFormState;
    contact: TaskConfigFormState;
  };
  detection: {
    enabled: boolean;
    intervalMs: string;
    timeoutMs: string;
  };
  fallbacks: {
    venmail: {
      enabled: boolean;
      apiKey: string;
    };
  };
}

type ScrapeTaskKey = keyof FormState['scraping'];

interface LookupFormState {
  name: string;
  email: string;
  domain: string;
  company: string;
}

type ViewMode = 'results' | 'search' | 'detection' | 'advanced';
type FormErrors = Partial<Record<keyof LookupFormState, string>>;

const defaultStatus: StatusMessage = { label: 'Idle', variant: 'info' };

type ContextLookupState = NonNullable<ExtensionResponseMessage['contextLookup']>;

const EMAIL_CAPTURE_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const DOMAIN_CAPTURE_REGEX = /\b([A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+)\b/i;
const COMPANY_KEYWORDS_REGEX = /\b(inc|llc|ltd|corp|company|gmbh|plc|sarl|sa|limited|co\.|pte|pty|bv|ag)\b/i;

function extractEmailCandidate(source?: string | null): string | undefined {
  if (!source) {
    return undefined;
  }
  const match = source.match(EMAIL_CAPTURE_REGEX);
  return match ? match[0].toLowerCase() : undefined;
}

function normalizeDomain(domain: string | undefined): string | undefined {
  if (!domain) {
    return undefined;
  }

  const cleaned = domain.trim().toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '');
  if (!cleaned) {
    return undefined;
  }

  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}

function findDomainCandidate(source?: string | null): string | undefined {
  if (!source) {
    return undefined;
  }

  const match = source.match(DOMAIN_CAPTURE_REGEX);
  if (!match) {
    return undefined;
  }

  return normalizeDomain((match[1] ?? match[0])?.toString());
}

function isLikelyPersonName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 64) {
    return false;
  }
  if (/[0-9@]/.test(trimmed)) {
    return false;
  }

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 5) {
    return false;
  }

  const validWords = words.filter((word) => /^[A-Z][a-zA-Z'\-]+$/.test(word));
  return validWords.length >= words.length - 1;
}

function isLikelyCompanyName(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length < 3 || trimmed.length > 80) {
    return false;
  }
  if (/[#@]/.test(trimmed)) {
    return false;
  }
  if (COMPANY_KEYWORDS_REGEX.test(trimmed)) {
    return true;
  }
  if (!/\s/.test(trimmed)) {
    return false;
  }
  return /^[A-Za-z0-9&'()\.\-, ]+$/.test(trimmed);
}

function deriveNameCandidate(selection: SelectionContext): string | undefined {
  const sources = [selection.text, selection.surroundingText, ...(selection.keyPhrases ?? [])];

  for (const source of sources) {
    if (!source) {
      continue;
    }
    const lines = source
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const line of lines) {
      if (isLikelyPersonName(line)) {
        return line;
      }
    }
  }

  return undefined;
}

function extractHostname(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  try {
    const url = value.includes('://') ? new URL(value) : new URL(`https://${value}`);
    return url.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return value.replace(/^www\./, '').toLowerCase();
  }
}

function normalizeComparableName(value?: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.toLowerCase().replace(/[^a-z0-9]/g, '');
}

function toAscii85(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let output = '';

  for (let index = 0; index < bytes.length; index += 4) {
    const block = bytes.slice(index, index + 4);
    if (block.length === 4 && block[0] === 0 && block[1] === 0 && block[2] === 0 && block[3] === 0) {
      output += 'z';
      continue;
    }

    let value = 0;
    for (let offset = 0; offset < 4; offset += 1) {
      value = (value << 8) | (block[offset] ?? 0);
    }

    const encoded = new Array(5);
    for (let offset = 4; offset >= 0; offset -= 1) {
      encoded[offset] = String.fromCharCode((value % 85) + 33);
      value = Math.floor(value / 85);
    }

    output += encoded.slice(0, block.length + 1).join('');
  }

  return output;
}

function resolveQuickSyncBaseUrl(apiBaseUrl?: string): string {
  if (!apiBaseUrl?.trim()) {
    return DEFAULT_VENMAIL_WEB_BASE;
  }

  try {
    return new URL(apiBaseUrl).origin;
  } catch {
    return DEFAULT_VENMAIL_WEB_BASE;
  }
}

function buildSelectionSignature(selection?: SelectionContext | null): string | null {
  if (!selection) {
    return null;
  }

  return JSON.stringify({
    text: selection.text,
    emails: selection.emails ?? null,
    phones: selection.phones ?? null,
    signatureBlock: selection.signatureBlock ?? null
  });
}

function deriveCompanyCandidate(selection: SelectionContext): string | undefined {
  const sources: (string | undefined | null)[] = [
    ...(selection.keyPhrases ?? []),
    ...(selection.signatureBlock?.split(/\n+/).map((line) => line.trim()) ?? []),
    selection.text,
    selection.surroundingText
  ];

  for (const source of sources) {
    if (!source) {
      continue;
    }
    if (isLikelyCompanyName(source)) {
      return source.trim();
    }
  }

  return undefined;
}

function deriveDomainCandidate(selection: SelectionContext, emailCandidate?: string): string | undefined {
  const domainFromEmail = normalizeDomain(emailCandidate?.split('@')[1]);
  if (domainFromEmail) {
    return domainFromEmail;
  }

  const sources = [selection.text, selection.surroundingText, ...(selection.keyPhrases ?? [])];
  for (const source of sources) {
    const domain = findDomainCandidate(source);
    if (domain) {
      return domain;
    }
  }

  return undefined;
}

export function PopupApp(): JSX.Element {
  const [status, setStatus] = useState<StatusMessage>(defaultStatus);
  const [settings, setSettings] = useState<ExtensionSettings | null>(null);
  const [formState, setFormState] = useState<FormState | null>(null);
  const [activeTabId, setActiveTabId] = useState<number | null>(null);
  const [detectionSnapshot, setDetectionSnapshot] = useState<DetectedContactSnapshot | null>(null);
  const [contextLookup, setContextLookup] = useState<ContextLookupState | null>(null);
  const [lookupForm, setLookupForm] = useState<LookupFormState>({ name: '', email: '', domain: '', company: '' });
  const [lookupErrors, setLookupErrors] = useState<FormErrors>({});
  const [isSaving, setIsSaving] = useState(false);
  const [isFetching, setIsFetching] = useState(false);
  const [lastResponse, setLastResponse] = useState<ReputationResponse | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('search');
  const [lastLookupRequest, setLastLookupRequest] = useState<ContactLookup | null>(null);
  const [progressUpdates, setProgressUpdates] = useState<LookupProgressUpdate[]>([]);
  const [activeLookupKey, setActiveLookupKey] = useState<string | null>(null);
  const [debugLoggingEnabled, setDebugLoggingEnabled] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('venmail_debug_logging');
      return stored ? stored === 'true' : false;
    } catch {
      return false;
    }
  });
  const [lookupQuery, setLookupQuery] = useState('');
  const [reputation, setReputation] = useState<ReputationBreakdown | null>(null);
  const [reputationSignals, setReputationSignals] = useState<ReputationSignals | null>(null);
  const [lastFromCache, setLastFromCache] = useState<boolean>(false);
  const pendingLookupRef = useRef<{ lookup: ContactLookup; context?: FetchContactInfoMessage['context'] } | null>(null);
  const selectionSignatureRef = useRef<string | null>(null);

  const applySelectionContext = useCallback(
    (selection?: SelectionContext | null) => {
      if (!selection) {
        selectionSignatureRef.current = null;
        return;
      }

      const signature = buildSelectionSignature(selection);
      if (signature && signature === selectionSignatureRef.current) {
        return;
      }

      const candidateEmail =
        selection.emails?.[0]?.toLowerCase() ??
        extractEmailCandidate(selection.text) ??
        extractEmailCandidate(selection.signatureBlock);
      const candidateDomain = deriveDomainCandidate(selection, candidateEmail);
      const candidateName = deriveNameCandidate(selection);
      const candidateCompany = deriveCompanyCandidate(selection);

      selectionSignatureRef.current = signature;

      setLookupForm((prev) => {
        const pick = (current: string, candidate?: string) => (current.trim().length ? current : candidate ?? current);
        return {
          name: pick(prev.name, candidateName),
          email: pick(prev.email, candidateEmail),
          domain: pick(prev.domain, candidateDomain),
          company: pick(prev.company, candidateCompany)
        };
      });
    },
    []
  );

  const refreshDetection = useCallback((tabIdentifier: number) => {
    safeSendMessage({ action: 'getDetectedContacts', tabId: tabIdentifier }, (response: ExtensionResponseMessage) => {
      if (chrome.runtime.lastError) {
        return;
      }

      if (response?.success && response.detection?.tabId === tabIdentifier) {
        setDetectionSnapshot(response.detection.snapshot ?? null);
      }
    });
  }, []);

  const requestSelectionFromTab = useCallback(
    (tabIdentifier: number) => {
      selectionSignatureRef.current = null;
      safeSendTabsMessage(tabIdentifier, { action: 'getSelectionContext' }, (response: { context?: SelectionContext | null }) => {
        if (chrome.runtime.lastError) {
          return;
        }

        applySelectionContext(response?.context ?? null);
      });
    },
    [applySelectionContext]
  );

  const refreshContextLookup = useCallback(() => {
    safeSendMessage({ action: 'getLastContextLookup' }, (response: ExtensionResponseMessage) => {
      if (chrome.runtime.lastError) {
        return;
      }

      if (response?.success) {
        const entry = response.contextLookup ?? null;
        setContextLookup(entry);
        applySelectionContext(entry?.context?.selection ?? null);
      }
    });
  }, [applySelectionContext]);

  const handleLookupFieldChange = useCallback((field: keyof LookupFormState, value: string) => {
    setLookupForm((prev) => ({ ...prev, [field]: value }));
    setLookupErrors((prev) => {
      if (!prev[field]) {
        return prev;
      }
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }, []);

  const validateLookupForm = useCallback((form: LookupFormState) => {
    const errors: FormErrors = {};

    if (!form.name.trim() && !form.email.trim()) {
      errors.name = 'Provide a name or email';
      errors.email = 'Provide a name or email';
    }

    if (form.email.trim() && !/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(form.email.trim())) {
      errors.email = 'Email looks invalid';
    }

    if (form.domain.trim() && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(form.domain.trim())) {
      errors.domain = 'Domain looks invalid';
    }

    return errors;
  }, []);

  const performLookup = useCallback(
    (lookup: ContactLookup, options?: { triggerMode?: 'auto' | 'manual'; context?: FetchContactInfoMessage['context'] }) => {
      setIsFetching(true);
      const startTime = performance.now();
      const request: FetchContactInfoMessage = {
        action: 'fetchContactInfo',
        email: lookup.email,
        name: lookup.name,
        domain: lookup.domain,
        company: lookup.company,
        context: options?.context
      };

      setLastLookupRequest({
        email: lookup.email,
        name: lookup.name,
        domain: lookup.domain,
        company: lookup.company
      });

      const lookupKey = buildRequestKey(lookup);
      setActiveLookupKey(lookupKey);
      setProgressUpdates([]);
      setViewMode('results');

      chrome.runtime.sendMessage(request, (response: ExtensionResponseMessage) => {
        setIsFetching(false);
        const duration = performance.now() - startTime;
        const source: 'cache' | 'fresh' | 'error' = chrome.runtime.lastError
          ? 'error'
          : response?.success
            ? response.meta?.fromCache
              ? 'cache'
              : 'fresh'
            : 'error';

        if (debugLoggingEnabled) {
          console.info('[venmail] Lookup completed in %dms (%s)', Math.round(duration), source);
        }

        if (chrome.runtime.lastError) {
          setStatus({
            label: `${chrome.runtime.lastError.message ?? 'Lookup failed'} after ${Math.round(duration)}ms`,
            variant: 'error'
          });
          return;
        }

        if (response?.success && response.data) {
          setLastResponse(response.data);
          setLastFromCache(Boolean(response.meta?.fromCache));
          setReputation(response.data.reputation);
          setReputationSignals(response.data.reputationSignals ?? null);
          setLookupQuery(
            lookup.email || lookup.name || lookup.domain || lookup.company || lookupQuery || 'Latest lookup'
          );
          setViewMode('results');
          const baseLabel = response.meta?.fromCache ? 'Insights loaded from cache' : 'Fresh insights ready';
          setStatus({ label: `${baseLabel} in ${Math.round(duration)}ms`, variant: 'success' });
        } else {
          setStatus({ label: `${response?.error ?? 'Lookup failed'} after ${Math.round(duration)}ms`, variant: 'error' });
        }
      });
    },
    [debugLoggingEnabled, lookupQuery, setStatus]
  );

  const handleLookupSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const errors = validateLookupForm(lookupForm);
      if (Object.keys(errors).length) {
        setLookupErrors(errors);
        return;
      }

      setLookupErrors({});
      performLookup({ ...lookupForm }, { triggerMode: 'manual' });
    },
    [performLookup, lookupForm, validateLookupForm]
  );

  const handleClearCache = useCallback(() => {
    if (!activeLookupKey) return;
    const storageKey = `venmail:reputation:${activeLookupKey}`;
    chrome.storage.local.remove(storageKey, () => {
      setLastFromCache(false);
      setStatus({ label: 'Cache cleared', variant: 'success' });
    });
  }, [activeLookupKey]);

  const handleDetectionLookup = useCallback(
    (value: string, type: 'email' | 'phone') => {
      if (type === 'email') {
        performLookup({ email: value }, { triggerMode: 'manual' });
      } else {
        performLookup({ name: value }, { triggerMode: 'manual' });
      }
    },
    [performLookup]
  );

  const bootstrapPendingLookup = useCallback(
    (payload: { lookup: ContactLookup; context?: FetchContactInfoMessage['context'] }) => {
      const targetLookup = payload.lookup;
      if (!targetLookup.email && !targetLookup.name) {
        return;
      }

      setLookupForm((prev) => ({
        name: targetLookup.name ?? prev.name,
        email: targetLookup.email ?? prev.email,
        domain: targetLookup.domain ?? prev.domain,
        company: targetLookup.company ?? prev.company
      }));
      setLookupErrors({});
      performLookup(targetLookup, { triggerMode: 'auto', context: payload.context });
    },
    [performLookup]
  );

  const handleExportToVenmail = useCallback(() => {
    if (!lastResponse) {
      return;
    }

    const payload = {
      source: 'venmail-extension',
      exportedAt: new Date().toISOString(),
      request: lastLookupRequest,
      query: lookupQuery,
      response: lastResponse
    };

    try {
      const encoded = toAscii85(JSON.stringify(payload));
      const webBase = resolveQuickSyncBaseUrl(settings?.apiBaseUrl);
      const quickSyncUrl = `${webBase}/contacts/quick-sync?payload=${encodeURIComponent(encoded)}`;
      window.open(quickSyncUrl, '_blank', 'noopener,noreferrer');
      setStatus({ label: 'Opened Venmail quick sync', variant: 'success' });
    } catch (error) {
      console.warn('[venmail] export payload encoding failed', error);
      setStatus({ label: 'Failed to encode quick sync payload', variant: 'error' });
    }
  }, [lastLookupRequest, lastResponse, lookupQuery, settings?.apiBaseUrl]);

  useEffect(() => {
    safeSendMessage({ action: 'popupReady' }, (response: ExtensionResponseMessage) => {
      if (response?.pendingLookup) {
        pendingLookupRef.current = response.pendingLookup;
        bootstrapPendingLookup(response.pendingLookup);
      }
    });
  }, [bootstrapPendingLookup]);

  useEffect(() => {
    if (pendingLookupRef.current) {
      bootstrapPendingLookup(pendingLookupRef.current);
    }
  }, [bootstrapPendingLookup]);

  const activeReputationSignals = useMemo<ReputationSignals | null>(() => {
    if (reputationSignals) {
      return reputationSignals;
    }
    return lastResponse?.reputationSignals ?? null;
  }, [lastResponse?.reputationSignals, reputationSignals]);

  useEffect(() => {
    chrome.runtime.sendMessage({ action: 'ping' }, (response: ExtensionResponseMessage) => {
      if (chrome.runtime.lastError) {
        setStatus({ label: chrome.runtime.lastError.message ?? 'Extension unavailable', variant: 'error' });
        return;
      }

      if (response?.success) {
        setStatus({ label: 'Ready', variant: 'success' });
      } else {
        setStatus({ label: response?.error ?? 'Ping failed', variant: 'warning' });
      }
    });

    chrome.runtime.sendMessage({ action: 'getSettings' }, (response: ExtensionResponseMessage) => {
      if (chrome.runtime.lastError) {
        setStatus({ label: chrome.runtime.lastError.message ?? 'Failed to load settings', variant: 'error' });
        return;
      }

      if (response?.success && response.settings) {
        setSettings(response.settings);
        setFormState(mapSettingsToForm(response.settings));
      } else if (response?.error) {
        setStatus({ label: response.error, variant: 'error' });
      }
    });

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const current = tabs[0];
      if (current?.id) {
        setActiveTabId(current.id);
        refreshDetection(current.id);
        requestSelectionFromTab(current.id);
      }
    });

    refreshContextLookup();
  }, [refreshContextLookup, refreshDetection, requestSelectionFromTab]);

  useEffect(() => {
    const listener = (message: unknown): void => {
      if (!message || typeof message !== 'object') {
        return;
      }

      const payload = message as {
        type?: string;
        detection?: { tabId?: number; snapshot?: DetectedContactSnapshot | null };
        contextLookup?: ContextLookupState;
        settings?: ExtensionSettings;
        pendingLookup?: { lookup: ContactLookup; context?: FetchContactInfoMessage['context'] };
      } | LookupProgressUpdate;

      if (payload.type === 'venmail-detection-updated' && typeof payload.detection?.tabId === 'number') {
        if (!activeTabId || payload.detection.tabId === activeTabId) {
          setDetectionSnapshot(payload.detection.snapshot ?? null);
        }
      }

      if (payload.type === 'venmail-context-lookup') {
        setContextLookup(payload.contextLookup ?? null);
        applySelectionContext(payload.contextLookup?.context?.selection ?? null);
      }

      if (payload.type === 'venmail-settings-updated' && payload.settings) {
        setSettings(payload.settings);
        setFormState(mapSettingsToForm(payload.settings));
      }

      if (payload.type === 'venmail-pending-lookup' && 'pendingLookup' in payload && payload.pendingLookup) {
        pendingLookupRef.current = payload.pendingLookup;
        bootstrapPendingLookup(payload.pendingLookup);
      }

      if (payload.type === 'venmail-lookup-progress') {
        const progress = payload as LookupProgressUpdate;
        setProgressUpdates((prev) => {
          const next = prev.filter((entry) => entry.lookupKey === progress.lookupKey);
          next.push(progress);
          return next;
        });
      }
    };

    chrome.runtime.onMessage.addListener(listener);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [activeTabId, applySelectionContext, bootstrapPendingLookup]);

  const hasUnsavedChanges = useMemo(() => {
    if (!settings || !formState) {
      return false;
    }

    return JSON.stringify(mapSettingsToForm(settings)) !== JSON.stringify(formState);
  }, [settings, formState]);

  const sanitizeNumberInput = (value: string): string => value.replace(/[^0-9]/g, '');

  const progressHistory = useMemo(() => {
    const byLookup = new Map<string, LookupProgressUpdate[]>();
    for (const update of progressUpdates) {
      const bucket = byLookup.get(update.lookupKey) ?? [];
      bucket.push(update);
      byLookup.set(update.lookupKey, bucket);
    }
    for (const bucket of byLookup.values()) {
      bucket.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }
    return byLookup;
  }, [progressUpdates]);

  const activeProgress = useMemo(() => {
    if (!activeLookupKey) {
      return [] as LookupProgressUpdate[];
    }
    return progressHistory.get(activeLookupKey) ?? [];
  }, [activeLookupKey, progressHistory]);

  const updateFormState = (updater: (prev: FormState) => FormState): void => {
    setFormState((prev) => {
      if (!prev) {
        return prev;
      }

      return updater(prev);
    });
  };

  const handleApiBaseUrlChange = (value: string) => {
    updateFormState((prev) => ({ ...prev, apiBaseUrl: value }));
  };

  const handleTaskToggle = (task: ScrapeTaskKey) => {
    updateFormState((prev) => ({
      ...prev,
      scraping: {
        ...prev.scraping,
        [task]: {
          ...prev.scraping[task],
          enabled: !prev.scraping[task].enabled
        }
      }
    }));
  };

  const handleTaskFieldChange = (
    task: ScrapeTaskKey,
    field: 'rateLimitMs' | 'cacheTtlMs',
    value: string
  ) => {
    const sanitized = sanitizeNumberInput(value);
    updateFormState((prev) => ({
      ...prev,
      scraping: {
        ...prev.scraping,
        [task]: {
          ...prev.scraping[task],
          [field]: sanitized
        }
      }
    }));
  };

  const handleDetectionToggle = () => {
    updateFormState((prev) => ({
      ...prev,
      detection: {
        ...prev.detection,
        enabled: !prev.detection.enabled
      }
    }));
  };

  const handleDetectionFieldChange = (field: 'intervalMs' | 'timeoutMs', value: string) => {
    const sanitized = sanitizeNumberInput(value);
    updateFormState((prev) => ({
      ...prev,
      detection: {
        ...prev.detection,
        [field]: sanitized
      }
    }));
  };

  const handleVenmailToggle = () => {
    updateFormState((prev) => ({
      ...prev,
      fallbacks: {
        ...prev.fallbacks,
        venmail: {
          ...prev.fallbacks.venmail,
          enabled: !prev.fallbacks.venmail.enabled
        }
      }
    }));
  };

  const handleVenmailApiKeyChange = (value: string) => {
    updateFormState((prev) => ({
      ...prev,
      fallbacks: {
        ...prev.fallbacks,
        venmail: {
          ...prev.fallbacks.venmail,
          apiKey: value
        }
      }
    }));
  };

  const handleSaveSettings = () => {
    if (!formState) {
      return;
    }

    setIsSaving(true);
    const toTaskSettings = (task: TaskConfigFormState) => ({
      enabled: task.enabled,
      rateLimitMs: parseOptionalNumber(task.rateLimitMs),
      cacheTtlMs: parseOptionalNumber(task.cacheTtlMs)
    });

    const detectionIntervalMs =
      parseOptionalNumber(formState.detection.intervalMs) ?? DEFAULT_SETTINGS.detection.polling.intervalMs;
    const detectionTimeoutMs =
      parseOptionalNumber(formState.detection.timeoutMs) ?? DEFAULT_SETTINGS.detection.polling.timeoutMs;

    const payload: SaveSettingsMessage = {
      action: 'saveSettings',
      settings: {
        apiBaseUrl: formState.apiBaseUrl.trim() || undefined,
        scraping: {
          serp: toTaskSettings(formState.scraping.serp),
          maps: toTaskSettings(formState.scraping.maps),
          profile: toTaskSettings(formState.scraping.profile),
          contact: toTaskSettings(formState.scraping.contact)
        },
        detection: {
          enabled: formState.detection.enabled,
          polling: {
            intervalMs: detectionIntervalMs,
            timeoutMs: detectionTimeoutMs
          }
        },
        fallbacks: {
          venmail: {
            enabled: formState.fallbacks.venmail.enabled,
            apiKey: formState.fallbacks.venmail.apiKey.trim() || undefined
          }
        }
      }
    };

    chrome.runtime.sendMessage(payload, (response: ExtensionResponseMessage) => {
      setIsSaving(false);

      if (chrome.runtime.lastError) {
        setStatus({ label: chrome.runtime.lastError.message ?? 'Save failed', variant: 'error' });
        return;
      }

      if (response?.success && response.settings) {
        setSettings(response.settings);
        setFormState(mapSettingsToForm(response.settings));
        setStatus({ label: 'Settings saved', variant: 'success' });
      } else {
        setStatus({ label: response?.error ?? 'Save failed', variant: 'error' });
      }
    });
  };

  const renderAdvancedSettings = () => {
    if (!formState) {
      return (
        <section className="settings-card">
          <h2>Advanced controls</h2>
          <p className="settings-hint">Loading settings…</p>
        </section>
      );
    }

    const scrapingRows: { key: ScrapeTaskKey; label: string; hint: string }[] = [
      {
        key: 'serp',
        label: 'Search (SERP scan)',
        hint: 'Use search engines to seed leads and company signals.'
      },
      {
        key: 'maps',
        label: 'Maps reputation scan',
        hint: 'Capture Google Maps ratings, review volume, and status signals.'
      },
      {
        key: 'profile',
        label: 'Profile discovery',
        hint: 'Resolve social profiles and public listings for the contact.'
      },
      {
        key: 'contact',
        label: 'Contact page scan',
        hint: 'Scrape company pages for emails and phone numbers.'
      }
    ];

    return (
      <section className="settings-card">
        <h2>Automation controls</h2>
        <p className="settings-hint">Tune scraping cadence, fallbacks, and detection behaviour.</p>

        <div className="settings-grid">
          <div>
            <h3>Scraping pipeline</h3>
            <table className="task-table">
              <thead>
                <tr>
                  <th scope="col">Task</th>
                  <th scope="col">Rate limit (ms)</th>
                  <th scope="col">Cache TTL (ms)</th>
                </tr>
              </thead>
              <tbody>
                {scrapingRows.map(({ key, label, hint }) => {
                  const task = formState.scraping[key];
                  return (
                    <tr key={key}>
                      <td>
                        <label className="field checkbox">
                          <input
                            type="checkbox"
                            checked={task.enabled}
                            onChange={() => handleTaskToggle(key)}
                          />
                          {label}
                        </label>
                        <p className="settings-hint">{hint}</p>
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          step={100}
                          value={task.rateLimitMs}
                          onChange={(event) => handleTaskFieldChange(key, 'rateLimitMs', event.currentTarget.value)}
                          placeholder="Auto"
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min={0}
                          step={1000}
                          value={task.cacheTtlMs}
                          onChange={(event) => handleTaskFieldChange(key, 'cacheTtlMs', event.currentTarget.value)}
                          placeholder="Auto"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div>
            <h3>Fallback services</h3>
            <div className="field checkbox">
              <label>
                <input
                  type="checkbox"
                  checked={formState.fallbacks.venmail.enabled}
                  onChange={handleVenmailToggle}
                />
                Enable Venmail lookup fallback
              </label>
            </div>
            <label className="field">
              <span>Venmail API key</span>
              <input
                type="password"
                placeholder="•••••••"
                value={formState.fallbacks.venmail.apiKey}
                onChange={(event) => handleVenmailApiKeyChange(event.currentTarget.value)}
                disabled={!formState.fallbacks.venmail.enabled}
              />
            </label>
            <p className="settings-hint">
              Venmail activates only after standard scraping tasks and the ContactOut keyword search fail to surface an email.
            </p>
          </div>
        </div>

        <div className="settings-grid">
          <div>
            <h3>On-page detection</h3>
            <div className="field checkbox">
              <label>
                <input type="checkbox" checked={formState.detection.enabled} onChange={handleDetectionToggle} />
                Enable real-time detection
              </label>
            </div>
            <div className="polling-grid">
              <label className="field">
                <span>Polling interval (ms)</span>
                <input
                  type="number"
                  min={100}
                  step={100}
                  value={formState.detection.intervalMs}
                  onChange={(event) => handleDetectionFieldChange('intervalMs', event.currentTarget.value)}
                  disabled={!formState.detection.enabled}
                />
              </label>
              <label className="field">
                <span>Timeout (ms)</span>
                <input
                  type="number"
                  min={1000}
                  step={500}
                  value={formState.detection.timeoutMs}
                  onChange={(event) => handleDetectionFieldChange('timeoutMs', event.currentTarget.value)}
                  disabled={!formState.detection.enabled}
                />
              </label>
            </div>
          </div>

          <div>
            <h3>Custom API base</h3>
            <label className="field">
              <span>Endpoint</span>
              <input
                type="url"
                placeholder="https://api.your-agent.com"
                value={formState.apiBaseUrl}
                onChange={(event) => handleApiBaseUrlChange(event.currentTarget.value)}
              />
            </label>
          </div>
        </div>

        <button type="button" disabled={!hasUnsavedChanges || isSaving} onClick={handleSaveSettings}>
          {isSaving ? 'Saving…' : 'Save settings'}
        </button>
      </section>
    );
  };

  const renderSearchTab = (): JSX.Element => (
    <SearchView
      lookupForm={lookupForm}
      lookupErrors={lookupErrors}
      isFetching={isFetching}
      onFieldChange={handleLookupFieldChange}
      onSubmit={handleLookupSubmit}
      onRefreshSelection={() => (activeTabId ? requestSelectionFromTab(activeTabId) : undefined)}
      contextLookup={contextLookup}
      activeProgress={activeProgress}
      activeLookupKey={activeLookupKey}
    />
  );

  const renderDetectionTab = (): JSX.Element => (
    <div className="tab-scroll">
      <section className="insights-card">
        <h2>Detection snapshot</h2>
        <DetectionSnapshot snapshot={detectionSnapshot} onLookup={handleDetectionLookup} />
      </section>
    </div>
  );

  const renderResultTab = (): JSX.Element => {
    if (isFetching) {
      const fallbackStage = activeLookupKey
        ? {
            type: 'venmail-lookup-progress' as const,
            stage: 'Starting lookup…',
            timestamp: new Date().toISOString(),
            lookupKey: activeLookupKey
          }
        : null;

      return (
        <section className="insights-card lookup-progress">
          <h2>Lookup in progress</h2>
          <LookupProgressTimeline
            updates={activeProgress}
            fallbackStage={fallbackStage}
            emptyLabel="Awaiting task updates…"
          />
        </section>
      );
    }

    if (!reputation || !activeReputationSignals || !lastResponse) {
      return <p className="empty-state">Run a lookup to generate insights.</p>;
    }

    return (
      <div className="result-container">
        <div className="result-banner">
          <div>
            <h2>{lookupQuery}</h2>
            <span className="result-meta">Score {reputation.score} • {reputation.status}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            {lastFromCache ? (
              <button className="ghost-button ghost-button--muted" onClick={handleClearCache} title="Clear cached result">
                Clear cache
              </button>
            ) : null}
            <button className="ghost-button" onClick={handleExportToVenmail} title="Export this lookup to your Venmail account">
              <ExternalLink size={16} /> Export to Venmail
            </button>
            <button className="ghost-button" onClick={() => setViewMode('search')}>
              <EditIcon size={16} /> Edit search
            </button>
          </div>
        </div>

        <InsightSummary response={lastResponse} />

        <section className="insights-card">
          <h3>Reputation breakdown</h3>
          <ul>
            {explainReputation(reputation, activeReputationSignals).map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </section>
      </div>
    );
  };

  return (
    <div className="popup-container">
      <header>
        <div className="header-bar">
          <div>
            <h1>Venmail Agent</h1>
            <p className={`status status-${status.variant}`}>{status.label}</p>
          </div>
          <nav className="nav">
            <button
              type="button"
              className={viewMode === 'results' ? 'nav__item nav__item--active' : 'nav__item'}
              onClick={() => setViewMode('results')}
            >
              Results
            </button>
            <button
              type="button"
              className={viewMode === 'search' ? 'nav__item nav__item--active' : 'nav__item'}
              onClick={() => setViewMode('search')}
            >
              Search form
            </button>
            <button
              type="button"
              className={viewMode === 'detection' ? 'nav__item nav__item--active' : 'nav__item'}
              onClick={() => setViewMode('detection')}
            >
              Detection
            </button>
            <button
              type="button"
              className={viewMode === 'advanced' ? 'nav__item nav__item--active' : 'nav__item'}
              onClick={() => setViewMode('advanced')}
            >
              Advanced
            </button>
          </nav>
        </div>
      </header>

      <main className={`view-${viewMode}`}>
        {viewMode === 'results' && renderResultTab()}
        {viewMode === 'search' && renderSearchTab()}
        {viewMode === 'detection' && renderDetectionTab()}
        {viewMode === 'advanced' && renderAdvancedSettings()}
      </main>
    </div>
  );
}

function mapSettingsToForm(settings: ExtensionSettings): FormState {
  const toNumberString = (value?: number, fallback?: number): string => {
    const resolved = value ?? fallback;
    return typeof resolved === 'number' ? String(resolved) : '';
  };

  const toTaskFormState = (task: ExtensionSettings['scraping']['serp']): TaskConfigFormState => ({
    enabled: task.enabled,
    rateLimitMs: toNumberString(task.rateLimitMs),
    cacheTtlMs: toNumberString(task.cacheTtlMs)
  });

  const defaultVenmailFallback = DEFAULT_SETTINGS.fallbacks
    ? DEFAULT_SETTINGS.fallbacks.venmail ?? { enabled: false, apiKey: undefined }
    : { enabled: false, apiKey: undefined };

  return {
    apiBaseUrl: settings.apiBaseUrl ?? '',
    scraping: {
      serp: toTaskFormState(settings.scraping.serp),
      maps: toTaskFormState(settings.scraping.maps),
      profile: toTaskFormState(settings.scraping.profile),
      contact: toTaskFormState(settings.scraping.contact)
    },
    detection: {
      enabled: settings.detection.enabled,
      intervalMs: toNumberString(
        settings.detection.polling.intervalMs,
        DEFAULT_SETTINGS.detection.polling.intervalMs
      ),
      timeoutMs: toNumberString(
        settings.detection.polling.timeoutMs,
        DEFAULT_SETTINGS.detection.polling.timeoutMs
      )
    },
    fallbacks: {
      venmail: {
        enabled: settings.fallbacks.venmail?.enabled ?? defaultVenmailFallback.enabled ?? false,
        apiKey: settings.fallbacks.venmail?.apiKey ?? defaultVenmailFallback.apiKey ?? ''
      }
    }
  };
}

function parseOptionalNumber(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}


