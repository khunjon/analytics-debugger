import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  imports: false,
  manifest: {
    name: 'Analytics Debugger',
    description:
      'See which interactions send which analytics hits. Adobe Analytics, Adobe Web SDK and GA4, decoded in a side panel.',
    // scripting: re-attach to open tabs after an update. unlimitedStorage: hand timelines across a reload.
    permissions: ['webRequest', 'webNavigation', 'storage', 'unlimitedStorage', 'sidePanel', 'scripting'],
    host_permissions: ['<all_urls>'],
    action: { default_title: 'Open Analytics Debugger' },
  },
});
