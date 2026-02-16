# API Type Detector

WXTで構築されたブラウザ拡張機能で、APIリクエストを監視し、レスポンスからTypeScript型定義を自動生成します。

## 機能

- 🔍 **API Routeの登録**: 監視したいAPIのURLパターンを正規表現で登録
- 📊 **通信の監視**: 登録されたルートへのリクエストを自動的に記録
- 🎯 **型定義の生成**: JSONレスポンスから適切なTypeScript型定義を自動生成
- 📋 **ワンクリックコピー**: 生成された型定義をクリップボードにコピー

## 使い方

### 1. 拡張機能のインストール

開発モードで実行:
```bash
bun run dev
```

本番用ビルド:
```bash
bun run build
```

### 2. API Routeの登録

1. 拡張機能のアイコンをクリックしてポップアップを開く
2. 「API Routeを登録」セクションで以下を入力:
   - **Route名**: わかりやすい名前（例: "User API"）
   - **URLパターン**: 監視したいURLの正規表現（例: `/api/users`）
3. 「追加」ボタンをクリック

#### URLパターンの例

- `/api/users` - `/api/users`を含むすべてのURL
- `^https://example\.com/api/` - example.comのAPIのみ
- `/api/posts/\d+$` - `/api/posts/123`のような数字で終わるURL

### 3. 通信の監視

登録したAPIパターンにマッチするリクエストが発生すると、自動的に記録されます。

### 4. 型定義の確認

「生成された型定義」セクションに、記録されたレスポンスから生成されたTypeScript型定義が表示されます。

- 複数のリクエストから統合された型定義が生成されます
- オプショナルなフィールドは`?`マークで示されます
- ユニオン型で複数の型の可能性を表現します

### 5. 型定義のコピー

「コピー」ボタンをクリックすると、型定義がクリップボードにコピーされ、コード内で使用できます。

## 技術スタック

- **WXT**: ブラウザ拡張機能開発フレームワーク
- **TypeScript**: 型安全な開発
- **WebRequest API**: ネットワークリクエストの監視
- **Storage API**: データの永続化

## 開発コマンド

```bash
# 開発モード (Chrome)
bun run dev

# 開発モード (Firefox)
bun run dev:firefox

# 本番ビルド
bun run build

# ZIPファイルの作成
bun run zip

# 型チェック
bun run compile
```

## ファイル構造

```
api-detect-extensions/
├── entrypoints/
│   ├── background.ts          # バックグラウンドスクリプト (API監視)
│   └── popup/
│       ├── index.html          # ポップアップHTML
│       ├── main.ts             # ポップアップロジック
│       └── style.css           # スタイル
├── types/
│   └── index.ts                # 型定義
├── utils/
│   └── typeGenerator.ts        # 型生成ユーティリティ
└── wxt.config.ts               # WXT設定
```

## 制限事項

- 現在はシンプルなJSON形式のみに対応
- 同一オリジンポリシーにより、一部のリクエストのレスポンスが取得できない場合があります
- 最大100件までのリクエストを保存

## ライセンス

MIT
