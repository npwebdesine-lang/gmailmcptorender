/**
 * ============================================================================
 * File Name: server.js (בתוך תיקיית הפרויקט של שרת ה-Gmail MCP)
 * Description: שרת MCP המשלב גישה מאובטחת ל-Gmail דרך OAuth 2.0,
 * וכולל מנגנון Human-In-The-Loop (אדם במעגל).
 * השרת לא שולח אימיילים אוטומטית, אלא מייצר "טיוטה"
 * שממתינה לאישור אנושי מפורש לפני השליחה בפועל.
 * ============================================================================
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import { google } from "googleapis";

// הגנה מפני קריסות פתאומיות בשרת (כמו ב-Render)
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

// ה-Refresh Token הוא "צמיד ה-VIP" שמאפשר גישה לתיבה בלי להזין סיסמה
oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

const gmail = google.gmail({ version: "v1", auth: oauth2Client });

// ==========================================
// חלק 2: מנגנון ה- Human in the Loop (HITL)
// ==========================================

// "הכספת": כאן השרת ישמור את הטיוטות שממתינות לאישור אנושי
// המפתח הוא Draft ID (מזהה טיוטה), והערך הוא פרטי האימייל (נמען, נושא, תוכן)
const pendingEmails = new Map();

function createGmailSessionServer() {
  const server = new McpServer({
    name: "Gmail Service (HITL)",
    version: "1.0.0",
  });

  // --- כלי מס' 1: קריאת אימיילים (פעולה בטוחה, לא דורשת אישור מיוחד) ---
  server.tool(
    "read_emails",
    "Fetches recent emails from the inbox.",
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
          const headers = msgDetails.data.payload.headers;
          const subject =
            headers.find((h) => h.name === "Subject")?.value || "ללא נושא";
          const from =
            headers.find((h) => h.name === "From")?.value || "לא ידוע";
          emailsText += `📧 מאת: ${from}\nנושא: ${subject}\n---\n`;
        }
        return { content: [{ type: "text", text: emailsText }] };
      } catch (e) {
        return { content: [{ type: "text", text: `Error: ${e.message}` }] };
      }
    },
  );

  // --- כלי מס' 2 (שלב א' ב-HITL): יצירת טיוטה (לא שולח באמת!) ---
  server.tool(
    "draft_email",
    "Creates a draft of an email. YOU MUST USE THIS FIRST BEFORE SENDING. Show the drafted content to the user and explicitly ask for their permission to send it.",
    {
      to: z.string().email().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Main email content"),
    },
    async ({ to, subject, body }) => {
      // יצירת מזהה ייחודי לטיוטה הזו
      const draftId =
        "DRAFT-" + Math.random().toString(36).substring(2, 8).toUpperCase();

      // שמירה בכספת של השרת
      pendingEmails.set(draftId, { to, subject, body });
      console.log(`>>> [HITL] Draft created: ${draftId} for ${to}`);

      // ההוראה הקריטית שחוזרת ל-AI:
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

  // --- כלי מס' 3 (שלב ב' ב-HITL): ביצוע ושליחה בפועל ---
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
      // בודקים אם יש לנו טיוטה כזו בכספת
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
        // קידוד מיוחד לג'ימייל (Base64 URL Safe)
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

        // השליחה בפועל דרך ה-API של גוגל
        await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw: encodedMessage },
        });

        // חשוב: מחיקת הטיוטה אחרי שהיא נשלחה כדי למנוע שליחה כפולה
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

// מילון ששומר את כל החיבורים הפעילים של הצ'אטבוטים למערכת
const transports = new Map();

app.get("/sse", async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports.set(transport.sessionId, transport);

  // ייצור שרת MCP פרטי לכל לקוח שמתחבר
  const sessionServer = createGmailSessionServer();

  // ניקוי המילון כשהלקוח מתנתק
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

// נקודת ביקורת (Keep-Alive) למניעת הרדמות השרת ב-Render
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// שינוי פורט ל-3001 כדי לא להתנגש עם שרתים אחרים בריצה מקומית
const port = process.env.PORT || 3001;
app.listen(port, "0.0.0.0", () => {
  console.log(`Gmail MCP Server running on port ${port}`);
});
