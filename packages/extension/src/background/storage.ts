import type {
  ContactLookup,
  DetectedContactSnapshot,
  ExtensionSettings,
  FetchContactInfoMessage,
  ReputationCacheEntry,
  ReputationResponse,
  ScrapeCacheEntry,
  ScrapeResult,
  ScrapeTaskId
} from '@venmail/shared';
import { buildRequestKey } from '@venmail/shared';

import { DEFAULT_SETTINGS, mergeSettings } from '../shared/settings';

const SETTINGS_KEY = 'venmail:settings';
const REPUTATION_PREFIX = 'venmail:reputation:';
const SCRAPE_PREFIX = 'venmail:scrape:';
const TASK_LAST_RUN_PREFIX = 'venmail:task:lastRun:';
const DETECTION_PREFIX = 'venmail:detection:tab:';
const LAST_CONTEXT_LOOKUP_KEY = 'venmail:last-context-lookup';

export interface DetectionStorageEntry {
  tabId: number;
  snapshot: DetectedContactSnapshot;
  updatedAt: number;
}

export interface LastContextLookupEntry {
  request: ContactLookup;
  response?: ReputationResponse;
  error?: string;
  updatedAt: number;
  context?: FetchContactInfoMessage['context'];
}

export async function loadSettings(): Promise<ExtensionSettings> {
  const stored = await storageGet<ExtensionSettings>(SETTINGS_KEY);
  if (!stored) {
    await storageSet(SETTINGS_KEY, DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }

  return mergeSettings(DEFAULT_SETTINGS, stored);
}

export async function saveSettings(partial: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const current = await loadSettings();
  const merged = mergeSettings(current, partial);
  await storageSet(SETTINGS_KEY, merged);
  return merged;
}

export async function getReputationCache(request: ContactLookup): Promise<ReputationCacheEntry | null> {
  const key = buildRequestKey(request);
  return getReputationCacheByKey(key);
}

export async function getReputationCacheByKey(key: string): Promise<ReputationCacheEntry | null> {
  const storageKey = REPUTATION_PREFIX + key;
  const entry = await storageGet<ReputationCacheEntry>(storageKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt < Date.now()) {
    await storageRemove(storageKey);
    return null;
  }

  return entry;
}

export async function setReputationCache(
  key: string,
  payload: ReputationResponse,
  tasks: ScrapeTaskId[],
  ttlMs: number
): Promise<void> {
  const storageKey = REPUTATION_PREFIX + key;
  const entry: ReputationCacheEntry = {
    key,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    payload,
    tasks
  };

  await storageSet(storageKey, entry);
}

export async function getScrapeCache(task: ScrapeTaskId, key: string): Promise<ScrapeCacheEntry | null> {
  const storageKey = buildScrapeCacheKey(task, key);
  const entry = await storageGet<ScrapeCacheEntry>(storageKey);

  if (!entry) {
    return null;
  }

  if (entry.expiresAt < Date.now()) {
    await storageRemove(storageKey);
    return null;
  }

  return entry;
}

export async function setScrapeCache(
  task: ScrapeTaskId,
  key: string,
  payload: ScrapeResult,
  ttlMs: number
): Promise<void> {
  const storageKey = buildScrapeCacheKey(task, key);
  const entry: ScrapeCacheEntry = {
    key,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
    payload,
    task
  };

  await storageSet(storageKey, entry);
}

export async function getTaskLastRun(task: ScrapeTaskId): Promise<number | null> {
  const storageKey = TASK_LAST_RUN_PREFIX + task;
  const timestamp = await storageGet<number>(storageKey);
  return typeof timestamp === 'number' ? timestamp : null;
}

export async function setTaskLastRun(task: ScrapeTaskId, timestamp: number): Promise<void> {
  const storageKey = TASK_LAST_RUN_PREFIX + task;
  await storageSet(storageKey, timestamp);
}

export async function saveDetectionSnapshot(
  tabId: number,
  snapshot: DetectedContactSnapshot
): Promise<DetectionStorageEntry> {
  const entry: DetectionStorageEntry = {
    tabId,
    snapshot,
    updatedAt: Date.now()
  };

  await storageSet(buildDetectionKey(tabId), entry);
  return entry;
}

export async function getDetectionSnapshot(tabId: number): Promise<DetectionStorageEntry | null> {
  const entry = await storageGet<DetectionStorageEntry>(buildDetectionKey(tabId));
  return entry ?? null;
}

export async function clearDetectionSnapshot(tabId: number): Promise<void> {
  await storageRemove(buildDetectionKey(tabId));
}

export async function loadLastContextLookup(): Promise<LastContextLookupEntry | null> {
  const entry = await storageGet<LastContextLookupEntry>(LAST_CONTEXT_LOOKUP_KEY);
  return entry ?? null;
}

export async function saveLastContextLookup(entry: LastContextLookupEntry): Promise<void> {
  await storageSet(LAST_CONTEXT_LOOKUP_KEY, entry);
}

function buildScrapeCacheKey(task: ScrapeTaskId, key: string): string {
  return `${SCRAPE_PREFIX}${task}:${key}`;
}

function buildDetectionKey(tabId: number): string {
  return `${DETECTION_PREFIX}${tabId}`;
}

async function storageGet<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(key, (items) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }

      resolve(items[key] as T | undefined);
    });
  });
}

async function storageSet(key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set({ [key]: value }, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

async function storageRemove(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(key, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}
