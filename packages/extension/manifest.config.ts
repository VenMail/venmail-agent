import { defineManifest } from '@crxjs/vite-plugin';

export default defineManifest({
  manifest_version: 3,
  name: 'Venmail Agent',
  version: '0.0.2',
  description: 'Contact reputation ranking, extraction, and verification companion.',
  permissions: ['storage', 'activeTab', 'scripting', 'tabs', 'contextMenus', 'notifications'],
  host_permissions: ['https://*/*', 'http://*/*'],
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['src/content/detection/index.ts'],
      run_at: 'document_idle'
    },
    {
      matches: [
        'https://www.google.com/search*',
        'https://google.com/search*',
        'https://www.bing.com/search*',
        'https://bing.com/search*',
        'https://duckduckgo.com/*'
      ],
      js: ['src/content/serp/index.ts'],
      run_at: 'document_idle'
    },
    {
      matches: ['https://*.contactout.com/*', 'https://*.contactout.io/*'],
      js: ['src/content/contactout/index.ts'],
      run_at: 'document_idle'
    }
  ],
  action: {
    default_popup: 'src/popup/index.html',
    default_title: 'Venmail Agent'
  },
  background: {
    service_worker: 'src/background/index.ts',
    type: 'module'
  },
  icons: {
    '16': 'public/icons/icon16.png',
    '48': 'public/icons/icon48.png',
    '128': 'public/icons/icon128.png'
  },
  externally_connectable: {
    matches: ['*://*/*']
  }
});
