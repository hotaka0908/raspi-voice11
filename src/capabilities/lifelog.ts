/**
 * Lifelog Capability
 *
 * 「記録する」に関する能力:
 * - ライフログ（自動撮影）
 * - 継続的な記録と振り返り
 */

import { existsSync, mkdirSync, readdirSync } from "fs";
import { resolve } from "path";
import OpenAI from "openai";
import type { Capability, CapabilityResult, Tool } from "./types.js";
import { CapabilityCategory } from "./types.js";
import { Config } from "../config.js";
import type { FirebaseVoiceMessenger } from "../core/firebase-voice.js";

// ライフログ状態管理
let lifelogEnabled = false;
let lifelogPaused = false;
let lifelogPhotoCount = 0;
let lifelogInterval: NodeJS.Timeout | null = null;
let lastDate: string | null = null;

// 外部依存
let firebaseMessenger: FirebaseVoiceMessenger | null = null;
let captureCallback: (() => Promise<Buffer | null>) | null = null;
let openaiClient: OpenAI | null = null;

export function setLifelogFirebaseMessenger(
  messenger: FirebaseVoiceMessenger
): void {
  firebaseMessenger = messenger;
}

export function setLifelogCaptureCallback(
  callback: () => Promise<Buffer | null>
): void {
  captureCallback = callback;
}

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: Config.getApiKey() });
  }
  return openaiClient;
}

async function analyzeLifelogPhoto(photoData: Buffer): Promise<string> {
  try {
    const client = getOpenAIClient();
    const imageBase64 = photoData.toString("base64");

    const response = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: 'この写真を24文字以内で説明。例:「カフェでコーヒーを飲んでいる」「電車で移動中」',
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${imageBase64}`,
                detail: "low",
              },
            },
          ],
        },
      ],
      max_tokens: 50,
    });

    return response.choices[0]?.message?.content?.trim() || "";
  } catch (error) {
    console.error("[Lifelog] Analysis error:", error);
    return "";
  }
}

async function captureLifelogPhoto(): Promise<boolean> {
  if (!captureCallback) {
    console.log("[Lifelog] No capture callback set");
    return false;
  }

  try {
    // 今日の日付
    const today = new Date().toISOString().split("T")[0];
    const timeStr = new Date()
      .toTimeString()
      .slice(0, 8)
      .replace(/:/g, "");

    // ローカル保存用ディレクトリ
    const lifelogDir = resolve(Config.LIFELOG_DIR, today);
    mkdirSync(lifelogDir, { recursive: true });

    // 撮影
    const photoData = await captureCallback();
    if (!photoData) {
      console.log("[Lifelog] Capture failed");
      return false;
    }

    lifelogPhotoCount++;
    console.log(`[Lifelog] Captured photo #${lifelogPhotoCount}`);

    // Firebaseにアップロード（非同期）
    if (firebaseMessenger) {
      const analysis = await analyzeLifelogPhoto(photoData);
      await firebaseMessenger.uploadLifelogPhoto(
        photoData,
        today,
        timeStr,
        analysis
      );
    }

    return true;
  } catch (error) {
    console.error("[Lifelog] Capture error:", error);
    return false;
  }
}

function lifelogLoop(): void {
  if (!lifelogEnabled || lifelogPaused) return;

  // 日付変更でカウントリセット
  const currentDate = new Date().toISOString().split("T")[0];
  if (currentDate !== lastDate) {
    lifelogPhotoCount = 0;
    lastDate = currentDate;
  }

  // 撮影
  captureLifelogPhoto().catch(console.error);
}

export function startLifelogThread(): void {
  if (lifelogInterval) return;

  lifelogInterval = setInterval(lifelogLoop, Config.LIFELOG_INTERVAL * 1000);
  console.log("[Lifelog] Thread started");
}

export function stopLifelogThread(): void {
  if (lifelogInterval) {
    clearInterval(lifelogInterval);
    lifelogInterval = null;
  }
}

export function pauseLifelog(): void {
  lifelogPaused = true;
}

export function resumeLifelog(): void {
  lifelogPaused = false;
}

export function isLifelogPaused(): boolean {
  return lifelogPaused;
}

export class LifelogCapability implements Capability {
  name = "lifelog";
  category = CapabilityCategory.MEMORY;
  description = "ライフログの開始・停止・状態確認";

  getTools(): Tool[] {
    return [
      {
        type: "function",
        name: "lifelog_start",
        description: `自動で記録を始める。以下の場面で使う：
- 「ライフログ開始」「記録始めて」「自動撮影ON」`,
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        type: "function",
        name: "lifelog_stop",
        description: `自動記録を止める。以下の場面で使う：
- 「ライフログ停止」「記録終了」「自動撮影OFF」`,
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        type: "function",
        name: "lifelog_status",
        description: `記録の状況を確認。以下の場面で使う：
- 「今日何枚撮った？」「記録の状態は？」`,
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    _args: Record<string, unknown>
  ): Promise<CapabilityResult> {
    switch (toolName) {
      case "lifelog_start":
        return this.start();
      case "lifelog_stop":
        return this.stop();
      case "lifelog_status":
        return this.status();
      default:
        return { success: false, message: `Unknown tool: ${toolName}` };
    }
  }

  private start(): CapabilityResult {
    if (lifelogEnabled) {
      return { success: true, message: "もう記録中です" };
    }

    lifelogEnabled = true;
    startLifelogThread();

    const intervalMin = Math.floor(Config.LIFELOG_INTERVAL / 60);
    return {
      success: true,
      message: `記録を始めます。${intervalMin}分ごとに撮影します`,
    };
  }

  private stop(): CapabilityResult {
    if (!lifelogEnabled) {
      return { success: true, message: "記録していませんでした" };
    }

    lifelogEnabled = false;
    return { success: true, message: "記録を止めました" };
  }

  private status(): CapabilityResult {
    const status = lifelogEnabled ? "記録中" : "停止中";
    const today = new Date().toISOString().split("T")[0];
    const lifelogDir = resolve(Config.LIFELOG_DIR, today);

    // 実際のファイル数をカウント
    let actualCount = 0;
    if (existsSync(lifelogDir)) {
      actualCount = readdirSync(lifelogDir).filter((f) =>
        f.endsWith(".jpg")
      ).length;
    }

    return {
      success: true,
      message: `今日は${actualCount}枚撮影しました。${status}です`,
    };
  }
}
