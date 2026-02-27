import { defineConfig } from 'wxt';

// See https://wxt.dev/api/config.html
export default defineConfig({
  manifestVersion: 2,
  modules: ["@wxt-dev/auto-icons"],
  browser: "firefox",
  targetBrowsers: ["firefox"],
  manifest: {
    name: 'API Type Detector',
    version: "0.0.3",
    description: 'Monitor API routes and generate TypeScript type definitions',
    // MV2 ではホスト権限も permissions 配列に含める
    permissions: [
      'storage',
      'webRequest',
      'webRequestBlocking',
      '<all_urls>',
    ],
    browser_specific_settings: {
      gecko: {
        // AMO署名・インストールに必須（MV2でも強く推奨）めんどくさい
        // id: 'api-type-detector@example.com',
        // filterResponseData: Firefox 57+。安定した現行 ESR ベースラインとして 91.0 を指定
        strict_min_version: '91.0',
        // AMO提出用データ収集権限の申告（Firefox 128+）
        data_collection_permissions: {
          required: ["websiteActivity", "websiteContent"]
        }
      }
    }
  }
});
