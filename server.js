/**
 * ============================================================================
 * File Name: server.js
 * Description: שרת MCP המשלב גישה מאובטחת ל-Gmail דרך OAuth 2.0.
 * כולל:
 * 1. Human-In-The-Loop (HITL) לשליחת מיילים.
 * 2. Attachment Vault - מנגנון חכם למניעת הזיות AI בשליפת מזהי קבצים.
 * 3. קריאת קבצי PDF ותמונות (OCR).
 * ============================================================================
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { google } from "googleapis";
import pdfParse from "pdf-parse";
import Tesseract from "tesseract.js";

process.on("uncaughtException", (error) =>
  console.error("Prevented Crash:", error),
);
process.on("unhandledRejection", (reason) =>
  console.error("Prevented Crash:", reason),
);

const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground",
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

function extractAttachments(parts) {
  let attachments = [];
  if (!parts) return attachments;
  for (const part of parts) {
    if (part.filename && part.body && part.body.attachmentId) {
      attachments.push({
        filename: part.filename,
        id: part.body.attachmentId,
        mimeType: part.mimeType,
      });
    }
    if (part.parts) {
      attachments.push(...extractAttachments(part.parts));
    }
  }
  return attachments;
}

// ==========================================
// כספות הזיכרון שלנו (Vaults)
// ==========================================
const pendingEmails = new Map(); // כספת לטיוטות של ה-HITL
const attachmentVault = new Map(); // כספת לקבצים מצורפים
let attachmentCounter = 1; // מונה קבצים ליצירת מזהים קצרים

function createGmailSessionServer() {
  const server = new McpServer({
    name: "Gmail Service (Pro)",
    version: "1.2.0",
  });

  // --- כלי מס' 1: קריאת אימיילים (ושמירת קבצים בכספת) ---
  server.tool(
    "read_emails",
    "Fetches recent emails. Returns sender, subject, body, and a list of ATTACHMENTS. If there are attachments, use the short 'ATT-X' ID with get_attachment tool.",
    {
      limit: z
        .number()
        .min(1)
        .max(5)
        .default(3)
        .describe("Number of emails to fetch"),
    },
    async ({ limit }) => {
      try {
        const res = await gmail.users.messages.list({
          userId: "me",
          maxResults: limit,
          q: "in:inbox",
        });
        const messages = res.data.messages || [];
        if (messages.length === 0)
          return { content: [{ type: "text", text: "אין אימיילים חדשים." }] };

        let emailsText = "";
        for (const msg of messages) {
          const msgDetails = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
          });
          const payload = msgDetails.data.payload;
          const headers = payload.headers;

          const subject =
            headers.find((h) => h.name === "Subject")?.value || "ללא נושא";
          const from =
            headers.find((h) => h.name === "From")?.value || "לא ידוע";

          const attachments = extractAttachments(payload.parts);
          let attachStr = "";

          if (attachments.length > 0) {
            attachStr = `\n📎 קבצים מצורפים (כדי לקרוא אותם, הפעל get_attachment עם ה-ID הקצר):\n`;
            for (const a of attachments) {
              const shortId = `ATT-${attachmentCounter++}`;
              // שמירת המזהה הארוך והמכוער בכספת!
              attachmentVault.set(shortId, {
                realAttachmentId: a.id,
                messageId: msg.id,
                mimeType: a.mimeType,
              });
              attachStr += `   - קובץ: ${a.filename} | ID: ${shortId} | סוג: ${a.mimeType}\n`;
            }
          }

          emailsText += `📧 מאת: ${from}\nנושא: ${subject}\nID המייל: ${msg.id}${attachStr}\n---\n`;
        }
        return { content: [{ type: "text", text: emailsText }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    },
  );

  // --- כלי מס' 2: קריאת קבצים מצורפים (דרך המזהה הקצר) ---
  server.tool(
    "get_attachment",
    "Downloads and reads an attachment. You MUST provide ONLY the short ID (e.g., ATT-1) found in the read_emails output.",
    {
      shortId: z
        .string()
        .describe("The short ID of the attachment (e.g. ATT-1)"),
    },
    async ({ shortId }) => {
      // שליפת הנתונים האמיתיים מהכספת
      const attachData = attachmentVault.get(shortId);
      if (!attachData) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Attachment ID '${shortId}' not found. Please read emails first.`,
            },
          ],
        };
      }

      const { realAttachmentId, messageId, mimeType } = attachData;
      console.log(
        `>>> [MCP] Fetching attachment ${shortId}... Type: ${mimeType}`,
      );

      try {
        const attachRes = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: messageId,
          id: realAttachmentId,
        });

        const base64Data = attachRes.data.data
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        const buffer = Buffer.from(base64Data, "base64");

        let extractedText = "";

        if (mimeType === "application/pdf") {
          console.log(">>> [MCP] Parsing PDF file...");
          const pdfData = await pdfParse(buffer);
          extractedText = pdfData.text;
        } else if (mimeType.startsWith("image/")) {
          console.log(">>> [MCP] Running OCR on Image...");
          const { data } = await Tesseract.recognize(buffer, "eng+heb");
          extractedText = data.text;
        } else if (
          mimeType.startsWith("text/") ||
          mimeType === "application/json" ||
          mimeType === "text/csv"
        ) {
          extractedText = buffer.toString("utf8");
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Error: File type '${mimeType}' is not supported for reading.`,
              },
            ],
          };
        }

        if (!extractedText || extractedText.trim().length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "The file was opened, but no readable text could be extracted.",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Extracted text from ${shortId}:\n\n${extractedText}\n\n--- End of file. Analyze this data for the user.`,
            },
          ],
        };
      } catch (error) {
        console.error("Attachment Error:", error);
        return {
          content: [
            {
              type: "text",
              text: `Failed to read attachment: ${error.message}`,
            },
          ],
        };
      }
    },
  );

  // --- כלי מס' 3 (HITL): יצירת טיוטה ---
  server.tool(
    "draft_email",
    "Creates a draft of an email. Show content to user and ask permission.",
    {
      to: z.string().email(),
      subject: z.string(),
      body: z.string(),
    },
    async ({ to, subject, body }) => {
      const draftId =
        "DRAFT-" + Math.random().toString(36).substring(2, 8).toUpperCase();
      pendingEmails.set(draftId, { to, subject, body });
      return {
        content: [
          {
            type: "text",
            text: `Draft created: ${draftId}. Show user exact 'to', 'subject', 'body'. Ask: "האם תרצה שאשלח?". DO NOT send until user says yes.`,
          },
        ],
      };
    },
  );

  // --- כלי מס' 4 (HITL): שליחת המייל ---
  server.tool(
    "send_confirmed_email",
    "Actually sends an email. ONLY use if user approved the draft.",
    { draftId: z.string() },
    async ({ draftId }) => {
      const emailData = pendingEmails.get(draftId);
      if (!emailData)
        return {
          content: [
            { type: "text", text: `Error: Draft ${draftId} not found.` },
          ],
        };

      try {
        const utf8Subject = `=?utf-8?B?${Buffer.from(emailData.subject).toString("base64")}?=`;
        const messageParts = [
          `To: ${emailData.to}`,
          `Subject: ${utf8Subject}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          emailData.body,
        ];
        const encodedMessage = Buffer.from(messageParts.join("\n"))
          .toString("base64")
          .replace(/\+/g, "-")
          .replace(/\//g, "_")
          .replace(/=+$/, "");

        await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw: encodedMessage },
        });
        pendingEmails.delete(draftId);
        return {
          content: [
            { type: "text", text: `✅ נשלח בהצלחה לנמען ${emailData.to}!` },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `❌ שגיאה: ${error.message}` }],
        };
      }
    },
  );

  return server;
}

const app = express();
app.use(cors());

const transports = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);
  const sessionServer = createGmailSessionServer();
  req.on("close", () => transports.delete(transport.sessionId));
  try {
    await sessionServer.connect(transport);
  } catch (e) {}
});

app.post("/messages", async (req, res) => {
  const transport = transports.get(req.query.sessionId);
  if (!transport) return res.status(503).send("No active connection");
  try {
    await transport.handlePostMessage(req, res);
  } catch (e) {}
});

app.get("/healthz", (req, res) => res.status(200).send("OK"));

const port = process.env.PORT || 3001;
app.listen(port, "0.0.0.0", () => {
  console.log(`Gmail MCP Server running on port ${port}`);
});
