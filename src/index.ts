/**
 * raspi-voice11 エントリーポイント
 *
 * TypeScript + Python ハイブリッド構成
 * - TypeScript: OpenAI Realtime API、Capability処理
 * - Python: 音声I/O、GPIO制御
 */

import { OpenAIRealtimeClient, AudioBridge, FirebaseVoiceMessenger } from "./core/index.js";
import type { AudioHandler } from "./core/index.js";
import {
  setCaptureCallback,
  initCalendar,
  initGmail,
  setMusicAudioCallbacks,
  pauseMusicForConversation,
  resumeMusicAfterConversation,
  isMusicActive,
  stopMusicPlayer,
  setAlarmNotifyCallback,
  startAlarmThread,
  stopAlarmThread,
  setLifelogFirebaseMessenger,
  setLifelogCaptureCallback,
  startLifelogThread,
  stopLifelogThread,
} from "./capabilities/index.js";

class AudioHandlerImpl implements AudioHandler {
  private audioBridge: AudioBridge;

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

  // Firebase Voice Messengerを初期化
  const firebaseMessenger = new FirebaseVoiceMessenger("raspi");

  // OpenAI Realtime Clientを初期化
  const realtimeClient = new OpenAIRealtimeClient(audioHandler, () => {
    console.log("[Main] Response complete");
    // 音楽再生中だった場合は再開
    if (isMusicActive()) {
      resumeMusicAfterConversation();
    }
  });

  // Capabilityの初期化
  // Vision: カメラキャプチャのコールバックを設定
  setCaptureCallback(async () => {
    return await audioBridge.captureImage();
  });

  // Calendar: Google Calendar初期化
  try {
    await initCalendar();
    console.log("[Main] Google Calendar initialized");
  } catch (error) {
    console.warn("[Main] Google Calendar initialization failed:", error);
  }

  // Gmail: Gmail初期化
  try {
    await initGmail();
    console.log("[Main] Gmail initialized");
  } catch (error) {
    console.warn("[Main] Gmail initialization failed:", error);
  }

  // Music: 音声の停止/開始コールバックを設定
  setMusicAudioCallbacks(
    () => {
      // 音楽再生を停止する必要がある場合
      console.log("[Music] Audio stop requested");
    },
    () => {
      // 音楽再生を再開する場合
      console.log("[Music] Audio start requested");
    }
  );

  // Schedule: アラーム通知コールバックを設定
  setAlarmNotifyCallback(async (message: string) => {
    console.log(`[Alarm] ${message}`);
    // Realtime APIを通じてユーザーに通知
    // TODO: 音声合成で通知
  });
  startAlarmThread();

  // Lifelog: Firebase messengerとキャプチャコールバックを設定
  setLifelogFirebaseMessenger(firebaseMessenger);
  setLifelogCaptureCallback(async () => {
    return await audioBridge.captureImage();
  });
  startLifelogThread();

  // AudioBridgeのイベントハンドラを設定
  audioBridge.on("audioInput", async (data: Buffer) => {
    // 録音中の音声をOpenAIに送信
    await realtimeClient.sendAudioChunk(data);
  });

  audioBridge.on("buttonPress", async () => {
    console.log("[Button] Press detected");
    // 音楽再生中なら一時停止
    if (isMusicActive()) {
      pauseMusicForConversation();
    }
    await realtimeClient.sendActivityStart();
    audioBridge.startRecording();
  });

  audioBridge.on("buttonRelease", async () => {
    console.log("[Button] Release detected");
    audioBridge.stopRecording();
    await realtimeClient.sendActivityEnd();
  });

  audioBridge.on("buttonDoubleClick", async () => {
    console.log("[Button] Double click detected - Voice message mode");
    // TODO: 音声メッセージモードの実装
    // 1. 録音開始
    // 2. 録音終了後、Firebaseにアップロード
    // 3. 送信確認の音声を再生
  });

  // Firebase: 新着メッセージのリスナーを開始
  firebaseMessenger.startListening(5000);

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
    const cleanup = async () => {
      console.log("\n[Main] Shutting down...");
      stopAlarmThread();
      stopLifelogThread();
      stopMusicPlayer();
      firebaseMessenger.stopListening();
      await realtimeClient.disconnect();
      audioBridge.disconnect();
      process.exit(0);
    };

    process.on("SIGINT", cleanup);
    process.on("SIGTERM", cleanup);

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
