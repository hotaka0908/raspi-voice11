/**
 * Calendar Capability
 *
 * 「予定」に関する能力:
 * - Google Calendarから予定を取得
 * - 予定を追加・削除
 */

import { google, calendar_v3 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Capability, CapabilityResult, Tool } from "./types.js";
import { CapabilityCategory } from "./types.js";
import { Config } from "../config.js";
import { resolve } from "path";
import { homedir } from "os";

const _CALENDAR_SCOPES = ["https://www.googleapis.com/auth/calendar"];

let calendarService: calendar_v3.Calendar | null = null;

export async function initCalendar(): Promise<boolean> {
  const tokenPath = resolve(homedir(), ".ai-necklace", "calendar_token.json");
  const credentialsPath = Config.GMAIL_CREDENTIALS_PATH;

  if (!existsSync(credentialsPath)) {
    console.log("[Calendar] credentials.json not found");
    return false;
  }

  try {
    const credentials = JSON.parse(readFileSync(credentialsPath, "utf-8"));
    const { client_id, client_secret, redirect_uris } =
      credentials.installed || credentials.web;

    const oauth2Client = new OAuth2Client(
      client_id,
      client_secret,
      redirect_uris?.[0]
    );

    if (existsSync(tokenPath)) {
      const token = JSON.parse(readFileSync(tokenPath, "utf-8"));
      oauth2Client.setCredentials(token);

      // トークンの有効期限チェックと更新
      if (token.expiry_date && token.expiry_date < Date.now()) {
        const { credentials: newCredentials } =
          await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(newCredentials);
        writeFileSync(tokenPath, JSON.stringify(newCredentials));
      }
    } else {
      console.log("[Calendar] Token not found. Please run auth flow first.");
      return false;
    }

    calendarService = google.calendar({ version: "v3", auth: oauth2Client });
    console.log("[Calendar] Initialized");
    return true;
  } catch (error) {
    console.error("[Calendar] Init error:", error);
    return false;
  }
}

function formatEventTime(event: calendar_v3.Schema$Event): string {
  const start = event.start;
  if (!start) return "";

  if (start.dateTime) {
    const dt = new Date(start.dateTime);
    return dt.toLocaleTimeString("ja-JP", {
      hour: "2-digit",
      minute: "2-digit",
    });
  } else if (start.date) {
    return "終日";
  }
  return "";
}

function parseDateTime(
  dtStr: string,
  baseDate: Date = new Date()
): Date | null {
  // 時刻のみ（HH:MM）
  if (dtStr.includes(":") && dtStr.length <= 5) {
    const [hour, minute] = dtStr.split(":").map(Number);
    const result = new Date(baseDate);
    result.setHours(hour, minute, 0, 0);
    return result;
  }

  // 日付+時刻のパターン
  const patterns = [
    /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/,
    /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/,
    /^(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/,
    /^(\d{2})-(\d{2}) (\d{2}):(\d{2})$/,
  ];

  for (const pattern of patterns) {
    const match = dtStr.match(pattern);
    if (match) {
      // パターンに応じて日付を構築
      // 簡略化のため基本的な処理のみ
      return new Date(dtStr);
    }
  }

  return null;
}

export class CalendarCapability implements Capability {
  name = "calendar";
  category = CapabilityCategory.SCHEDULE;
  description = "予定を確認・追加・削除する";

  getTools(): Tool[] {
    return [
      {
        type: "function",
        name: "calendar_list",
        description: `予定を確認する。以下の場面で使う：
- 「今日の予定は？」「明日の予定」
- 「来週の予定を教えて」
- 「今週何かある？」

daysで何日分の予定を取得するか指定（デフォルト1日）`,
        parameters: {
          type: "object",
          properties: {
            days: {
              type: "string",
              description: "取得する日数（1=今日のみ、7=1週間）",
            },
          },
          required: [],
        },
      },
      {
        type: "function",
        name: "calendar_add",
        description: `予定を追加する。以下の場面で使う：
- 「明日10時に会議を入れて」
- 「来週月曜に歯医者の予定を追加」
- 「15時からミーティング」`,
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "予定のタイトル",
            },
            start_time: {
              type: "string",
              description: "開始時刻（HH:MM形式、または YYYY-MM-DD HH:MM）",
            },
            duration_minutes: {
              type: "string",
              description: "所要時間（分）。デフォルト60分",
            },
            date: {
              type: "string",
              description: "日付（today, tomorrow, または YYYY-MM-DD）",
            },
          },
          required: ["title", "start_time"],
        },
      },
      {
        type: "function",
        name: "calendar_delete",
        description: `予定を削除する。以下の場面で使う：
- 「今日の会議をキャンセル」
- 「明日の歯医者の予定を消して」

titleで削除する予定のタイトル（部分一致）を指定`,
        parameters: {
          type: "object",
          properties: {
            title: {
              type: "string",
              description: "削除する予定のタイトル（部分一致）",
            },
            date: {
              type: "string",
              description: "日付（today, tomorrow, または YYYY-MM-DD）",
            },
          },
          required: ["title"],
        },
      },
    ];
  }

  async execute(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<CapabilityResult> {
    if (!calendarService) {
      return { success: false, message: "今は予定を確認できません" };
    }

    switch (toolName) {
      case "calendar_list":
        return this.listEvents(Number(args.days) || 1);
      case "calendar_add":
        return this.addEvent(
          args.title as string,
          args.start_time as string,
          Number(args.duration_minutes) || 60,
          (args.date as string) || "today"
        );
      case "calendar_delete":
        return this.deleteEvent(
          args.title as string,
          (args.date as string) || "today"
        );
      default:
        return { success: false, message: `Unknown tool: ${toolName}` };
    }
  }

  private async listEvents(days: number): Promise<CapabilityResult> {
    try {
      const now = new Date();
      const startOfDay = new Date(now);
      startOfDay.setHours(0, 0, 0, 0);

      const endTime = new Date(startOfDay);
      endTime.setDate(endTime.getDate() + days);

      const response = await calendarService!.events.list({
        calendarId: "primary",
        timeMin: startOfDay.toISOString(),
        timeMax: endTime.toISOString(),
        maxResults: 10,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = response.data.items || [];

      if (events.length === 0) {
        return {
          success: true,
          message:
            days === 1
              ? "今日の予定はありません"
              : `今後${days}日間の予定はありません`,
        };
      }

      const resultLines: string[] = [];
      let currentDate: string | null = null;

      for (const event of events) {
        const start = event.start;
        let eventDate: string;

        if (start?.dateTime) {
          eventDate = new Date(start.dateTime).toLocaleDateString("ja-JP");
        } else if (start?.date) {
          eventDate = new Date(start.date).toLocaleDateString("ja-JP");
        } else {
          continue;
        }

        // 日付が変わったら見出し追加
        if (days > 1 && eventDate !== currentDate) {
          currentDate = eventDate;
          const eventDateObj = new Date(start?.dateTime || start?.date || "");
          const today = new Date();
          const tomorrow = new Date(today);
          tomorrow.setDate(tomorrow.getDate() + 1);

          if (eventDateObj.toDateString() === today.toDateString()) {
            resultLines.push("【今日】");
          } else if (eventDateObj.toDateString() === tomorrow.toDateString()) {
            resultLines.push("【明日】");
          } else {
            resultLines.push(
              `【${eventDateObj.toLocaleDateString("ja-JP", { month: "2-digit", day: "2-digit" })}】`
            );
          }
        }

        const timeStr = formatEventTime(event);
        const summary = event.summary || "(タイトルなし)";
        resultLines.push(`- ${timeStr} ${summary}`);
      }

      return { success: true, message: resultLines.join("\n") };
    } catch (error) {
      console.error("[Calendar] List error:", error);
      return { success: false, message: "今は予定を確認できません" };
    }
  }

  private async addEvent(
    title: string,
    startTime: string,
    durationMinutes: number,
    date: string
  ): Promise<CapabilityResult> {
    try {
      const now = new Date();
      let baseDate: Date;

      if (date === "today") {
        baseDate = now;
      } else if (date === "tomorrow") {
        baseDate = new Date(now);
        baseDate.setDate(baseDate.getDate() + 1);
      } else {
        baseDate = new Date(date);
      }

      const startDt = parseDateTime(startTime, baseDate);
      if (!startDt) {
        return { success: false, message: "時刻が正しくありません" };
      }

      const endDt = new Date(startDt);
      endDt.setMinutes(endDt.getMinutes() + durationMinutes);

      await calendarService!.events.insert({
        calendarId: "primary",
        requestBody: {
          summary: title,
          start: {
            dateTime: startDt.toISOString(),
            timeZone: "Asia/Tokyo",
          },
          end: {
            dateTime: endDt.toISOString(),
            timeZone: "Asia/Tokyo",
          },
        },
      });

      const timeStr = startDt.toLocaleString("ja-JP", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      });
      return { success: true, message: `${timeStr}に「${title}」を追加しました` };
    } catch (error) {
      console.error("[Calendar] Add error:", error);
      return { success: false, message: "今は予定を追加できません" };
    }
  }

  private async deleteEvent(
    title: string,
    date: string
  ): Promise<CapabilityResult> {
    try {
      const now = new Date();
      let baseDate: Date;

      if (date === "today") {
        baseDate = now;
      } else if (date === "tomorrow") {
        baseDate = new Date(now);
        baseDate.setDate(baseDate.getDate() + 1);
      } else {
        baseDate = new Date(date);
      }

      const startOfDay = new Date(baseDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(startOfDay);
      endOfDay.setDate(endOfDay.getDate() + 1);

      const response = await calendarService!.events.list({
        calendarId: "primary",
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = response.data.items || [];

      for (const event of events) {
        const summary = event.summary || "";
        if (summary.toLowerCase().includes(title.toLowerCase())) {
          await calendarService!.events.delete({
            calendarId: "primary",
            eventId: event.id!,
          });
          return { success: true, message: `「${summary}」を削除しました` };
        }
      }

      return { success: false, message: "その予定は見つかりません" };
    } catch (error) {
      console.error("[Calendar] Delete error:", error);
      return { success: false, message: "今は予定を削除できません" };
    }
  }
}
