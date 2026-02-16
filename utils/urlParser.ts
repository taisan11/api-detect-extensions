/**
 * URLからクエリパラメータを除いたベースURLを取得
 */
export function getBaseUrl(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.origin}${urlObj.pathname}`;
  } catch {
    // URLのパースに失敗した場合は、クエリパラメータを手動で除去
    return url.split('?')[0].split('#')[0];
  }
}

/**
 * URLからパス部分のみを抽出
 */
export function extractPath(url: string): string {
  try {
    const urlObj = new URL(url);
    return urlObj.pathname;
  } catch {
    // URLのパースに失敗した場合
    const match = url.match(/^https?:\/\/[^/]+(\/[^?#]*)/);
    return match ? match[1] : '/';
  }
}

/**
 * URLがベースURLにマッチするかチェック
 */
export function matchesBaseUrl(url: string, baseUrl: string): boolean {
  try {
    const urlObj = new URL(url);
    const baseUrlObj = new URL(baseUrl);
    
    // オリジンが一致し、パスが指定されたベースで始まる
    return urlObj.origin === baseUrlObj.origin && 
           urlObj.pathname.startsWith(baseUrlObj.pathname);
  } catch {
    return false;
  }
}

/**
 * ルート名を生成（パスとメソッドから）
 */
export function generateRouteName(path: string, method: string): string {
  // パスをキャメルケースに変換
  const segments = path.split('/').filter(s => s.length > 0);
  const pathName = segments
    .map(seg => {
      // 数値やIDのようなセグメントは除外
      if (/^\d+$/.test(seg) || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
        return ':id';
      }
      return seg;
    })
    .map(seg => seg.charAt(0).toUpperCase() + seg.slice(1).toLowerCase())
    .join(' ');
  
  return `${method} ${pathName || '/'}`;
}

/**
 * パスを正規化（IDなどを:idに置き換え）
 */
export function normalizePath(path: string): string {
  return path.split('/').map(seg => {
    // 数値は:idに置き換え
    if (/^\d+$/.test(seg)) {
      return ':id';
    }
    // UUIDは:idに置き換え
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)) {
      return ':id';
    }
    return seg;
  }).join('/');
}

/**
 * URLパターン（:id形式）を正規表現に変換
 * 例: /api/users/:id/posts -> /api/users/[^/]+/posts
 */
export function patternToRegex(pattern: string): string {
  // エスケープが必要な特殊文字
  let regex = pattern
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // 正規表現の特殊文字をエスケープ
    .replace(/:\w+/g, '[^/?#]+'); // :param を [^/?#]+ に置き換え（パス区切りまでの任意の文字列）
  
  // URLの末尾にクエリパラメータやハッシュがあっても許容
  if (!regex.endsWith('$')) {
    regex += '(\\?.*)?$';
  }
  
  return regex;
}

/**
 * URLがパターンにマッチするかチェック（:id形式対応）
 */
export function matchesPattern(url: string, pattern: string): boolean {
  try {
    // パターンが正規表現形式かチェック
    if (pattern.includes(':')) {
      // :param 形式の場合は正規表現に変換
      const regexPattern = patternToRegex(pattern);
      const regex = new RegExp(regexPattern);
      const cleanUrl = getBaseUrl(url);
      return regex.test(cleanUrl);
    } else {
      // 通常の正規表現として扱う
      const regex = new RegExp(pattern);
      return regex.test(url);
    }
  } catch (e) {
    console.error('Pattern matching error:', e);
    return false;
  }
}

