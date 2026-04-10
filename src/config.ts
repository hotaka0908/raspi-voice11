/**
 * raspi-voice11 設定
 *
 * TypeScript + Python ハイブリッド構成
 */

import { config as dotenvConfig } from "dotenv";
import { resolve } from "path";
import { homedir } from "os";

// 環境変数の読み込み
const envPath = resolve(homedir(), ".ai-necklace", ".env");
dotenvConfig({ path: envPath });

export const Config = {
  // OpenAI Realtime API設定
  MODEL: "gpt-4o-realtime-preview",
  VOICE: "alloy" as const, // alloy, echo, fable, onyx, nova, shimmer

  // オーディオ設定 (OpenAI Realtime API仕様)
  SEND_SAMPLE_RATE: 24000, // OpenAI入力: 24kHz
  RECEIVE_SAMPLE_RATE: 24000, // OpenAI出力: 24kHz
  INPUT_SAMPLE_RATE: 48000, // マイク入力: 48kHz
  OUTPUT_SAMPLE_RATE: 48000, // スピーカー出力: 48kHz
  CHANNELS: 1, // モノラル
  CHUNK_SIZE: 512,

  // パス設定
  BASE_DIR: resolve(homedir(), ".ai-necklace"),
  GMAIL_CREDENTIALS_PATH: resolve(homedir(), ".ai-necklace", "credentials.json"),
  GMAIL_TOKEN_PATH: resolve(homedir(), ".ai-necklace", "token.json"),
  ALARM_FILE_PATH: resolve(homedir(), ".ai-necklace", "alarms.json"),
  LOG_DIR: resolve(homedir(), ".ai-necklace", "logs"),
  LIFELOG_DIR: resolve(homedir(), "lifelog"),

  // ライフログ設定
  LIFELOG_INTERVAL: 60, // 1分（秒）

  // セッション設定
  SESSION_RESET_TIMEOUT: 10, // 秒
  VOICE_MESSAGE_TIMEOUT: 60, // 秒

  // 再接続設定
  MAX_RECONNECT_ATTEMPTS: 5,
  RECONNECT_DELAY_BASE: 2, // 秒

  // Python Audio Daemon設定
  AUDIO_DAEMON_SOCKET:
    process.env.AUDIO_DAEMON_SOCKET || "/tmp/raspi-voice-audio.sock",

  // APIキー取得
  getApiKey(): string {
    const key = process.env.OPENAI_API_KEY;
    if (!key) {
      throw new Error("OPENAI_API_KEY が設定されていません");
    }
    return key;
  },

  getTavilyApiKey(): string {
    const key = process.env.TAVILY_API_KEY;
    if (!key) {
      throw new Error("TAVILY_API_KEY が設定されていません");
    }
    return key;
  },
} as const;

export type Voice = "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
