/**
 * Python Audio Daemonとの通信ブリッジ
 *
 * Unix Socketを介してPython側の音声I/Oと通信
 */

import { createConnection, Socket } from "net";
import { EventEmitter } from "events";
import { Config } from "../config.js";

export interface AudioBridgeEvents {
  audioInput: (data: Buffer) => void;
  buttonPress: () => void;
  buttonRelease: () => void;
  buttonDoubleClick: () => void;
  connected: () => void;
  disconnected: () => void;
  error: (error: Error) => void;
}

type MessageType =
  | "audio_input"
  | "audio_output"
  | "button_press"
  | "button_release"
  | "button_double_click"
  | "start_recording"
  | "stop_recording"
  | "ping"
  | "pong";

interface Message {
  type: MessageType;
  data?: string; // base64 encoded audio data
}

export class AudioBridge extends EventEmitter {
  private socket: Socket | null = null;
  private _isConnected = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private buffer = "";

  constructor() {
    super();
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const socketPath = Config.AUDIO_DAEMON_SOCKET;

      this.socket = createConnection(socketPath, () => {
        this._isConnected = true;
        console.log("[AudioBridge] Connected to Python daemon");
        this.emit("connected");
        resolve();
      });

      this.socket.on("data", (data) => {
        this.handleData(data);
      });

      this.socket.on("close", () => {
        this._isConnected = false;
        console.log("[AudioBridge] Disconnected from Python daemon");
        this.emit("disconnected");
        this.scheduleReconnect();
      });

      this.socket.on("error", (error) => {
        console.error("[AudioBridge] Socket error:", error);
        this.emit("error", error);
        if (!this._isConnected) {
          reject(error);
        }
      });
    });
  }

  private handleData(data: Buffer): void {
    // 改行区切りのJSONメッセージを処理
    this.buffer += data.toString();
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;

      try {
        const message = JSON.parse(line) as Message;
        this.handleMessage(message);
      } catch (error) {
        console.error("[AudioBridge] Failed to parse message:", line);
      }
    }
  }

  private handleMessage(message: Message): void {
    switch (message.type) {
      case "audio_input":
        if (message.data) {
          const audioData = Buffer.from(message.data, "base64");
          this.emit("audioInput", audioData);
        }
        break;

      case "button_press":
        this.emit("buttonPress");
        break;

      case "button_release":
        this.emit("buttonRelease");
        break;

      case "button_double_click":
        this.emit("buttonDoubleClick");
        break;

      case "pong":
        // Heartbeat response
        break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (error) {
        console.error("[AudioBridge] Reconnect failed:", error);
        this.scheduleReconnect();
      }
    }, 2000);
  }

  sendAudioOutput(audioData: Buffer): void {
    this.sendMessage({
      type: "audio_output",
      data: audioData.toString("base64"),
    });
  }

  startRecording(): void {
    this.sendMessage({ type: "start_recording" });
  }

  stopRecording(): void {
    this.sendMessage({ type: "stop_recording" });
  }

  private sendMessage(message: Message): void {
    if (!this.socket || !this._isConnected) {
      console.warn("[AudioBridge] Not connected, cannot send message");
      return;
    }

    try {
      this.socket.write(JSON.stringify(message) + "\n");
    } catch (error) {
      console.error("[AudioBridge] Failed to send message:", error);
    }
  }

  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }

    this._isConnected = false;
  }
}
