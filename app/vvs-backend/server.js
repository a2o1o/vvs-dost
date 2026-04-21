import "dotenv/config";
import cors from "cors";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";

const app = express();
const port = Number(process.env.PORT || 3000);
const appToken = process.env.APP_TOKEN || "";
const geminiApiKeys = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3
]
  .map((value) => String(value || "").trim())
  .filter(Boolean);
const sessionMemory = new Map();
const seenUsers = new Set();
const returningUsers = new Set();
const analytics = {
  totalRequests: 0,
  successes: 0,
  failures: 0,
  safetyResponses: 0,
  greetingResponses: 0,
  thanksResponses: 0,
  normalResponses: 0,
  memoryResets: 0,
  memoryEnabledRequests: 0,
  totalLatencyMs: 0,
  totalResponseChars: 0,
  averageResponseChars: 0,
  issueBuckets: {},
  recentErrors: [],
  recentActivity: []
};
const startedAt = Date.now();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(publicDir));

const SAFETY_RE =
  /(suicide|kill myself|hurt myself|self harm|self-harm|want to disappear|don't want to live|die|end my life|abuse|being hurt|unsafe at home|unsafe at school|hit me|hurting me|hurt someone|kill someone|violence|scared to go home|scared to stay alone)/i;
const GREETING_RE =
  /^(hi|hello|hey|heyy|hii|good morning|good afternoon|good evening|yo|hey you there|are you there|you there|hello\?|hi\?)\b[!. ?]*$/i;
const THANKS_RE = /^(thanks|thank you|thx|ty)\b[!. ]*$/i;

function isAuthorized(req) {
  if (!appToken) {
    return true;
  }
  return req.get("x-app-token") === appToken || String(req.query?.appToken || "").trim() === appToken;
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

function bumpCounter(map, key) {
  const cleanKey = String(key || "unknown").trim() || "unknown";
  map[cleanKey] = (map[cleanKey] || 0) + 1;
}

function rememberUser(userId) {
  if (!userId) {
    return;
  }
  if (seenUsers.has(userId)) {
    returningUsers.add(userId);
    return;
  }
  seenUsers.add(userId);
}

function detectIssueBucket(message) {
  const text = String(message || "").toLowerCase();
  if (!text) return "unknown";
  if (/(stress|overwhelm|pressure|too much|exam|study|studies|homework)/.test(text)) return "stress / overwhelm";
  if (/(friend|friendship|fight|argument|group|left out|ignored)/.test(text)) return "friendship / belonging";
  if (/(nervous|fear|afraid|scared|anxious|panic)/.test(text)) return "nervousness / fear";
  if (/(lonely|alone|no one|isolated)/.test(text)) return "loneliness";
  if (/(embarrass|shame|awkward|humiliat)/.test(text)) return "embarrassment / shame";
  if (/(angry|anger|frustrat|mad|annoyed)/.test(text)) return "anger / frustration";
  if (/(confused|dont know|don't know|not sure|can't name)/.test(text)) return "confused / cannot name it";
  if (/(friend is not okay|worried about my friend|worried about a friend|someone else)/.test(text)) return "worried about a friend";
  return "general support";
}

function pushRecent(list, item, limit = 8) {
  list.unshift(item);
  if (list.length > limit) {
    list.length = limit;
  }
}

function recordSuccess({ userId, message, responseText, mode, latencyMs, memoryMode }) {
  analytics.totalRequests += 1;
  analytics.successes += 1;
  analytics.totalLatencyMs += Number(latencyMs || 0);
  analytics.totalResponseChars += String(responseText || "").length;
  analytics.averageResponseChars = analytics.successes
    ? Math.round(analytics.totalResponseChars / analytics.successes)
    : 0;

  if (mode === "emergency") analytics.safetyResponses += 1;
  if (mode === "greeting") analytics.greetingResponses += 1;
  if (mode === "thanks") analytics.thanksResponses += 1;
  if (mode === "normal") analytics.normalResponses += 1;
  if (memoryMode !== "off") analytics.memoryEnabledRequests += 1;

  rememberUser(userId);
  bumpCounter(analytics.issueBuckets, detectIssueBucket(message));
  pushRecent(analytics.recentActivity, {
    at: new Date().toLocaleString("en-IN"),
    bucket: detectIssueBucket(message),
    mode,
    preview: String(message || "").slice(0, 80)
  });
}

function recordFailure({ userId, message, error, latencyMs, memoryMode }) {
  analytics.totalRequests += 1;
  analytics.failures += 1;
  analytics.totalLatencyMs += Number(latencyMs || 0);
  if (memoryMode !== "off") analytics.memoryEnabledRequests += 1;
  rememberUser(userId);
  bumpCounter(analytics.issueBuckets, detectIssueBucket(message));
  pushRecent(analytics.recentErrors, {
    at: new Date().toLocaleString("en-IN"),
    bucket: detectIssueBucket(message),
    error: String(error || "Unknown error"),
    latencyMs: Number(latencyMs || 0)
  });
}

function emergencyReply() {
  return [
    "This sounds serious, and you should not handle it alone.",
    "Please go to a trusted adult right now: a parent, teacher, school counsellor, or another adult nearby.",
    "Say it for me: I need help right now and I should not be alone with this."
  ].join("\n\n");
}

function greetingReply() {
  return "Hi. I'm VVS Dost. Tell me what happened, and I'll help you think through the next step.";
}

function thanksReply() {
  return "You're welcome. If you want, tell me what happened and I'll help you think it through.";
}

function buildSystemInstruction() {
  return `You are VVS Dost, a calm first-step support guide for school students.
Help the user identify what they may be feeling, take one small calming action, choose one safe next step, and express themselves clearly to a trusted human.
You are not a therapist, doctor, counsellor replacement, or authority.
Use warm, simple, non-judgmental language.
Never diagnose. Never promise secrecy. Never shame.
Keep responses short.
Write like a real helpful school support companion, not like a worksheet.

First classify the input quietly into one of these:
- casual greeting or light small talk
- normal support request
- serious safety concern

If the user mentions self-harm, suicide, abuse, danger, or wanting to hurt someone, switch into emergency support mode and tell them to contact a trusted adult now.

If the input is just a greeting, thanks, or simple small talk, do not force a support intervention. Reply naturally in 1 or 2 short lines and invite the user to share what happened if they want help.

Do not turn neutral inputs into distress. Do not overread ordinary messages as emotional crises.

For support situations, the "Say it for me" line must sound like a natural sentence a student could actually say out loud or text. Keep it short, plain, and specific. Avoid formal phrases like "I was wondering if we could talk sometime" unless the user is already speaking that way.

For normal support situations, use exactly these plain-text headers:
What this might be
Try this now
Next step
Say it for me`;
}

function cleanReply(text) {
  return String(text || "")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\r/g, "")
    .trim();
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
  if (!geminiApiKeys.length) {
    throw new Error("GEMINI_API_KEY is not configured on the server.");
  }

  const models = ["gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-flash-latest", "gemini-2.0-flash"];
  let lastError = "No usable reply returned.";

  for (const apiKey of geminiApiKeys) {
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
              "x-goog-api-key": apiKey
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
          return cleanReply(reply);
        }

        lastError = data?.error?.message || `Request failed (${response.status})`;
      } catch (error) {
        clearTimeout(timeout);
        lastError = error?.message || "Request failed.";
      }
    }
  }

  throw new Error(lastError);
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "vvs-dost-backend",
    geminiConfigured: Boolean(geminiApiKeys.length),
    geminiKeyCount: geminiApiKeys.length,
    tokenProtected: Boolean(appToken)
  });
});

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(publicDir, "dashboard.html"));
});

app.get("/api/dashboard-metrics", (_req, res) => {
  res.json({
    model: "gemini multi-key fallback",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    totals: {
      totalRequests: analytics.totalRequests,
      successes: analytics.successes,
      failures: analytics.failures,
      successRate: analytics.totalRequests
        ? Number(((analytics.successes / analytics.totalRequests) * 100).toFixed(1))
        : 0,
      totalUsers: seenUsers.size,
      repeatUsers: returningUsers.size,
      safetyResponses: analytics.safetyResponses,
      greetingResponses: analytics.greetingResponses,
      thanksResponses: analytics.thanksResponses,
      normalResponses: analytics.normalResponses,
      memoryResets: analytics.memoryResets,
      memoryEnabledRequests: analytics.memoryEnabledRequests,
      averageLatencyMs: analytics.totalRequests
        ? Math.round(analytics.totalLatencyMs / analytics.totalRequests)
        : 0,
      averageResponseChars: analytics.averageResponseChars,
      geminiKeyCount: geminiApiKeys.length
    },
    breakdowns: {
      issueBuckets: analytics.issueBuckets
    },
    recentErrors: analytics.recentErrors,
    recentActivity: analytics.recentActivity
  });
});

app.post("/api/chat", async (req, res) => {
  if (!isAuthorized(req)) {
    return res.status(401).json({ error: "Unauthorized app token." });
  }

  const message = String(req.body?.message || "").trim();
  const memory = normalizeMemory(req.body?.memory);
  const userId = String(req.body?.userId || "").trim();
  const started = Date.now();

  if (!message) {
    return res.status(400).json({ error: "message is required." });
  }

  if (SAFETY_RE.test(message)) {
    recordSuccess({ userId, message, responseText: emergencyReply(), mode: "emergency", latencyMs: Date.now() - started, memoryMode: "keep" });
    return res.json({
      reply: emergencyReply(),
      mode: "emergency"
    });
  }

  if (GREETING_RE.test(message)) {
    recordSuccess({ userId, message, responseText: greetingReply(), mode: "greeting", latencyMs: Date.now() - started, memoryMode: "keep" });
    return res.json({
      reply: greetingReply(),
      mode: "greeting"
    });
  }

  if (THANKS_RE.test(message)) {
    recordSuccess({ userId, message, responseText: thanksReply(), mode: "thanks", latencyMs: Date.now() - started, memoryMode: "keep" });
    return res.json({
      reply: thanksReply(),
      mode: "casual"
    });
  }

  try {
    const reply = await callGemini(message, memory);
    recordSuccess({ userId, message, responseText: reply, mode: "normal", latencyMs: Date.now() - started, memoryMode: "keep" });
    return res.json({
      reply,
      mode: "normal"
    });
  } catch (error) {
    recordFailure({ userId, message, error: error?.message, latencyMs: Date.now() - started, memoryMode: "keep" });
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
  const started = Date.now();

  if (resetMemory === "1") {
    clearSessionMemory(userId);
    analytics.memoryResets += 1;
  }

  if (!message) {
    if (resetMemory === "1") {
      return res.type("text/plain").send("Memory cleared.");
    }
    return res.status(400).type("text/plain").send("message is required.");
  }

  if (SAFETY_RE.test(message)) {
    recordSuccess({ userId, message, responseText: emergencyReply(), mode: "emergency", latencyMs: Date.now() - started, memoryMode });
    return res.type("text/plain").send(emergencyReply());
  }

  if (GREETING_RE.test(message)) {
    recordSuccess({ userId, message, responseText: greetingReply(), mode: "greeting", latencyMs: Date.now() - started, memoryMode });
    return res.type("text/plain").send(greetingReply());
  }

  if (THANKS_RE.test(message)) {
    recordSuccess({ userId, message, responseText: thanksReply(), mode: "thanks", latencyMs: Date.now() - started, memoryMode });
    return res.type("text/plain").send(thanksReply());
  }

  const useMemory = memoryMode !== "off";
  const memory = useMemory ? getSessionMemory(userId) : [];

  try {
    const reply = await callGemini(message, memory);
    storeSessionMemory(userId, message, useMemory);
    recordSuccess({ userId, message, responseText: reply, mode: "normal", latencyMs: Date.now() - started, memoryMode });
    return res.type("text/plain").send(reply);
  } catch (error) {
    recordFailure({ userId, message, error: error?.message, latencyMs: Date.now() - started, memoryMode });
    return res
      .status(502)
      .type("text/plain")
      .send(error?.message || "Could not get a reply from Gemini.");
  }
});

const host = "0.0.0.0";

app.listen(port, host, () => {
  console.log(`VVS Dost backend listening on http://${host}:${port}`);
});
