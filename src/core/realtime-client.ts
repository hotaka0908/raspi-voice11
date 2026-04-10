/**
 * OpenAI Realtime APIクライアント
 *
 * リアルタイム音声対話を管理
 */

import WebSocket from "ws";
import { Config } from "../config.js";
import { getSystemPrompt } from "../prompts/index.js";
import { CapabilityExecutor } from "../capabilities/executor.js";
import type { Tool } from "../capabilities/types.js";

interface SessionConfig {
  modalities: string[];
  instructions: string;
  voice: string;
  input_audio_format: string;
  output_audio_format: string;
  input_audio_transcription: {
    model: string;
  };
  turn_detection: null;
  tools: Tool[];
}

interface RealtimeEvent {
  type: string;
  [key: string]: unknown;
}

export interface AudioHandler {
  playAudioChunk(data: Buffer): void;
}

type ResponseCompleteCallback = () => void;

export class OpenAIRealtimeClient {
  private apiKey: string;
  private audioHandler: AudioHandler;
  private onResponseComplete?: ResponseCompleteCallback;
  private executor: CapabilityExecutor;

  private ws: WebSocket | null = null;
  private _isConnected = false;
  private _isResponding = false;

  private needsReconnect = false;
  private reconnectCount = 0;
  private lastResponseTime: number | null = null;
  private lastAudioTime: number | null = null;

  // 音声メッセージモード
  private _voiceMessageMode = false;
  private voiceMessageTimestamp: number | null = null;

  constructor(
    audioHandler: AudioHandler,
    onResponseComplete?: ResponseCompleteCallback
  ) {
    this.apiKey = Config.getApiKey();
    this.audioHandler = audioHandler;
    this.onResponseComplete = onResponseComplete;
    this.executor = CapabilityExecutor.getInstance();
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  get isResponding(): boolean {
    return this._isResponding;
  }

  get voiceMessageMode(): boolean {
    return this._voiceMessageMode;
  }

  private getSessionConfig(): SessionConfig {
    return {
      modalities: ["text", "audio"],
      instructions: getSystemPrompt(),
      voice: Config.VOICE,
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: {
        model: "whisper-1",
      },
      turn_detection: null, // 手動制御
      tools: this.executor.getOpenAITools(),
    };
  }

  async connect(): Promise<void> {
    try {
      const url = `wss://api.openai.com/v1/realtime?model=${Config.MODEL}`;

      this.ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "OpenAI-Beta": "realtime=v1",
        },
      });

      await new Promise<void>((resolve, reject) => {
        if (!this.ws) return reject(new Error("WebSocket not initialized"));

        this.ws.on("open", () => {
          this._isConnected = true;
          resolve();
        });

        this.ws.on("error", (error) => {
          reject(error);
        });
      });

      // セッション設定を送信
      await this.sendEvent("session.update", {
        session: this.getSessionConfig(),
      });

      // メッセージ受信を開始
      this.setupMessageHandler();

      console.log("[OpenAI] Realtime API接続完了");
    } catch (error) {
      console.error("[OpenAI] 接続エラー:", error);
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this._isConnected = false;
    }
  }

  private async sendEvent(
    eventType: string,
    data?: Record<string, unknown>
  ): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const event: RealtimeEvent = { type: eventType, ...data };

    try {
      this.ws.send(JSON.stringify(event));
    } catch (error) {
      console.error("[OpenAI] イベント送信エラー:", error);
    }
  }

  async sendActivityStart(): Promise<void> {
    await this.clearInputBuffer();
  }

  async clearInputBuffer(): Promise<void> {
    if (!this._isConnected || !this.ws) return;
    await this.sendEvent("input_audio_buffer.clear");
  }

  async sendActivityEnd(): Promise<void> {
    if (!this._isConnected || !this.ws) return;

    try {
      // 音声バッファをコミット
      await this.sendEvent("input_audio_buffer.commit");
      // レスポンス生成を要求
      await this.sendEvent("response.create");
    } catch (error) {
      console.error("[OpenAI] activity_end送信エラー:", error);
    }
  }

  async sendAudioChunk(audioData: Buffer): Promise<void> {
    if (!this._isConnected || !this.ws) return;

    try {
      const audioBase64 = audioData.toString("base64");
      await this.sendEvent("input_audio_buffer.append", {
        audio: audioBase64,
      });
    } catch (error) {
      console.error("[OpenAI] 音声送信エラー:", error);
    }
  }

  async sendTextMessage(text: string): Promise<void> {
    if (!this._isConnected || !this.ws) return;

    try {
      await this.sendEvent("conversation.item.create", {
        item: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text,
            },
          ],
        },
      });
      await this.sendEvent("response.create");
    } catch (error) {
      console.error("[OpenAI] テキスト送信エラー:", error);
    }
  }

  private async sendToolResponse(callId: string, result: string): Promise<void> {
    if (!this._isConnected || !this.ws) return;

    try {
      await this.sendEvent("conversation.item.create", {
        item: {
          type: "function_call_output",
          call_id: callId,
          output: result,
        },
      });
      await this.sendEvent("response.create");
    } catch (error) {
      console.error("[OpenAI] ツール結果送信エラー:", error);
    }
  }

  private setupMessageHandler(): void {
    if (!this.ws) return;

    this.ws.on("message", async (data) => {
      try {
        const event = JSON.parse(data.toString()) as RealtimeEvent;
        await this.handleEvent(event);
        this.reconnectCount = 0;
      } catch (error) {
        console.error("[OpenAI] メッセージ処理エラー:", error);
      }
    });

    this.ws.on("close", () => {
      console.warn("[OpenAI] WebSocket接続が閉じられました");
      this._isConnected = false;
      this.needsReconnect = true;
    });

    this.ws.on("error", (error) => {
      console.error("[OpenAI] WebSocketエラー:", error);
      this._isConnected = false;
      this.needsReconnect = true;
    });
  }

  private async handleEvent(event: RealtimeEvent): Promise<void> {
    const eventType = event.type;

    switch (eventType) {
      case "session.created":
        console.log("[OpenAI] セッション作成完了");
        break;

      case "session.updated":
        console.log("[OpenAI] セッション設定更新完了");
        break;

      case "error": {
        const error = event.error as { message?: string };
        console.error("[OpenAI] APIエラー:", error?.message || "Unknown error");
        break;
      }

      case "response.created":
        this._isResponding = true;
        break;

      case "response.audio.delta": {
        const delta = event.delta as string;
        if (delta) {
          const audioData = Buffer.from(delta, "base64");
          this.audioHandler.playAudioChunk(audioData);
          this.lastAudioTime = Date.now();
        }
        break;
      }

      case "response.audio_transcript.delta": {
        const text = event.delta as string;
        if (text) {
          process.stdout.write(text);
        }
        break;
      }

      case "response.audio_transcript.done": {
        const transcript = event.transcript as string;
        if (transcript) {
          console.log(`\n[AI] ${transcript}`);
        }
        break;
      }

      case "conversation.item.input_audio_transcription.completed": {
        const transcript = event.transcript as string;
        if (transcript) {
          console.log(`[USER] ${transcript}`);
        }
        break;
      }

      case "response.function_call_arguments.done": {
        const callId = event.call_id as string;
        const name = event.name as string;
        const argumentsStr = (event.arguments as string) || "{}";

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(argumentsStr);
        } catch {
          args = {};
        }

        console.log(`[CAPABILITY] ${name}`, args);

        // ツール実行
        const result = await this.executor.execute(name, args);

        // voice_sendの場合は録音モードを有効化
        if (result.data?.startVoiceRecording) {
          this._voiceMessageMode = true;
          this.voiceMessageTimestamp = Date.now();
        }

        // ツール結果を送信
        await this.sendToolResponse(callId, result.message);
        break;
      }

      case "response.done":
        this._isResponding = false;
        this.lastResponseTime = Date.now();
        this.onResponseComplete?.();
        break;

      // その他のイベントは無視
      case "input_audio_buffer.speech_started":
      case "input_audio_buffer.speech_stopped":
      case "input_audio_buffer.committed":
      case "rate_limits.updated":
        break;
    }
  }

  async resetSession(): Promise<boolean> {
    await this.disconnect();

    if (!this._voiceMessageMode) {
      this._voiceMessageMode = false;
      this.voiceMessageTimestamp = null;
    }

    try {
      await this.connect();
      return true;
    } catch {
      this.needsReconnect = true;
      return false;
    }
  }

  async reconnect(): Promise<boolean> {
    this.reconnectCount++;
    if (this.reconnectCount > Config.MAX_RECONNECT_ATTEMPTS) {
      return false;
    }

    const delay = Math.min(
      Config.RECONNECT_DELAY_BASE ** this.reconnectCount,
      60
    );
    await new Promise((resolve) => setTimeout(resolve, delay * 1000));

    await this.disconnect();
    this.needsReconnect = false;

    if (!this._voiceMessageMode) {
      this._voiceMessageMode = false;
      this.voiceMessageTimestamp = null;
    }

    try {
      await this.connect();
      return true;
    } catch {
      this.needsReconnect = true;
      return false;
    }
  }

  checkVoiceMessageTimeout(): boolean {
    if (this._voiceMessageMode && this.voiceMessageTimestamp) {
      const elapsed = Date.now() - this.voiceMessageTimestamp;
      if (elapsed > Config.VOICE_MESSAGE_TIMEOUT * 1000) {
        this._voiceMessageMode = false;
        this.voiceMessageTimestamp = null;
        return false;
      }
    }
    return this._voiceMessageMode;
  }

  resetVoiceMessageMode(): void {
    this._voiceMessageMode = false;
    this.voiceMessageTimestamp = null;
  }
}
