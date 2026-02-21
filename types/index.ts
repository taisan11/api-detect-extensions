// API Route定義
export interface ApiRoute {
  id: string;
  pattern: string; // URLパターン (正規表現として扱う)
  name: string; // 表示用の名前
  enabled: boolean;
  createdAt: number;
  isAutoDetect?: boolean; // 自動検出モード（ベースURLから派生ルートを自動作成）
  baseUrl?: string; // 自動検出用のベースURL
  parentId?: string; // 親ルートのID（自動生成されたルートの場合）
  method?: string; // HTTPメソッド（自動生成されたルートの場合）
  path?: string; // パス（自動生成されたルートの場合）
}

// 記録されたAPIリクエスト
export interface RecordedRequest {
  id: string;
  routeId: string;
  url: string;
  method: string;
  timestamp: number;
  response?: any; // JSONレスポンス
  statusCode?: number;
  queryParams?: Record<string, string[]>; // URLパラメータ
  requestBody?: any; // リクエストボディ
}

// 生成された型定義
export interface GeneratedType {
  routeId: string;
  routeName: string;
  typeName: string;
  typeDefinition: string;
  sampleCount: number; // 何個のサンプルから生成したか
  lastUpdated: number;
  signature?: string; // 再生成スキップ用ハッシュ
}

// 設定情報
export interface AppSettings {
  sampleLimit: number; // パラメータサンプル保持上限
}

// ストレージのデータ構造
export interface StorageData extends AppSettings {
  routes: ApiRoute[];
  requests: RecordedRequest[];
  types: GeneratedType[];
}
