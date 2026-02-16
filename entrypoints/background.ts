import type { ApiRoute, RecordedRequest, GeneratedType, StorageData } from '@/types';
import { generateTypeFromSamples, generateTypeName } from '@/utils/typeGenerator';
import { getBaseUrl, extractPath, matchesBaseUrl, generateRouteName, normalizePath, matchesPattern } from '@/utils/urlParser';
import { extractQueryParams } from '@/utils/paramCollector';
import {formatCode} from "@/utils/format"

// リクエストボディを一時的に保存
const requestBodies = new Map<string, any>();
// レスポンスボディを一時的に保存
const responseBodies = new Map<string, any>();
// レスポンスメタ情報を一時的に保存
const responseMeta = new Map<string, { contentType?: string }>();

// Firefox専用のAPI型定義
interface FilterResponseDataEvent {
  data: ArrayBuffer;
}

interface StreamFilter {
  ondata: ((event: FilterResponseDataEvent) => void) | null;
  onstop: (() => void) | null;
  onerror: ((event: any) => void) | null;
  write(data: ArrayBuffer | Uint8Array): void;
  disconnect(): void;
  close(): void;
}

interface FirefoxWebRequest {
  filterResponseData(requestId: string): StreamFilter;
}

export default defineBackground(() => {
  console.log('🚀 API Type Detector background started');

  // ストレージの初期化
  initStorage();

  // webRequestリスナーの設定
  setupWebRequestListeners();

  // メッセージリスナーの設定
  setupMessageListeners();
});

async function initStorage() {
  const data = await browser.storage.local.get(['routes', 'requests', 'types']);
  
  if (!data.routes) {
    await browser.storage.local.set({ routes: [] });
  }
  if (!data.requests) {
    await browser.storage.local.set({ requests: [] });
  }
  if (!data.types) {
    await browser.storage.local.set({ types: [] });
  }
}

function setupWebRequestListeners() {
  console.log('📡 Setting up web request listeners');
  
  // レスポンスヘッダーを取得（Content-Type判定用）
  browser.webRequest.onHeadersReceived.addListener(
    (details) => {
      const requestId = `${details.requestId}`;
      const contentType = details.responseHeaders
        ?.find(header => header.name.toLowerCase() === 'content-type')
        ?.value;
      if (contentType) {
        responseMeta.set(requestId, { contentType });
        console.log(`📝 Stored content-type for ${details.url}: ${contentType}`);
      }
      return undefined;
    },
    { urls: ['<all_urls>'] },
    ['responseHeaders']
  );

  // レスポンスボディを取得（MV2のwebRequestから）
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      // 拡張機能自身のリクエストを除外
      if (details.tabId === -1) {
        return undefined;
      }

      // 対象メソッドのみ
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(details.method)) {
        return undefined;
      }

      const webRequest = browser.webRequest as any as FirefoxWebRequest;
      if (!webRequest.filterResponseData) {
        console.warn('⚠️ filterResponseData is not available in this browser.');
        return undefined;
      }

      const requestId = `${details.requestId}`;
      console.log(`🔍 Attempting to capture response for: ${details.method} ${details.url}`);
      
      try {
        const filter = webRequest.filterResponseData(details.requestId.toString());
        const chunks: Uint8Array[] = [];

        filter.onerror = (event) => {
          console.error(`❌ Filter error for ${details.url}:`, event);
        };

        filter.ondata = (event: FilterResponseDataEvent) => {
          chunks.push(new Uint8Array(event.data));
          filter.write(event.data);
        };

        filter.onstop = () => {
          try {
            const combined = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
            let offset = 0;
            for (const chunk of chunks) {
              combined.set(chunk, offset);
              offset += chunk.length;
            }

            const decoder = new TextDecoder('utf-8');
            const text = decoder.decode(combined);
            
            if (text.trim()) {
              const parsed = JSON.parse(text);
              responseBodies.set(requestId, parsed);
              console.log(`✅ Captured response body for ${details.url}`, parsed);
            }
          } catch (e) {
            console.log(`ℹ️ Non-JSON response or parse error for ${details.url}:`, e);
          } finally {
            filter.disconnect();
          }
        };
      } catch (e) {
        console.error(`❌ Failed to create filter for ${details.url}:`, e);
      }

      return undefined;
    },
    { urls: ['<all_urls>'] },
    ['blocking']
  );

  // リクエストボディを取得（送信前）
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      if (details.requestBody) {
        const requestId = `${details.requestId}`;
        
        if (details.requestBody.formData) {
          // FormDataの場合
          requestBodies.set(requestId, details.requestBody.formData);
        } else if (details.requestBody.raw) {
          // Rawデータの場合（JSON等）
          try {
            const decoder = new TextDecoder('utf-8');
            const combined = details.requestBody.raw
              .map(item => decoder.decode(item.bytes))
              .join('');
            const parsed = JSON.parse(combined);
            requestBodies.set(requestId, parsed);
          } catch (e) {
            // パースできない場合はスキップ
          }
        }
      }
      return undefined;
    },
    { urls: ['<all_urls>'] },
    ['requestBody']
  );

  // リクエストの完了を監視
  browser.webRequest.onCompleted.addListener(
    async (details) => {
      // 拡張機能自身のリクエストを除外
      if (details.tabId === -1) {
        return;
      }

      // GETまたはPOSTリクエストのみを対象
      if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(details.method)) {
        return;
      }

      console.log(`🏁 Request completed: ${details.method} ${details.url}`);

      // クエリパラメータを除いたURLを取得
      const cleanUrl = getBaseUrl(details.url);

      // 登録されたルートと照合
      const data = await browser.storage.local.get('routes');
      const routes: ApiRoute[] = (data.routes as ApiRoute[] | undefined) || [];
      
      // 通常のパターンマッチング（:id形式も対応）
      let matchedRoute = routes.find(route => {
        if (!route.enabled || route.parentId || route.isAutoDetect) return false; // 子ルートと自動検出は除外
        if (!route.pattern) return false;
        return matchesPattern(cleanUrl, route.pattern);
      });

      // 自動検出モードのルートをチェック
      const autoDetectRoute = routes.find(route => 
        route.enabled && route.isAutoDetect && route.baseUrl && matchesBaseUrl(cleanUrl, route.baseUrl)
      );

      if (autoDetectRoute) {
        // 自動検出: パスとメソッドから子ルートを作成または取得
        const path = extractPath(cleanUrl);
        const normalizedPath = normalizePath(path);
        
        // 既存の子ルートを検索
        let childRoute = routes.find(route => 
          route.parentId === autoDetectRoute.id && 
          route.method === details.method && 
          route.path === normalizedPath
        );

        if (!childRoute) {
          // 新しい子ルートを作成
          childRoute = await createChildRoute(autoDetectRoute, normalizedPath, details.method);
        }

        matchedRoute = childRoute;
      }

      if (matchedRoute) {
        console.log(`✨ Matched route: ${matchedRoute.name} for ${cleanUrl}`);
        
        // WebRequestで取得したレスポンスボディを使用
        captureResponse(details, matchedRoute);
      } else {
        console.log(`ℹ️ No matching route for: ${cleanUrl}`);
      }
    },
    { urls: ['<all_urls>'] }
  );
}

async function createChildRoute(parentRoute: ApiRoute, path: string, method: string): Promise<ApiRoute> {
  const childRoute: ApiRoute = {
    id: `${Date.now()}-${Math.random()}`,
    pattern: '', // 子ルートはパターンマッチングを使わない
    name: generateRouteName(path, method),
    enabled: true,
    createdAt: Date.now(),
    parentId: parentRoute.id,
    method: method,
    path: path,
  };

  const data = await browser.storage.local.get('routes');
  const routes: ApiRoute[] = (data.routes as ApiRoute[] | undefined) || [];
  routes.push(childRoute);
  await browser.storage.local.set({ routes });

  console.log('Auto-detected new route:', childRoute.name);
  return childRoute;
}

async function captureResponse(
  details: any,
  route: ApiRoute
) {
  try {
    // URLパラメータを抽出
    const queryParams = extractQueryParams(details.url);
    
    // リクエストボディを取得
    const requestId = `${details.requestId}`;
    const requestBody = requestBodies.get(requestId);

    const meta = responseMeta.get(requestId);
    const contentType = meta?.contentType ?? '';
    const json = responseBodies.get(requestId);

    console.log(`🔎 Capture attempt - Route: ${route.name}, Has JSON: ${!!json}, Content-Type: ${contentType}`);

    if (json && (contentType === '' || contentType.includes('application/json'))) {
      
      // リクエストを記録
      const recordedRequest: RecordedRequest = {
        id: `${Date.now()}-${Math.random()}`,
        routeId: route.id,
        url: details.url,
        method: details.method,
        timestamp: Date.now(),
        response: json,
        statusCode: details.statusCode,
        queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
        requestBody: requestBody,
      };

      const data = await browser.storage.local.get('requests');
      const requests: RecordedRequest[] = (data.requests as RecordedRequest[] | undefined) || [];
      
      // 最大100件まで保存
      requests.push(recordedRequest);
      if (requests.length > 100) {
        requests.shift();
      }

      await browser.storage.local.set({ requests });

      // 型定義を更新
      await updateTypeDefinition(route, requests);
    }
  } catch (error) {
    console.error('Failed to capture response:', error);
  } finally {
    // リクエスト完了後にキャッシュをクリア
    const requestId = `${details.requestId}`;
    requestBodies.delete(requestId);
    responseBodies.delete(requestId);
    responseMeta.delete(requestId);
  }
}

async function updateTypeDefinition(route: ApiRoute, allRequests: RecordedRequest[]) {
  // このルートに関連するリクエストを取得
  const routeRequests = allRequests
    .filter(req => req.routeId === route.id && req.response)
    .slice(-10); // 最新10件から型を生成

  if (routeRequests.length === 0) return;

  const samples = routeRequests.map(req => req.response);
  const typeName = generateTypeName(route.name);
  const typeDefinition = generateTypeFromSamples(samples, typeName,{analyzeAllArrayElements: true});

  const formattedTypeDefinition = await formatCode(typeDefinition);

  const generatedType: GeneratedType = {
    routeId: route.id,
    routeName: route.name,
    typeName,
    typeDefinition: formattedTypeDefinition,
    sampleCount: routeRequests.length,
    lastUpdated: Date.now(),
  };

  // 型定義を保存
  const data = await browser.storage.local.get('types');
  const types: GeneratedType[] = (data.types as GeneratedType[] | undefined) || [];
  
  const existingIndex = types.findIndex(t => t.routeId === route.id);
  if (existingIndex >= 0) {
    types[existingIndex] = generatedType;
  } else {
    types.push(generatedType);
  }

  await browser.storage.local.set({ types });
  console.log('Type definition updated:', typeName);
}

function setupMessageListeners() {
  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'GET_DATA') {
      // ポップアップから要求されたデータを返す
      browser.storage.local.get(['routes', 'requests', 'types']).then(sendResponse);
      return true; // 非同期レスポンス
    }
    if (message.type === 'REGENERATE_TYPES') {
      // すべてのルートに対して型定義を再生成
      browser.storage.local.get(['routes', 'requests']).then(async (data) => {
        const routes: ApiRoute[] = (data.routes as ApiRoute[] | undefined) || [];
        const requests: RecordedRequest[] = (data.requests as RecordedRequest[] | undefined) || [];
        
        for (const route of routes) {
          await updateTypeDefinition(route, requests);
        }
        
        sendResponse({ success: true });
      });
      return true;
    }
    if (message.type === 'CLEAR_ALL') {
      // すべてのデータをクリア
      browser.storage.local.set({ routes: [], requests: [], types: [] }).then(() => {
        sendResponse({ success: true });
      });
      return true;
    }
    if (message.type === 'ADD_ROUTE') {
      // 自動検出モードかどうかをチェック
      const isAutoDetect = message.isAutoDetect === true;
      
      const newRoute: ApiRoute = {
        id: `${Date.now()}-${Math.random()}`,
        pattern: isAutoDetect ? '' : message.pattern,
        name: message.name,
        enabled: true,
        createdAt: Date.now(),
        isAutoDetect: isAutoDetect,
        baseUrl: isAutoDetect ? message.baseUrl : undefined,
      };
      
      browser.storage.local.get('routes').then(data => {
        const routes: ApiRoute[] = (data.routes as ApiRoute[] | undefined) || [];
        routes.push(newRoute);
        return browser.storage.local.set({ routes });
      }).then(() => {
        sendResponse({ success: true, route: newRoute });
      });
      return true;
    }
    
    if (message.type === 'DELETE_ROUTE') {
      browser.storage.local.get(['routes', 'requests', 'types']).then(data => {
        const allRoutes: ApiRoute[] = (data.routes as ApiRoute[] | undefined) || [];
        
        // 削除対象のルートとその子ルートを取得
        const routeIdsToDelete = new Set<string>([message.routeId]);
        allRoutes.forEach(route => {
          if (route.parentId === message.routeId) {
            routeIdsToDelete.add(route.id);
          }
        });
        
        const routes = allRoutes.filter(r => !routeIdsToDelete.has(r.id));
        const requests: RecordedRequest[] = ((data.requests as RecordedRequest[] | undefined) || [])
          .filter(r => !routeIdsToDelete.has(r.routeId));
        const types: GeneratedType[] = ((data.types as GeneratedType[] | undefined) || [])
          .filter(t => !routeIdsToDelete.has(t.routeId));
        
        return browser.storage.local.set({ routes, requests, types });
      }).then(() => {
        sendResponse({ success: true });
      });
      return true;
    }
    
    if (message.type === 'TOGGLE_ROUTE') {
      browser.storage.local.get('routes').then(data => {
        const routes: ApiRoute[] = (data.routes as ApiRoute[] | undefined) || [];
        const route = routes.find(r => r.id === message.routeId);
        if (route) {
          route.enabled = !route.enabled;
          return browser.storage.local.set({ routes });
        }
      }).then(() => {
        sendResponse({ success: true });
      });
      return true;
    }
  });
}
