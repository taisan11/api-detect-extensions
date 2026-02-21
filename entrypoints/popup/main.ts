import './style.css';
import type { ApiRoute } from '@/types';

let routes: ApiRoute[] = [];

// イベントリスナーのセットアップ
document.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  loadSettings();
  loadRoutes();
});

function setupEventListeners() {
  // オプションページを開く
  document.getElementById('openOptionsBtn')?.addEventListener('click', () => {
    const url = browser.runtime.getURL('/result.html');
    window.open(url, '_blank');
  });

  // モード切り替え
  const modeRadios = document.querySelectorAll<HTMLInputElement>('input[name="mode"]');
  modeRadios.forEach(radio => {
    radio.addEventListener('change', () => {
      const patternForm = document.getElementById('patternForm')!;
      const autoForm = document.getElementById('autoForm')!;
      const patternHint = document.getElementById('patternHint')!;
      const autoHint = document.getElementById('autoHint')!;
      
      if (radio.value === 'auto') {
        patternForm.style.display = 'none';
        autoForm.style.display = 'flex';
        patternHint.style.display = 'none';
        autoHint.style.display = 'block';
      } else {
        patternForm.style.display = 'flex';
        autoForm.style.display = 'none';
        patternHint.style.display = 'block';
        autoHint.style.display = 'none';
      }
    });
  });

  // ルート登録
  document.getElementById('addRoute')?.addEventListener('click', addRoute);
  document.getElementById('addAutoRoute')?.addEventListener('click', addAutoRoute);
  document.getElementById('saveSampleLimitBtn')?.addEventListener('click', saveSampleLimit);

  // URL ツール
  document.getElementById('encodeBtn')?.addEventListener('click', () => {
    const input = (document.getElementById('urlEncodeInput') as HTMLTextAreaElement).value;
    const output = document.getElementById('urlEncodeOutput') as HTMLTextAreaElement;
    output.value = encodeURIComponent(input);
  });

  document.getElementById('decodeBtn')?.addEventListener('click', () => {
    const input = (document.getElementById('urlEncodeInput') as HTMLTextAreaElement).value;
    const output = document.getElementById('urlEncodeOutput') as HTMLTextAreaElement;
    try {
      output.value = decodeURIComponent(input);
    } catch (e) {
      output.value = 'エラー: 無効なエンコード文字列';
    }
  });

  document.getElementById('copyEncodeBtn')?.addEventListener('click', async () => {
    const output = (document.getElementById('urlEncodeOutput') as HTMLTextAreaElement).value;
    await navigator.clipboard.writeText(output);
    const btn = document.getElementById('copyEncodeBtn') as HTMLButtonElement;
    const originalText = btn.textContent;
    btn.textContent = 'コピーしました!';
    setTimeout(() => btn.textContent = originalText, 2000);
  });

  document.getElementById('cleanUrlBtn')?.addEventListener('click', () => {
    const input = (document.getElementById('urlCleanInput') as HTMLTextAreaElement).value;
    const output = document.getElementById('urlCleanOutput') as HTMLTextAreaElement;
    
    const urls = input.split('\n').filter(line => line.trim());
    const cleaned = urls.map(url => {
      try {
        return url.split('?')[0].split('#')[0];
      } catch {
        return url;
      }
    });
    
    output.value = cleaned.join('\n');
  });

  document.getElementById('copyCleanBtn')?.addEventListener('click', async () => {
    const output = (document.getElementById('urlCleanOutput') as HTMLTextAreaElement).value;
    await navigator.clipboard.writeText(output);
    const btn = document.getElementById('copyCleanBtn') as HTMLButtonElement;
    const originalText = btn.textContent;
    btn.textContent = 'コピーしました!';
    setTimeout(() => btn.textContent = originalText, 2000);
  });
}

async function loadRoutes() {
  try {
    const data = await browser.runtime.sendMessage({ type: 'GET_DATA' });
    routes = (data.routes as ApiRoute[] | undefined) || [];
    renderRouteList();
  } catch (e) {
    console.error('Failed to load routes', e);
  }
}

async function loadSettings() {
  try {
    const response = await browser.runtime.sendMessage({ type: 'GET_SETTINGS' });
    const sampleLimit = response?.settings?.sampleLimit ?? 20;
    const input = document.getElementById('sampleLimitInput') as HTMLInputElement | null;
    if (input) {
      input.value = String(sampleLimit);
    }
  } catch (error) {
    console.error('Failed to load settings', error);
  }
}

async function saveSampleLimit() {
  const input = document.getElementById('sampleLimitInput') as HTMLInputElement | null;
  if (!input) return;

  const parsed = Number(input.value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    alert('サンプル保持上限は1以上の数値を入力してください');
    return;
  }

  const response = await browser.runtime.sendMessage({
    type: 'UPDATE_SETTINGS',
    sampleLimit: Math.floor(parsed),
  });

  if (response?.success) {
    input.value = String(response.settings.sampleLimit);
    alert('表示設定を保存しました');
  }
}

function renderRouteList() {
  const list = document.getElementById('routeList');
  if (!list) return;

  if (!routes.length) {
    list.innerHTML = '<div class="empty">登録済みのRouteはありません</div>';
    return;
  }

  list.innerHTML = routes.map(route => {
    const method = (route.method || (route.isAutoDetect ? 'AUTO' : 'ANY')).toUpperCase();
    const badgeClass = `method-${method.toLowerCase()}`;
    const path = route.path
      ? route.path
      : (route.baseUrl || route.pattern || '');

    return `
      <div class="route-row">
        <div class="route-row-header">
          <span class="method-badge ${badgeClass}">${method}</span>
          <span class="route-row-name">${escapeHtml(route.name)}</span>
        </div>
        <div class="route-row-path">${escapeHtml(path)}</div>
      </div>
    `;
  }).join('');
}

async function addRoute() {
  const nameInput = document.getElementById('routeName') as HTMLInputElement;
  const patternInput = document.getElementById('routePattern') as HTMLInputElement;

  const name = nameInput.value.trim();
  const pattern = patternInput.value.trim();

  if (!name || !pattern) {
    alert('名前とパターンを入力してください');
    return;
  }

  if (!pattern.includes(':')) {
    try {
      new RegExp(pattern);
    } catch (e) {
      alert('無効な正規表現です');
      return;
    }
  }

  const response = await browser.runtime.sendMessage({
    type: 'ADD_ROUTE',
    name,
    pattern,
  });

  if (response.success) {
    nameInput.value = '';
    patternInput.value = '';
    alert('Routeを追加しました');
    loadRoutes();
  }
}

async function addAutoRoute() {
  const nameInput = document.getElementById('autoRouteName') as HTMLInputElement;
  const urlInput = document.getElementById('autoRouteUrl') as HTMLInputElement;

  const name = nameInput.value.trim();
  const baseUrl = urlInput.value.trim();

  if (!name || !baseUrl) {
    alert('名前とベースURLを入力してください');
    return;
  }

  try {
    new URL(baseUrl);
  } catch (e) {
    alert('有効なURLを入力してください');
    return;
  }

  const response = await browser.runtime.sendMessage({
    type: 'ADD_ROUTE',
    name,
    baseUrl,
    isAutoDetect: true,
  });

  if (response.success) {
    nameInput.value = '';
    urlInput.value = '';
    alert('Routeを追加しました');
    loadRoutes();
  }
}

function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text ?? '';
  return div.innerHTML;
}
