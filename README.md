# raspi-voice11

AIネックレス - Raspberry Pi音声アシスタント

TypeScript + Python ハイブリッドアーキテクチャで構築された、ウェアラブル音声AIアシスタント。

## アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│                    TypeScript (メイン)                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │  OpenAI     │  │ Capability  │  │     Firebase        │  │
│  │  Realtime   │  │  Executor   │  │  Voice Messenger    │  │
│  │  Client     │  │             │  │                     │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                     │             │
│         └────────────────┼─────────────────────┘             │
│                          │                                   │
│  ┌───────────────────────┴───────────────────────────────┐  │
│  │                    Audio Bridge                        │  │
│  │                  (Unix Socket IPC)                     │  │
│  └───────────────────────┬───────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │ Unix Socket
┌──────────────────────────┼──────────────────────────────────┐
│                    Python Daemon                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │   PyAudio   │  │   gpiozero  │  │    rpicam-still     │  │
│  │  (音声I/O)  │  │   (GPIO)    │  │     (カメラ)        │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 機能

### Capabilities（能力）

| 能力 | 説明 | ツール |
|------|------|--------|
| **Vision** | 目の前を見て理解 | `camera_capture` |
| **Search** | Web検索（Tavily API） | `web_search` |
| **Calendar** | Google Calendar連携 | `calendar_list`, `calendar_add`, `calendar_delete` |
| **Communication** | Gmail連携 | `gmail_list`, `gmail_read`, `gmail_send`, `gmail_reply`, `voice_send` |
| **Music** | YouTube音楽再生 | `music_play`, `music_stop`, `music_pause` |
| **Schedule** | アラーム管理 | `alarm_set`, `alarm_list`, `alarm_delete` |
| **Lifelog** | 自動ライフログ撮影 | `lifelog_start`, `lifelog_stop`, `lifelog_status` |

## セットアップ

### 必要なもの

- Raspberry Pi 4/5（推奨）
- USBマイク
- USBスピーカー
- カメラモジュール
- 押しボタン（GPIO 5）

### 環境変数

`~/.ai-necklace/.env` に以下を設定：

```env
# OpenAI
OPENAI_API_KEY=sk-...

# Tavily (Web検索)
TAVILY_API_KEY=tvly-...

# Firebase
FIREBASE_API_KEY=...
FIREBASE_DATABASE_URL=https://xxx.firebaseio.com
FIREBASE_STORAGE_BUCKET=xxx.appspot.com

# オプション
AUDIO_DAEMON_SOCKET=/tmp/raspi-voice-audio.sock
```

### Google API認証

Gmail/Calendarを使用する場合：

1. [Google Cloud Console](https://console.cloud.google.com/)でプロジェクト作成
2. Gmail API と Calendar API を有効化
3. OAuth 2.0クライアントIDを作成
4. `credentials.json` を `~/.ai-necklace/` に配置
5. 認証フローを実行してトークンを取得

### インストール

```bash
# Node.js依存関係
npm install

# Python依存関係（Raspberry Pi）
cd audio-daemon
pip install -r requirements.txt

# gpiozero（Raspberry Piのみ）
pip install gpiozero
```

### ビルド

```bash
npm run build
```

## 実行

### 1. Python Daemonを起動

```bash
cd audio-daemon
python daemon.py
```

### 2. TypeScriptメインを起動

```bash
npm start
```

## 開発

### プロジェクト構成

```
raspi-voice11/
├── src/
│   ├── index.ts              # エントリーポイント
│   ├── config.ts             # 設定
│   ├── core/
│   │   ├── realtime-client.ts    # OpenAI Realtime API
│   │   ├── audio-bridge.ts       # Python daemon通信
│   │   └── firebase-voice.ts     # Firebase連携
│   ├── capabilities/
│   │   ├── executor.ts           # Capability実行エンジン
│   │   ├── types.ts              # 型定義
│   │   ├── search.ts             # Web検索
│   │   ├── vision.ts             # カメラ・画像認識
│   │   ├── calendar.ts           # Google Calendar
│   │   ├── communication.ts      # Gmail
│   │   ├── music.ts              # 音楽再生
│   │   ├── schedule.ts           # アラーム
│   │   └── lifelog.ts            # ライフログ
│   └── prompts/
│       └── system.ts             # システムプロンプト
├── audio-daemon/
│   ├── daemon.py             # Python音声デーモン
│   └── requirements.txt      # Python依存関係
├── package.json
├── tsconfig.json
└── eslint.config.js
```

### コマンド

```bash
# ビルド
npm run build

# 開発モード（ホットリロード）
npm run dev

# Lint
npm run lint
```

## 使い方

### ボタン操作

- **シングルクリック**: 押している間、音声入力
- **ダブルクリック**: 音声メッセージモード（未実装）

### 音声コマンド例

```
# 視覚
「これ何？」「この答えは？」「読んで」

# メール
「メールある？」「1番目を読んで」「了解と返信して」

# カレンダー
「今日の予定は？」「明日10時に会議を入れて」

# 音楽
「音楽流して」「紅蓮の弓矢かけて」「止めて」

# アラーム
「7時に起こして」「30分後に教えて」

# ライフログ
「記録開始」「今日何枚撮った？」

# Web検索
「今日の天気は？」「東京の美味しいラーメン屋」
```

## 依存関係

### TypeScript

- `openai` - OpenAI Realtime API
- `ws` - WebSocket
- `googleapis` - Gmail / Calendar
- `dotenv` - 環境変数

### Python

- `pyaudio` - 音声I/O
- `numpy` - 音声処理
- `gpiozero` - GPIO（Raspberry Piのみ）
- `python-dotenv` - 環境変数

### 外部ツール

- `mpv` - 音楽再生
- `yt-dlp` - YouTube音声取得
- `rpicam-still` - カメラ撮影（Raspberry Pi）

## ライセンス

MIT
