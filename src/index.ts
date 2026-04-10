/**
 * raspi-voice11 エントリーポイント
 *
 * TypeScript + Python ハイブリッド構成
 * - TypeScript: OpenAI Realtime API、Capability処理
 * - Python: 音声I/O、GPIO制御
 */

import { OpenAIRealtimeClient, AudioBridge } from "./core/index.js";
import type { AudioHandler } from "./core/index.js";

class AudioHandlerImpl implements AudioHandler {
  private audioBridge: AudioBridge;
  private audioQueue: Buffer[] = [];
  private isPlaying = false;

  constructor(audioBridge: AudioBridge) {
    this.audioBridge = audioBridge;
  }

  playAudioChunk(data: Buffer): void {
    // 音声データをPythonデーモンに送信
    this.audioBridge.sendAudioOutput(data);
  }
}

async function main(): Promise<void> {
  console.log("=".repeat(50));
  console.log("raspi-voice11 - AI Necklace (TypeScript + Python)");
  console.log("=".repeat(50));

  // AudioBridgeを初期化（Python daemonへの接続）
  const audioBridge = new AudioBridge();

  // AudioHandlerを作成
  const audioHandler = new AudioHandlerImpl(audioBridge);

  // OpenAI Realtime Clientを初期化
  const realtimeClient = new OpenAIRealtimeClient(audioHandler, () => {
    console.log("[Main] Response complete");
  });

  // AudioBridgeのイベントハンドラを設定
  audioBridge.on("audioInput", async (data: Buffer) => {
    // 録音中の音声をOpenAIに送信
    await realtimeClient.sendAudioChunk(data);
  });

  audioBridge.on("buttonPress", async () => {
    console.log("[Button] Press detected");
    await realtimeClient.sendActivityStart();
    audioBridge.startRecording();
  });

  audioBridge.on("buttonRelease", async () => {
    console.log("[Button] Release detected");
    audioBridge.stopRecording();
    await realtimeClient.sendActivityEnd();
  });

  audioBridge.on("buttonDoubleClick", () => {
    console.log("[Button] Double click detected - Voice message mode");
    // TODO: 音声メッセージモードの実装
  });

  // 接続を開始
  try {
    console.log("[Main] Connecting to Python audio daemon...");
    await audioBridge.connect();
    console.log("[Main] Audio daemon connected");

    console.log("[Main] Connecting to OpenAI Realtime API...");
    await realtimeClient.connect();
    console.log("[Main] OpenAI connected");

    console.log("\n[Main] Ready! Press the button to speak.\n");

    // プロセス終了時のクリーンアップ
    process.on("SIGINT", async () => {
      console.log("\n[Main] Shutting down...");
      await realtimeClient.disconnect();
      audioBridge.disconnect();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      console.log("\n[Main] Shutting down...");
      await realtimeClient.disconnect();
      audioBridge.disconnect();
      process.exit(0);
    });

    // メインループ（イベントドリブンなので待機するだけ）
    await new Promise(() => {
      // 永続的に実行
    });
  } catch (error) {
    console.error("[Main] Startup error:", error);

    // Python daemonが起動していない場合のフォールバック
    if (
      error instanceof Error &&
      error.message.includes("ENOENT")
    ) {
      console.log("\n[Main] Python audio daemon is not running.");
      console.log("Please start the daemon first:");
      console.log("  cd audio-daemon && python daemon.py\n");
    }

    process.exit(1);
  }
}

main().catch(console.error);
