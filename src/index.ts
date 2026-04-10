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
  pauseLifelog,
  resumeLifelog,
} from "./capabilities/index.js";

// 音声メッセージモードの状態管理
interface VoiceMessageState {
  isActive: boolean;
  audioChunks: Buffer[];
  startTime: number | null;
  timeout: NodeJS.Timeout | null;
}

const voiceMessageState: VoiceMessageState = {
  isActive: false,
  audioChunks: [],
  startTime: null,
  timeout: null,
};

// 音声メッセージの最大録音時間（秒）
const VOICE_MESSAGE_MAX_DURATION = 60;

// 確認音を生成（簡易的なビープ音）
function generateBeepTone(frequency: number, durationMs: number, sampleRate = 24000): Buffer {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const buffer = Buffer.alloc(numSamples * 2); // 16-bit samples

  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    // フェードイン/アウトを適用
    const fadeLength = Math.floor(numSamples * 0.1);
    let amplitude = 0.3;
    if (i < fadeLength) {
      amplitude *= i / fadeLength;
    } else if (i > numSamples - fadeLength) {
      amplitude *= (numSamples - i) / fadeLength;
    }
    const sample = Math.floor(amplitude * 32767 * Math.sin(2 * Math.PI * frequency * t));
    buffer.writeInt16LE(sample, i * 2);
  }

  return buffer;
}

// 開始音（上昇トーン）
function generateStartTone(): Buffer {
  const tone1 = generateBeepTone(440, 100);
  const tone2 = generateBeepTone(660, 100);
  return Buffer.concat([tone1, tone2]);
}

// 完了音（下降トーン）
function generateCompleteTone(): Buffer {
  const tone1 = generateBeepTone(660, 100);
  const tone2 = generateBeepTone(880, 150);
  return Buffer.concat([tone1, tone2]);
}

// エラー音
function generateErrorTone(): Buffer {
  const tone1 = generateBeepTone(200, 200);
  const tone2 = generateBeepTone(150, 300);
  return Buffer.concat([tone1, tone2]);
}

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

  // エラーハンドラを先に設定（EventEmitterのエラーをキャッチ）
  audioBridge.on("error", (error: Error) => {
    // connect()のPromise.rejectで処理されるので、ここではログのみ
    console.error("[AudioBridge] Error event:", error.message);
  });

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

  // 音声メッセージモードを開始
  const startVoiceMessageMode = () => {
    if (voiceMessageState.isActive) return;

    console.log("[VoiceMessage] Mode started - Recording...");
    voiceMessageState.isActive = true;
    voiceMessageState.audioChunks = [];
    voiceMessageState.startTime = Date.now();

    // ライフログを一時停止
    pauseLifelog();

    // 開始音を再生
    const startTone = generateStartTone();
    audioBridge.sendAudioOutput(startTone);

    // 録音開始
    audioBridge.startRecording();

    // タイムアウト設定
    voiceMessageState.timeout = setTimeout(async () => {
      if (voiceMessageState.isActive) {
        console.log("[VoiceMessage] Timeout - Auto sending...");
        await finishVoiceMessage();
      }
    }, VOICE_MESSAGE_MAX_DURATION * 1000);
  };

  // 音声メッセージモードを終了して送信
  const finishVoiceMessage = async () => {
    if (!voiceMessageState.isActive) return;

    // タイムアウトをクリア
    if (voiceMessageState.timeout) {
      clearTimeout(voiceMessageState.timeout);
      voiceMessageState.timeout = null;
    }

    // 録音停止
    audioBridge.stopRecording();
    voiceMessageState.isActive = false;

    const chunks = voiceMessageState.audioChunks;
    voiceMessageState.audioChunks = [];

    // ライフログを再開
    resumeLifelog();

    if (chunks.length === 0) {
      console.log("[VoiceMessage] No audio recorded");
      const errorTone = generateErrorTone();
      audioBridge.sendAudioOutput(errorTone);
      return;
    }

    // 音声データを結合
    const audioData = Buffer.concat(chunks);
    const duration = voiceMessageState.startTime
      ? (Date.now() - voiceMessageState.startTime) / 1000
      : 0;

    console.log(
      `[VoiceMessage] Recorded ${audioData.length} bytes (${duration.toFixed(1)}s)`
    );

    // WAVヘッダーを追加（24kHz, 16-bit, mono）
    const wavData = createWavBuffer(audioData, 24000, 16, 1);

    // Firebaseにアップロード
    console.log("[VoiceMessage] Uploading to Firebase...");
    try {
      const success = await firebaseMessenger.sendMessage(wavData);
      if (success) {
        console.log("[VoiceMessage] Sent successfully!");
        const completeTone = generateCompleteTone();
        audioBridge.sendAudioOutput(completeTone);
      } else {
        console.error("[VoiceMessage] Upload failed");
        const errorTone = generateErrorTone();
        audioBridge.sendAudioOutput(errorTone);
      }
    } catch (error) {
      console.error("[VoiceMessage] Error:", error);
      const errorTone = generateErrorTone();
      audioBridge.sendAudioOutput(errorTone);
    }

    voiceMessageState.startTime = null;
  };

  // WAVファイルを作成
  function createWavBuffer(
    pcmData: Buffer,
    sampleRate: number,
    bitsPerSample: number,
    channels: number
  ): Buffer {
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const dataSize = pcmData.length;
    const headerSize = 44;

    const header = Buffer.alloc(headerSize);

    // RIFF header
    header.write("RIFF", 0);
    header.writeUInt32LE(dataSize + headerSize - 8, 4);
    header.write("WAVE", 8);

    // fmt chunk
    header.write("fmt ", 12);
    header.writeUInt32LE(16, 16); // chunk size
    header.writeUInt16LE(1, 20); // audio format (PCM)
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);

    // data chunk
    header.write("data", 36);
    header.writeUInt32LE(dataSize, 40);

    return Buffer.concat([header, pcmData]);
  }

  // Capabilityの初期化
  // Vision: カメラキャプチャのコールバックを設定
  setCaptureCallback(async () => {
    return await audioBridge.captureImage();
  });

  // Calendar: Google Calendar初期化
  try {
    const calendarOk = await initCalendar();
    if (calendarOk) {
      console.log("[Main] Google Calendar initialized");
    } else {
      console.warn("[Main] Google Calendar not available (token missing)");
    }
  } catch (error) {
    console.warn("[Main] Google Calendar initialization failed:", error);
  }

  // Gmail: Gmail初期化
  try {
    const gmailOk = await initGmail();
    if (gmailOk) {
      console.log("[Main] Gmail initialized");
    } else {
      console.warn("[Main] Gmail not available (token missing)");
    }
  } catch (error) {
    console.warn("[Main] Gmail initialization failed:", error);
  }

  // Music: 音声の停止/開始コールバックを設定
  setMusicAudioCallbacks(
    () => {
      console.log("[Music] Audio stop requested");
    },
    () => {
      console.log("[Music] Audio start requested");
    }
  );

  // Schedule: アラーム通知コールバックを設定
  setAlarmNotifyCallback(async (message: string) => {
    console.log(`[Alarm] ${message}`);
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
    if (voiceMessageState.isActive) {
      // 音声メッセージモード中は音声を蓄積
      voiceMessageState.audioChunks.push(Buffer.from(data));
    } else {
      // 通常モードはOpenAIに送信
      await realtimeClient.sendAudioChunk(data);
    }
  });

  audioBridge.on("buttonPress", async () => {
    // 音声メッセージモード中は無視（ダブルクリックの2回目のプレスは別イベント）
    if (voiceMessageState.isActive) {
      console.log("[Button] Press ignored (in voice message mode)");
      return;
    }

    console.log("[Button] Press detected");
    // 音楽再生中なら一時停止
    if (isMusicActive()) {
      pauseMusicForConversation();
    }
    await realtimeClient.sendActivityStart();
    audioBridge.startRecording();
  });

  audioBridge.on("buttonRelease", async () => {
    if (voiceMessageState.isActive) {
      // 音声メッセージモード中は送信処理
      console.log("[Button] Release detected - Finishing voice message");
      await finishVoiceMessage();
      return;
    }

    console.log("[Button] Release detected");
    audioBridge.stopRecording();
    await realtimeClient.sendActivityEnd();
  });

  audioBridge.on("buttonDoubleClick", async () => {
    console.log("[Button] Double click detected - Voice message mode");
    startVoiceMessageMode();
  });

  // Firebase: 新着メッセージのリスナーを開始（コールバック付き）
  firebaseMessenger.startListening(5000);

  // 接続を開始
  try {
    console.log("[Main] Connecting to Python audio daemon...");
    await audioBridge.connect();
    console.log("[Main] Audio daemon connected");

    console.log("[Main] Connecting to OpenAI Realtime API...");
    await realtimeClient.connect();
    console.log("[Main] OpenAI connected");

    console.log("\n[Main] Ready! Press the button to speak.");
    console.log("[Main] Double-click to send a voice message.\n");

    // プロセス終了時のクリーンアップ
    const cleanup = async () => {
      console.log("\n[Main] Shutting down...");

      // 音声メッセージモード中なら終了
      if (voiceMessageState.isActive) {
        if (voiceMessageState.timeout) {
          clearTimeout(voiceMessageState.timeout);
        }
        voiceMessageState.isActive = false;
      }

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
    if (error instanceof Error && error.message.includes("ENOENT")) {
      console.log("\n[Main] Python audio daemon is not running.");
      console.log("Please start the daemon first:");
      console.log("  cd audio-daemon && python daemon.py\n");
    }

    process.exit(1);
  }
}

main().catch(console.error);
