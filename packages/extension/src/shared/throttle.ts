export function throttle<TArgs extends unknown[]>(fn: (...args: TArgs) => void | Promise<void>, waitMs: number) {
  let isScheduled = false;
  let lastArgs: TArgs | null = null;

  const invoke = () => {
    if (!lastArgs) {
      isScheduled = false;
      return;
    }

    const args = lastArgs;
    lastArgs = null;
    isScheduled = true;

    Promise.resolve(fn(...args)).finally(() => {
      isScheduled = false;
      if (lastArgs) {
        setTimeout(invoke, waitMs);
      }
    });
  };

  return (...args: TArgs) => {
    lastArgs = args;
    if (!isScheduled) {
      invoke();
    }
  };
}
