import "dotenv/config";
import cors from "cors";
import express from "express";

const app = express();
const port = Number(process.env.PORT || 3000);
const appToken = process.env.APP_TOKEN || "";
const geminiApiKey = process.env.GEMINI_API_KEY || "";
const sessionMemory = new Map();

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const SAFETY_RE =
  /(suicide|kill myself|hurt myself|self harm|self-harm|want to disappear|don't want to live|die|end my life|abuse|being hurt|unsafe at home|unsafe at school|hit me|hurting me|hurt someone|kill someone|violence|scared to go home|scared to stay alone)/i;

function isAuthorized(req) {
  if (!appToken) {
    return true;
  }
  return req.get("x-app-token") === appToken;
}

function normalizeMemory(memory) {
  if (!Array.isArray(memory)) {
    return [];
  }
  return memory
    .map((item) => String(item || "").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(-6);
}

function getSessionMemory(userId) {
  if (!userId) {
    return [];
  }
  const existing = sessionMemory.get(userId);
  return Array.isArray(existing) ? existing : [];
}

function storeSessionMemory(userId, message, enabled) {
  if (!userId || !enabled) {
    return;
  }
  const current = getSessionMemory(userId);
  const clean = String(message || "").replace(/\s+/g, " ").trim();
  if (!clean) {
    return;
  }
  current.push(clean.length > 160 ? clean.slice(0, 160) + "..." : clean);
  sessionMemory.set(userId, current.slice(-6));
}

function clearSessionMemory(userId) {
  if (!userId) {
    return;
  }
  sessionMemory.delete(userId);
}

function emergencyReply() {
  return [
    "This sounds serious, and you should not handle it alone.",
    "Please go to a trusted adult right now: a parent, teacher, school counsellor, or another adult nearby.",
    "Say it for me: I need help right now and I should not be alone with this."
  ].join("\n\n");
}

function buildSystemInstruction() {
  return `You are VVS Dost, a calm first-step support guide for school students.
Help the user identify what they may be feeling, take one small calming action, choose one safe next step, and express themselves clearly to a trusted human.
You are not a therapist, doctor, counsellor replacement, or authority.
Use warm, simple, non-judgmental language.
Never diagnose. Never promise secrecy. Never shame.
Keep responses short.

If the user mentions self-harm, suicide, abuse, danger, or wanting to hurt someone, switch into emergency support mode and tell them to contact a trusted adult now.

For normal situations, use exactly these headers:
What this might be
Try this now
Next step
Say it for me`;
}

function buildRequestBody(message, memory) {
  const memoryContext = memory.length
    ? `Recent context from earlier visits on this device:\n- ${memory.join("\n- ")}`
    : "Recent context from earlier visits on this device: none.";

  return {
    systemInstruction: { parts: [{ text: buildSystemInstruction() }] },
    contents: [
      {
        role: "user",
        parts: [
          {
            text: `${memoryContext}\n\nCurrent student message: ${message}`
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 260
    }
  };
}

async function callGemini(message, memory) {
  if (!geminiApiKey) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }

  const models = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash"];
  let lastError = "No usable reply returned.";

  for (const model of models) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": geminiApiKey
          },
          body: JSON.stringify(buildRequestBody(message, memory)),
          signal: controller.signal
        }
      );
      const data = await response.json();
      clearTimeout(timeout);

      const reply = (
        data?.candidates?.[0]?.content?.parts?.map((part) => part.text || "").join("\n").trim() ||
        data?.candidates?.[0]?.output_text ||
        ""
      ).trim();

      if (response.ok && reply) {
        return reply;
      }

      lastError = data?.error?.message || `Request failed (${response.status})`;
    } catch (error) {
      clearTimeout(timeout);
      lastError = error?.message || "Request failed.";
    }
  }

  throw new Error(lastError);
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "vvs-dost-backend",
    geminiConfigured: Boolean(geminiApiKey),
    tokenProtected: Boolean(appToken)
  });
});

app.post("/api/chat", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized app token." });
  }

  const message = String(req.body?.message || "").trim();
  const memory = normalizeMemory(req.body?.memory);

  if (!message) {
    return res.status(400).json({ error: "message is required." });
  }

  if (SAFETY_RE.test(message)) {
    return res.json({
      reply: emergencyReply(),
      mode: "emergency"
    });
  }

  try {
    const reply = await callGemini(message, memory);
    return res.json({
      reply,
      mode: "normal"
    });
  } catch (error) {
    return res.status(502).json({
      error: error?.message || "Could not get a reply from Gemini."
    });
  }
});

app.get("/api/chat-text", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).type("text/plain").send("Unauthorized app token.");
  }

  const message = String(req.query?.message || "").trim();
  const userId = String(req.query?.userId || "").trim();
  const memoryMode = String(req.query?.memoryMode || "").trim().toLowerCase();
  const resetMemory = String(req.query?.resetMemory || "").trim();

  if (resetMemory === "1") {
    clearSessionMemory(userId);
  }

  if (!message) {
    return res.status(400).type("text/plain").send("message is required.");
  }

  if (SAFETY_RE.test(message)) {
    return res.type("text/plain").send(emergencyReply());
  }

  const useMemory = memoryMode !== "off";
  const memory = useMemory ? getSessionMemory(userId) : [];

  try {
    const reply = await callGemini(message, memory);
    storeSessionMemory(userId, message, useMemory);
    return res.type("text/plain").send(reply);
  } catch (error) {
    return res
      .status(502)
      .type("text/plain")
      .send(error?.message || "Could not get a reply from Gemini.");
  }
});

app.listen(port, () => {
  console.log(`VVS Dost backend listening on http://localhost:${port}`);
});
