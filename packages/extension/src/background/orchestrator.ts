import type {
  ContactLookup,
  ExtensionSettings,
  FetchContactInfoMessage,
  LookupProgressUpdate,
  ReputationResponse,
  ScrapeResult,
  ScrapeTaskId
} from '@venmail/shared';
import { buildReputationResponse, buildRequestKey } from '@venmail/shared';

import {
  getReputationCache,
  getScrapeCache,
  getTaskLastRun,
  loadSettings,
  setReputationCache,
  setScrapeCache,
  setTaskLastRun
} from './storage';
import { runScrapeTask } from './scrapers';
import type { ScrapeTaskOutput } from './taskMap';

const TASK_TIMEOUT_MS = 25_000;
const REPUTATION_DEFAULT_TTL_MS = 1000 * 60 * 15;

export interface LookupOutcome {
  response: ReputationResponse;
  fromCache: boolean;
  notes: string[];
}

type TaskOrder = ScrapeTaskId[];

export async function orchestrateLookup(
  lookup: ContactLookup,
  options?: { context?: FetchContactInfoMessage['context']; onProgress?: (update: LookupProgressUpdate) => void }
): Promise<LookupOutcome> {
  const requestKey = buildRequestKey(lookup);
  const emitProgress = (stage: string, taskId?: ScrapeTaskId, notes?: string[]) => {
    options?.onProgress?.({
      type: 'venmail-lookup-progress',
      stage,
      taskId,
      notes,
      timestamp: new Date().toISOString(),
      lookupKey: requestKey
    });
  };

  emitProgress('started');

  const settings = await loadSettings();
  const cacheEntry = await getReputationCache(lookup);

  if (cacheEntry) {
    emitProgress('cache-hit', undefined, ['Reputation served from cache.']);
    emitProgress('completed');
    return {
      response: cacheEntry.payload,
      fromCache: true,
      notes: ['cache-hit']
    };
  }

  const taskQueue = buildTaskQueue(settings);
  const results: ScrapeResult[] = [];
  const taskTtls: number[] = [];
  const aggregatedNotes: string[] = [];
  let emailResolved = false;

  for (const task of taskQueue) {
    if (task === 'venmail-lookup' && emailResolved) {
      emitProgress('task-skipped', task, ['Email already found from earlier tasks.']);
      aggregatedNotes.push('venmail-lookup skipped – email already identified.');
      continue;
    }

    if (!isTaskEnabled(settings, task)) {
      continue;
    }

    const taskTtl = getTaskCacheTtl(settings, task);
    if (typeof taskTtl === 'number') {
      taskTtls.push(taskTtl);
    }

    const cached = await getScrapeCache(task, requestKey);
    const now = Date.now();
    const rateLimit = getTaskRateLimit(settings, task);
    const lastRun = await getTaskLastRun(task);

    if (rateLimit > 0 && lastRun && now - lastRun < rateLimit) {
      if (cached?.payload) {
        emitProgress('task-cache-hit', task, ['Using cached result (rate limited).']);
        const normalized = markScrapeResult(task, cached.payload, ['Using cached result (rate limited).']);
        results.push(normalized);
        emailResolved ||= resultHasEmail(normalized);
        continue;
      }

      emitProgress('task-rate-limited', task, ['Skipped due to rate limiting.']);
      aggregatedNotes.push(`${task} skipped due to rate limiting.`);
      continue;
    }

    if (cached?.payload) {
      emitProgress('task-cache-hit', task, ['Using cached result.']);
      const normalized = markScrapeResult(task, cached.payload);
      results.push(normalized);
      emailResolved ||= resultHasEmail(normalized);
      continue;
    }

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort('timeout'), TASK_TIMEOUT_MS);

    try {
      emitProgress('task-start', task);
      const scrape = await runScrapeTask({
        task,
        lookup,
        signal: abortController.signal,
        settings,
        cachedResult: cached ?? undefined,
        attempt: results.length + 1,
        selection: options?.context?.selection,
        pageUrl: options?.context?.pageUrl,
        pageTitle: options?.context?.pageTitle,
        tabId: options?.context?.tabId,
        mapSummary: options?.context?.mapSummary ?? null,
        mapsQuery: options?.context?.mapsQuery
      });

      clearTimeout(timeoutId);

      const normalized = markScrapeResult(task, scrape);
      results.push(normalized);
      emailResolved ||= resultHasEmail(normalized);
      emitProgress('task-success', task, normalized.notes?.length ? normalized.notes : undefined);

      if (taskTtl && taskTtl > 0) {
        await setScrapeCache(task, requestKey, normalized, taskTtl);
      }

      await setTaskLastRun(task, Date.now());
    } catch (error) {
      clearTimeout(timeoutId);
      const message = error instanceof Error ? error.message : String(error);
      aggregatedNotes.push(`${task} failed: ${message}`);
      emitProgress('task-error', task, [message]);
      results.push({
        task,
        signals: {},
        additionalData: {
          verifiedEmail: false,
          notes: message
        },
        socialProfiles: {},
        notes: [`${task} failed: ${message}`],
        error: 'task_failed',
        fetchedAt: new Date().toISOString()
      });
    }
  }

  if (results.length === 0) {
    results.push({
      task: 'serp-scan',
      signals: {},
      socialProfiles: {},
      companyInfo: undefined,
      additionalData: { verifiedEmail: false, notes: 'No scraping tasks executed.' },
      notes: ['No scraping results available.'],
      error: 'no_tasks',
      fetchedAt: new Date().toISOString()
    });
  }

  emitProgress('aggregating');
  const response = buildReputationResponse(results);
  if (options?.context?.selection) {
    response.additionalData.selectionInsights =
      response.additionalData.selectionInsights ?? options.context.selection;
  }
  if (options?.context?.pageUrl) {
    const trustedSources = response.additionalData.trustedSources ?? [];
    if (!trustedSources.includes(options.context.pageUrl)) {
      response.additionalData.trustedSources = [...trustedSources, options.context.pageUrl];
    }
  }

  const tasksUsed = response.tasksUsed ?? results.map((result) => result.task);
  const reputationTtl = taskTtls.length ? Math.min(...taskTtls) : REPUTATION_DEFAULT_TTL_MS;

  await setReputationCache(requestKey, response, tasksUsed, reputationTtl);

  emitProgress('completed');

  return {
    response,
    fromCache: false,
    notes: Array.from(
      new Set([
        ...aggregatedNotes,
        ...(response.additionalData.notes ? response.additionalData.notes.split('\n') : [])
      ])
    )
  };
}

function markScrapeResult(task: ScrapeTaskId, result: ScrapeTaskOutput, extraNotes: string[] = []): ScrapeResult {
  const notes = [...(result.notes ?? []), ...extraNotes];
  return {
    task,
    signals: result.signals ?? {},
    socialProfiles: result.socialProfiles ?? {},
    companyInfo: result.companyInfo,
    additionalData: result.additionalData,
    notes,
    error: result.error,
    fetchedAt: result.fetchedAt ?? new Date().toISOString()
  };
}

function buildTaskQueue(settings: ExtensionSettings): TaskOrder {
  const order: TaskOrder = ['serp-scan', 'maps-scan', 'profile-scan', 'contact-page-scan'];

  if (settings.fallbacks?.venmail?.enabled) {
    order.push('venmail-lookup');
  }

  return Array.from(new Set(order));
}

function isTaskEnabled(settings: ExtensionSettings, task: ScrapeTaskId): boolean {
  switch (task) {
    case 'venmail-lookup':
      return Boolean(settings.fallbacks?.venmail?.enabled);
    case 'contact-page-scan':
      return settings.scraping.contact.enabled;
    case 'maps-scan':
      return settings.scraping.maps.enabled;
    case 'profile-scan':
      return settings.scraping.profile.enabled;
    case 'serp-scan':
    default:
      return settings.scraping.serp.enabled;
  }
}

function getTaskRateLimit(settings: ExtensionSettings, task: ScrapeTaskId): number {
  return settings.taskRateLimits?.[task] ?? 0;
}

function getTaskCacheTtl(settings: ExtensionSettings, task: ScrapeTaskId): number | undefined {
  return settings.cacheTtlOverrides?.[task];
}

function resultHasEmail(result: ScrapeResult): boolean {
  const emails = collectEmails(result);
  return emails.length > 0 || Boolean(result.signals?.emailVerified);
}

function collectEmails(result: ScrapeResult): string[] {
  const collected = new Set<string>();

  const direct = result.additionalData?.emailAddresses ?? [];
  for (const email of direct) {
    if (email) {
      collected.add(email.toLowerCase());
    }
  }

  const channels = result.additionalData?.contactChannels ?? [];
  for (const channel of channels ?? []) {
    for (const email of channel.emails ?? []) {
      if (email) {
        collected.add(email.toLowerCase());
      }
    }
  }

  return Array.from(collected);
}
