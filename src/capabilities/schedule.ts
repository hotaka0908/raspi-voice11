/**
 * Schedule Capability
 *
 * 「覚える」に関する能力:
 * - アラーム設定・確認・削除
 * - 時間が来たら思い出して伝える
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Capability, CapabilityResult, Tool } from "./types.js";
import { CapabilityCategory } from "./types.js";
import { Config } from "../config.js";

interface Alarm {
  id: number;
  time: string;
  label: string;
  message: string;
  enabled: boolean;
  createdAt: string;
}

let alarms: Alarm[] = [];
let alarmNextId = 1;
let checkInterval: NodeJS.Timeout | null = null;
let alarmNotifyCallback: ((message: string) => void) | null = null;
const lastTriggered: Map<string, boolean> = new Map();

function loadAlarms(): void {
  try {
    if (existsSync(Config.ALARM_FILE_PATH)) {
      const data = JSON.parse(readFileSync(Config.ALARM_FILE_PATH, "utf-8"));
      alarms = data.alarms || [];
      alarmNextId = data.nextId || 1;
    }
  } catch {
    alarms = [];
    alarmNextId = 1;
  }
}

function saveAlarms(): void {
  try {
    mkdirSync(dirname(Config.ALARM_FILE_PATH), { recursive: true });
    writeFileSync(
      Config.ALARM_FILE_PATH,
      JSON.stringify({ alarms, nextId: alarmNextId }, null, 2)
    );
  } catch (error) {
    console.error("[Schedule] Save error:", error);
  }
}

export function setAlarmNotifyCallback(
  callback: (message: string) => void
): void {
  alarmNotifyCallback = callback;
}

function checkAlarms(): void {
  const now = new Date();
  const currentTime = now.toLocaleTimeString("ja-JP", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const alarmsToDelete: number[] = [];

  for (const alarm of alarms) {
    if (!alarm.enabled) continue;

    const triggerKey = `${alarm.id}_${currentTime}`;
    if (lastTriggered.has(triggerKey)) continue;

    if (alarm.time === currentTime) {
      lastTriggered.set(triggerKey, true);

      // コールバックで通知
      if (alarmNotifyCallback) {
        const message = alarm.message || `${alarm.label}の時間です`;
        try {
          alarmNotifyCallback(`アラームです。${message}`);
        } catch {
          // エラーは無視
        }
      }

      alarmsToDelete.push(alarm.id);
    }
  }

  // 発動したアラームを削除
  if (alarmsToDelete.length > 0) {
    alarms = alarms.filter((a) => !alarmsToDelete.includes(a.id));
    saveAlarms();
  }

  // 古い記録をクリア
  for (const key of lastTriggered.keys()) {
    if (!key.endsWith(currentTime)) {
      lastTriggered.delete(key);
    }
  }
}

export function startAlarmThread(): void {
  loadAlarms();
  if (checkInterval) return;
  checkInterval = setInterval(checkAlarms, 10000);
  console.log("[Schedule] Alarm thread started");
}

export function stopAlarmThread(): void {
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

export class ScheduleCapability implements Capability {
  name = "schedule";
  category = CapabilityCategory.SCHEDULE;
  description = "アラームの設定・確認・削除";

  getTools(): Tool[] {
    return [
      {
        type: "function",
        name: "alarm_set",
        description: `時間を覚えておいて知らせる。以下の場面で使う：
- 「7時に起こして」「30分後に教えて」「○時にアラーム」
- 時間に関する依頼があったとき自動で時刻を計算してセット`,
        parameters: {
          type: "object",
          properties: {
            time: {
              type: "string",
              description: "時刻（HH:MM形式、例: 07:00, 14:30）",
            },
            label: {
              type: "string",
              description: "ラベル（例: 起床、会議）",
            },
            message: {
              type: "string",
              description: "読み上げメッセージ",
            },
          },
          required: ["time"],
        },
      },
      {
        type: "function",
        name: "alarm_list",
        description: `覚えていることを確認。以下の場面で使う：
- 「アラーム確認」「何時にセットしてある？」
- 既存のアラームについて聞かれたとき`,
        parameters: {
          type: "object",
          properties: {},
          required: [],
        },
      },
      {
        type: "function",
        name: "alarm_delete",
        description: `覚えていることを忘れる。以下の場面で使う：
- 「アラーム消して」「キャンセル」`,
        parameters: {
          type: "object",
          properties: {
            alarm_id: {
              type: "string",
              description: "アラームID（番号）",
            },
          },
          required: ["alarm_id"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CapabilityResult> {
    switch (toolName) {
      case "alarm_set":
        return this.setAlarm(
          args.time as string,
          (args.label as string) || "アラーム",
          (args.message as string) || ""
        );
      case "alarm_list":
        return this.listAlarms();
      case "alarm_delete":
        return this.deleteAlarm(args.alarm_id as string);
      default:
        return { success: false, message: `Unknown tool: ${toolName}` };
    }
  }

  private setAlarm(
    time: string,
    label: string,
    message: string
  ): CapabilityResult {
    try {
      const [hourStr, minuteStr] = time.split(":");
      const hour = parseInt(hourStr, 10);
      const minute = parseInt(minuteStr, 10);

      if (
        isNaN(hour) ||
        isNaN(minute) ||
        hour < 0 ||
        hour > 23 ||
        minute < 0 ||
        minute > 59
      ) {
        return { success: false, message: "時刻が正しくありません" };
      }
    } catch {
      return { success: false, message: "時刻が正しくありません" };
    }

    const alarm: Alarm = {
      id: alarmNextId,
      time,
      label,
      message: message || `${label}の時間です`,
      enabled: true,
      createdAt: new Date().toISOString(),
    };

    alarms.push(alarm);
    alarmNextId++;
    saveAlarms();

    return { success: true, message: `${time}に覚えておきます` };
  }

  private listAlarms(): CapabilityResult {
    if (alarms.length === 0) {
      return { success: true, message: "覚えていることはありません" };
    }

    const items = alarms.map((alarm) => {
      const status = alarm.enabled ? "有効" : "無効";
      return `${alarm.id}. ${alarm.time} - ${alarm.label} (${status})`;
    });

    return { success: true, message: "覚えていること:\n" + items.join("\n") };
  }

  private deleteAlarm(alarmId: string): CapabilityResult {
    const id = parseInt(alarmId, 10);
    if (isNaN(id)) {
      return { success: false, message: "番号を教えてください" };
    }

    const index = alarms.findIndex((a) => a.id === id);
    if (index === -1) {
      return { success: false, message: "その予定は見つかりません" };
    }

    const deleted = alarms.splice(index, 1)[0];
    saveAlarms();

    return { success: true, message: `${deleted.time}の予定を忘れました` };
  }
}
