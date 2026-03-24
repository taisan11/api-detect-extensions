import type { ApiRoute, RecordedRequest, GeneratedType, StorageData } from '@/types';
import { aggregateParams } from '@/utils/paramCollector';

let currentData: StorageData = {
  routes: [],
  requests: [],
  types: [],
  sampleLimit: 20,
};
let selectedRouteId: string | null = null;
const expandedNodes = new Set<string>();
let nodeCounter = 0;
let explorerListenerAttached = false;

// 初期化
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadData();
});

function setupEventListeners() {
  // 更新ボタン
  document.getElementById('refreshBtn')?.addEventListener('click', async ()=>{
    await loadData();
  });
  
  // 全クリアボタン
  document.getElementById('clearAllBtn')?.addEventListener('click', async () => {
    if (confirm('全てのデータを削除しますか?')) {
      await browser.runtime.sendMessage({ type: 'CLEAR_ALL' });
      loadData();
    }
  });
  
  // モーダルを閉じる
  document.getElementById('modalClose')?.addEventListener('click', () => {
    document.getElementById('modal')!.classList.remove('active');
  });
  
  // モーダルの背景クリックで閉じる
  document.getElementById('modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      document.getElementById('modal')!.classList.remove('active');
    }
  });

  const results = document.getElementById('results');
  results?.addEventListener('click', async (e) => {
    const target = e.target as HTMLElement;
    const badge = target.closest('.type-badge') as HTMLElement | null;
    if (badge) {
      const samplesJson = badge.getAttribute('data-samples');
      if (!samplesJson) return;

      try {
        const samples = JSON.parse(samplesJson);
        showModal('サンプル値', samples);
      } catch (error) {
        console.error('Failed to parse samples', error);
      }
      return;
    }

    const copyBtn = target.closest('.copy-btn') as HTMLElement | null;
    if (copyBtn) {
      const text = copyBtn.getAttribute('data-copy');
      if (!text) return;

      await navigator.clipboard.writeText(text);
      const originalText = copyBtn.textContent;
      copyBtn.textContent = '✓ コピーしました';
      setTimeout(() => {
        copyBtn.textContent = originalText;
      }, 2000);
      return;
    }

    const promoteBtn = target.closest('[data-action="promote-auto"]') as HTMLElement | null;
    if (promoteBtn) {
      const parentRouteId = promoteBtn.dataset.routeId!;
      const methodSelect = document.getElementById('promoteMethodSelect') as HTMLSelectElement | null;
      const nameInput = document.getElementById('promoteNameInput') as HTMLInputElement | null;
      const patternInput = document.getElementById('promotePatternInput') as HTMLInputElement | null;
      const method = methodSelect?.value.trim() || undefined;
      const name = nameInput?.value.trim() ?? '';
      const pattern = patternInput?.value.trim() ?? '';

      if (!name || !pattern) {
        alert('名前とパターンを入力してください');
        return;
      }

      const response = await browser.runtime.sendMessage({
        type: 'PROMOTE_TO_PATTERN',
        parentRouteId,
        method,
        name,
        pattern,
      });

      if (response.success) {
        selectedRouteId = response.route.id;
        await loadData();
      } else {
        alert(`登録に失敗しました: ${response.error}`);
      }
    }
  });
}

async function loadData() {
  const response = await browser.runtime.sendMessage({ type: 'GET_RESULT_DATA' });
  currentData = {
    routes: response.routes || [],
    requests: response.requests || [],
    types: response.types || [],
    sampleLimit: response.sampleLimit || 20,
  };
  renderExplorer();
  renderSelectedResult();
}

function getRouteHost(route: ApiRoute): string {
  const routeRequests = currentData.requests.filter(r => r.routeId === route.id);
  if (routeRequests.length > 0) {
    try {
      return new URL(routeRequests[0].url).host;
    } catch (e) {
      // ignore
    }
  }

  if (route.baseUrl) {
    try {
      return new URL(route.baseUrl).host;
    } catch (e) {
      // ignore
    }
  }

  if (route.pattern?.startsWith('http')) {
    try {
      const normalized = route.pattern.replace(/:[^/]+/g, 'placeholder');
      return new URL(normalized).host;
    } catch (e) {
      // ignore
    }
  }

  return '未分類';
}

function renderExplorer() {
  const explorer = document.getElementById('explorerTree')!;
  nodeCounter = 0;

  if (currentData.routes.length === 0) {
    explorer.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">登録されたRouteはありません</div></div>';
    return;
  }

  const tree = buildExplorerTree();
  if (!selectedRouteId || !currentData.routes.find(r => r.id === selectedRouteId)) {
    selectedRouteId = findFirstRouteId(tree);
  }

  explorer.innerHTML = tree.folders.map(folder => renderFolder(folder, 0)).join('');

  if (!explorerListenerAttached) {
    explorer.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const row = target.closest('.tree-row') as HTMLElement | null;
      if (!row) return;
      const action = row.dataset.action;
      if (action === 'toggle') {
        const nodeId = row.dataset.nodeId!;
        if (expandedNodes.has(nodeId)) {
          expandedNodes.delete(nodeId);
        } else {
          expandedNodes.add(nodeId);
        }
        renderExplorer();
      }
      if (action === 'select') {
        const routeId = row.dataset.routeId!;
        if (routeId !== selectedRouteId) {
          selectedRouteId = routeId;
          renderExplorer();
          renderSelectedResult();
        }
      }
    });
    explorerListenerAttached = true;
  }
}

function renderSelectedResult() {
  const results = document.getElementById('results')!;

  if (currentData.routes.length === 0) {
    results.innerHTML = '<div class="empty"><div class="empty-icon">📊</div><div class="empty-text">登録されたRouteはありません</div><div class="empty-hint">Routeを追加するとここに集約結果が表示されます</div></div>';
    return;
  }

  const route = currentData.routes.find(r => r.id === selectedRouteId);
  if (!route) {
    results.innerHTML = '<div class="empty"><div class="empty-icon">📌</div><div class="empty-text">左のエクスプローラーからファイルを選択してください</div></div>';
    return;
  }

  // AUTOルートは専用UIを表示
  if (route.isAutoDetect) {
    results.innerHTML = renderAutoParentResult(route);
    return;
  }

  const requests = currentData.requests.filter(r => r.routeId === route.id);
  const params = aggregateParams(requests, currentData.sampleLimit);
  const paramList = Object.values(params);
  const typeInfo = currentData.types.find(t => t.routeId === route.id);
  const requestCount = requests.length;
  const method = getRouteMethod(route);
  const badgeClass = `method-${method.toLowerCase()}`;
  const displayPath = getRouteDisplayPath(route);
  const graphqlOps = route.isGraphQL ? summarizeGraphqlOperations(requests) : null;
  const typeLabel = typeInfo?.format === 'graphql' ? 'GraphQL Schema (SDL)' : 'TypeScript 型定義';

  results.innerHTML = `
    <div class="result-header">
      <span class="method-badge ${badgeClass}">${method}</span>
      <div class="result-title">${escapeHtml(route.name)}</div>
      <div class="muted">${requestCount}件</div>
    </div>
    <div class="result-path">${escapeHtml(displayPath)}</div>

    ${renderUrlHistory(requests)}

    ${graphqlOps ? `
      <div class="subsection">
        <div class="subsection-title">GraphQL Operations</div>
        <table class="params-table">
          <thead>
            <tr>
              <th>Operation</th>
              <th>Type</th>
              <th>出現回数</th>
            </tr>
          </thead>
          <tbody>
            ${graphqlOps.map(op => `
              <tr>
                <td class="param-name">${escapeHtml(op.name)}</td>
                <td><span class="type-badge">${escapeHtml(op.type)}</span></td>
                <td>${op.count}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : ''}

    ${paramList.length > 0 ? `
      <div class="subsection">
        <div class="subsection-title">クエリパラメータ & リクエストボディ</div>
        <table class="params-table">
          <thead>
            <tr>
              <th>パラメータ名</th>
              <th>型</th>
              <th>出現回数</th>
            </tr>
          </thead>
          <tbody>
            ${paramList.map(param => `
              <tr>
                <td class="param-name">${escapeHtml(param.name)}</td>
                <td>
                  <div class="param-types">
                    ${Array.from(param.types).map(type => 
                      `<span class="type-badge" data-samples="${escapeHtml(JSON.stringify(param.samples))}">${type}</span>`
                    ).join('')}
                  </div>
                </td>
                <td>${param.frequency}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '<div class="muted">パラメータはまだありません</div>'}

    ${typeInfo ? `
      <div class="subsection">
        <div class="subsection-title">${typeLabel}</div>
        <div class="type-definition">
          <pre>${escapeHtml(typeInfo.typeDefinition)}</pre>
          <button class="copy-btn" data-copy="${escapeHtml(typeInfo.typeDefinition)}">📋 コピー</button>
        </div>
      </div>
    ` : '<div class="muted">型定義はまだありません</div>'}
  `;

}

function renderAutoParentResult(route: ApiRoute): string {
  const childRoutes = currentData.routes.filter(r => r.parentId === route.id);
  const totalRequests = childRoutes.reduce(
    (sum, child) => sum + currentData.requests.filter(r => r.routeId === child.id).length,
    0
  );
  const baseUrl = route.baseUrl || '';

  return `
    <div class="result-header">
      <span class="method-badge method-auto">AUTO</span>
      <div class="result-title">${escapeHtml(route.name)}</div>
      <div class="muted">${childRoutes.length}ルート収集 / ${totalRequests}リクエスト</div>
    </div>
    <div class="result-path">${escapeHtml(baseUrl)}</div>

    <div class="subsection promote-section">
      <div class="subsection-title">🔧 パターンルート登録</div>
      <div class="promote-hint">
        収集されたURLを確認し、<code>:id</code> などで可変部分を置換したパターンを定義してください。<br>
        登録するとパターンにマッチした収集ルートのリクエストデータが引き継がれ、型定義が生成されます。
      </div>
      <div class="promote-form">
        <label class="promote-label">HTTPメソッド</label>
        <select id="promoteMethodSelect" class="promote-input">
          <option value="">すべてのメソッド</option>
          <option value="GET">GET</option>
          <option value="POST">POST</option>
          <option value="PUT">PUT</option>
          <option value="PATCH">PATCH</option>
          <option value="DELETE">DELETE</option>
        </select>
        <label class="promote-label">ルート名</label>
        <input type="text" id="promoteNameInput" class="promote-input" placeholder="例: GET Users By Id" />
        <label class="promote-label">URLパターン（:param で可変部分を指定）</label>
        <input type="text" id="promotePatternInput" class="promote-input"
          value="${escapeHtml(baseUrl)}"
          placeholder="例: https://example.com/api/users/:id" />
        <div class="promote-actions">
          <button class="btn btn-primary" data-action="promote-auto" data-route-id="${escapeHtml(route.id)}">✅ パターンルートとして登録</button>
        </div>
      </div>
    </div>

    ${renderCollectedRoutesList(childRoutes)}
  `;
}

function renderCollectedRoutesList(childRoutes: ApiRoute[]): string {
  if (childRoutes.length === 0) {
    return '<div class="muted" style="margin-top:16px;">まだルートが収集されていません。対象ページを操作してAPIリクエストを発生させてください。</div>';
  }

  // メソッド → パスでソート
  const sorted = [...childRoutes].sort((a, b) => {
    const m = (a.method ?? '').localeCompare(b.method ?? '');
    return m !== 0 ? m : (a.path ?? '').localeCompare(b.path ?? '');
  });

  const rows = sorted.map(child => {
    const method = (child.method || 'ANY').toUpperCase();
    const badgeClass = `method-${method.toLowerCase()}`;
    const reqCount = currentData.requests.filter(r => r.routeId === child.id).length;
    return `
      <div class="collected-route-row">
        <span class="method-badge ${badgeClass}" style="font-size:10px;padding:2px 6px;">${method}</span>
        <span class="collected-route-path">${escapeHtml(child.path || '/')}</span>
        <span class="collected-route-count">${reqCount}件</span>
      </div>`;
  }).join('');

  return `
    <div class="subsection">
      <div class="subsection-title">📡 収集されたルート <span class="muted">(${childRoutes.length}件)</span></div>
      <div class="collected-routes-list">${rows}</div>
    </div>`;
}

function renderUrlHistory(requests: RecordedRequest[]): string {
  if (requests.length === 0) return '';

  // URL を重複除去して直近10件取得（新しい順）
  const seen = new Set<string>();
  const unique = [...requests].reverse().filter(r => {
    if (seen.has(r.url)) return false;
    seen.add(r.url);
    return true;
  }).slice(0, 10);

  const rows = unique.map(req => {
    const code = req.statusCode ?? 0;
    const statusClass = code >= 500 ? 'status-error'
      : code >= 400 ? 'status-error'
      : code >= 300 ? 'status-redirect'
      : code >= 200 ? 'status-ok'
      : 'status-other';
    return `
      <div class="url-history-row">
        <span class="status-badge ${statusClass}">${req.statusCode ?? '-'}</span>
        <span class="url-history-text">${escapeHtml(req.url)}</span>
      </div>`;
  }).join('');

  return `
    <div class="subsection">
      <div class="subsection-title">キャプチャされたURL <span class="muted">(直近${unique.length}件 / 計${requests.length}件)</span></div>
      <div class="url-history">${rows}</div>
    </div>`;
}

function buildExplorerTree() {
  const root = {
    folders: [] as FolderNode[],
  };

  const hostMap = new Map<string, FolderNode>();

  // parentId を持つ子ルート（AUTOで収集された未昇格ルート）はExplorerに表示しない
  currentData.routes.filter(route => !route.parentId).forEach(route => {
    const { host, folders, fileLabel, method } = getRouteExplorerInfo(route);
    const hostFolder = getOrCreateFolder(hostMap, host, 0);
    let currentFolder = hostFolder;

    folders.forEach((folderName, index) => {
      const found = currentFolder.folders.find(f => f.name === folderName);
      if (found) {
        currentFolder = found;
      } else {
        const newFolder = createFolder(folderName, index + 1);
        currentFolder.folders.push(newFolder);
        currentFolder = newFolder;
      }
    });

    currentFolder.files.push({
      id: nextNodeId(),
      name: fileLabel,
      routeId: route.id,
      method,
      depth: currentFolder.depth + 1,
    });
  });

  root.folders = Array.from(hostMap.values()).sort((a, b) => a.name.localeCompare(b.name));
  root.folders.forEach(folder => sortFolder(folder));
  return root;
}

function sortFolder(folder: FolderNode) {
  folder.folders.sort((a, b) => a.name.localeCompare(b.name));
  folder.files.sort((a, b) => a.name.localeCompare(b.name));
  folder.folders.forEach(child => sortFolder(child));
}

function findFirstRouteId(tree: { folders: FolderNode[] }): string | null {
  for (const folder of tree.folders) {
    const found = findFirstFileInFolder(folder);
    if (found) return found;
  }
  return null;
}

function findFirstFileInFolder(folder: FolderNode): string | null {
  if (folder.files.length > 0) {
    return folder.files[0].routeId;
  }
  for (const child of folder.folders) {
    const found = findFirstFileInFolder(child);
    if (found) return found;
  }
  return null;
}

function getOrCreateFolder(map: Map<string, FolderNode>, name: string, depth: number): FolderNode {
  const existing = map.get(name);
  if (existing) return existing;
  const folder = createFolder(name, depth);
  map.set(name, folder);
  return folder;
}

function createFolder(name: string, depth: number): FolderNode {
  return {
    id: nextNodeId(),
    name,
    depth,
    folders: [],
    files: [],
  };
}

function nextNodeId() {
  nodeCounter += 1;
  return `node-${nodeCounter}`;
}

function renderFolder(folder: FolderNode, depth: number): string {
  const isExpanded = expandedNodes.has(folder.id) || depth === 0;
  const chevron = isExpanded ? '▾' : '▸';
  return `
    <div class="tree-folder">
      <div class="tree-row" style="--depth:${depth};" data-action="toggle" data-node-id="${folder.id}">
        <span class="tree-chevron">${chevron}</span>
        <span class="tree-icon">📁</span>
        <span class="tree-label">${escapeHtml(folder.name)}</span>
      </div>
      <div class="tree-children" style="display:${isExpanded ? 'block' : 'none'};">
        ${folder.folders.map(child => renderFolder(child, depth + 1)).join('')}
        ${folder.files.map(file => renderFile(file, depth + 1)).join('')}
      </div>
    </div>
  `;
}

function renderFile(file: FileNode, depth: number): string {
  const isActive = file.routeId === selectedRouteId;
  const badgeClass = `method-${file.method.toLowerCase()}`;
  return `
    <div class="tree-row ${isActive ? 'active' : ''}" style="--depth:${depth};" data-action="select" data-route-id="${file.routeId}">
      <span class="tree-chevron"></span>
      <span class="tree-icon">📄</span>
      <span class="tree-label">${escapeHtml(file.name)}</span>
      <span class="tree-badge ${badgeClass}">${file.method}</span>
    </div>
  `;
}

function getRouteExplorerInfo(route: ApiRoute) {
  const displayPath = getRouteDisplayPath(route);
  let host = getRouteHost(route);
  let path = displayPath;

  try {
    if (displayPath.startsWith('http')) {
      const url = new URL(displayPath);
      host = url.host || host;
      path = url.pathname;
    } else if (route.baseUrl && route.baseUrl.startsWith('http')) {
      const url = new URL(route.baseUrl);
      host = url.host || host;
      path = route.path || url.pathname;
    }
  } catch (e) {
    // ignore
  }

  const segments = path.split('/').filter(Boolean);
  const rawLabel = segments.length > 0 ? segments[segments.length - 1] : route.name;
  const fileLabel = rawLabel && rawLabel.length > 0 ? rawLabel : route.name;
  const folders = segments.slice(0, Math.max(0, segments.length - 1));
  const method = getRouteMethod(route);

  return { host, folders, fileLabel, method };
}

function getRouteMethod(route: ApiRoute): string {
  return (route.method || (route.isGraphQL ? 'GQL' : (route.isAutoDetect ? 'AUTO' : 'ANY'))).toUpperCase();
}

function getRouteDisplayPath(route: ApiRoute): string {
  const parent = route.parentId ? currentData.routes.find(r => r.id === route.parentId) : undefined;
  if (route.path) {
    if (parent?.baseUrl) {
      try {
        const { origin } = new URL(parent.baseUrl);
        return `${origin}${route.path}`;
      } catch {
        // baseUrl が不正な場合はパスのみ返す
      }
    }
    return route.path;
  }
  return route.graphqlEndpoint || route.baseUrl || route.pattern || '(パス未設定)';
}

function summarizeGraphqlOperations(requests: RecordedRequest[]): Array<{ name: string; type: string; count: number }> {
  const map = new Map<string, { name: string; type: string; count: number }>();
  requests.forEach((request) => {
    const operationName = request.graphqlOperationName || 'Anonymous';
    const operationType = request.graphqlOperationType || 'query';
    const key = `${operationType}:${operationName}`;
    const item = map.get(key);
    if (item) {
      item.count += 1;
      return;
    }
    map.set(key, {
      name: operationName,
      type: operationType,
      count: 1,
    });
  });

  return Array.from(map.values()).sort((a, b) => `${a.type}:${a.name}`.localeCompare(`${b.type}:${b.name}`));
}

type FolderNode = {
  id: string;
  name: string;
  depth: number;
  folders: FolderNode[];
  files: FileNode[];
};

type FileNode = {
  id: string;
  name: string;
  routeId: string;
  method: string;
  depth: number;
};

function showModal(title: string, samples: string[]) {
  const modal = document.getElementById('modal')!;
  const modalTitle = document.getElementById('modalTitle')!;
  const modalSamples = document.getElementById('modalSamples')!;
  
  modalTitle.textContent = title;
  modalSamples.innerHTML = samples.slice(0, 20).map(sample => 
    `<li>${escapeHtml(String(sample))}</li>`
  ).join('');
  
  modal.classList.add('active');
}

function escapeHtml(text: string): string {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
