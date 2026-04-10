/**
 * Communication Capability
 *
 * 「送る」に関する能力:
 * - メールの確認・送信・返信
 * - スマホへの音声/写真メッセージ送信
 */

import { google, gmail_v1 } from "googleapis";
import { OAuth2Client } from "google-auth-library";
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { Capability, CapabilityResult, Tool } from "./types.js";
import { CapabilityCategory } from "./types.js";
import { Config } from "../config.js";

const _GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

let gmailService: gmail_v1.Gmail | null = null;

interface EmailInfo {
  id: string;
  from: string;
  fromEmail: string;
  subject: string;
}

let lastEmailList: EmailInfo[] = [];

export async function initGmail(): Promise<boolean> {
  const tokenPath = Config.GMAIL_TOKEN_PATH;
  const credentialsPath = Config.GMAIL_CREDENTIALS_PATH;

  if (!existsSync(credentialsPath)) {
    console.log("[Gmail] credentials.json not found");
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

      if (token.expiry_date && token.expiry_date < Date.now()) {
        const { credentials: newCredentials } =
          await oauth2Client.refreshAccessToken();
        oauth2Client.setCredentials(newCredentials);
        writeFileSync(tokenPath, JSON.stringify(newCredentials));
      }
    } else {
      console.log("[Gmail] Token not found. Please run auth flow first.");
      return false;
    }

    gmailService = google.gmail({ version: "v1", auth: oauth2Client });
    console.log("[Gmail] Initialized");
    return true;
  } catch (error) {
    console.error("[Gmail] Init error:", error);
    return false;
  }
}

function extractEmailName(fromHeader: string): string {
  const match = fromHeader.match(/^(.+?)\s*</);
  if (match) {
    return match[1].trim().replace(/"/g, "");
  }
  return fromHeader.split("@")[0];
}

function createEmailMessage(
  to: string,
  subject: string,
  body: string,
  _threadId?: string
): string {
  const message = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");

  return Buffer.from(message).toString("base64url");
}

export class CommunicationCapability implements Capability {
  name = "communication";
  category = CapabilityCategory.COMMUNICATION;
  description = "メールの確認・送信・返信";

  getTools(): Tool[] {
    return [
      {
        type: "function",
        name: "gmail_list",
        description: `メールを確認する。以下の場面で使う：
- 「メールある？」「新着メールは？」「メール来てる？」
- 「○○さんからメール来てる？」（from:で検索）
- メールについて話題が出たとき`,
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description:
                "検索クエリ（例: is:unread, from:xxx@gmail.com）",
            },
            max_results: {
              type: "string",
              description: "取得件数（デフォルト5）",
            },
          },
          required: [],
        },
      },
      {
        type: "function",
        name: "gmail_read",
        description: `メールの本文を読む。以下の場面で使う：
- 「1番目のメールを読んで」「さっきのメール詳しく」
- gmail_listの後、特定のメールについて聞かれたとき`,
        parameters: {
          type: "object",
          properties: {
            message_id: {
              type: "string",
              description: "メールID（番号: 1, 2, 3など）",
            },
          },
          required: ["message_id"],
        },
      },
      {
        type: "function",
        name: "gmail_send",
        description: `メールを送る。以下の場面で使う：
- 「○○さんにメール送って」「メールを書いて」
- 宛先・件名・本文を確認してから送信`,
        parameters: {
          type: "object",
          properties: {
            to: { type: "string", description: "宛先メールアドレス" },
            subject: { type: "string", description: "件名" },
            body: { type: "string", description: "本文" },
          },
          required: ["to", "subject", "body"],
        },
      },
      {
        type: "function",
        name: "gmail_reply",
        description: `メールに返信する。以下の場面で使う：
- 「返信して」「了解と返しておいて」
- 直前に読んだメールに対する返信を依頼されたとき`,
        parameters: {
          type: "object",
          properties: {
            message_id: {
              type: "string",
              description: "返信するメールの番号（1, 2, 3など）",
            },
            body: { type: "string", description: "返信本文" },
          },
          required: ["message_id", "body"],
        },
      },
      {
        type: "function",
        name: "voice_send",
        description: `スマホに音声メッセージを送る。

【重要】このツールは「内容を聞かずに即座に呼び出す」こと。
ユーザーが録音で直接メッセージを吹き込むため、テキストで内容を聞く必要はない。

以下の場面で即座に呼び出す：
- 「スマホにメッセージ送って」「スマホに連絡」

呼び出したら「どうぞ」とだけ言い、ユーザーの録音を待つ。`,
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
      case "gmail_list":
        return this.listEmails(
          (args.query as string) || "is:unread",
          Number(args.max_results) || 5
        );
      case "gmail_read":
        return this.readEmail(args.message_id as string);
      case "gmail_send":
        return this.sendEmail(
          args.to as string,
          args.subject as string,
          args.body as string
        );
      case "gmail_reply":
        return this.replyEmail(
          args.message_id as string,
          args.body as string
        );
      case "voice_send":
        return this.startVoiceMessage();
      default:
        return { success: false, message: `Unknown tool: ${toolName}` };
    }
  }

  private async listEmails(
    query: string,
    maxResults: number
  ): Promise<CapabilityResult> {
    if (!gmailService) {
      return { success: false, message: "今はメールを確認できません" };
    }

    try {
      const response = await gmailService.users.messages.list({
        userId: "me",
        q: query,
        maxResults,
      });

      const messages = response.data.messages || [];
      if (messages.length === 0) {
        return { success: true, message: "新しいメールはありません" };
      }

      const emailList: string[] = [];
      lastEmailList = [];

      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        const detail = await gmailService.users.messages.get({
          userId: "me",
          id: msg.id!,
          format: "metadata",
          metadataHeaders: ["From", "Subject", "Date"],
        });

        const headers: Record<string, string> = {};
        for (const h of detail.data.payload?.headers || []) {
          if (h.name && h.value) {
            headers[h.name] = h.value;
          }
        }

        const fromHeader = headers.From || "不明";
        const fromName = extractEmailName(fromHeader);

        const emailInfo: EmailInfo = {
          id: msg.id!,
          from: fromName,
          fromEmail: fromHeader,
          subject: headers.Subject || "(件名なし)",
        };
        lastEmailList.push(emailInfo);
        emailList.push(`${i + 1}. ${fromName}さんから: ${emailInfo.subject}`);
      }

      return {
        success: true,
        message: "メール一覧:\n" + emailList.join("\n"),
      };
    } catch (error) {
      console.error("[Gmail] List error:", error);
      return { success: false, message: "今はメールを確認できません" };
    }
  }

  private async readEmail(messageId: string): Promise<CapabilityResult> {
    if (!gmailService) {
      return { success: false, message: "今はメールを読めません" };
    }

    // 番号で指定された場合
    let actualId = messageId;
    if (/^\d+$/.test(messageId)) {
      const idx = parseInt(messageId, 10) - 1;
      if (idx >= 0 && idx < lastEmailList.length) {
        actualId = lastEmailList[idx].id;
      } else {
        return { success: false, message: "そのメールは見つかりません" };
      }
    }

    try {
      const msg = await gmailService.users.messages.get({
        userId: "me",
        id: actualId,
        format: "full",
      });

      const headers: Record<string, string> = {};
      for (const h of msg.data.payload?.headers || []) {
        if (h.name && h.value) {
          headers[h.name] = h.value;
        }
      }

      let body = "";
      const payload = msg.data.payload;

      if (payload?.body?.data) {
        body = Buffer.from(payload.body.data, "base64url").toString("utf-8");
      } else if (payload?.parts) {
        for (const part of payload.parts) {
          if (part.mimeType === "text/plain" && part.body?.data) {
            body = Buffer.from(part.body.data, "base64url").toString("utf-8");
            break;
          }
        }
      }

      if (body.length > 500) {
        body = body.slice(0, 500) + "...(以下省略)";
      }

      const fromName = extractEmailName(headers.From || "不明");

      return {
        success: true,
        message: `送信者: ${fromName}\n件名: ${headers.Subject || "(件名なし)"}\n\n本文:\n${body}`,
      };
    } catch (error) {
      console.error("[Gmail] Read error:", error);
      return { success: false, message: "今はメールを読めません" };
    }
  }

  private async sendEmail(
    to: string,
    subject: string,
    body: string
  ): Promise<CapabilityResult> {
    if (!gmailService) {
      return { success: false, message: "今はメールを送れません" };
    }

    try {
      const raw = createEmailMessage(to, subject, body);

      await gmailService.users.messages.send({
        userId: "me",
        requestBody: { raw },
      });

      const toName = to.split("@")[0];
      return { success: true, message: `${toName}さんに送りました` };
    } catch (error) {
      console.error("[Gmail] Send error:", error);
      return { success: false, message: "今はメールを送れません" };
    }
  }

  private async replyEmail(
    messageId: string,
    body: string
  ): Promise<CapabilityResult> {
    if (!gmailService) {
      return { success: false, message: "今は返信できません" };
    }

    // 番号で指定された場合
    let actualId = messageId;
    let toEmail: string | undefined;

    if (/^\d+$/.test(messageId)) {
      const idx = parseInt(messageId, 10) - 1;
      if (idx >= 0 && idx < lastEmailList.length) {
        actualId = lastEmailList[idx].id;
        toEmail = lastEmailList[idx].fromEmail;
      } else {
        return { success: false, message: "そのメールは見つかりません" };
      }
    }

    try {
      const original = await gmailService.users.messages.get({
        userId: "me",
        id: actualId,
        format: "full",
      });

      const headers: Record<string, string> = {};
      for (const h of original.data.payload?.headers || []) {
        if (h.name && h.value) {
          headers[h.name] = h.value;
        }
      }

      const toRaw = toEmail || headers["Reply-To"] || headers.From || "";
      const emailMatch = toRaw.match(/<([^>]+)>/);
      const to = emailMatch ? emailMatch[1] : toRaw.trim();

      let subject = headers.Subject || "";
      if (!subject.startsWith("Re:")) {
        subject = "Re: " + subject;
      }

      const threadId = original.data.threadId;
      const raw = createEmailMessage(to, subject, body);

      await gmailService.users.messages.send({
        userId: "me",
        requestBody: { raw, threadId },
      });

      const toName = to.split("@")[0];
      return { success: true, message: `${toName}さんに返信しました` };
    } catch (error) {
      console.error("[Gmail] Reply error:", error);
      return { success: false, message: "今は返信できません" };
    }
  }

  private async startVoiceMessage(): Promise<CapabilityResult> {
    // Firebase未実装のため、録音モードフラグを返す
    return {
      success: true,
      message:
        "録音モードに入りました。ユーザーに「どうぞ」とだけ伝えてください。",
      data: { startVoiceRecording: true },
    };
  }
}
