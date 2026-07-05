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

// ==========================================
// ייבוא ספריות חיצוניות
// ==========================================

// טוען משתני סביבה מקובץ .env (כמו CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN)
import "dotenv/config";

// Express - מסגרת לבניית שרת HTTP
import express from "express";

// CORS - מאפשר בקשות ממקורות שונים (דפדפן / לקוח חיצוני)
import cors from "cors";

// McpServer - הליבה של פרוטוקול MCP שמאפשרת לרשום "כלים" שה-AI יכול לקרוא
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// SSEServerTransport - שכבת תקשורת ב-Server-Sent Events (חיבור זרם מהשרת ללקוח)
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

// Zod - ספריית ולידציה לבדיקת הפרמטרים שה-AI שולח לכלים
import { z } from "zod";

// googleapis - ספריית Google הרשמית לגישה ל-Gmail API
import { google } from "googleapis";

// pdf-parse - ספרייה לחילוץ טקסט מקבצי PDF
import pdfParse from "pdf-parse";

// tesseract.js - מנוע OCR לזיהוי טקסט מתוך תמונות
import Tesseract from "tesseract.js";

// ==========================================
// טיפול בשגיאות קריטיות
// ==========================================

// מונע קריסת התהליך כולו במקרה של שגיאה לא מטופלת (synchronous)
process.on("uncaughtException", (error) =>
  console.error("Prevented Crash:", error),
);

// מונע קריסת התהליך כולו במקרה של Promise שנדחה ולא טופל (async)
process.on("unhandledRejection", (reason) =>
  console.error("Prevented Crash:", reason),
);

// ==========================================
// הגדרת חיבור OAuth 2.0 ל-Gmail
// ==========================================

// יצירת לקוח OAuth עם פרטי האפליקציה מתוך משתני הסביבה
const oauth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,       // מזהה האפליקציה ב-Google Cloud
  process.env.GMAIL_CLIENT_SECRET,   // סוד האפליקציה
  "https://developers.google.com/oauthplayground", // כתובת ה-redirect שנרשמה ב-Google
);

// הגדרת ה-Refresh Token - מאפשר לשרת לקבל Access Token חדש אוטומטית כשהישן פג
oauth2Client.setCredentials({
  refresh_token: process.env.GMAIL_REFRESH_TOKEN,
});

// יצירת לקוח Gmail עם ה-OAuth שהגדרנו - כל הקריאות ל-API יעברו דרכו
const gmail = google.gmail({ version: "v1", auth: oauth2Client });

// ==========================================
// פונקציית עזר: חילוץ קבצים מצורפים
// ==========================================

/**
 * מקבלת את ה-parts של ההודעה (מבנה עץ) ומחזירה רשימה שטוחה של כל הקבצים המצורפים.
 * הפונקציה רקורסיבית כי מבנה ה-MIME של Gmail יכול להיות מקונן.
 * @param {Array} parts - חלקי ההודעה מ-Gmail API
 * @returns {Array} - רשימה של { filename, id, mimeType }
 */
function extractAttachments(parts) {
  let attachments = [];
  if (!parts) return attachments;
  for (const part of parts) {
    // part עם filename ו-attachmentId הוא קובץ מצורף אמיתי
    if (part.filename && part.body && part.body.attachmentId) {
      attachments.push({
        filename: part.filename,
        id: part.body.attachmentId,
        mimeType: part.mimeType,
      });
    }
    // טיפול רקורסיבי ב-parts מקוננים (למשל multipart/mixed)
    if (part.parts) {
      attachments.push(...extractAttachments(part.parts));
    }
  }
  return attachments;
}

// ==========================================
// כספות הזיכרון שלנו (Vaults)
// ==========================================

// כספת לטיוטות של ה-HITL - שומרת מיילים שממתינים לאישור המשתמש לפני שליחה
const pendingEmails = new Map();

// כספת לקבצים מצורפים - ממפה בין מזהה קצר (ATT-1) למזהה הארוך של Gmail
// מטרה: למנוע מה-AI להמציא מזהי קבצים (hallucination)
const attachmentVault = new Map();

// מונה גלובלי ליצירת מזהים קצרים וייחודיים עבור כל קובץ מצורף
let attachmentCounter = 1;

// ==========================================
// יצירת שרת MCP לכל Session
// ==========================================

/**
 * יוצרת מופע חדש של שרת MCP עם כל הכלים הרשומים.
 * נקראת בכל חיבור SSE חדש כדי לאפשר הפרדה בין sessions שונות.
 * @returns {McpServer} - שרת MCP מוכן לחיבור
 */
function createGmailSessionServer() {
  const server = new McpServer({
    name: "Gmail Service (Pro)",
    version: "1.2.0",
  });

  // ==========================================
  // כלי מס' 1: קריאת אימיילים
  // ==========================================
  // שולף אימיילים אחרונים מהתיבה, כולל פרטי שולח, נושא, ומידע על קבצים מצורפים.
  // הקבצים המצורפים נשמרים בכספת עם מזהה קצר (ATT-X) כדי שה-AI לא ימציא מזהים.
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
        // שליפת רשימת המזהים של ההודעות האחרונות מהתיבה הנכנסת
        const res = await gmail.users.messages.list({
          userId: "me",
          maxResults: limit,
          q: "in:inbox",
        });
        const messages = res.data.messages || [];
        if (messages.length === 0)
          return { content: [{ type: "text", text: "אין אימיילים חדשים." }] };

        let emailsText = "";

        // לולאה על כל הודעה - שליפת הפרטים המלאים
        for (const msg of messages) {
          const msgDetails = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
          });
          const payload = msgDetails.data.payload;
          const headers = payload.headers;

          // חילוץ כותרות הנושא והשולח מתוך מערך ה-headers
          const subject =
            headers.find((h) => h.name === "Subject")?.value || "ללא נושא";
          const from =
            headers.find((h) => h.name === "From")?.value || "לא ידוע";

          // חילוץ כל הקבצים המצורפים מהמבנה הרקורסיבי של ה-MIME
          const attachments = extractAttachments(payload.parts);
          let attachStr = "";

          if (attachments.length > 0) {
            attachStr = `\n📎 קבצים מצורפים (כדי לקרוא אותם, הפעל get_attachment עם ה-ID הקצר):\n`;
            for (const a of attachments) {
              // יצירת מזהה קצר וידידותי (ATT-1, ATT-2, ...)
              const shortId = `ATT-${attachmentCounter++}`;

              // שמירת המיפוי בין המזהה הקצר לנתונים האמיתיים בכספת
              // הכספת מסתירה את המזהה הארוך מה-AI כדי למנוע הזיות
              attachmentVault.set(shortId, {
                realAttachmentId: a.id,  // המזהה הארוך של Gmail API
                messageId: msg.id,        // מזהה ההודעה להורדת הקובץ
                mimeType: a.mimeType,     // סוג הקובץ לצורך בחירת הפרסר הנכון
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

  // ==========================================
  // כלי מס' 2: קריאת קבצים מצורפים
  // ==========================================
  // מוריד קובץ מצורף מ-Gmail לפי המזהה הקצר (ATT-X) ומחלץ ממנו טקסט.
  // תומך ב: PDF (pdf-parse), תמונות (OCR עם Tesseract), קבצי טקסט ו-JSON.
  server.tool(
    "get_attachment",
    "Downloads and reads an attachment. You MUST provide ONLY the short ID (e.g., ATT-1) found in the read_emails output.",
    {
      shortId: z
        .string()
        .describe("The short ID of the attachment (e.g. ATT-1)"),
    },
    async ({ shortId }) => {
      // שליפת הנתונים האמיתיים מהכספת לפי המזהה הקצר
      // אם ה-AI המציא מזהה שאינו בכספת - הבקשה נדחית
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
        // הורדת תוכן הקובץ מ-Gmail API (מוחזר כ-Base64)
        const attachRes = await gmail.users.messages.attachments.get({
          userId: "me",
          messageId: messageId,
          id: realAttachmentId,
        });

        // המרת Base64 URL-safe לבינארי (Buffer) - Gmail משתמש ב- "-" ו-"_" במקום "+" ו-"/"
        const base64Data = attachRes.data.data
          .replace(/-/g, "+")
          .replace(/_/g, "/");
        const buffer = Buffer.from(base64Data, "base64");

        let extractedText = "";

        // בחירת הפרסר המתאים לפי סוג הקובץ
        if (mimeType === "application/pdf") {
          // חילוץ טקסט מ-PDF באמצעות pdf-parse
          console.log(">>> [MCP] Parsing PDF file...");
          const pdfData = await pdfParse(buffer);
          extractedText = pdfData.text;
        } else if (mimeType.startsWith("image/")) {
          // זיהוי טקסט מתמונה (OCR) - תומך בעברית ואנגלית
          console.log(">>> [MCP] Running OCR on Image...");
          const { data } = await Tesseract.recognize(buffer, "eng+heb");
          extractedText = data.text;
        } else if (
          mimeType.startsWith("text/") ||
          mimeType === "application/json" ||
          mimeType === "text/csv"
        ) {
          // קבצי טקסט רגילים - המרה ישירה מ-Buffer ל-String
          extractedText = buffer.toString("utf8");
        } else {
          // סוג קובץ שאינו נתמך (למשל: zip, docx, exe)
          return {
            content: [
              {
                type: "text",
                text: `Error: File type '${mimeType}' is not supported for reading.`,
              },
            ],
          };
        }

        // בדיקה שהחילוץ הצליח ולא חזר ריק
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

        // החזרת הטקסט שחולץ עם הוראה ל-AI לנתח אותו
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

  // ==========================================
  // כלי מס' 3 (HITL): יצירת טיוטת מייל
  // ==========================================
  // שלב ראשון בתהליך שליחת מייל - שומר את הטיוטה בכספת ומחזיר מזהה.
  // ה-AI חייב להציג את תוכן הטיוטה למשתמש ולבקש אישור לפני שליחה.
  // זהו ה-Human-In-The-Loop (HITL) - הגנה מפני שליחת מיילים ללא ידיעת המשתמש.
  server.tool(
    "draft_email",
    "Creates a draft of an email. Show content to user and ask permission.",
    {
      to: z.string().email(),       // כתובת הנמען - חייבת להיות מייל תקין
      subject: z.string(),          // נושא המייל
      body: z.string(),             // גוף המייל
    },
    async ({ to, subject, body }) => {
      // יצירת מזהה ייחודי לטיוטה (למשל: DRAFT-A3F7X2)
      const draftId =
        "DRAFT-" + Math.random().toString(36).substring(2, 8).toUpperCase();

      // שמירת הטיוטה בכספת - ה-AI לא יכול לשלוח בלי המזהה הזה
      pendingEmails.set(draftId, { to, subject, body });

      // ה-AI מקבל הוראות מפורשות: הצג למשתמש ובקש אישור - אל תשלח!
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

  // ==========================================
  // כלי מס' 4 (HITL): שליחת מייל מאושר
  // ==========================================
  // שלב שני ואחרון - שולח את הטיוטה רק לאחר שה-AI קיבל אישור מהמשתמש.
  // מקודד את נושא המייל ב-UTF-8 (Base64) לתמיכה בעברית ותווים מיוחדים.
  server.tool(
    "send_confirmed_email",
    "Actually sends an email. ONLY use if user approved the draft.",
    { draftId: z.string() }, // מזהה הטיוטה שנוצרה ב-draft_email
    async ({ draftId }) => {
      // שליפת הטיוטה מהכספת - אם לא קיימת, שולח שגיאה
      const emailData = pendingEmails.get(draftId);
      if (!emailData)
        return {
          content: [
            { type: "text", text: `Error: Draft ${draftId} not found.` },
          ],
        };

      try {
        // קידוד הנושא ב-Base64 UTF-8 לפי תקן RFC 2047 - תמיכה בעברית
        const utf8Subject = `=?utf-8?B?${Buffer.from(emailData.subject).toString("base64")}?=`;

        // בניית הודעת ה-MIME הגולמית (raw email format)
        const messageParts = [
          `To: ${emailData.to}`,
          `Subject: ${utf8Subject}`,
          "MIME-Version: 1.0",
          "Content-Type: text/plain; charset=utf-8",
          "",
          emailData.body,
        ];

        // קידוד ההודעה ל-Base64 URL-safe (נדרש ע"י Gmail API)
        const encodedMessage = Buffer.from(messageParts.join("\n"))
          .toString("base64")
          .replace(/\+/g, "-")   // Base64 URL-safe: + -> -
          .replace(/\//g, "_")   // Base64 URL-safe: / -> _
          .replace(/=+$/, "");   // הסרת ה-padding

        // שליחת המייל דרך Gmail API
        await gmail.users.messages.send({
          userId: "me",
          requestBody: { raw: encodedMessage },
        });

        // מחיקת הטיוטה מהכספת לאחר שליחה מוצלחת
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

// ==========================================
// הגדרת שרת Express
// ==========================================

// יצירת אפליקציית Express - השרת ה-HTTP שמאזין לבקשות
const app = express();

// הפעלת CORS - מאפשר לדפדפנים ולקוחות חיצוניים לפנות לשרת
app.use(cors());

// Map לשמירת ה-transport הפעיל לכל session (מזהה session -> transport)
const transports = new Map();

// ==========================================
// נקודת קצה: /sse (Server-Sent Events)
// ==========================================
// כל לקוח MCP פותח חיבור GET לנקודה זו.
// נוצר transport חדש ושרת MCP חדש לכל חיבור - הפרדה מלאה בין sessions.
app.get("/sse", async (req, res) => {
  // יצירת ערוץ SSE חדש - הלקוח יקבל אירועים בזרם רציף
  const transport = new SSEServerTransport("/messages", res);

  // שמירת ה-transport לפי ה-sessionId הייחודי שלו
  transports.set(transport.sessionId, transport);

  // יצירת מופע שרת MCP חדש עם כל הכלים עבור ה-session הזה
  const sessionServer = createGmailSessionServer();

  // ניקוי ה-transport כשהלקוח מנתק את החיבור
  req.on("close", () => transports.delete(transport.sessionId));

  try {
    // חיבור שרת ה-MCP לערוץ ה-SSE - מתחיל להאזין לפקודות
    await sessionServer.connect(transport);
  } catch (e) {}
});

// ==========================================
// נקודת קצה: /messages (POST)
// ==========================================
// הלקוח שולח בקשות (כמו קריאה לכלי) דרך POST לנקודה זו.
// ה-sessionId ב-query string מזהה לאיזה session מיועדת הבקשה.
app.post("/messages", async (req, res) => {
  // מציאת ה-transport הרלוונטי לפי sessionId
  const transport = transports.get(req.query.sessionId);

  // אם אין session פעיל עם המזהה הזה - שגיאה
  if (!transport) return res.status(503).send("No active connection");

  try {
    // העברת הבקשה ל-transport המתאים לעיבוד
    await transport.handlePostMessage(req, res);
  } catch (e) {}
});

// ==========================================
// נקודת קצה: /healthz (Health Check)
// ==========================================
// בדיקת תקינות פשוטה - מחזירה 200 OK אם השרת פעיל.
// משמש עבור מערכות ניטור, load balancer, ו-container orchestration.
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// ==========================================
// הפעלת השרת
// ==========================================

// הגדרת הפורט - ניתן לדריסה דרך משתנה סביבה PORT (שימושי ב-cloud)
const port = process.env.PORT || 3001;

// האזנה על כל הממשקים (0.0.0.0) - נגיש גם מחוץ ל-localhost
app.listen(port, "0.0.0.0", () => {
  console.log(`Gmail MCP Server running on port ${port}`);
});
