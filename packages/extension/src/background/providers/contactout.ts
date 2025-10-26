import type { ScrapeExecutionContext } from '@venmail/shared';

import { registerScrapeTask, type ScrapeTaskOutput } from '../taskMap';

const CONTACTOUT_CAPTURE_EVENT = 'venmail-contactout-capture';
const CONTACTOUT_STATUS_EVENT = 'venmail-contactout-status';

type ContactOutPollingConfig = {
  intervalMs?: number;
  timeoutMs?: number;
} | undefined;

registerScrapeTask('contactout-capture', {
  async run(context: ScrapeExecutionContext): Promise<ScrapeTaskOutput> {
    const { cachedResult, lookup, settings } = context;

    if (cachedResult?.payload) {
      return cachedResult.payload;
    }

    const target = lookup.email ?? lookup.name ?? lookup.domain ?? 'contact';
    reportStatus('execute_start', { target });

    const polling: ContactOutPollingConfig = settings.fallbacks?.contactOut?.polling;

    const capture = await waitForCapture(target, polling).catch((error: unknown) => {
      reportStatus('capture_failed', {
        target,
        message: error instanceof Error ? error.message : String(error)
      });

      return {
        signals: {},
        notes: [
          `ContactOut capture failed: ${error instanceof Error ? error.message : String(error)}`
        ],
        additionalData: {
          verifiedEmail: false,
          notes: 'Capture failed'
        },
        error: 'task_error'
      } satisfies ScrapeTaskOutput;
    });

    if (!capture) {
      reportStatus('interaction_required', { target });
      return buildInteractionRequiredResult(target);
    }

    reportStatus('capture_success', { target });
    return capture;
  }
});

async function waitForCapture(
  targetLabel: string,
  pollingConfig: ContactOutPollingConfig
): Promise<ScrapeTaskOutput | null> {
  reportStatus('wait_for_tab', { target: targetLabel });

  const activeTab = await queryActiveTab().catch((error) => {
    reportStatus('tab_query_failed', {
      target: targetLabel,
      message: error instanceof Error ? error.message : String(error)
    });
    throw new Error(`Failed to query active tab: ${error instanceof Error ? error.message : String(error)}`);
  });

  if (!activeTab?.id) {
    reportStatus('no_active_tab', { target: targetLabel });
    return null;
  }

  await sendPrepareMessage(activeTab.id, {
    type: 'venmail:contactout:prepare',
    target: targetLabel,
    polling: {
      intervalMs: pollingConfig?.intervalMs,
      timeoutMs: pollingConfig?.timeoutMs
    }
  }).catch((error) => {
    reportStatus('prepare_failed', {
      target: targetLabel,
      message: error instanceof Error ? error.message : String(error)
    });
    throw new Error(
      `Failed to send capture request: ${error instanceof Error ? error.message : String(error)}`
    );
  });

  reportStatus('prepare_dispatched', {
    target: targetLabel,
    tabId: activeTab.id,
    tabUrl: activeTab.url
  });

  const timeoutMs = pollingConfig?.timeoutMs ?? 15_000;

  return new Promise<ScrapeTaskOutput | null>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reportStatus('capture_timeout', { target: targetLabel });
      resolve(null);
    }, timeoutMs);

    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      if (!message || typeof message !== 'object') {
        return;
      }

      const payload = message as { type?: string; result?: ScrapeTaskOutput & { task?: string }; error?: string };

      if (payload.type !== CONTACTOUT_CAPTURE_EVENT) {
        return;
      }

      if (!sender.tab || sender.tab.id !== activeTab.id) {
        return;
      }

      chrome.runtime.onMessage.removeListener(listener);
      clearTimeout(timeoutId);

      reportStatus('message_received', { target: targetLabel });

      if (payload.error) {
        reportStatus('payload_error', {
          target: targetLabel,
          message: payload.error
        });
        reject(new Error(payload.error));
        return;
      }

      reportStatus('payload_success', {
        target: targetLabel,
        hasResult: Boolean(payload.result)
      });
      if (payload.result) {
        const { task: _task, ...rest } = payload.result;
        resolve(rest);
      } else {
        resolve(null);
      }
    };

    chrome.runtime.onMessage.addListener(listener);
  });
}

function buildInteractionRequiredResult(target: string): ScrapeTaskOutput {
  return {
    signals: {},
    notes: [
      `Open ContactOut for ${target} and trigger the Venmail capture action to populate data.`,
      'ContactOut scraping requires an authenticated browser session with appropriate consent.'
    ],
    additionalData: {
      verifiedEmail: false,
      notes: 'ContactOut capture requires manual interaction.'
    },
    fetchedAt: new Date().toISOString(),
    error: 'interaction_required'
  } satisfies ScrapeTaskOutput;
}

async function queryActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }

      resolve(tabs[0]);
    });
  });
}

interface PreparePayload {
  type: string;
  target: string;
  polling?: {
    intervalMs?: number;
    timeoutMs?: number;
  };
}

async function sendPrepareMessage(tabId: number, payload: PreparePayload): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, payload, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function reportStatus(phase: string, detail?: Record<string, unknown>): void {
  const payload = {
    type: CONTACTOUT_STATUS_EVENT,
    phase,
    detail,
    timestamp: new Date().toISOString()
  };

  console.info(`[Venmail][ContactOut] ${phase}`, detail ?? '');

  try {
    chrome.runtime.sendMessage(payload, () => {
      const error = chrome.runtime.lastError;
      if (error && !error.message?.includes('Receiving end does not exist')) {
        console.warn('[Venmail][ContactOut] status dispatch error', error.message);
      }
    });
  } catch (error) {
    console.debug('[Venmail][ContactOut] status dispatch skipped', error);
  }
}
