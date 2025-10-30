import type { ScrapeExecutionContext, ScrapeTaskId } from '@venmail/shared';

import { executeTask, hasTask, type ScrapeTaskOutput } from './taskMap';
import './providers/serpScan';
import './providers/mapsScan';
import './providers/profileScan';
import './providers/contactPage';
import './providers/venmailLookup';

export async function runScrapeTask(
  context: ScrapeExecutionContext & { task: ScrapeTaskId }
): Promise<ScrapeTaskOutput> {
  if (!hasTask(context.task)) {
    throw new Error(`Scrape task '${context.task}' is not registered.`);
  }

  return executeTask(context);
}
