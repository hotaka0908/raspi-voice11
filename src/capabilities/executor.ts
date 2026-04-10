/**
 * Capability実行エンジン
 *
 * ツール呼び出しを適切なCapabilityにルーティング
 */

import type { Capability, CapabilityResult, Tool } from "./types.js";
import { SearchCapability } from "./search.js";

export class CapabilityExecutor {
  private static instance: CapabilityExecutor;
  private capabilities: Map<string, Capability> = new Map();
  private toolToCapability: Map<string, string> = new Map();

  private constructor() {
    this.registerCapabilities();
  }

  static getInstance(): CapabilityExecutor {
    if (!CapabilityExecutor.instance) {
      CapabilityExecutor.instance = new CapabilityExecutor();
    }
    return CapabilityExecutor.instance;
  }

  private registerCapabilities(): void {
    // 利用可能なCapabilityを登録
    const capabilities: Capability[] = [
      new SearchCapability(),
      // TODO: 他のCapabilityを追加
      // new VisionCapability(),
      // new CommunicationCapability(),
      // new CalendarCapability(),
      // new MusicCapability(),
    ];

    for (const capability of capabilities) {
      this.capabilities.set(capability.name, capability);

      // ツール名からCapability名へのマッピングを構築
      for (const tool of capability.getTools()) {
        this.toolToCapability.set(tool.name, capability.name);
      }
    }

    console.log(
      `[Executor] ${this.capabilities.size} capabilities registered`
    );
  }

  getOpenAITools(): Tool[] {
    const tools: Tool[] = [];
    for (const capability of this.capabilities.values()) {
      tools.push(...capability.getTools());
    }
    return tools;
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CapabilityResult> {
    const capabilityName = this.toolToCapability.get(toolName);

    if (!capabilityName) {
      return {
        success: false,
        message: `Unknown tool: ${toolName}`,
      };
    }

    const capability = this.capabilities.get(capabilityName);

    if (!capability) {
      return {
        success: false,
        message: `Capability not found: ${capabilityName}`,
      };
    }

    try {
      return await capability.execute(toolName, args);
    } catch (error) {
      console.error(`[Executor] Error executing ${toolName}:`, error);
      return {
        success: false,
        message:
          error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }
}
