/* eslint-disable @typescript-eslint/no-explicit-any */
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
