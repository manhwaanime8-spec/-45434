import express from "express";
import path from "path";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";
import dotenv from "dotenv";
import { getSafeGenAI, reportFailedKey, recordKeyUsage, generateContentWithRetry } from "./src/lib/gemini";
import { db } from "./src/lib/firebase";
import { doc, getDoc } from "firebase/firestore";
import { safeJsonParseArray } from "./src/lib/jsonRepair";

dotenv.config();

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '50mb' }));
  
  // Handle JSON parsing errors (e.g., Payload Too Large)
  app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'status' in err && err.status === 400 && 'body' in err) {
         return res.status(400).json({ error: "Invalid JSON format" });
    }
    if (err && err.type === 'entity.too.large') {
         return res.status(413).json({ error: "حجم الملف كبير جداً. الحد الأقصى هو 50 ميجابايت." });
    }
    next(err);
  });

  // API Routes
  app.get("/api/env-keys", (req, res) => {
    const envKeys = Object.entries(process.env)
        .filter(([k, v]) => k.includes('GEMINI') && v)
        .map(([k, v]) => v!);
        
    res.json({ 
        geminiApiKey: process.env.GEMINI_API_KEY || null,
        viteGeminiApiKey: process.env.VITE_GEMINI_API_KEY || null,
        allEnvKeys: [...new Set(envKeys)]
    });
  });

  app.post("/api/proxy-gemini", async (req, res) => {
    try {
      const { feature, request, maxRetries, initialDelayMs } = req.body;
      const response = await generateContentWithRetry(feature, request, maxRetries, initialDelayMs);
      res.json({ text: response.text });
    } catch (error: any) {
      console.error("Gemini Proxy Error:", error);
      const statusCode = error?.status && typeof error.status === 'number' ? error.status : 500;
      res.status(statusCode).json({ error: error.message, usedConfig: error.usedConfig });
    }
  });

  app.post("/api/extract-pdf-text", async (req, res) => {
    let usedConfig: any = null;
    try {
      const { ai, keyUsed, feature } = await getSafeGenAI('extract');
      usedConfig = { keyUsed, feature };
      const { fileBase64, mimeType } = req.body;
      
      const response = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents: [
            { role: "user", parts: [
                { inlineData: { data: fileBase64, mimeType: mimeType || "application/pdf" } },
                { text: "Extract and return the entire text content from this document as raw text. Do not summarize, just extract the text as accurately as possible." }
            ]}
        ]
      });
      if (usedConfig) await recordKeyUsage(usedConfig.feature, usedConfig.keyUsed);
      res.json({ text: response.text });
    } catch (e: any) {
      if (usedConfig) await reportFailedKey('extract', usedConfig.keyUsed);
      console.error("PDF Extraction error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/chat", async (req, res) => {
    let usedConfig: any = null;
    try {
      const { ai, keyUsed, feature } = await getSafeGenAI('chat');
      usedConfig = { keyUsed, feature };

      const { message, history, contextQuestions, bankId, fileData, mimeType } = req.body;
      
      let referenceBook = "";
      if (bankId) {
        try {
          const bankDoc = await getDoc(doc(db, "banks", bankId));
          if (bankDoc.exists()) {
             referenceBook = bankDoc.data().referenceBook || "";
          }
        } catch (e) {
          console.error("Failed to fetch bank's reference book:", e);
        }
      }

      let systemInstruction = `You are a concise, accurate AI medical tutor for Tamrediano. 
Speak strictly in friendly Egyptian Arabic mixed with simple terms, and occasionally add a playful phrase like "المركز الفني في البنك مش بيرد" if suitable. Your language must be VERY SIMPLE, clear, and easy to understand for nursing students. 
Avoid complex medical jargon where possible, and explain things using everyday analogies. Keep it EXTREMELY SHORT, DIRECT, and SUMMARIZED (ما قل ودل). DO NOT talk too much. Get straight to the point.
CRITICAL: Never invent facts, hallucinate numbers, or modify values from copied text. If you receive copied text, strictly use the numbers found in it. ONLY cite a book/page if it is explicitly provided. If you don't know, say you don't know.`;

      if (referenceBook) {
        systemInstruction += `\n\nCRITICAL CONTEXT / SUBJECT BOOK REFERENCE (Please answer the student's question strictly according to this subject matter and medical information):\n${referenceBook}\n`;
      }

      if (contextQuestions && contextQuestions.length > 0) {
        systemInstruction += `\nHere are the questions the student is asking about:\n`;
        contextQuestions.forEach((q: any, i: number) => {
          systemInstruction += `${q.index ? q.index : i + 1}. Q: ${q.questionText}\nChoices: ${q.choices ? q.choices.join(', ') : 'N/A'}\nCorrect Answer: ${q.correctAnswer}\nStudent's Selected Answer: ${q.studentSelectedAnswer || 'None'}\n`;
        });
      }

      const formattedHistory = [
        { role: "user", parts: [{ text: systemInstruction }] },
        { role: "model", parts: [{ text: "أهلاً بيك يا دكتور! أنا هنا عشان أساعدك وأشرحلك أي سؤال. اتفضل!" }] },
        ...(history || []).map((msg: any) => ({
          role: msg.role === "user" ? "user" : "model",
          parts: [{ text: msg.content }]
        }))
      ];
      
      const userParts: any[] = [{ text: message }];
      if (fileData && mimeType) {
          userParts.push({ inlineData: { data: fileData, mimeType } });
      }

      const response = await generateContentWithRetry('chat', {
        model: "gemini-2.5-flash",
        contents: [
            ...formattedHistory,
            { role: "user", parts: userParts }
        ],
      });

      if (usedConfig) await recordKeyUsage(usedConfig.feature, usedConfig.keyUsed);
      res.json({ message: response.text });
    } catch (error: any) {
      console.error("Gemini Error:", error);
      
      const is503 = error?.status === "UNAVAILABLE" || error?.status === 503 || error?.message?.includes("503");
      const is429 = error?.status === "RESOURCE_EXHAUSTED" || error?.status === 429 || error?.message?.includes("429");
      
      const is403 = error?.status === "PERMISSION_DENIED" || error?.status === 403 || error?.message?.includes("403") || error?.message?.includes("leaked");
      
      if (usedConfig && (is403 || is429 || !is503)) { // ONLY rotate on auth/quota/other errors, NOT 503
          await reportFailedKey(usedConfig.feature, usedConfig.keyUsed);
      }
      
      if (is503 || is429) {
         res.status(503).json({ error: "الخدمة تواجه ضغطاً عالياً حالياً (503). يرجى المحاولة بعد قليل." });
      } else if (is403) {
         res.status(403).json({ error: "خطأ: مفتاح الذكاء الاصطناعي (API Key) غير صالح أو قد تسرّب. يرجى التوجه لإعدادات بيئة العمل وتحديث المفتاح." });
      } else {
         res.status(500).json({ error: "Failed to generate AI response" });
      }
    }
  });

  app.post("/api/generate-questions", async (req, res) => {
    let usedConfig: any = null;
    try {
      const { ai, keyUsed, feature } = await getSafeGenAI('extract');
      usedConfig = { keyUsed, feature };

      const { text, count, type, fileData, mimeType } = req.body;
      const systemInstruction = `You are an expert medical exam creator. Extract exactly ${count} ${type} questions from the provided text or document.
The questions and choices MUST be in English.
The explanation MUST be in friendly Egyptian Arabic, mixed with some simple terms. Also occasionally add a playful joke like "شكل المركز الفني في البنك مش بيرد" to keep it light. The explanation MUST end with a citation of the exact source page/section from the uploaded document.
CRITICAL: DO NOT invent or hallucinate any numbers or facts. If text is copied, stick strictly to the exact numbers in the text. 
CRITICAL RULES for JSON:
1. Output MUST be a JSON array of objects without markdown blocks.
2. "correct" MUST be the exact integer index (0, 1, 2, or 3) indicating the true correct option in the "options" array. Double-check that this index accurately maps to the correct answer.
Structure:
[
  {
    "text": "The English question text",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correct": 0,
    "explanation": "شرح بالمصري مع مصطلحات بسيطة..، المصدر: صفحة X"
  }
]`;

      const userParts: any[] = [];
      if (fileData && mimeType) {
         userParts.push({ text: systemInstruction });
         userParts.push({ inlineData: { data: fileData, mimeType } });
         if (text) userParts.push({ text: "\nAdditional Context/Text:\n" + text });
      } else {
         userParts.push({ text: systemInstruction + "\n\nSource Text:\n" + text });
      }

      const response = await generateContentWithRetry('extract', {
        model: "gemini-2.5-flash",
        contents: [
            { role: "user", parts: userParts }
        ],
        config: {
            responseMimeType: "application/json",
            maxOutputTokens: 8192
        }
      });
      if (usedConfig) await recordKeyUsage(usedConfig.feature, usedConfig.keyUsed);
      
      let data;
      try {
        data = safeJsonParseArray(response.text);
        // Force the count to respect the AI output precisely if it over-generated
        if (Array.isArray(data) && data.length > parseInt(count)) {
            data = data.slice(0, parseInt(count));
        }
      } catch (e) {
        return res.status(500).json({ error: "فشل في تحليل الاستجابة بسبب كبر الحجم." });
      }
      res.json({ questions: data });
    } catch (error: any) {
      console.error("Gemini Error:", error);
      const is503 = error?.status === "UNAVAILABLE" || error?.status === 503 || error?.message?.includes("503");
      const is429 = error?.status === "RESOURCE_EXHAUSTED" || error?.status === 429 || error?.message?.includes("429");
      
      const is403 = error?.status === "PERMISSION_DENIED" || error?.status === 403 || error?.message?.includes("403") || error?.message?.includes("leaked");
      
      if (usedConfig && (is403 || is429 || !is503)) {
          await reportFailedKey(usedConfig.feature, usedConfig.keyUsed);
      }
      
      if (is503 || is429) {
         res.status(503).json({ error: "الخدمة تواجه ضغطاً عالياً حالياً (503). يرجى المحاولة بعد قليل." });
      } else if (is403) {
         res.status(403).json({ error: "خطأ: مفتاح الذكاء الاصطناعي (API Key) غير صالح أو قد تسرّب. يرجى التوجه لإعدادات بيئة العمل وتحديث المفتاح." });
      } else {
         res.status(500).json({ error: "Failed to generate questions." });
      }
    }
  });

  app.post("/api/study-guide", async (req, res) => {
    let usedConfig: any = null;
    try {
      const { ai, keyUsed, feature } = await getSafeGenAI('chat'); // uses chat key for study guide too
      usedConfig = { keyUsed, feature };

      const { incorrectQuestions } = req.body;
      
      const systemInstruction = `You are a concise Egyptian Arabic AI tutor.
The student got these questions wrong:
${incorrectQuestions.map((q: any, i: number) => `Q: ${q.text}\nCorrect: ${q.correctAnswer}\nExplanation: ${q.explanation}`).join('\n\n')}

Provide a VERY CONCISE, bulleted summary of WHAT concepts they need to study based ONLY on these explanations. 
CRITICAL: DO NOT invent page numbers, book names, or random numbers. ONLY mention books/pages if they are explicitly mentioned in the Explanation text above. Keep it brief and direct. NO fluff. NO tables.`;

      const response = await generateContentWithRetry('chat', {
        model: "gemini-2.5-flash",
        contents: [
            { role: "user", parts: [{ text: systemInstruction }] }
        ],
      });
      if (usedConfig) await recordKeyUsage(usedConfig.feature, usedConfig.keyUsed);

      res.json({ guide: response.text });
    } catch (error: any) {
      console.error("Gemini Error:", error);
      const is503 = error?.status === "UNAVAILABLE" || error?.status === 503 || error?.message?.includes("503");
      const is429 = error?.status === "RESOURCE_EXHAUSTED" || error?.status === 429 || error?.message?.includes("429");
      
      const is403 = error?.status === "PERMISSION_DENIED" || error?.status === 403 || error?.message?.includes("403") || error?.message?.includes("leaked");
      
      if (usedConfig && (is403 || is429 || !is503)) {
          await reportFailedKey(usedConfig.feature, usedConfig.keyUsed);
      }
      
      if (is503 || is429) {
         res.status(503).json({ error: "الخدمة تواجه ضغطاً عالياً حالياً (503). يرجى المحاولة بعد قليل." });
      } else if (is403) {
         res.status(403).json({ error: "خطأ: مفتاح الذكاء الاصطناعي (API Key) غير صالح أو قد تسرّب. يرجى التوجه لإعدادات بيئة العمل وتحديث المفتاح." });
      } else {
         res.status(500).json({ error: "Failed to generate study guide." });
      }
    }
  });

  app.post("/api/extract-names", async (req, res) => {
    let usedConfig: any = null;
    try {
      const { ai, keyUsed, feature } = await getSafeGenAI('extract');
      usedConfig = { keyUsed, feature };
      const { text, fileData, mimeType } = req.body;
      const systemInstruction = `You are a data extraction assistant. Extract ALL human names (specifically Arabic names if present) from the provided text block or file.
Clean up the names, removing any numbers, punctuation, or extra whitespace.
Return the output as a structured JSON array of strings. Do not return markdown, do not return \`\`\`json. Just the raw array. Structure:
["Name 1", "Name 2", "Name 3"]`;

      let parts: any[] = [];
      if (fileData && mimeType) {
         parts.push({ text: systemInstruction });
         parts.push({ inlineData: { data: fileData, mimeType } });
      } else {
         parts.push({ text: systemInstruction + "\n\nText:\n" + text });
      }

      const response = await generateContentWithRetry('extract', {
        model: "gemini-2.5-flash",
        contents: [
            { role: "user", parts }
        ],
        config: {
            responseMimeType: "application/json"
        }
      });
      if (usedConfig) await recordKeyUsage(usedConfig.feature, usedConfig.keyUsed);

      let data;
      try {
        data = safeJsonParseArray(response.text);
      } catch (e) {
        return res.status(500).json({ error: "فشل استخراج الأسماء." });
      }
      res.json({ names: data });
    } catch (error) {
      console.error("Gemini Error:", error);
      const is403 = error?.status === "PERMISSION_DENIED" || error?.status === 403 || error?.message?.includes("403") || error?.message?.includes("leaked");
      if (usedConfig && is403) { await reportFailedKey(usedConfig.feature, usedConfig.keyUsed); }
      if (is403) {
         res.status(403).json({ error: "خطأ: مفتاح الذكاء الاصطناعي (API Key) غير صالح أو قد تسرّب. يرجى التوجه لإعدادات بيئة العمل وتحديث المفتاح." });
      } else {
         res.status(500).json({ error: "Failed to extract names." });
      }
    }
  });

  // Vite development middleware
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    // Production static files
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
