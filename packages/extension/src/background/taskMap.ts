import type { ScrapeExecutionContext, ScrapeResult, ScrapeTaskId } from '@venmail/shared';

export type ScrapeTaskOutput = Omit<ScrapeResult, 'task'>;

export interface ScrapeTaskAdapter {
  run(context: ScrapeExecutionContext): Promise<ScrapeTaskOutput>;
}

const adapters: Partial<Record<ScrapeTaskId, ScrapeTaskAdapter>> = {};

export function registerScrapeTask(task: ScrapeTaskId, adapter: ScrapeTaskAdapter): void {
  adapters[task] = adapter;
}

export async function executeTask(
  context: ScrapeExecutionContext & { task: ScrapeTaskId }
): Promise<ScrapeTaskOutput> {
  const handler = adapters[context.task];

  if (!handler) {
    throw new Error(`Scrape task not registered for ${context.task}`);
  }

  return handler.run(context);
}

export function hasTask(task: ScrapeTaskId): boolean {
  return Boolean(adapters[task]);
}
