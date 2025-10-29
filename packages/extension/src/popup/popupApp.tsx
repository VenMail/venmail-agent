import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ContactLookup,
  DetectedContactSnapshot,
  ExtensionResponseMessage,
  ExtensionSettings,
  FetchContactInfoMessage,
  ReputationResponse,
  SaveSettingsMessage,
  SelectionContext
} from '@venmail/shared';

import './popupApp.css';
import { DEFAULT_SETTINGS } from '../shared/settings';
import { safeSendMessage, safeSendTabsMessage } from '../shared/messaging';
import { ReputationBreakdown, ReputationSignals, explainReputation } from '@venmail/shared';
import { EditIcon } from 'lucide-react';

type StatusVariant = 'info' | 'success' | 'warning' | 'error';

interface StatusMessage {
  label: string;
  variant: StatusVariant;
}

type LookupHistoryEntry = {
  timestamp: number;
  durationMs: number;
  source: 'cache' | 'fresh' | 'error';
};

const LOOKUP_HISTORY_KEY = 'venmail_lookup_history';

function renderDetectionSnapshot(
  snapshot: DetectedContactSnapshot | null,
  onLookup: (value: string, type: 'email' | 'phone') => void
): JSX.Element {
  if (!snapshot || snapshot.contacts.length === 0) {
    return <p className="empty-state">No detected contacts yet.</p>;
  }

  return (
    <div className="detection-list">
      <p className="detection-meta">
        {snapshot.url ? (
          <>
            from{' '}
            <a href={snapshot.url} target="_blank" rel="noreferrer">
              {snapshot.title ?? snapshot.url}
            </a>
          </>
        ) : (
          'From this page'
        )}
      </p>
      <ul>
        {snapshot.contacts.map((contact) => (
          <li key={`${contact.type}:${contact.value}`}>
            <span className="contact-value">{contact.value}</span>
            <button type="button" onClick={() => onLookup(contact.value, contact.type)}>
              Lookup
            </button>
            {contact.context ? <span className="contact-context">{contact.context}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function renderMapsInsights(
  response: ReputationResponse | null,
  contextContext?: FetchContactInfoMessage['context']
): JSX.Element | null {
  const summary = response?.additionalData.mapSummary ?? contextContext?.mapSummary;
  if (!summary) {
    return null;
  }

  const { rating, reviewCount, statusText, categories, address, phone, sourceUrl, name } = summary;

  return (
    <section className="insights-card">
      <h2>Maps reputation</h2>
      <dl className="insights-list">
        {name ? (
          <div>
            <dt>Listing</dt>
            <dd>{name}</dd>
          </div>
        ) : null}

        {typeof rating === 'number' ? (
          <div>
            <dt>Rating</dt>
            <dd>{rating.toFixed(2)} / 5</dd>
          </div>
        ) : null}

        {typeof reviewCount === 'number' ? (
          <div>
            <dt>Reviews</dt>
            <dd>{reviewCount.toLocaleString()}</dd>
          </div>
        ) : null}

        {statusText ? (
          <div>
            <dt>Status</dt>
            <dd>{statusText}</dd>
          </div>
        ) : null}

        {categories?.length ? (
          <div>
            <dt>Categories</dt>
            <dd>{categories.join(', ')}</dd>
          </div>
        ) : null}

        {address ? (
          <div>
            <dt>Address</dt>
            <dd>{address}</dd>
          </div>
        ) : null}

        {phone ? (
          <div>
            <dt>Phone</dt>
            <dd>{phone}</dd>
          </div>
        ) : null}

        {sourceUrl ? (
          <div>
            <dt>Source</dt>
            <dd>
              <a href={sourceUrl} target="_blank" rel="noreferrer">
                View on Google Maps
              </a>
            </dd>
          </div>
        ) : null}
      </dl>
    </section>
  );
}

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
    hunter: {
      enabled: boolean;
      apiKey: string;
    };
    contactOut: {
      enabled: boolean;
      intervalMs: string;
      timeoutMs: string;
    };
  };
}

type ScrapeTaskKey = keyof FormState['scraping'];
type FallbackKey = keyof FormState['fallbacks'];

interface LookupFormState {
  name: string;
  email: string;
  domain: string;
  company: string;
}

type ViewMode = 'insights' | 'advanced';
type PopupMode = 'query' | 'result';

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
  const [viewMode, setViewMode] = useState<ViewMode>('insights');
  const [lookupLatencyMs, setLookupLatencyMs] = useState<number | null>(null);
  const [lookupHistory, setLookupHistory] = useState<LookupHistoryEntry[]>([]);
  const [lastLookupRequest, setLastLookupRequest] = useState<ContactLookup | null>(null);
  const [debugLoggingEnabled, setDebugLoggingEnabled] = useState<boolean>(() => {
    try {
      const stored = localStorage.getItem('venmail_debug_logging');
      return stored ? stored === 'true' : false;
    } catch {
      return false;
    }
  });
  const [mode, setMode] = useState<PopupMode>('query');
  const [lookupQuery, setLookupQuery] = useState('');
  const [reputation, setReputation] = useState<ReputationBreakdown | null>(null);
  const [reputationSignals, setReputationSignals] = useState<ReputationSignals | null>(null);
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

  useEffect(() => {
    if (!chrome?.storage?.local) {
      return;
    }

    chrome.storage.local.get(LOOKUP_HISTORY_KEY, (result) => {
      if (chrome.runtime.lastError) {
        console.warn('[venmail] Failed to load lookup history:', chrome.runtime.lastError.message);
        return;
      }

      const stored = result?.[LOOKUP_HISTORY_KEY];
      if (!Array.isArray(stored)) {
        return;
      }

      const normalized = stored.filter((entry: unknown): entry is LookupHistoryEntry => {
        if (!entry || typeof entry !== 'object') {
          return false;
        }
        const candidate = entry as Partial<LookupHistoryEntry>;
        return (
          typeof candidate.timestamp === 'number' &&
          typeof candidate.durationMs === 'number' &&
          (candidate.source === 'cache' || candidate.source === 'fresh' || candidate.source === 'error')
        );
      });

      if (!normalized.length) {
        return;
      }

      const trimmed = normalized.slice(-10);
      setLookupHistory(trimmed);
      setLookupLatencyMs(trimmed[trimmed.length - 1]?.durationMs ?? null);
    });
  }, []);

  const appendLookupHistory = useCallback((entry: LookupHistoryEntry) => {
    setLookupHistory((prev) => {
      const next = [...prev, entry].slice(-10);
      if (chrome?.storage?.local) {
        chrome.storage.local.set({ [LOOKUP_HISTORY_KEY]: next }, () => {
          if (chrome.runtime.lastError) {
            console.warn('[venmail] Failed to persist lookup history:', chrome.runtime.lastError.message);
          }
        });
      }
      return next;
    });
  }, []);

  const handleToggleDebugLogging = useCallback(() => {
    setDebugLoggingEnabled((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('venmail_debug_logging', String(next));
      } catch {
        // ignore persistence failures
      }
      return next;
    });
  }, []);

  const handleClearLookupHistory = useCallback(() => {
    setLookupHistory([]);
    setLookupLatencyMs(null);
    if (chrome?.storage?.local) {
      chrome.storage.local.remove(LOOKUP_HISTORY_KEY, () => {
        void chrome.runtime.lastError;
      });
    }
  }, []);

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
    (lookup: ContactLookup) => {
      setIsFetching(true);
      const startTime = performance.now();
      const request: FetchContactInfoMessage = {
        action: 'fetchContactInfo',
        email: lookup.email,
        name: lookup.name,
        domain: lookup.domain,
        company: lookup.company
      };

      setLastLookupRequest({
        email: lookup.email,
        name: lookup.name,
        domain: lookup.domain,
        company: lookup.company
      });

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

        setLookupLatencyMs(duration);
        if (debugLoggingEnabled) {
          console.info('[venmail] Lookup completed in %dms (%s)', Math.round(duration), source);
        }

        if (chrome.runtime.lastError) {
          setStatus({
            label: `${chrome.runtime.lastError.message ?? 'Lookup failed'} after ${Math.round(duration)}ms`,
            variant: 'error'
          });
          appendLookupHistory({ timestamp: Date.now(), durationMs: duration, source });
          return;
        }

        if (response?.success && response.data) {
          setLastResponse(response.data);
          const baseLabel = response.meta?.fromCache ? 'Insights loaded from cache' : 'Fresh insights ready';
          setStatus({ label: `${baseLabel} in ${Math.round(duration)}ms`, variant: 'success' });
          appendLookupHistory({ timestamp: Date.now(), durationMs: duration, source });
        } else {
          setStatus({ label: `${response?.error ?? 'Lookup failed'} after ${Math.round(duration)}ms`, variant: 'error' });
          appendLookupHistory({ timestamp: Date.now(), durationMs: duration, source });
        }
      });
    },
    [appendLookupHistory, debugLoggingEnabled, setStatus]
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
      performLookup({ ...lookupForm });
    },
    [performLookup, lookupForm, validateLookupForm]
  );

  const handleRefreshLookup = useCallback(() => {
    if (!lastLookupRequest || isFetching) {
      return;
    }
    performLookup({ ...lastLookupRequest });
  }, [isFetching, lastLookupRequest, performLookup]);

  const handleDetectionLookup = useCallback(
    (value: string, type: 'email' | 'phone') => {
      if (type === 'email') {
        performLookup({ email: value });
      } else {
        performLookup({ name: value });
      }
    },
    [performLookup]
  );

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
      };

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
    };

    chrome.runtime.onMessage.addListener(listener);

    return () => {
      chrome.runtime.onMessage.removeListener(listener);
    };
  }, [activeTabId]);

  const hasUnsavedChanges = useMemo(() => {
    if (!settings || !formState) {
      return false;
    }

    return JSON.stringify(mapSettingsToForm(settings)) !== JSON.stringify(formState);
  }, [settings, formState]);

  const sanitizeNumberInput = (value: string): string => value.replace(/[^0-9]/g, '');

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

  const handleFallbackToggle = (fallback: FallbackKey) => {
    updateFormState((prev) => ({
      ...prev,
      fallbacks: {
        ...prev.fallbacks,
        [fallback]: {
          ...prev.fallbacks[fallback],
          enabled: !prev.fallbacks[fallback].enabled
        }
      }
    }));
  };

  const handleFallbackHunterApiKeyChange = (value: string) => {
    updateFormState((prev) => ({
      ...prev,
      fallbacks: {
        ...prev.fallbacks,
        hunter: {
          ...prev.fallbacks.hunter,
          apiKey: value
        }
      }
    }));
  };

  const handleFallbackPollingChange = (field: 'intervalMs' | 'timeoutMs', value: string) => {
    const sanitized = sanitizeNumberInput(value);
    updateFormState((prev) => ({
      ...prev,
      fallbacks: {
        ...prev.fallbacks,
        contactOut: {
          ...prev.fallbacks.contactOut,
          [field]: sanitized
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
          hunter: {
            enabled: formState.fallbacks.hunter.enabled,
            apiKey: formState.fallbacks.hunter.apiKey.trim() || undefined
          },
          contactOut: {
            enabled: formState.fallbacks.contactOut.enabled,
            polling: {
              intervalMs: parseOptionalNumber(formState.fallbacks.contactOut.intervalMs),
              timeoutMs: parseOptionalNumber(formState.fallbacks.contactOut.timeoutMs)
            }
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
                  checked={formState.fallbacks.hunter.enabled}
                  onChange={() => handleFallbackToggle('hunter')}
                />
                Allow Hunter.io verification
              </label>
            </div>
            <label className="field">
              <span>Hunter.io API key</span>
              <input
                type="password"
                placeholder="•••••••"
                value={formState.fallbacks.hunter.apiKey}
                onChange={(event) => handleFallbackHunterApiKeyChange(event.currentTarget.value)}
                disabled={!formState.fallbacks.hunter.enabled}
              />
            </label>

            <div className="field checkbox">
              <label>
                <input
                  type="checkbox"
                  checked={formState.fallbacks.contactOut.enabled}
                  onChange={() => handleFallbackToggle('contactOut')}
                />
                Enable ContactOut capture
              </label>
            </div>
            <div className="polling-grid">
              <label className="field">
                <span>Polling interval (ms)</span>
                <input
                  type="number"
                  min={100}
                  step={100}
                  value={formState.fallbacks.contactOut.intervalMs}
                  onChange={(event) => handleFallbackPollingChange('intervalMs', event.currentTarget.value)}
                  disabled={!formState.fallbacks.contactOut.enabled}
                />
              </label>
              <label className="field">
                <span>Timeout (ms)</span>
                <input
                  type="number"
                  min={1000}
                  step={500}
                  value={formState.fallbacks.contactOut.timeoutMs}
                  onChange={(event) => handleFallbackPollingChange('timeoutMs', event.currentTarget.value)}
                  disabled={!formState.fallbacks.contactOut.enabled}
                />
              </label>
            </div>
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

  const renderReputation = (response: ReputationResponse | null): JSX.Element => {
    if (!response) {
      return <p className="empty-state">Run a lookup to see reputation insights.</p>;
    }

    const { additionalData, reputation, companyInfo, socialProfiles } = response;
    const phoneNumbers = additionalData.phoneNumbers ?? [];
    const locations = additionalData.locations ?? [];
    const socialEntries = Object.entries(socialProfiles).filter(([, url]) => Boolean(url)) as [string, string][];
    const reputationSources = reputation.sources.slice(0, 4);
    const actionableTakeaways: { label: string; tone: 'positive' | 'warning' | 'info'; action?: () => void }[] = [];
    const badges: { label: string; tone: 'positive' | 'info' | 'neutral' }[] = [];
    const confidenceScores = additionalData.confidenceScores ?? {};

    if (reputation.status === 'verified' || reputation.score >= 80) {
      actionableTakeaways.push({ label: 'Profile looks strong — share contact with confidence.', tone: 'positive' });
      badges.push({ label: 'Verified reputation', tone: 'positive' });
    }

    if (additionalData.trustedSources?.length) {
      actionableTakeaways.push({
        label: `Trusted sources found on ${additionalData.trustedSources.length} site${
          additionalData.trustedSources.length > 1 ? 's' : ''
        }.`,
        tone: 'positive'
      });
      badges.push({ label: 'Trusted sources confirmed', tone: 'positive' });
    }

    if (additionalData.mapSummary?.rating && additionalData.mapSummary.rating >= 4.2) {
      actionableTakeaways.push({
        label: `Excellent Maps presence (${additionalData.mapSummary.rating.toFixed(1)}/5).`,
        tone: 'positive'
      });
      badges.push({ label: `${additionalData.mapSummary.rating.toFixed(1)}★ on Maps`, tone: 'positive' });
    }

    if (additionalData.negativeMentions?.length) {
      actionableTakeaways.push({
        label: `Investigate ${additionalData.negativeMentions.length} negative mention${
          additionalData.negativeMentions.length > 1 ? 's' : ''
        }.`,
        tone: 'warning'
      });
    }

    if ((confidenceScores.social ?? 0) >= 60) {
      actionableTakeaways.push({
        label: 'Follow up on LinkedIn — strong social presence detected.',
        tone: 'positive',
        action: additionalData.socialLinks?.linkedin
          ? () => window.open(additionalData.socialLinks?.linkedin, '_blank')
          : undefined
      });
      badges.push({ label: 'Strong social presence', tone: 'positive' });
    }

    if ((confidenceScores.contact ?? 0) >= 60) {
      actionableTakeaways.push({
        label: 'Call or email using verified contact channel.',
        tone: 'positive'
      });
      badges.push({ label: 'Contact channel verified', tone: 'positive' });
    }

    if (!badges.length) {
      badges.push({ label: 'Signals still building', tone: 'neutral' });
    }

    if (!actionableTakeaways.length) {
      actionableTakeaways.push({
        label: 'Gather more signals to enrich this profile.',
        tone: 'info'
      });
    }

    const quickStats = [
      {
        label: 'Reputation score',
        value: reputation.score.toString(),
        detail: reputation.status
      },
      {
        label: 'Email status',
        value: additionalData.verifiedEmail ? 'Verified' : 'Unverified',
        detail: additionalData.verifiedEmail ? 'Delivery safe' : 'Needs validation'
      },
      {
        label: 'Phone signals',
        value: phoneNumbers.length > 0 ? phoneNumbers[0] : 'Not surfaced',
        detail: phoneNumbers.length > 1 ? `+${phoneNumbers.length - 1} more` : undefined
      },
      {
        label: 'Geo presence',
        value: locations.length > 0 ? locations[0] : 'Not detected',
        detail: locations.length > 1 ? `+${locations.length - 1} regions` : undefined
      }
    ];

    return (
      <section className="insight-card insight-summary">
        <div className="insight-card__header">
          <h2>Insight summary</h2>
          <span className="tag">Updated {response.generatedAt ? new Date(response.generatedAt).toLocaleTimeString() : 'moments ago'}</span>
        </div>

        <ul className="insight-actions">
          {actionableTakeaways.map((item, index) => (
            <li key={`${item.label}-${index}`} className={`insight-actions__item insight-actions__item--${item.tone}`}>
              <button type="button" onClick={item.action} disabled={!item.action} className={item.action ? 'insight-actions__cta' : undefined}>
                {item.label}
              </button>
            </li>
          ))}
        </ul>

        <div className="insight-badges">
          {badges.map((badge, index) => (
            <span key={`${badge.label}-${index}`} className={`insight-badge insight-badge--${badge.tone}`}>
              {badge.label}
            </span>
          ))}
        </div>

        <div className="insight-highlights">
          {quickStats.map((item) => (
            <div key={item.label} className="highlight-card">
              <span className="highlight-label">{item.label}</span>
              <span className="highlight-value">{item.value}</span>
              {item.detail && <span className="highlight-detail">{item.detail}</span>}
            </div>
          ))}
        </div>

        <div className="insight-body">
          <div className="insight-section">
            <h3>Company profile</h3>
            <dl className="insight-list">
              <div>
                <dt>Name</dt>
                <dd>{companyInfo.name || 'Unavailable'}</dd>
              </div>
              <div>
                <dt>Website</dt>
                <dd>{companyInfo.website ? <a href={companyInfo.website} target="_blank" rel="noreferrer">{companyInfo.website}</a> : 'Unavailable'}</dd>
              </div>
              {companyInfo.industry && (
                <div>
                  <dt>Industry</dt>
                  <dd>{companyInfo.industry}</dd>
                </div>
              )}
              {companyInfo.size && (
                <div>
                  <dt>Team size</dt>
                  <dd>{companyInfo.size}</dd>
                </div>
              )}
            </dl>
          </div>

          <div className="insight-section">
            <h3>Digital presence</h3>
            {socialEntries.length > 0 ? (
              <ul className="insight-links">
                {socialEntries.map(([platform, url]) => (
                  <li key={platform}>
                    <a href={url} target="_blank" rel="noreferrer">
                      {platform}
                    </a>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="insight-placeholder">No public profiles detected yet.</p>
            )}
          </div>

          <div className="insight-section">
            <h3>Signals referenced</h3>
            {reputationSources.length > 0 ? (
              <ul className="insight-pills">
                {reputationSources.map((source) => (
                  <li key={source}>{source}</li>
                ))}
              </ul>
            ) : (
              <p className="insight-placeholder">Signals will appear here once gathered.</p>
            )}
          </div>
        </div>
      </section>
    );
  };

  const renderInsights = () => (
    <>
      <section className="lookup-card">
        <header className="lookup-card__header">
          <div>
            <h2>Smart lookup</h2>
            <p>Context-aware fields pull from page selection automatically.</p>
          </div>
          <button type="button" className="ghost-button" onClick={() => (activeTabId ? requestSelectionFromTab(activeTabId) : undefined)}>
            Refresh selection
          </button>
        </header>

        <div className="lookup-card__body">
          <aside className="callout info">
            <strong>Tip:</strong> Highlight a name or email on the page and relaunch the popup to prefill the form instantly.
          </aside>

          <form className="lookup-form" onSubmit={handleLookupSubmit}>
            <div className="lookup-grid lookup-grid--two">
              <div className="field">
                <label className="field__label">Name</label>
                <input
                  type="text"
                  autoComplete="name"
                  placeholder="e.g. Jane Doe"
                  value={lookupForm.name}
                  onChange={(event) => handleLookupFieldChange('name', event.currentTarget.value)}
                />
                {lookupErrors.name && <span className="field__error">{lookupErrors.name}</span>}
              </div>

              <div className="field">
                <label className="field__label">Email</label>
                <input
                  type="email"
                  autoComplete="email"
                  placeholder="jane@example.com"
                  value={lookupForm.email}
                  onChange={(event) => handleLookupFieldChange('email', event.currentTarget.value)}
                />
                {lookupErrors.email && <span className="field__error">{lookupErrors.email}</span>}
              </div>

              <div className="field">
                <label className="field__label">Domain</label>
                <input
                  type="text"
                  inputMode="url"
                  placeholder="example.com"
                  value={lookupForm.domain}
                  onChange={(event) => handleLookupFieldChange('domain', event.currentTarget.value)}
                />
                {lookupErrors.domain && <span className="field__error">{lookupErrors.domain}</span>}
              </div>

              <div className="field">
                <label className="field__label">Company</label>
                <input
                  type="text"
                  placeholder="e.g. Example Inc."
                  value={lookupForm.company}
                  onChange={(event) => handleLookupFieldChange('company', event.currentTarget.value)}
                />
              </div>
            </div>

            <footer className="lookup-actions">
              <button type="submit" disabled={isFetching}>
                {isFetching ? 'Gathering insights…' : 'Reveal profile insights'}
              </button>

              <div className="lookup-status">
                {contextLookup?.updatedAt ? (
                  <div className="recent-lookup">
                    <span className="recent-lookup__label">Last request</span>
                    <div className="recent-lookup__meta">
                      <span>{new Date(contextLookup.updatedAt).toLocaleTimeString()}</span>
                      {contextLookup.error ? <span className="recent-lookup__error">{contextLookup.error}</span> : <span>Ready</span>}
                    </div>
                  </div>
                ) : (
                  <p className="lookup-hint">Run a search to populate insights below.</p>
                )}
              </div>
            </footer>
          </form>
        </div>
      </section>

      <section className="insights-card">
        <div className="insights-card__header">
          <h2>Signals & reputation</h2>
          <button
            type="button"
            className="ghost-button"
            onClick={handleRefreshLookup}
            disabled={!lastLookupRequest || isFetching}
          >
            {isFetching ? 'Refreshing…' : 'Refresh insights'}
          </button>
        </div>
        {renderReputation(lastResponse)}
      </section>

      {renderMapsInsights(lastResponse, contextLookup?.context)}

      <section className="insights-card">
        <h2>Detection snapshot</h2>
        {renderDetectionSnapshot(detectionSnapshot, handleDetectionLookup)}
      </section>

      {(lookupLatencyMs !== null || lookupHistory.length) ? (
        <section className="insights-card insights-card--meta">
          <h2>Performance</h2>
          {lookupLatencyMs !== null ? (
            <p className="insight-placeholder">Last lookup completed in {Math.round(lookupLatencyMs)}ms.</p>
          ) : null}
          <div className="performance-controls">
            <label className="field checkbox">
              <input type="checkbox" checked={debugLoggingEnabled} onChange={handleToggleDebugLogging} /> Enable debug logging
            </label>
            <button type="button" className="ghost-button" onClick={handleClearLookupHistory} disabled={!lookupHistory.length}>
              Clear history
            </button>
          </div>
          {lookupHistory.length ? (
            <ul className="performance-history">
              {lookupHistory
                .slice()
                .reverse()
                .map((entry, index) => (
                  <li key={entry.timestamp} className={`performance-history__item performance-history__item--${entry.source}`}>
                    <span>{new Date(entry.timestamp).toLocaleTimeString()}</span>
                    <span>{Math.round(entry.durationMs)}ms</span>
                    <span>{entry.source}</span>
                  </li>
                ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {mode === 'result' && reputation && (
        <div className="result-container">
          <div className="header">
            <h2>{lookupQuery}</h2>
            <button 
              className="edit-btn"
              onClick={() => setMode('query')}
            >
              <EditIcon size={16} /> Edit Search
            </button>
          </div>
          
          <div className="reputation-badge">
            <div className="score">{reputation.score}</div>
            <div className="status">{reputation.status}</div>
          </div>
          
          <div className="explanation">
            <h3>Reputation Breakdown</h3>
            <ul>
              {explainReputation(reputation, reputationSignals).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </>
  );

  const renderResult = () => {
    if (mode === 'query') {
      return renderInsights();
    } else {
      return (
        <div className="result-container">
          <div className="header">
            <h2>{lookupQuery}</h2>
            <button 
              className="edit-btn"
              onClick={() => setMode('query')}
            >
              <EditIcon size={16} /> Edit Search
            </button>
          </div>
          
          <div className="reputation-badge">
            <div className="score">{reputation.score}</div>
            <div className="status">{reputation.status}</div>
          </div>
          
          <div className="explanation">
            <h3>Reputation Breakdown</h3>
            <ul>
              {explainReputation(reputation, reputationSignals).map((line, i) => (
                <li key={i}>{line}</li>
              ))}
            </ul>
          </div>
        </div>
      );
    }
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
              className={viewMode === 'insights' ? 'nav__item nav__item--active' : 'nav__item'}
              onClick={() => setViewMode('insights')}
            >
              Insights
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

      <main className={`view-${viewMode}`}>{viewMode === 'insights' ? renderResult() : renderAdvancedSettings()}</main>
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
      hunter: {
        enabled: settings.fallbacks.hunter?.enabled ?? false,
        apiKey: settings.fallbacks.hunter?.apiKey ?? ''
      },
      contactOut: {
        enabled: settings.fallbacks.contactOut?.enabled ?? false,
        intervalMs: toNumberString(
          settings.fallbacks.contactOut?.polling?.intervalMs,
          DEFAULT_SETTINGS.fallbacks.contactOut?.polling?.intervalMs
        ),
        timeoutMs: toNumberString(
          settings.fallbacks.contactOut?.polling?.timeoutMs,
          DEFAULT_SETTINGS.fallbacks.contactOut?.polling?.timeoutMs
        )
      }
    }
  };
}

function parseOptionalNumber(value: string): number | undefined {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function InsightSummary({ response }: { response: ReputationResponse }): JSX.Element {
  const { additionalData, reputation, companyInfo, socialProfiles } = response;
  const phoneNumbers = additionalData.phoneNumbers ?? [];
  const locations = additionalData.locations ?? [];
  const socialEntries = Object.entries(socialProfiles).filter(([, url]) => Boolean(url)) as [string, string][];
  const reputationSources = reputation.sources.slice(0, 4);
  const quickStats = [
    {
      label: 'Reputation score',
      value: reputation.score.toString(),
      detail: reputation.status
    },
    {
      label: 'Email status',
      value: additionalData.verifiedEmail ? 'Verified' : 'Unverified',
      detail: additionalData.verifiedEmail ? 'Delivery safe' : 'Needs validation'
    },
    {
      label: 'Phone signals',
      value: phoneNumbers.length > 0 ? phoneNumbers[0] : 'Not surfaced',
      detail: phoneNumbers.length > 1 ? `+${phoneNumbers.length - 1} more` : undefined
    },
    {
      label: 'Geo presence',
      value: locations.length > 0 ? locations[0] : 'Not detected',
      detail: locations.length > 1 ? `+${locations.length - 1} regions` : undefined
    }
  ];

  return (
    <section className="insight-card insight-summary">
      <div className="insight-card__header">
        <h2>Insight summary</h2>
        <span className="tag">Updated {response.generatedAt ? new Date(response.generatedAt).toLocaleTimeString() : 'moments ago'}</span>
      </div>

      <div className="insight-highlights">
        {quickStats.map((item) => (
          <div key={item.label} className="highlight-card">
            <span className="highlight-label">{item.label}</span>
            <span className="highlight-value">{item.value}</span>
            {item.detail && <span className="highlight-detail">{item.detail}</span>}
          </div>
        ))}
      </div>

      <div className="insight-body">
        <div className="insight-section">
          <h3>Company profile</h3>
          <dl className="insight-list">
            <div>
              <dt>Name</dt>
              <dd>{companyInfo.name || 'Unavailable'}</dd>
            </div>
            <div>
              <dt>Website</dt>
              <dd>{companyInfo.website ? <a href={companyInfo.website} target="_blank" rel="noreferrer">{companyInfo.website}</a> : 'Unavailable'}</dd>
            </div>
            {companyInfo.industry && (
              <div>
                <dt>Industry</dt>
                <dd>{companyInfo.industry}</dd>
              </div>
            )}
            {companyInfo.size && (
              <div>
                <dt>Team size</dt>
                <dd>{companyInfo.size}</dd>
              </div>
            )}
          </dl>
        </div>

        <div className="insight-section">
          <h3>Digital presence</h3>
          {socialEntries.length > 0 ? (
            <ul className="insight-links">
              {socialEntries.map(([platform, url]) => (
                <li key={platform}>
                  <a href={url} target="_blank" rel="noreferrer">
                    {platform}
                  </a>
                </li>
              ))}
            </ul>
          ) : (
            <p className="insight-placeholder">No public profiles detected yet.</p>
          )}
        </div>

        <div className="insight-section">
          <h3>Signals referenced</h3>
          {reputationSources.length > 0 ? (
            <ul className="insight-pills">
              {reputationSources.map((source) => (
                <li key={source}>{source}</li>
              ))}
            </ul>
          ) : (
            <p className="insight-placeholder">Signals will appear here once gathered.</p>
          )}
        </div>
      </div>
    </section>
  );
}
