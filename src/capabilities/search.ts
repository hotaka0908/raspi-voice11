/**
 * 検索Capability
 *
 * Tavily APIを使用したWeb検索
 */

import type { Capability, CapabilityResult, Tool } from "./types.js";
import { CapabilityCategory } from "./types.js";
import { Config } from "../config.js";

interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

interface TavilyResponse {
  results: TavilySearchResult[];
  answer?: string;
}

export class SearchCapability implements Capability {
  name = "search";
  category = CapabilityCategory.SEARCH;
  description = "Web検索を行う";

  getTools(): Tool[] {
    return [
      {
        type: "function",
        name: "web_search",
        description:
          "インターネットで最新情報を検索する。天気、ニュース、為替、店舗情報など、リアルタイムの情報が必要な場合に使用。",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "検索クエリ（日本語可）",
            },
          },
          required: ["query"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CapabilityResult> {
    if (toolName !== "web_search") {
      return {
        success: false,
        message: `Unknown tool: ${toolName}`,
      };
    }

    const query = args.query as string;
    if (!query) {
      return {
        success: false,
        message: "検索クエリが指定されていません",
      };
    }

    try {
      const result = await this.search(query);
      return {
        success: true,
        message: result,
      };
    } catch (error) {
      console.error("[Search] Error:", error);
      return {
        success: false,
        message: "検索に失敗しました",
      };
    }
  }

  private async search(query: string): Promise<string> {
    const apiKey = Config.getTavilyApiKey();

    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        search_depth: "basic",
        include_answer: true,
        max_results: 5,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status}`);
    }

    const data = (await response.json()) as TavilyResponse;

    // 結果を整形
    let result = "";

    if (data.answer) {
      result += `【回答】\n${data.answer}\n\n`;
    }

    if (data.results && data.results.length > 0) {
      result += "【検索結果】\n";
      for (const item of data.results.slice(0, 3)) {
        result += `- ${item.title}\n  ${item.content.slice(0, 200)}...\n\n`;
      }
    }

    return result || "検索結果が見つかりませんでした";
  }
}
