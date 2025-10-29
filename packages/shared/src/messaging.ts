declare const chrome: any;

import { ReputationSignals } from './types';

export interface ProviderResult {
  provider: string;
  signals: ReputationSignals;
  socialProfiles: Record<string, string>;
  companyInfo: {
    name: string;
    website: string;
  };
  notes: string[];
  additionalData: any;
  fetchedAt: string;
}

export interface LookupRequestMessage {
  action: 'lookup';
  query: string;
}

export interface LookupResponseMessage {
  action: 'lookup-response';
  result: ProviderResult;
}

export type ExtensionMessage = LookupRequestMessage | LookupResponseMessage | { action: string };

export function isLookupRequest(
  message: ExtensionMessage
): message is LookupRequestMessage {
  return (message as LookupRequestMessage).action === 'lookup';
}

export function isLookupResponse(
  message: ExtensionMessage
): message is LookupResponseMessage {
  return (message as LookupResponseMessage).action === 'lookup-response';
}

export function safeSendMessage<TMessage>(message: TMessage): void;
export function safeSendMessage<TMessage, TResponse>(
  message: TMessage,
  callback: (response: TResponse) => void
): void;
export function safeSendMessage<TMessage, TResponse>(
  message: TMessage,
  callback?: (response: TResponse) => void
): void {
  try {
    if (!chrome?.runtime?.id) {
      return;
    }

    if (callback) {
      chrome.runtime.sendMessage(message, callback);
    } else {
      chrome.runtime.sendMessage(message);
    }
  } catch (error) {
    console.debug('[venmail] message dispatch dropped', error);
  }
}

export function safeSendTabsMessage<TMessage>(tabId: number, message: TMessage): void;
export function safeSendTabsMessage<TMessage, TResponse>(
  tabId: number,
  message: TMessage,
  callback: (response: TResponse) => void
): void;
export function safeSendTabsMessage<TMessage, TResponse>(
  tabId: number,
  message: TMessage,
  callback?: (response: TResponse) => void
): void {
  try {
    if (!chrome?.runtime?.id || typeof chrome?.tabs?.sendMessage !== 'function') {
      return;
    }

    if (callback) {
      chrome.tabs.sendMessage(tabId, message, callback as any);
    } else {
      chrome.tabs.sendMessage(tabId, message);
    }
  } catch (error) {
    console.debug('[venmail] tab message dispatch dropped', error);
  }
}

