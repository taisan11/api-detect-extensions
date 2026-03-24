# API Type Detector

REST/GraphQL の API リクエストを監視し、型定義を自動生成する Firefox 拡張です。

## Features

- パターンモード: URLパターン (`:id` 記法対応) で REST エンドポイントを監視
- 自動検出モード: ベースURL配下のエンドポイントを自動収集
- GraphQLモード: エンドポイント指定で operation / variables / response を解析し、GraphQL Schema (SDL) を生成
- 収集データから TypeScript 型定義を再生成
- キャプチャURL履歴・パラメータ統計の可視化

## How to Build
```bash
bun i # or npm or pnpm or yarn
bun run compile
bun run build
```
## License
MIT
