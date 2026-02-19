import type {
  ContactLookup,
  DetectedContactSnapshot,
  ExtensionMessage,
  ExtensionResponseMessage,
  ExtensionResponseMeta,
  ExtensionSettings,
  FetchContactInfoMessage,
  GetDetectedContactsMessage,
  LookupProgressUpdate,
  RegisterDetectedContactsMessage,
  ReputationResponse,
  SelectionContext,
  MapReputationSummary,
  GetSearchHistoryMessage,
  SaveSearchHistoryEntryMessage,
  DeleteSearchHistoryEntryMessage,
  ClearSearchHistoryMessage
} from '@venmail/shared';
import { validateLookup } from '@venmail/shared';

import { orchestrateLookup } from './orchestrator';
import {
  loadSettings,
  saveSettings,
  saveDetectionSnapshot,
  getDetectionSnapshot,
  clearDetectionSnapshot,
  loadLastContextLookup,
  saveLastContextLookup,
  getSearchHistory,
  saveSearchHistoryEntry,
  deleteSearchHistoryEntry,
  clearSearchHistory
} from './storage';

let pendingPopupLookup: { lookup: ContactLookup; context?: FetchContactInfoMessage['context'] } | null = null;

chrome.runtime.onMessage.addListener(
  (message: ExtensionMessage, sender: chrome.runtime.MessageSender, sendResponse): boolean => {
    void handleMessage(message, sender.tab?.id)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => {
        console.error('Venmail background error', error);
        sendResponse(buildErrorResponse(error));
      });

    return true;
  }
);

chrome.runtime.onMessageExternal.addListener(
  (message: ExtensionMessage, _sender, sendResponse): boolean => {
    void handleMessage(message)
      .then((response) => sendResponse(response))
      .catch((error: unknown) => sendResponse(buildErrorResponse(error)));

    return true;
  }
);

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'venmail-lookup-selection',
    title: 'Look up "%s" with Venmail',
    contexts: ['selection']
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'venmail-lookup-selection' || !info.selectionText) {
    return;
  }

  const lookup: ContactLookup = { name: info.selectionText?.trim() };
  const context: FetchContactInfoMessage['context'] | undefined = tab?.id
    ? {
        tabId: tab.id,
        pageUrl: tab.url,
        pageTitle: tab.title
      }
    : undefined;

  void openActionPopupWithLookup({ lookup, context }).catch((error) => {
    console.warn('[venmail] failed to open popup from context menu', error);
  });
});

async function openActionPopupWithLookup(payload: {
  lookup: ContactLookup;
  context?: FetchContactInfoMessage['context'];
}): Promise<void> {
  pendingPopupLookup = payload;
  try {
    await chrome.action.openPopup();
  } catch (error) {
    // In some Chromium builds, openPopup rejects if already open; ignore
    console.debug('[venmail] chrome.action.openPopup failed', error);
  }

  flushPendingPopupLookup();
}

function flushPendingPopupLookup(): void {
  if (!pendingPopupLookup) {
    return;
  }

  chrome.runtime.sendMessage(
    {
      type: 'venmail-pending-lookup',
      pendingLookup: pendingPopupLookup
    },
    () => {
      if (!chrome.runtime.lastError) {
        pendingPopupLookup = null;
      }
    }
  );
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void clearDetectionSnapshot(tabId).then(() => notifyDetectionUpdate(tabId, null)).catch(() => undefined);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    void clearDetectionSnapshot(tabId).then(() => notifyDetectionUpdate(tabId, null)).catch(() => undefined);
  }
});

async function handleMessage(message: ExtensionMessage, tabId?: number): Promise<ExtensionResponseMessage> {
  switch (message.action) {
    case 'ping':
      return {
        success: true,
        meta: { notes: ['pong'] }
      } satisfies ExtensionResponseMessage;

    case 'getSettings': {
      const settings = await loadSettings();
      return {
        success: true,
        settings,
        meta: { notes: ['settings_loaded'] }
      } satisfies ExtensionResponseMessage;
    }

    case 'saveSettings': {
      const updated = await saveSettings(message.settings ?? {});
      notifySettingsUpdated(updated);
      return {
        success: true,
        settings: updated,
        meta: { notes: ['settings_saved'] }
      } satisfies ExtensionResponseMessage;
    }

    case 'fetchContactInfo':
      return handleFetchContactInfo(message, tabId);

    case 'registerDetectedContacts':
      return handleRegisterDetectedContacts(message, tabId);

    case 'getDetectedContacts':
      return handleGetDetectedContacts(message);

    case 'getLastContextLookup':
      return handleGetLastContextLookup();

    case 'popupReady': {
      const pending = pendingPopupLookup;
      if (pending) {
        pendingPopupLookup = null;
      }
      return {
        success: true,
        pendingLookup: pending ?? undefined,
        meta: { notes: ['popup_ready'] }
      } satisfies ExtensionResponseMessage;
    }

    case 'getSearchHistory': {
      const history = await getSearchHistory();
      return {
        success: true,
        searchHistory: history,
        meta: { notes: ['search_history_loaded'] }
      } satisfies ExtensionResponseMessage;
    }

    case 'saveSearchHistoryEntry': {
      await saveSearchHistoryEntry(message.entry);
      return {
        success: true,
        meta: { notes: ['search_history_entry_saved'] }
      } satisfies ExtensionResponseMessage;
    }

    case 'deleteSearchHistoryEntry': {
      await deleteSearchHistoryEntry(message.timestamp);
      return {
        success: true,
        meta: { notes: ['search_history_entry_deleted'] }
      } satisfies ExtensionResponseMessage;
    }

    case 'clearSearchHistory': {
      await clearSearchHistory();
      return {
        success: true,
        meta: { notes: ['search_history_cleared'] }
      } satisfies ExtensionResponseMessage;
    }

    default:
      return buildErrorResponse(`Unknown action: ${(message as ExtensionMessage).action ?? 'n/a'}`);
  }
}

async function handleFetchContactInfo(
  message: FetchContactInfoMessage,
  tabId?: number
): Promise<ExtensionResponseMessage> {
  const context = await resolveLookupContext(message, tabId);
  const lookup = enrichLookupFromContext(
    {
      email: message.email,
      name: message.name,
      domain: message.domain,
      company: message.company
    },
    context
  );

  const validation = validateLookup(lookup);
  if (!validation.valid) {
    return buildErrorResponse(validation.errors[0] ?? 'Invalid lookup request', {
      notes: validation.errors,
      fromCache: false
    });
  }

  try {
    const { response, fromCache, notes } = await orchestrateLookup(lookup, {
      context,
      onProgress: (update) => notifyLookupProgress(update)
    });

    const meta: ExtensionResponseMeta = {
      fromCache,
      notes
    };

    await saveLastContextLookup({
      request: lookup,
      response,
      updatedAt: Date.now(),
      context
    });

    notifyContextLookupUpdate({
      request: lookup,
      response,
      updatedAt: new Date().toISOString(),
      context
    });

    return {
      success: true,
      data: response,
      meta,
      contextLookup: {
        request: lookup,
        response,
        updatedAt: new Date().toISOString()
      }
    } satisfies ExtensionResponseMessage;
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error ?? 'Unknown error');
    await saveLastContextLookup({
      request: lookup,
      error: messageText,
      updatedAt: Date.now(),
      context
    });
    notifyContextLookupUpdate({
      request: lookup,
      error: messageText,
      updatedAt: new Date().toISOString(),
      context
    });
    return buildErrorResponse(messageText, {
      fromCache: false,
      notes: [messageText]
    });
  }
}

async function handleRegisterDetectedContacts(
  message: RegisterDetectedContactsMessage,
  tabId?: number
): Promise<ExtensionResponseMessage> {
  if (!tabId) {
    return buildErrorResponse('No tab id supplied for detection snapshot');
  }

  const entry = await saveDetectionSnapshot(tabId, message.snapshot);

  notifyDetectionUpdate(tabId, entry.snapshot);

  return {
    success: true,
    detection: {
      tabId,
      snapshot: entry.snapshot
    }
  } satisfies ExtensionResponseMessage;
}

async function handleGetDetectedContacts(
  message: GetDetectedContactsMessage
): Promise<ExtensionResponseMessage> {
  const tabId = message.tabId;

  if (typeof tabId !== 'number') {
    return buildErrorResponse('tabId required for getDetectedContacts');
  }

  const entry = await getDetectionSnapshot(tabId);

  notifyDetectionUpdate(tabId, entry?.snapshot ?? null);

  return {
    success: true,
    detection: {
      tabId,
      snapshot: entry?.snapshot ?? null
    }
  } satisfies ExtensionResponseMessage;
}

async function handleGetLastContextLookup(): Promise<ExtensionResponseMessage> {
  const entry = await loadLastContextLookup();

  return {
    success: true,
    contextLookup: entry
      ? {
          request: entry.request,
          response: entry.response,
          error: entry.error,
          updatedAt: new Date(entry.updatedAt).toISOString()
        }
      : undefined
  } satisfies ExtensionResponseMessage;
}

function buildErrorResponse(error: unknown, meta?: ExtensionResponseMeta): ExtensionResponseMessage {
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return {
    success: false,
    error: message,
    meta
  };
}

function notifySettingsUpdated(settings: ExtensionSettings): void {
  chrome.runtime.sendMessage({ type: 'venmail-settings-updated', settings }, () => {
    void chrome.runtime.lastError;
  });

  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') {
        continue;
      }

      chrome.tabs.sendMessage(tab.id, { type: 'venmail-settings-updated', settings }, () => {
        void chrome.runtime.lastError;
      });
    }
  });
}

function notifyDetectionUpdate(tabId: number, snapshot: DetectedContactSnapshot | null): void {
  chrome.runtime.sendMessage({ type: 'venmail-detection-updated', detection: { tabId, snapshot } }, () => {
    void chrome.runtime.lastError;
  });
}

function notifyContextLookupUpdate(payload: {
  request?: ContactLookup;
  response?: ReputationResponse;
  error?: string;
  updatedAt?: string;
  context?: FetchContactInfoMessage['context'];
}): void {
  chrome.runtime.sendMessage({ type: 'venmail-context-lookup', contextLookup: payload }, () => {
    void chrome.runtime.lastError;
  });
}

function notifyLookupProgress(update: LookupProgressUpdate): void {
  chrome.runtime.sendMessage(update, () => {
    void chrome.runtime.lastError;
  });
}

async function resolveLookupContext(
  message: FetchContactInfoMessage,
  tabId?: number
): Promise<FetchContactInfoMessage['context'] | undefined> {
  const baseContext = message.context ?? {};

  const [selectionFromTab, tabMeta, mapSummary] = await Promise.all([
    baseContext.selection ? Promise.resolve(undefined) : requestSelectionContext(tabId),
    resolveTabMeta(tabId),
    baseContext.mapSummary ? Promise.resolve(baseContext.mapSummary) : requestMapSummary(tabId, baseContext.mapsQuery)
  ]);

  const selection = baseContext.selection ?? selectionFromTab ?? undefined;
  const context: FetchContactInfoMessage['context'] | undefined = selection
    ? { ...baseContext, selection }
    : Object.keys(baseContext).length
    ? { ...baseContext }
    : undefined;

  const pageUrl = baseContext.pageUrl ?? tabMeta.pageUrl;
  const pageTitle = baseContext.pageTitle ?? tabMeta.pageTitle;

  if (!context && !pageUrl && !pageTitle && !tabId) {
    return undefined;
  }

  return {
    ...context,
    pageUrl,
    pageTitle,
    tabId: baseContext.tabId ?? tabId,
    mapSummary: mapSummary ?? undefined,
    mapsQuery: baseContext.mapsQuery ?? deriveMapsQuery(baseContext, selection)
  };
}

async function requestSelectionContext(tabId?: number): Promise<SelectionContext | undefined> {
  if (typeof tabId !== 'number') {
    return undefined;
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'getSelectionContext' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(undefined);
        return;
      }

      resolve((response?.context as SelectionContext | undefined) ?? undefined);
    });
  });
}

async function requestMapSummary(tabId?: number, query?: string): Promise<MapReputationSummary | undefined> {
  if (typeof tabId !== 'number') {
    return undefined;
  }

  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, { action: 'getMapSummary', query }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(undefined);
        return;
      }

      resolve((response?.summary as MapReputationSummary | undefined) ?? undefined);
    });
  });
}

async function resolveTabMeta(tabId?: number): Promise<{ pageUrl?: string; pageTitle?: string }> {
  if (typeof tabId !== 'number') {
    return {};
  }

  return new Promise((resolve) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        resolve({});
        return;
      }

      resolve({ pageUrl: tab?.url ?? undefined, pageTitle: tab?.title ?? undefined });
    });
  });
}

function enrichLookupFromContext(
  base: ContactLookup,
  context?: FetchContactInfoMessage['context']
): ContactLookup {
  if (!context?.selection) {
    return base;
  }

  const selection = context.selection;
  const enriched: ContactLookup = { ...base };

  if (!enriched.email && selection.emails?.length) {
    enriched.email = selection.emails[0];
  }

  if (!enriched.name && selection.text) {
    enriched.name = selection.text;
  }

  if (!enriched.company && selection.signatureBlock) {
    const companyLine = selection.signatureBlock
      .split('\n')
      .map((line) => line.trim())
      .find((line) => /inc\.|llc|ltd|corp|co\b/i.test(line));
    if (companyLine) {
      enriched.company = companyLine;
    }
  }

  return enriched;
}

function deriveMapsQuery(
  context: FetchContactInfoMessage['context'] | undefined,
  selection?: SelectionContext
): string | undefined {
  if (context?.mapsQuery) {
    return context.mapsQuery;
  }

  if (context?.pageTitle) {
    return context.pageTitle;
  }

  if (selection?.text) {
    return selection.text;
  }

  return context?.pageUrl;
}
