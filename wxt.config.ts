import { build, defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion:2,
  targetBrowsers:["firefox"],
  manifest: {
    name: 'API Type Detector',
    description: 'Monitor API routes and generate TypeScript type definitions',
    permissions: [
      'storage',
      'webRequest',
      'webRequestBlocking',
    ],
    host_permissions: ['<all_urls>'],
  }
});
