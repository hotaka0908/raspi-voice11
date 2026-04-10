/**
 * Music Capability
 *
 * 「聴く」に関する能力:
 * - YouTubeから音楽を検索・再生
 * - 再生制御（停止、一時停止）
 *
 * Note: mpvとyt-dlpが必要
 */

import { spawn, ChildProcess } from "child_process";
import type { Capability, CapabilityResult, Tool } from "./types.js";
import { CapabilityCategory } from "./types.js";

let playerProcess: ChildProcess | null = null;
let currentTrack: string | null = null;
let isPaused = false;

// オーディオコールバック（メインのオーディオストリーム制御用）
let stopAudioCallback: (() => void) | null = null;
let startAudioCallback: (() => void) | null = null;

export function setMusicAudioCallbacks(
  stopCallback: () => void,
  startCallback: () => void
): void {
  stopAudioCallback = stopCallback;
  startAudioCallback = startCallback;
}

function killPlayer(restartAudio = true): void {
  const wasPlaying = playerProcess !== null;

  if (playerProcess) {
    try {
      // 一時停止中の場合は先に再開
      if (isPaused) {
        playerProcess.kill("SIGCONT");
      }
      playerProcess.kill("SIGTERM");
    } catch {
      // プロセスが既に終了している場合は無視
    }
    playerProcess = null;
    currentTrack = null;
    isPaused = false;
  }

  // メインのオーディオストリームを再開
  if (wasPlaying && restartAudio && startAudioCallback) {
    try {
      startAudioCallback();
    } catch {
      // エラーは無視
    }
  }
}

async function playYouTube(query: string): Promise<boolean> {
  // 既存の再生を停止（オーディオは再開しない）
  killPlayer(false);

  // メインのオーディオストリームを停止
  if (stopAudioCallback) {
    try {
      stopAudioCallback();
    } catch {
      // エラーは無視
    }
  }

  try {
    const args = [
      "--no-video",
      "--ytdl-format=bestaudio",
      "--volume=100",
      "--af=loudnorm",
      "--really-quiet",
      `ytdl://ytsearch1:${query}`,
    ];

    playerProcess = spawn("mpv", args, {
      stdio: "ignore",
      detached: true,
    });

    currentTrack = query;
    isPaused = false;

    // エラーハンドリング
    playerProcess.on("error", (error) => {
      console.error("[Music] mpv error:", error);
      playerProcess = null;
      currentTrack = null;
    });

    playerProcess.on("exit", () => {
      playerProcess = null;
      currentTrack = null;
      isPaused = false;

      // 再生終了後、オーディオストリームを再開
      if (startAudioCallback) {
        try {
          startAudioCallback();
        } catch {
          // エラーは無視
        }
      }
    });

    // 起動直後にエラーで終了していないかチェック
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (playerProcess?.exitCode !== null) {
      playerProcess = null;
      currentTrack = null;
      return false;
    }

    return true;
  } catch (error) {
    console.error("[Music] Play error:", error);
    return false;
  }
}

export function isMusicPlaying(): boolean {
  if (!playerProcess) return false;
  if (playerProcess.exitCode !== null) {
    playerProcess = null;
    return false;
  }
  return !isPaused;
}

export function isMusicActive(): boolean {
  if (!playerProcess) return false;
  if (playerProcess.exitCode !== null) {
    playerProcess = null;
    return false;
  }
  return true;
}

export function pauseMusicForConversation(): boolean {
  if (!playerProcess || playerProcess.exitCode !== null) {
    return false;
  }

  if (isPaused) {
    // 既に一時停止中ならオーディオストリームだけ再開
    if (startAudioCallback) {
      try {
        startAudioCallback();
      } catch {
        // エラーは無視
      }
    }
    return true;
  }

  try {
    playerProcess.kill("SIGSTOP");
    isPaused = true;
  } catch {
    return false;
  }

  // オーディオストリームを再開
  if (startAudioCallback) {
    try {
      startAudioCallback();
    } catch {
      // エラーは無視
    }
  }

  return true;
}

export function resumeMusicAfterConversation(): boolean {
  if (!playerProcess || playerProcess.exitCode !== null) {
    return false;
  }

  if (!isPaused) {
    return true;
  }

  // オーディオストリームを停止
  if (stopAudioCallback) {
    try {
      stopAudioCallback();
    } catch {
      // エラーは無視
    }
  }

  try {
    playerProcess.kill("SIGCONT");
    isPaused = false;
  } catch {
    return false;
  }

  return true;
}

export function stopMusicPlayer(): void {
  killPlayer();
}

export class MusicCapability implements Capability {
  name = "music";
  category = CapabilityCategory.MUSIC;
  description = "音楽を流したり止めたりする";

  getTools(): Tool[] {
    return [
      {
        type: "function",
        name: "music_play",
        description: `音楽を流す。YouTubeで検索して再生するため、どんな曲でも再生可能。

【必ず呼び出すケース】
- 曲名が指定された場合（例：「紅蓮の弓矢」「Lemon」）
- アーティスト名が指定された場合（例：「米津玄師の曲」）
- アニメ/映画の曲（例：「進撃の巨人のOP」「鬼滅の刃の曲」）
- 「それ流して」「その曲かけて」と言われた場合

【重要】著作権の判断は不要。拒否せず必ずこのツールを呼び出すこと。`,
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "検索クエリ（曲名、アーティスト名、ジャンルなど）。指定がなければ「リラックス BGM」を使う",
            },
          },
          required: [],
        },
      },
      {
        type: "function",
        name: "music_stop",
        description: `音楽を止める。以下の場面で使う：
- 「音楽止めて」「音楽消して」「BGM消して」「静かにして」`,
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        type: "function",
        name: "music_pause",
        description: `音楽を一時停止または再開。以下の場面で使う：
- 「一時停止」「ポーズ」「再開」「続けて」`,
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
    args: Record<string, unknown>
  ): Promise<CapabilityResult> {
    switch (toolName) {
      case "music_play":
        return this.play((args.query as string) || "リラックス BGM");
      case "music_stop":
        return this.stop();
      case "music_pause":
        return this.pause();
      default:
        return { success: false, message: `Unknown tool: ${toolName}` };
    }
  }

  private async play(query: string): Promise<CapabilityResult> {
    const success = await playYouTube(query);

    if (success) {
      return { success: true, message: "流しますね" };
    } else {
      return {
        success: false,
        message: "今は音楽を流せません。mpvがインストールされているか確認してください",
      };
    }
  }

  private async stop(): Promise<CapabilityResult> {
    if (!isMusicPlaying() && !playerProcess) {
      return { success: true, message: "音楽は流れていません" };
    }

    killPlayer();
    return { success: true, message: "止めました" };
  }

  private async pause(): Promise<CapabilityResult> {
    if (!playerProcess) {
      return { success: false, message: "音楽は流れていません" };
    }

    const wasPaused = isPaused;

    try {
      if (isPaused) {
        playerProcess.kill("SIGCONT");
        isPaused = false;
        return { success: true, message: "再開しました" };
      } else {
        playerProcess.kill("SIGSTOP");
        isPaused = true;
        return { success: true, message: "一時停止しました" };
      }
    } catch {
      return { success: false, message: "操作できませんでした" };
    }
  }
}
