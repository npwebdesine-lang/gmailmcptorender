/**
 * ============================================================================
 * File Name: server.js (בתוך תיקיית הפרויקט של שרת ה-Gmail MCP)
 * Description: שרת MCP המשלב גישה מאובטחת ל-Gmail דרך OAuth 2.0.
 * המערכת כוללת:
 * 1. Human-In-The-Loop (HITL) - טיוטה ואישור אנושי לפני שליחת מייל.
 * 2. Attachment Parsing - יכולת קריאת קבצים מצורפים (PDF, תמונות באמצעות OCR, וטקסט).
 * ============================================================================
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { google } from "googleapis";
import pdfParse from "pdf-parse"; // ספרייה לקריאת קבצי PDF
import Tesseract from "tesseract.js"; // ספרייה לזיהוי טקסט מתמונות (OCR)

// הגנה מפני קריסות פתאומיות בשרת
process.on("uncaughtException", (error) =>
  console.error("Prevented Crash:", error),
);
process.on("unhandledRejection", (reason) =>
  console.error("Prevented Crash:", reason),
);

// ==========================================
// חלק 1: הגדרת האבטחה והחיבור ל-Gmail (OAuth 2.0)
// ==========================================
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  "https://developers.google.com/oauthplayground",
);

oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

// ==========================================
// פונקציית עזר: איתור קבצים מצורפים בתוך מבנה המייל
// ==========================================
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
    // חיפוש רקורסיבי (למקרה שהקובץ חבוי עמוק בשרשור)
    if (part.parts) {
      attachments.push(...extractAttachments(part.parts));
    }
  }
  return attachments;
}

// ==========================================
// חלק 2: מנגנון הכלים (MCP)
// ==========================================
const pendingEmails = new Map();

function createGmailSessionServer() {
  const server = new McpServer({
    name: "Gmail Service (HITL & Attachments)",
    version: "1.1.0",
  });

  // --- כלי מס' 1: קריאת אימיילים (כולל דיווח על קבצים מצורפים) ---
  server.tool(
    "read_emails",
    "Fetches recent emails from the inbox. Returns sender, subject, body snippet, and importantly: a list of ATTACHMENTS with their IDs.",
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

          // שולפים את הקבצים המצורפים אם ישנם
          const attachments = extractAttachments(payload.parts);
          let attachStr =
            attachments.length > 0
              ? `\n📎 קבצים מצורפים:\n` +
                attachments
                  .map(
                    (a) =>
                      `   - קובץ: ${a.filename} | ID: ${a.id} | סוג: ${a.mimeType}`,
                  )
                  .join("\n")
              : "";

          emailsText += `📧 מאת: ${from}\nנושא: ${subject}\nID המייל: ${msg.id}${attachStr}\n---\n`;
        }
        return { content: [{ type: "text", text: emailsText }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    },
  );

  // --- כלי מס' 2 (חדש): קריאת קבצים מצורפים ---
  server.tool(
    "get_attachment",
    "Downloads and reads an attachment from an email. Use this when the user asks to summarize a PDF, read an invoice, or analyze an attached image. You MUST provide the messageId and attachmentId.",
    {
      messageId: z.string().describe("The ID of the email message"),
      attachmentId: z
        .string()
        .describe("The ID of the attachment (found via read_emails)"),
      mimeType: z
        .string()
        .describe("The type of the file (e.g. application/pdf, image/jpeg)"),
    },
    async ({ messageId, attachmentId, mimeType }) => {
      console.log(`>>> [MCP] Fetching attachment... Type: ${mimeType}`);
      try {
        // 1. הורדת הקובץ מגוגל (מגיע בקידוד Base64 URL Safe)
        const attachRes = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: messageId,
          id: attachmentId,
        });

        // 2. תרגום הקידוד למידע גולמי (Buffer)
        const base64Data = attachRes.data.data
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        const buffer = Buffer.from(base64Data, "base64");

        // 3. פענוח הקובץ לפי סוג (PDF, תמונה או טקסט)
        let extractedText = "";

        if (mimeType === "application/pdf") {
          console.log(">>> [MCP] Parsing PDF file...");
          const pdfData = await pdfParse(buffer);
          extractedText = pdfData.text;
        } else if (mimeType.startsWith("image/")) {
          console.log(
            ">>> [MCP] Running OCR on Image (might take a few seconds)...",
          );
          // מריצים OCR לזיהוי טקסט (אנגלית ועברית)
          const { data } = await Tesseract.recognize(buffer, "eng+heb");
          extractedText = data.text;
        } else if (
          mimeType.startsWith("text/") ||
          mimeType === "application/json" ||
          mimeType === "text/csv"
        ) {
          console.log(">>> [MCP] Reading plain text file...");
          extractedText = buffer.toString("utf8");
        } else {
          return {
            content: [
              {
                type: "text",
                text: `Error: File type '${mimeType}' is not supported for automatic reading.`,
              },
            ],
          };
        }

        if (!extractedText || extractedText.trim().length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "The file was opened, but no readable text could be extracted. It might be a scanned document without embedded text.",
              },
            ],
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Here is the extracted text from the attachment:\n\n${extractedText}\n\n--- End of file. You can now summarize or analyze this data for the user.`,
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
    "Creates a draft of an email. YOU MUST USE THIS FIRST BEFORE SENDING. Show the drafted content to the user and explicitly ask for their permission to send it.",
    {
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Main email content"),
    },
    async ({ to, subject, body }) => {
      const draftId =
        "DRAFT-" + Math.random().toString(36).substring(2, 8).toUpperCase();
      pendingEmails.set(draftId, { to, subject, body });
      console.log(`>>> [HITL] Draft created: ${draftId} for ${to}`);

      return {
        content: [
          {
            type: "text",
            text: `Draft successfully created and saved in server memory with ID: ${draftId}. 
          CRITICAL INSTRUCTION: Show the user the exact 'to', 'subject', and 'body'. 
          Then, ask the user: "האם תרצה שאשלח את האימייל הזה?". 
          DO NOT proceed to send until the user says yes.`,
          },
        ],
      };
    },
  );

  // --- כלי מס' 4 (HITL): שליחת המייל ---
  server.tool(
    "send_confirmed_email",
    "Actually sends an email. ONLY USE THIS TOOL if the user explicitly approved the draft.",
    {
      draftId: z
        .string()
        .describe(
          "The Draft ID returned from the draft_email tool (e.g. DRAFT-X4G1)",
        ),
    },
    async ({ draftId }) => {
      const emailData = pendingEmails.get(draftId);

      if (!emailData) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Draft ${draftId} not found or already sent.`,
            },
          ],
        };
      }

      console.log(`>>> [HITL] Approval received! Sending ${draftId}...`);

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
            {
              type: "text",
              text: `✅ האימייל נשלח בהצלחה לנמען ${emailData.to}!`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            { type: "text", text: `❌ שגיאה בשליחה: ${error.message}` },
          ],
        };
      }
    },
  );

  return server;
}

// ==========================================
// חלק 3: מרכזיית הלקוחות (Express & SSE)
// ==========================================
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
