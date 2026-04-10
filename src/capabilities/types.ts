/**
 * Capability関連の型定義
 */

export enum CapabilityCategory {
  VISION = "vision",
  COMMUNICATION = "communication",
  SCHEDULE = "schedule",
  MEMORY = "memory",
  CALL = "call",
  MUSIC = "music",
  SEARCH = "search",
  SYSTEM = "system",
}

export interface CapabilityResult {
  success: boolean;
  message: string;
  data?: Record<string, unknown>;
}

export interface ToolParameter {
  type: string;
  description: string;
  enum?: string[];
}

export interface Tool {
  type: "function";
  name: string;
  description: string;
  parameters: {
    type: "object";
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

export interface Capability {
  name: string;
  category: CapabilityCategory;
  description: string;
  getTools(): Tool[];
  execute(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CapabilityResult>;
}
