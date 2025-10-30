import type { ExtensionSettings } from '@venmail/shared';

export const DEFAULT_SETTINGS: ExtensionSettings = {
  apiBaseUrl: undefined,
  scraping: {
    serp: { enabled: true, rateLimitMs: 15_000, cacheTtlMs: 1000 * 60 * 30 },
    maps: { enabled: true, rateLimitMs: 45_000, cacheTtlMs: 1000 * 60 * 60 },
    profile: { enabled: true, rateLimitMs: 30_000, cacheTtlMs: 1000 * 60 * 60 },
    contact: { enabled: true, rateLimitMs: 45_000, cacheTtlMs: 1000 * 60 * 30 }
  },
  detection: {
    enabled: true,
    polling: {
      intervalMs: 400,
      timeoutMs: 12_000
    }
  },
  fallbacks: {
    venmail: {
      enabled: false,
      apiKey: undefined
    }
  },
  cacheTtlOverrides: {},
  taskRateLimits: {}
};

export function mergeSettings(
  base: ExtensionSettings,
  override: Partial<ExtensionSettings>
): ExtensionSettings {
  return {
    apiBaseUrl: override.apiBaseUrl ?? base.apiBaseUrl,
    scraping: {
      serp: {
        enabled: override.scraping?.serp?.enabled ?? base.scraping.serp.enabled,
        rateLimitMs: override.scraping?.serp?.rateLimitMs ?? base.scraping.serp.rateLimitMs,
        cacheTtlMs: override.scraping?.serp?.cacheTtlMs ?? base.scraping.serp.cacheTtlMs
      },
      maps: {
        enabled: override.scraping?.maps?.enabled ?? base.scraping.maps.enabled,
        rateLimitMs: override.scraping?.maps?.rateLimitMs ?? base.scraping.maps.rateLimitMs,
        cacheTtlMs: override.scraping?.maps?.cacheTtlMs ?? base.scraping.maps.cacheTtlMs
      },
      profile: {
        enabled: override.scraping?.profile?.enabled ?? base.scraping.profile.enabled,
        rateLimitMs: override.scraping?.profile?.rateLimitMs ?? base.scraping.profile.rateLimitMs,
        cacheTtlMs: override.scraping?.profile?.cacheTtlMs ?? base.scraping.profile.cacheTtlMs
      },
      contact: {
        enabled: override.scraping?.contact?.enabled ?? base.scraping.contact.enabled,
        rateLimitMs: override.scraping?.contact?.rateLimitMs ?? base.scraping.contact.rateLimitMs,
        cacheTtlMs: override.scraping?.contact?.cacheTtlMs ?? base.scraping.contact.cacheTtlMs
      }
    },
    detection: {
      enabled: override.detection?.enabled ?? base.detection.enabled,
      polling: {
        intervalMs: override.detection?.polling?.intervalMs ?? base.detection.polling.intervalMs,
        timeoutMs: override.detection?.polling?.timeoutMs ?? base.detection.polling.timeoutMs
      }
    },
    fallbacks: {
      venmail: {
        enabled: override.fallbacks?.venmail?.enabled ?? base.fallbacks.venmail?.enabled ?? false,
        apiKey: override.fallbacks?.venmail?.apiKey ?? base.fallbacks.venmail?.apiKey
      }
    },
    cacheTtlOverrides: {
      ...base.cacheTtlOverrides,
      ...override.cacheTtlOverrides
    },
    taskRateLimits: {
      ...base.taskRateLimits,
      ...override.taskRateLimits
    }
  };
}
