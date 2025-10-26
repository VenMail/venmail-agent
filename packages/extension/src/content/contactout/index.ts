import { extractContactOutResult } from './extractor';
import { safeSendMessage } from '../../shared/messaging';

const PREPARE_MESSAGE = 'venmail:contactout:prepare';
const CAPTURE_EVENT = 'venmail-contactout-capture';
const POLL_INTERVAL_MS = 400;
const POLL_TIMEOUT_MS = 12_000;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse): void => {
  if (!message || typeof message !== 'object' || (message as { type?: string }).type !== PREPARE_MESSAGE) {
    return;
  }

  const payload = message as {
    type?: string;
    target?: unknown;
    polling?: {
      intervalMs?: number;
      timeoutMs?: number;
    };
  };

  const target = payload.target;
  const targetLabel = typeof target === 'string' ? target : undefined;
  const polling = payload.polling;

  sendResponse({ status: 'capturing' });

  void captureAndReport(targetLabel, polling ?? undefined);
});

async function captureAndReport(
  targetLabel?: string,
  polling?: { intervalMs?: number; timeoutMs?: number }
): Promise<void> {
  try {
    sendStatus('content_poll_start', { target: targetLabel });
    const result = await pollForResult({
      targetLabel,
      intervalMs: polling?.intervalMs,
      timeoutMs: polling?.timeoutMs
    });
    sendStatus('content_poll_success', { target: targetLabel });
    safeSendMessage({ type: CAPTURE_EVENT, result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendStatus('content_poll_failed', { target: targetLabel, message });
    safeSendMessage({ type: CAPTURE_EVENT, error: message });
  }
}

interface PollOptions {
  targetLabel?: string;
  timeoutMs?: number;
  intervalMs?: number;
}

async function pollForResult(options: PollOptions): Promise<ReturnType<typeof extractContactOutResult>> {
  const { targetLabel, timeoutMs = POLL_TIMEOUT_MS, intervalMs = POLL_INTERVAL_MS } = options;
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    attempt += 1;

    try {
      return extractContactOutResult({ targetLabel });
    } catch (error) {
      lastError = error;
      sendStatus('content_poll_retry', {
        target: targetLabel,
        attempt,
        message: error instanceof Error ? error.message : String(error)
      });
    }

    await delay(intervalMs);
  }

  if (lastError instanceof Error) {
    throw lastError;
  }

  throw new Error('ContactOut profile not ready');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function sendStatus(phase: string, detail?: Record<string, unknown>): void {
  safeSendMessage({
    type: 'venmail-contactout-status',
    phase,
    detail,
    timestamp: new Date().toISOString()
  });
}
