# V-Link Station - 開発ガイド

## プロジェクト概要

Electron + Express + Socket.IO 製のローカルデスクトップアプリ。
LiveLink モーションキャプチャ受信・録画、および WebRTC 映像配信を行う。
**ビルドステップなし** — `.js` ファイルをそのまま配信・実行する構成。JavaScript のみ（TypeScript 不使用）。

## ディレクトリ構成

```
pnpm-workspace.yaml    ワークスペース定義 (apps/*, packages/*)
package.json           ルート (scripts: start/dist, devDeps: electron/electron-builder)
apps/
  desktop/             Electron メインプロセス (@v-link/desktop)
    electron/
      main.js
      preload.js
    package.json
  server/              Express + Socket.IO サーバー (@v-link/server)
    server.js
    package.json
packages/
  renderer/            ブラウザ側 HTML / CSS / JS (@v-link/renderer)
    index.html
    mocap.js           キャンバスインフラのみ。ノード固有ロジックは書かない
    mocap.css          全ノード共通スタイル
    package.json
  protocols/           プロトコルプラグイン一式 (@v-link/protocols)
    livelink-face/     parser.js (Node.js) / renderer.js (browser) / node.js (plugin)
    webcam/            node.js
    screen-capture/    node.js
    stream-output/     node.js
    package.json
  shared/              サーバー・クライアント共通定数 (@v-link/shared)
    constants.js
    package.json
```

### pnpm 起動コマンド

```sh
pnpm start   # node node_modules/electron/cli.js apps/desktop
pnpm dist    # electron-builder (apps/desktop 経由)
```

> **注意**: このプロジェクトはネットワークドライブ (UNC パス) 上にある。
> pnpm workspace モードで CMD.EXE が UNC パスを扱えない問題を回避するため `.npmrc` に
> `script-shell=powershell.exe` を設定している。
> また `.bin` シム生成が UNC パスで失敗するため `start` スクリプトは
> `node node_modules/electron/cli.js` で electron を直接起動している。

## ノードプラグインのルール

新しいノードを追加するときは **`protocols/<name>/node.js` 1ファイルに以下をすべて実装する**。
`mocap.js` や `renderer/` 直下には書かない。

### 必須プロパティ

```javascript
window.NodePlugins['plugin-id'] = {
  label:       'ノード表示名',      // 右クリックメニューに表示
  icon:        '絵文字',            // ラベル前に表示
  menuSection: 'セクション名',      // 右クリックメニューのグループ
  nodeClass:   'node-card ...',     // ノードカードの CSS クラス
  pins: {
    out: [{ type: 'video', label: '出力ラベル' }],             // 出力ピン: type が色と型を決める
    in:  [{ label: '入力ラベル', accepts: 'video' }],          // 入力ピン: accepts で接続可能な型を制限
  },
  // accepts が未指定の入力ピンは全型を受け入れる
  // accepts に合わない型をドラッグしてもハイライトされず接続できない
  // accepts="video" の入力ピンは自動でオレンジ色になる
  create(pos)               { ... },  // 右クリックから呼ばれる
  mount(nodeId, nodeEl)     { ... },  // ノードカード本体を構築
  createPanel(nodeId, cont) { ... },  // 右ペイン詳細パネル。不要なら null
  getMetrics(nodeId)        { ... },  // パフォーマンスパネル用メトリクス
  unmount(nodeId)           { ... },  // 削除時クリーンアップ
};
```

### getMetrics の戻り値フォーマット（必ず守る）

```javascript
return {
  dotCls:      'node-state-dot state-active',  // ドットの CSS クラス
  statusCls:   'badge-active',                 // バッジの CSS クラス
  statusLabel: '受信中',                        // バッジのテキスト
  stats: [
    { lbl: 'FPS',  val: '60.0' },              // パフォーマンス統計（任意個）
    { lbl: '解像度', val: '1920×1080' },
  ],
};
```

### ノードヘッダーのルール（全ノード統一）

```html
<div class="node-header ..." id="nheader-${nodeId}">
  <span class="node-state-dot" id="ndot-${nodeId}"></span>  <!-- 左: 状態色 -->
  <input class="node-name" id="ename-${nodeId}" ...>        <!-- 中: 編集可能な名前 -->
  <button class="node-delete-btn" onclick="removePluginNode('${nodeId}')">✕</button>  <!-- 右: 削除 -->
</div>
```

### ドット色の意味（統一ルール）

| CSS クラス | 色 | 意味 |
|---|---|---|
| `node-state-dot` (クラスなし) | 灰色 | 待機中・未接続 |
| `state-active` | 緑 | 正常動作中（受信中・キャプチャ中） |
| `state-orange` | オレンジ | 利用可能だが未送出 |
| `state-purple` + blink | 紫点滅 | 配信中 |

### ノード連番名のルール

**必ず `window.nextUniqueName` を使うこと。** インクリメントのみのカウンターは削除後に番号がズレるため使用禁止。

```javascript
function nextName() {
  return window.nextUniqueName('plugin-id', 'NodeLabel');
}
```

- 同じ pluginId のノードが1つもなければ `NodeLabel`（番号なし）
- 既に `NodeLabel` が存在すれば `NodeLabel_2`、以降は最小の未使用番号
- 実装は `mocap.js` の `window.nextUniqueName(pluginId, baseName)` を参照
- デバイスノード（LiveLink 等）は `getNextDeviceName()` が同等の処理をしている

### FPS 計測（映像ノード共通）

`requestVideoFrameCallback` を使い `window.nodeMetrics.set(nodeId, { fps, resolution })` に書き込む。
フォールバックとして `setInterval` で解像度のみ計測する。

## グローバル API（mocap.js が公開）

| 変数 / 関数 | 型 | 説明 |
|---|---|---|
| `window.NodePlugins` | Object | プラグイン登録先 |
| `window.nodeStreams` | Map | nodeId → MediaStream |
| `window.nodeMetrics` | Map | nodeId → 任意のメトリクスオブジェクト |
| `window.devices` | Map | LiveLink deviceId → デバイス状態 |
| `window.connections` | Map | 接続情報 |
| `window.socket` | Socket | Socket.IO クライアント |
| `window.pluginNodeCounters` | Object | プラグイン別連番カウンター |
| `createPluginNode(pluginId, nodeId, pos)` | function | ノード生成 |
| `removePluginNode(nodeId)` | function | ノード削除 |
| `generateNodeId()` | function | ユニーク ID 生成 |
| `registerNodeHandlers(nodeId, handlers)` | function | 接続イベントハンドラー登録 |
| `unregisterNodeHandlers(nodeId)` | function | 接続イベントハンドラー解除 |
| `window.escHtml(s)` | function | HTML エスケープ |
| `window.formatBytes(n)` | function | バイト数フォーマット |

## 接続制御のルール

| 関数 | 用途 |
|---|---|
| `removeSingleConnection(fromId, toId)` | 特定の1本を切断（ハンドラーも呼ばれる） |
| `removeConnectionsForNode(nodeId)` | そのノードに関わる全接続を切断 |

入力を1本に制限したいノードは `onConnected` で既存接続を明示的に切る：

```javascript
registerNodeHandlers(nodeId, {
  onConnected(from, to) {
    if (to !== nodeId) return;
    // 今接続されたもの(from)以外を切断
    const existing = [...window.connections.values()]
      .filter(c => c.toNodeId === nodeId && c.fromNodeId !== from);
    for (const conn of existing) {
      window.removeSingleConnection(conn.fromNodeId, nodeId);
    }
  },
  onDisconnected(_from, to) { ... },
});
```

`onConnected` は `createConnection` 完了後に呼ばれるため、新しい接続はすでに `window.connections` に存在する。

## Recording ノードのルール

- `mocap.js` 内に直書き（`protocols/` に移動しない）
- LiveLink テイク録画（`.vlnk`）の根幹機能であるため
- `takeState` オブジェクトで状態管理、`socket.emit('take-start/stop')` でサーバーと同期

## ピン型と色

| 型 | 色 | 用途 |
|---|---|---|
| `livelink-face` | 青 `#3b82f6` | LiveLink Face データ |
| `video` | オレンジ `#f97316` | 映像ストリーム |
| `trigger` | 緑 `#22c55e` | トリガー信号 |

## サーバー側プロトコル追加

`protocols/<name>/parser.js` を作成し `server/server.js` の `PROTOCOL_PARSERS` 配列に追加する。

```javascript
module.exports = { PROTOCOL_ID: 'name', parse(buf) { ... } };
```

戻り値: `{ format: 'name', parsed: { ... } }` または `null`（非対応パケット）。
