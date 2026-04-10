/**
 * Firebase Voice Messaging Module
 *
 * ラズパイとスマホ間で音声メッセージをやり取りするためのモジュール
 * Firebase Realtime Database + Cloud Storage を使用
 */

import { homedir } from "os";
import { resolve } from "path";
import { config as dotenvConfig } from "dotenv";

// 環境変数の読み込み
const envPath = resolve(homedir(), ".ai-necklace", ".env");
dotenvConfig({ path: envPath });

interface FirebaseConfig {
  apiKey: string;
  databaseURL: string;
  storageBucket: string;
}

interface Message {
  id?: string;
  from: string;
  audio_url?: string;
  photo_url?: string;
  filename: string;
  timestamp: number;
  played: boolean;
  text?: string;
  type?: string;
}

interface LifelogEntry {
  deviceId: string;
  timestamp: number;
  time: string;
  photoUrl: string;
  analyzed: boolean;
  analysis: string;
  location?: {
    latitude: number;
    longitude: number;
    accuracy: number;
    source: string;
  };
}

const FIREBASE_CONFIG: FirebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY || "",
  databaseURL: process.env.FIREBASE_DATABASE_URL || "",
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET || "",
};

type MessageCallback = (message: Message) => void;

export class FirebaseVoiceMessenger {
  private deviceId: string;
  private onMessageReceived?: MessageCallback;
  private dbUrl: string;
  private storageBucket: string;
  private running = false;
  private pollInterval: NodeJS.Timeout | null = null;
  private processedIds: Set<string> = new Set();

  constructor(deviceId = "raspi", onMessageReceived?: MessageCallback) {
    this.deviceId = deviceId;
    this.onMessageReceived = onMessageReceived;
    this.dbUrl = FIREBASE_CONFIG.databaseURL;
    this.storageBucket = FIREBASE_CONFIG.storageBucket;
  }

  private async uploadToStorage(
    data: Buffer,
    path: string,
    contentType: string
  ): Promise<string | null> {
    const storageUrl = `https://firebasestorage.googleapis.com/v0/b/${this.storageBucket}/o`;
    const encodedPath = encodeURIComponent(path);
    const uploadUrl = `${storageUrl}/${encodedPath}`;

    try {
      const response = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": contentType },
        body: data,
      });

      if (response.ok) {
        return `${storageUrl}/${encodedPath}?alt=media`;
      }
      console.error("[Firebase] Upload failed:", response.status);
      return null;
    } catch (error) {
      console.error("[Firebase] Upload error:", error);
      return null;
    }
  }

  async uploadAudio(
    audioData: Buffer,
    filename?: string
  ): Promise<string | null> {
    const name = filename || `${this.deviceId}_${Date.now()}.wav`;
    return this.uploadToStorage(audioData, `audio/${name}`, "audio/wav");
  }

  async uploadPhoto(
    photoData: Buffer,
    filename?: string
  ): Promise<string | null> {
    const name = filename || `${this.deviceId}_${Date.now()}.jpg`;
    return this.uploadToStorage(photoData, `photos/${name}`, "image/jpeg");
  }

  async sendMessage(audioData: Buffer, text?: string): Promise<boolean> {
    const timestamp = Date.now();
    const filename = `${this.deviceId}_${timestamp}.wav`;
    const audioUrl = await this.uploadAudio(audioData, filename);

    if (!audioUrl) return false;

    const messageData: Partial<Message> = {
      from: this.deviceId,
      audio_url: audioUrl,
      filename,
      timestamp,
      played: false,
    };

    if (text) {
      messageData.text = text;
    }

    try {
      const response = await fetch(`${this.dbUrl}/messages.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messageData),
      });
      return response.ok;
    } catch (error) {
      console.error("[Firebase] Send message error:", error);
      return false;
    }
  }

  async sendPhotoMessage(photoData: Buffer, text?: string): Promise<boolean> {
    const timestamp = Date.now();
    const filename = `${this.deviceId}_${timestamp}.jpg`;
    const photoUrl = await this.uploadPhoto(photoData, filename);

    if (!photoUrl) return false;

    const messageData: Partial<Message> = {
      from: this.deviceId,
      photo_url: photoUrl,
      filename,
      timestamp,
      played: false,
      type: "photo",
    };

    if (text) {
      messageData.text = text;
    }

    try {
      const response = await fetch(`${this.dbUrl}/messages.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(messageData),
      });
      return response.ok;
    } catch (error) {
      console.error("[Firebase] Send photo error:", error);
      return false;
    }
  }

  async uploadLifelogPhoto(
    photoData: Buffer,
    date: string,
    timeStr: string,
    analysis = "",
    location?: LifelogEntry["location"]
  ): Promise<boolean> {
    const filename = `${timeStr}.jpg`;
    const path = `lifelogs/${date}/${filename}`;
    const photoUrl = await this.uploadToStorage(photoData, path, "image/jpeg");

    if (!photoUrl) return false;

    const timestamp = Date.now();
    const timeFormatted = `${timeStr.slice(0, 2)}:${timeStr.slice(2, 4)}`;

    const docData: LifelogEntry = {
      deviceId: this.deviceId,
      timestamp,
      time: timeFormatted,
      photoUrl,
      analyzed: Boolean(analysis),
      analysis,
    };

    if (location) {
      docData.location = location;
    }

    try {
      const response = await fetch(
        `${this.dbUrl}/lifelogs/${date}/${timeStr}.json`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(docData),
        }
      );
      return response.ok;
    } catch (error) {
      console.error("[Firebase] Upload lifelog error:", error);
      return false;
    }
  }

  async getMessages(limit = 10, unplayedOnly = false): Promise<Message[]> {
    try {
      const response = await fetch(`${this.dbUrl}/messages.json`);
      if (!response.ok) {
        console.error("[Firebase] Get messages error:", response.status);
        return [];
      }

      const data = await response.json();
      if (!data) return [];

      const messages: Message[] = [];
      for (const [key, value] of Object.entries(data)) {
        if (typeof value !== "object" || value === null) continue;
        const msg = value as Message;
        msg.id = key;

        if (msg.from !== this.deviceId) {
          if (!unplayedOnly || !msg.played) {
            messages.push(msg);
          }
        }
      }

      messages.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      return messages.slice(0, limit);
    } catch (error) {
      console.error("[Firebase] Get messages error:", error);
      return [];
    }
  }

  async downloadAudio(audioUrl: string): Promise<Buffer | null> {
    try {
      const response = await fetch(audioUrl);
      if (response.ok) {
        const arrayBuffer = await response.arrayBuffer();
        return Buffer.from(arrayBuffer);
      }
      return null;
    } catch (error) {
      console.error("[Firebase] Download audio error:", error);
      return null;
    }
  }

  async markAsPlayed(messageId: string): Promise<void> {
    try {
      await fetch(`${this.dbUrl}/messages/${messageId}/played.json`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "true",
      });
    } catch (error) {
      console.error("[Firebase] Mark as played error:", error);
    }
  }

  async sendDetailInfo(
    imageData: Buffer,
    briefAnalysis: string,
    detailAnalysis: string,
    originalPrompt: string
  ): Promise<boolean> {
    const timestamp = Date.now();
    const filename = `${this.deviceId}_${timestamp}.jpg`;
    const imageUrl = await this.uploadToStorage(
      imageData,
      `detail_photos/${filename}`,
      "image/jpeg"
    );

    if (!imageUrl) return false;

    const detailData = {
      deviceId: this.deviceId,
      timestamp,
      imageUrl,
      briefAnalysis,
      detailAnalysis,
      originalPrompt,
      read: false,
    };

    try {
      const response = await fetch(`${this.dbUrl}/detail_info.json`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(detailData),
      });
      return response.ok;
    } catch (error) {
      console.error("[Firebase] Send detail info error:", error);
      return false;
    }
  }

  startListening(pollIntervalMs = 3000): void {
    if (this.running) return;

    this.running = true;
    this.processedIds.clear();

    // 既存メッセージを記録
    this.getMessages(20).then((messages) => {
      for (const msg of messages) {
        if (msg.id) {
          this.processedIds.add(msg.id);
        }
      }
      console.log(
        `[Firebase] Listening started, ${this.processedIds.size} existing messages`
      );
    });

    this.pollInterval = setInterval(async () => {
      if (!this.running) return;

      try {
        const messages = await this.getMessages(15);

        for (const msg of messages.reverse()) {
          if (!msg.id || this.processedIds.has(msg.id)) continue;

          console.log(`[Firebase] New message: ${msg.id}`);

          if (this.onMessageReceived) {
            try {
              this.onMessageReceived(msg);
            } catch (error) {
              console.error("[Firebase] Callback error:", error);
            }
          }

          this.processedIds.add(msg.id);
        }

        // 古いIDをクリア
        if (this.processedIds.size > 100) {
          const currentIds = new Set(messages.map((m) => m.id).filter(Boolean));
          this.processedIds = new Set(
            [...this.processedIds].filter((id) => currentIds.has(id))
          );
        }
      } catch (error) {
        console.error("[Firebase] Polling error:", error);
      }
    }, pollIntervalMs);
  }

  stopListening(): void {
    this.running = false;
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
  }
}
