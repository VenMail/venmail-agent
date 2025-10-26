import type { HunterApiResponse, ScrapeExecutionContext } from '@venmail/shared';
import { mapHunterResponseToScrapeResult, buildHunterFallbackError } from '@venmail/shared';

import { registerScrapeTask, type ScrapeTaskOutput } from '../taskMap';

const HUNTER_BASE_URL = 'https://api.hunter.io/v2/email-verifier';

registerScrapeTask('email-verification', {
  async run(context: ScrapeExecutionContext): Promise<ScrapeTaskOutput> {
    const { cachedResult, lookup, settings, signal } = context;

    if (cachedResult?.payload) {
      return cachedResult.payload;
    }

    const { email, domain } = lookup;

    if (!email) {
      return buildHunterFallbackError('Hunter.io skipped – no email supplied.');
    }

    if (!settings.fallbacks?.hunter?.apiKey) {
      return buildHunterFallbackError('Hunter.io API key not configured. Add it in extension settings.');
    }

    try {
      const endpoint = settings.apiBaseUrl
        ? `${settings.apiBaseUrl.replace(/\/$/, '')}/api/hunter/verify`
        : HUNTER_BASE_URL;

      const url = new URL(endpoint);

      const requestInit: RequestInit = {
        method: settings.apiBaseUrl ? 'POST' : 'GET',
        signal
      };

      if (settings.apiBaseUrl) {
        requestInit.headers = {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.fallbacks.hunter.apiKey}`
        };
        requestInit.body = JSON.stringify({ email, domain });
      } else {
        url.searchParams.set('email', email);
        url.searchParams.set('api_key', settings.fallbacks.hunter.apiKey);
      }

      const response = await fetch(url.toString(), requestInit);

      if (!response.ok) {
        const errorText = await response.text();
        return buildHunterFallbackError(
          `Hunter.io request failed with status ${response.status}`,
          errorText || undefined
        );
      }

      const payload: HunterApiResponse = await response.json();
      const parsed = mapHunterResponseToScrapeResult(payload);

      if (!parsed) {
        return buildHunterFallbackError('No verification data returned from Hunter.io');
      }

      if (domain && !parsed.companyInfo?.website) {
        parsed.companyInfo = {
          ...(parsed.companyInfo ?? {}),
          website: `https://${domain}`
        };
      }

      return {
        ...parsed,
        fetchedAt: new Date().toISOString()
      } satisfies ScrapeTaskOutput;
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      return buildHunterFallbackError(`Hunter.io request error: ${message}`);
    }
  }
});
