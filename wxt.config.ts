import { build, defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion:2,
  modules:["@wxt-dev/auto-icons"],
  browser:"firefox",
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
    browser_specific_settings: {
      gecko: {
        data_collection_permissions: {
          required: ["websiteActivity", "websiteContent"]
        }
      }
    }
  }
});
