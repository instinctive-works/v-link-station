# V-Link Station - 開発ガイド

## プロジェクト概要

Electron + Express + Socket.IO 製のローカルデスクトップアプリ。
モーションキャプチャ受信・録画、および WebRTC 映像配信を行う。
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
    index.html         Electron 本体 UI（ノードグラフエディタ）
    browser.html       非 Electron ブラウザ向け（収録一覧 + ライブ視聴タブ統合）
    takes.html         収録一覧ページ
    live.html          WebRTC ライブ視聴ページ
    console.js           キャンバスインフラのみ。ノード固有ロジックは書かない
    console.css          全ノード共通スタイル
    package.json
  protocols/           プロトコルプラグイン一式 (@v-link/protocols)
    livelink-face/     parser.js (Node.js) / renderer.js (browser) / node.js (plugin)
    webcam/            node.js
    screen-capture/    node.js
    video-share/       node.js
    video-switch/      node.js
    visca-over-ip/     node.js
    override/          node.js
    countdown/         node.js
    merge/             node.js
    livelink-mb/       node.js
    vmc/               node.js
    mocopi/            node.js
    virtual-camera/    node.js  ← DirectShow 仮想カメラ出力（Electron 専用・1インスタンス制限）
    package.json
  virtual-camera-helper/  C++ ヘルパー（vcam-helper.exe / vcam-source.dll）
    src/
      vcam_helper.cpp  stdin から JPEG を受信し共有メモリへ書き込む
      vcam_source.cpp  DirectShow フィルター（DLL）。共有メモリからフレームを取り出して配信
      vcam_shared.h    共有メモリ定義（VCAM_MAP_NAME / VCAM_EVENT_NAME / VCamShmHeader）
    CMakeLists.txt
  shared/              サーバー・クライアント共通定数 (@v-link/shared)
debug/               デバッグ専用（コミット不要）
  temp/              一時出力ファイル置き場（ログ・ダンプ等）
    constants.js
    package.json
  wasm-video/          WASM フレーム処理 (Rust → wasm32-unknown-unknown)
    src/lib.rs
    loader.js
    Cargo.toml
    build.ps1
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

## デバッグ・一時ファイルのルール

- デバッグ用スクリプト・ヘルパーは `debug/` に置く
- 一時出力ファイル（ログ・ダンプ・キャプチャ等）は `debug/temp/` に出力する
- `apps/server/` や `packages/` 直下に一時ファイルを置かない
- `debug/` はコミット不要（`.gitignore` 対象）

## ノードプラグインのルール

新しいノードを追加するときは **`protocols/<name>/node.js` 1ファイルに以下をすべて実装する**。
`console.js` や `renderer/` 直下には書かない。

### 必須プロパティ

```javascript
window.NodePlugins['plugin-id'] = {
  label:       'ノード表示名',      // 右クリックメニューに表示
  icon:        '絵文字',            // ラベル前に表示
  menuSection: 'セクション名',      // 右クリックメニューのグループ
  nodeClass:   'node-card ...',     // ノードカードの CSS クラス
  pins: {
    out: [{ type: window.PIN_TYPES.VIDEO, label: '出力ラベル' }],    // 出力ピン: type が色と型を決める
    in:  [{ label: '入力ラベル', accepts: window.PIN_TYPES.VIDEO }], // 入力ピン: accepts で接続可能な型を制限
  },
  // accepts が未指定の入力ピンは全型を受け入れる
  // accepts に合わない型をドラッグしてもハイライトされず接続できない
  // accepts=PIN_TYPES.VIDEO の入力ピンは自動でオレンジ色になる
  create(pos)               { ... },  // 右クリックから呼ばれる
  mount(nodeId, nodeEl)     { ... },  // ノードカード本体を構築
  createPanel(nodeId, cont) { ... },  // 右ペイン詳細パネル。不要なら null
  getMetrics(nodeId)        { ... },  // パフォーマンスパネル用メトリクス
  getSettings(nodeId)       { ... },  // シーン保存用設定値を返す（省略可）
  applySettings(nodeId, s)  { ... },  // シーン復元時に設定値を適用（省略可）
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

### getSettings / applySettings のルール

ユーザーが設定する値（ポート番号・フィットモード・ブレンド率など）は `getSettings`/`applySettings` で保存・復元する。
接続状態（`srcId` 等）は `connections` から `onConnected` 経由で自動復元されるため保存不要。

```javascript
getSettings(nodeId) {
  const state = window._myState && window._myState[nodeId];
  return { port: state ? state.port : 11111 };
},
applySettings(nodeId, s) {
  const state = window._myState && window._myState[nodeId];
  if (!state) return;
  if (s.port != null) {
    state.port = s.port;
    const inp = document.getElementById(`my-port-${nodeId}`);
    if (inp) inp.value = s.port;
  }
},
```

### インスタンス数制限のルール

デバイス制約などで1つしか作れないノードは `create` の先頭でチェックする。
`window._myState` がすでにエントリを持っていれば `alert` して `null` を返す。

```javascript
create(pos) {
  if (window._myState && Object.keys(window._myState).length > 0) {
    alert('このノードは1つしか作成できません。');
    return null;
  }
  // ...
},
```

### ノード名の表記ルール

- `label`（右クリックメニューに表示される名前）は **日本語表記** にする
- `nextUniqueName` の第2引数（ノード作成時のデフォルト名）は **英語表記** のままにする

```javascript
label: '映像を共有',                                    // メニュー: 日本語
create(pos) {
  window.nextUniqueName('video-share', 'VideoShare'); // デフォルト名: 英語
}
```

### ノード連番名のルール

**必ず `window.nextUniqueName` を使うこと。** インクリメントのみのカウンターは削除後に番号がズレるため使用禁止。

```javascript
function nextName() {
  return window.nextUniqueName('plugin-id', 'NodeLabel');
}
```

- 同じ pluginId のノードが1つもなければ `NodeLabel`（番号なし）
- 既に `NodeLabel` が存在すれば `NodeLabel_2`、以降は最小の未使用番号
- 実装は `console.js` の `window.nextUniqueName(pluginId, baseName)` を参照
- デバイスノード（LiveLink 等）は `getNextDeviceName()` が同等の処理をしている

### FPS 計測（映像ノード共通）

`requestVideoFrameCallback` を使い `window.nodeMetrics.set(nodeId, { fps, resolution })` に書き込む。
フォールバックとして `setInterval` で解像度のみ計測する。

## グローバル API（console.js が公開）

| 変数 / 関数 | 型 | 説明 |
|---|---|---|
| `window.NodePlugins` | Object | プラグイン登録先 |
| `window.nodeStreams` | Map | nodeId → MediaStream |
| `window.nodeMetrics` | Map | nodeId → 任意のメトリクスオブジェクト |
| `window.devices` | Map | LiveLink deviceId → デバイス状態 |
| `window.connections` | Map | 接続情報 |
| `window.socket` | Socket | Socket.IO クライアント |
| `window.pluginNodeCounters` | Object | プラグイン別連番カウンター |
| `window.broadcastStreams` | Map | videoShareNodeId → cloned MediaStream |
| `createPluginNode(pluginId, nodeId, pos)` | function | ノード生成 |
| `removePluginNode(nodeId)` | function | ノード削除 |
| `generateNodeId()` | function | ユニーク ID 生成 |
| `registerNodeHandlers(nodeId, handlers)` | function | 接続イベントハンドラー登録 |
| `unregisterNodeHandlers(nodeId)` | function | 接続イベントハンドラー解除 |
| `window.fireTrigger(fromNodeId, fromPinIdx, payload?)` | function | トリガー信号を下流へ伝播。payload: `{ bool?, st? }` |
| `window.notifyFrame(fromNodeId, fromPinIdx, token)` | function | WASM_FRAME トークンを下流へ伝播 |
| `window._rtcSyncPeers()` | function | broadcastStreams 変化時に WebRTC ピアを再同期 |
| `captureScene()` / `applyScene(scene)` | function | シーンの JSON 化 / 復元 |
| `fitToView()` / `zoomIn()` / `zoomOut()` | function | ビュー変換操作 |
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
  onFrame(fromNodeId, fromPinIdx, token) { ... }, // WASM_FRAME 受信時。token は { ptr, width, height, size }
});
```

`onConnected` は `createConnection` 完了後に呼ばれるため、新しい接続はすでに `window.connections` に存在する。

### トリガー信号の発火

トリガー出力ピンから下流へ信号を送るには `window.fireTrigger` を使う。

```javascript
// fromPinIdx は pins.out 配列のインデックス
// payload は省略可能。省略時は {} として扱われる
window.fireTrigger(nodeId, fromPinIdx, { bool: true, st: 'TakeName' });
```

**payload フィールド**

| フィールド | 型 | 説明 |
|---|---|---|
| `bool` | `true` / `false` / 未指定 | `true`=start, `false`=stop, 未指定=toggle（後方互換） |
| `st` | string / 未指定 | テイク名の一時上書き（Recording ノードのプレフィックスを1回だけ差し替える） |

受け取り側のノードは `registerNodeHandlers` で `onTrigger` を登録する：

```javascript
window.registerNodeHandlers(nodeId, {
  onTrigger(fromNodeId, toNodeId, payload = {}) {
    if (toNodeId !== nodeId) return;
    // payload.bool === true  → start
    // payload.bool === false → stop
    // payload.bool 未定義   → toggle
  },
});
```

## パフォーマンスパネルの更新ルール

`console.js` の `setInterval`（500ms）がノードのステータスを `panel-content` に書き込む。
このタイマーは **`_rightActiveTab === 'nodes'` のときのみ** `panel-content` を操作する。
`設定` タブや `収録一覧` タブ表示中は何もしない。

新たに `panel-content` を操作するコードを追加する場合は同様に `_rightActiveTab` をチェックすること。

## Recording ノードのルール

- `console.js` 内に直書き（`protocols/` に移動しない）
- LiveLink テイク録画（`.vlnk`）の根幹機能であるため
- `takeState` オブジェクトで状態管理、`socket.emit('take-start/stop')` でサーバーと同期

## ピン型の管理ルール

すべての `pins:` 定義では **文字列リテラルを直書きせず `window.PIN_TYPES` の定数を使う**。

```javascript
pins: {
  out: [{ type: window.PIN_TYPES.VIDEO,   label: '映像出力' }],
  in:  [{ label: '映像入力', accepts: window.PIN_TYPES.VIDEO }],
},
```

### 定義箇所

| 対象 | 場所 |
|---|---|
| 基本型（`video` / `trigger` / `livelink-face`） | `shared/constants.js` の `PIN_TYPES` に集約 |
| プロトコル固有型 | 将来的に `protocols/<name>/` 内で定義し、`PIN_TYPES` には含めない |

`shared/constants.js` はブラウザ側では `window.PIN_TYPES` / `window.EVENTS` としてグローバル公開される（`index.html` で `<script src="/shared/constants.js">` より先に読み込まれている）。

### 新しいピン型を追加する手順

1. `shared/constants.js` の `PIN_TYPES` にエントリ追加
2. `renderer/console.css` に `.pin-type-<name>` のスタイルを追加
3. 各 `node.js` で `window.PIN_TYPES.<KEY>` を参照

## ピン型と色

| 定数 | 値 | 色 | 用途 |
|---|---|---|---|
| `PIN_TYPES.VIDEO` | `'video'` | オレンジ `#f97316` | MediaStream 映像 |
| `PIN_TYPES.TRIGGER` | `'trigger'` | 緑 `#22c55e` | トリガー信号 |
| `PIN_TYPES.LIVELINK_FACE` | `'livelink-face'` | 青 `#3b82f6` | LiveLink Face データ |
| `PIN_TYPES.REPLAY` | `'replay'` | 紫 `#a855f7` | リプレイデータ（映像＋モーション内包）|
| `PIN_TYPES.WASM_FRAME` | `'wasm-frame'` | シアン `#06b6d4` | WASM ヒープ上のピクセルフレーム ptr トークン |

## WASM フレームパイプライン

`packages/wasm-video/` (Rust → wasm32-unknown-unknown) が提供するフレームバッファ管理 API。
`loader.js` が `/wasm-video/video_proc.wasm` をロードし `window.VLinkWasm` に公開する。
失敗時は `window.VLinkWasm = null` になるため、各ノードは `if (window.VLinkWasm)` でガードすること。

### VLinkWasm API

| 関数 | シグネチャ | 説明 |
|---|---|---|
| `alloc_frame(size)` | `usize → ptr` | ゼロ初期化フレームバッファを WASM ヒープに確保（align=16） |
| `free_frame(ptr, size)` | `ptr, usize → void` | `alloc_frame` で確保したバッファを解放 |
| `copy_frame(src, dst, len)` | `ptr, ptr, usize → void` | WASM 内メモリコピー（Merge ノードがフレームをスナップショット保持するために使用） |
| `scale_frame(src, src_w, src_h, dst, dst_w, dst_h)` | `ptr, u32, u32, ptr, u32, u32 → void` | ニアレストネイバーで RGBA フレームをリサイズ。`dst` は `dst_w * dst_h * 4` バイト確保済みであること |
| `blend_frames(a, b, out, len, alpha_256)` | `ptr, ptr, ptr, usize, u32 → void` | アルファブレンド。`alpha_256=0`→A のみ、`256`→B のみ、`128`→50/50。出力 alpha は常に 255 |
| `add_frames(a, b, out, len)` | `ptr, ptr, ptr, usize → void` | 加算ブレンド（各チャンネル clamp 255、出力 alpha は常に 255） |
| `diff_frames(a, b, out, len)` | `ptr, ptr, ptr, usize → void` | 差分ブレンド（`\|A−B\|` per channel、出力 alpha は常に 255） |

JS 側からは `new Uint8ClampedArray(window.VLinkWasm.memory.buffer, ptr, size)` でアクセスする。

### WASM_FRAME トークン

`notifyFrame` を通じて流れるオブジェクト: `{ ptr, width, height, size }`

- `ptr`: WASM ヒープ上の RGBA バッファポインタ
- `size`: `width * height * 4` バイト
- 受け取ったノードは処理後に `free_frame(ptr, size)` で解放するか、次の `notifyFrame` に渡す

## Socket.IO イベント一覧

### Server → Client

| イベント名 | ペイロード | タイミング |
|---|---|---|
| `get-devices` (接続時応答) | `Device[]` | 接続時に現在のデバイス一覧を送信 |
| `device-update` | `Device` | デバイス新規追加 or データ更新時（2秒周期） |
| `device-remove` | `deviceId: string` | 5秒間未受信のデバイスを削除 |
| `mocap-data` | `{ format, data, port }` | UDP パケット受信・解析成功時 |
| `take-started` | `{ takeId, filePath }` | テイク録画開始後 |
| `take-stopped` | `{ takeId, filePath }` | テイク録画停止後 |
| `take-error` | — | 定義済み・現在未使用 |
| `rtc:viewer-joined` | `{ viewerId }` | ビューワー参加時に配信側へ broadcast |
| `rtc:viewer-left` | `{ viewerId }` | ビューワー切断時に配信側へ broadcast |
| `rtc:offer` | `{ broadcasterId, sdp }` | SDP Offer をビューワーへ中継 |
| `rtc:answer` | `{ viewerId, sdp }` | SDP Answer を配信側へ中継 |
| `rtc:ice` | `{ fromId, candidate }` | ICE 候補を相手側へ中継 |
| `visca:response` | `{ nodeId, data: number[] }` | VISCA カメラからの UDP 応答 |
| `visca:error` | `{ nodeId, error: string }` | VISCA 送信エラー |

### Client → Server

| イベント名 | ペイロード | 処理 |
|---|---|---|
| `get-devices` | — | デバイス一覧を再送 |
| `livelink:bind-port` | `{ port }` | 指定 UDP ポートを新規バインド |
| `take-start` | `{ takeId, recordDir, deviceIds }` | 録画開始 |
| `take-stop` | `{ takeId }` | 録画停止 |
| `take-video-chunk` | `{ takeId, chunk }` | 動画チャンク送信 |
| `rtc:viewer-join` | — | ビューワーとして参加表明 |
| `rtc:offer` | `{ viewerId, sdp }` | SDP Offer をビューワーへ中継依頼 |
| `rtc:answer` | `{ broadcasterId, sdp }` | SDP Answer を配信側へ中継依頼 |
| `rtc:ice` | `{ targetId, candidate }` | ICE 候補を相手へ中継依頼 |
| `visca:send` | `{ nodeId, host, port, command }` | VISCA コマンドを UDP で送信 |

## サーバー側プロトコル追加

`protocols/<name>/parser.js` を作成し `server/server.js` の `PROTOCOL_PARSERS` 配列に追加する。

```javascript
module.exports = { PROTOCOL_ID: 'name', parse(buf) { ... } };
```

戻り値: `{ format: 'name', parsed: { ... } }` または `null`（非対応パケット）。
