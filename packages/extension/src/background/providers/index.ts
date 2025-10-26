import type { ProviderModule } from '@venmail/shared';

import contactOutProvider from './contactout';
import hunterProvider from './hunter';
import webSearchProvider from './webSearch';

const modules: ProviderModule[] = [contactOutProvider, hunterProvider, webSearchProvider];

export function getProviderModules(): ProviderModule[] {
  return modules;
}
