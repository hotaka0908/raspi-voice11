/**
 * Vision Capability
 *
 * 「見る」に関する能力:
 * - カメラで撮影して分析
 * - 画像からテキストを読み取る
 * - 目の前のものを理解する
 */

import OpenAI from "openai";
import type { Capability, CapabilityResult, Tool } from "./types.js";
import { CapabilityCategory } from "./types.js";
import { Config } from "../config.js";

// 直前の撮影コンテキスト
interface LastCaptureContext {
  imageBase64: string;
  briefAnalysis: string;
  prompt: string;
  timestamp: number;
}

let lastCapture: LastCaptureContext | null = null;
const CAPTURE_TIMEOUT_MS = 5 * 60 * 1000; // 5分

// OpenAIクライアント（Vision API用）
let openaiClient: OpenAI | null = null;

// カメラ撮影コールバック（Python daemonへの依頼）
let captureCallback: (() => Promise<Buffer | null>) | null = null;

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: Config.getApiKey() });
  }
  return openaiClient;
}

export function setCaptureCallback(
  callback: () => Promise<Buffer | null>
): void {
  captureCallback = callback;
}

export function getLastCapture(): LastCaptureContext | null {
  if (!lastCapture) return null;
  if (Date.now() - lastCapture.timestamp > CAPTURE_TIMEOUT_MS) {
    lastCapture = null;
    return null;
  }
  return lastCapture;
}

export function clearLastCapture(): void {
  lastCapture = null;
}

export class VisionCapability implements Capability {
  name = "vision";
  category = CapabilityCategory.VISION;
  description = "目の前を見て理解する";

  getTools(): Tool[] {
    return [
      {
        type: "function",
        name: "camera_capture",
        description: `目の前を見て理解する。以下の場面で使う：

■ 視覚が必要な質問すべて：
- 「この答えは？」→ 問題を見て答えを計算
- 「これ何？」「何が見える？」→ 目の前を見て説明
- 「読んで」→ 文字を見て読み上げ
- 「どう思う？」「どっちがいい？」→ 見て意見を述べる
- 「色は？」「サイズは？」「いくつある？」→ 見て確認
- 「翻訳して」→ 外国語を見て翻訳

■ 指示語がある場合：
- 「これ」「あれ」「それ」「この」→ 見る必要がある

promptで質問を渡すと、見たものについてその質問に答える`,
        parameters: {
          type: "object",
          properties: {
            prompt: {
              type: "string",
              description:
                "見たものに対する質問（例: 'この問題の答えを教えて', '何が見えますか'）",
            },
          },
          required: [],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CapabilityResult> {
    if (toolName !== "camera_capture") {
      return { success: false, message: `Unknown tool: ${toolName}` };
    }

    const prompt = (args.prompt as string) || "何が見えますか？";

    if (!captureCallback) {
      return { success: false, message: "今は見えません" };
    }

    try {
      // Python daemonから画像を取得
      const imageData = await captureCallback();
      if (!imageData) {
        return { success: false, message: "今は見えません" };
      }

      const imageBase64 = imageData.toString("base64");

      // OpenAI Vision APIで分析
      const client = getOpenAIClient();
      const response = await client.chat.completions.create({
        model: "gpt-4o",
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  prompt +
                  "\n\n日本語で回答してください。音声で読み上げるため、1-2文程度の簡潔な説明をお願いします。",
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${imageBase64}`,
                  detail: "auto",
                },
              },
            ],
          },
        ],
        max_tokens: 300,
      });

      const briefAnalysis = response.choices[0]?.message?.content || "";

      // 撮影コンテキストを保存
      lastCapture = {
        imageBase64,
        briefAnalysis,
        prompt,
        timestamp: Date.now(),
      };

      return { success: true, message: briefAnalysis };
    } catch (error) {
      console.error("[Vision] Error:", error);
      return { success: false, message: "今は見えません" };
    }
  }
}
