import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  manifest: {
    name: 'Analytics Debugger',
    description:
      'See which interactions send which analytics hits. Adobe Analytics, Adobe Web SDK and GA4, decoded in a side panel.',
    // Main-world content scripts need 111, sidePanel.setPanelBehavior 116.
    minimum_chrome_version: '116',
    // scripting: re-attach to open tabs after an update. Dev builds also get unlimitedStorage (see scripts/deploy.mjs).
    permissions: ['webRequest', 'webNavigation', 'storage', 'sidePanel', 'scripting'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Open Analytics Debugger' },
  },
});
