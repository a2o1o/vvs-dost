import "dotenv/config";
import cors from "cors";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const backendDir = path.dirname(__filename);
const repoRoot = path.resolve(backendDir, "../..");
const publicDir = path.join(backendDir, "public");

const app = express();
const port = Number(process.env.PORT || 3000);
const allowedOrigin = process.env.ALLOWED_ORIGIN || "*";
const sharedAccessToken = process.env.APP_ACCESS_TOKEN || "";
const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const maxOutputTokens = Number(process.env.MAX_OUTPUT_TOKENS || 1100);
const geminiApiKeys = [
  ...String(process.env.GEMINI_API_KEYS || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean),
  ...(!process.env.GEMINI_API_KEYS && process.env.GEMINI_API_KEY
    ? [String(process.env.GEMINI_API_KEY).trim()]
    : [])
].filter(Boolean);
const geminiClients = geminiApiKeys.map((apiKey) => new GoogleGenAI({ apiKey }));
let geminiClientIndex = 0;
const extraInstructions = process.env.CUSTOM_GPT_INSTRUCTIONS || "";

const baseSystemPrompt = [
  "You are Sakhi, a warm reflection companion for girls and young women in the Maitri community.",
  "Sound like a thoughtful peer, not a lecturer, therapist, or authority figure.",
  "Be calm, human, non-judgmental, and clear.",
  "Match the user's language naturally. If the user writes in English, reply in English. If the user writes in Hinglish, reply in Hinglish. If the user writes in Hindi, reply in Hindi.",
  "Reflect first, then offer useful next steps only if they help.",
  "For greetings or very short messages, reply lightly in 1 or 2 sentences.",
  "For meaningful concerns, aim for 4 to 8 sentences unless the user clearly wants more.",
  "If the user is overwhelmed, keep it simple and offer one small next step.",
  "If the user is choosing between paths, give 2 or 3 ways to think about it without deciding for them.",
  "Use anonymized peer grounding only when genuinely relevant and keep it subtle.",
  "Never use names or identifying details.",
  "Never mention datasets, internal sources, files, or hidden context.",
  "Never diagnose, prescribe, or overpromise.",
  "Do not just restate the problem. Move the conversation forward."
].join(" ");

const systemPrompt = extraInstructions
  ? `${baseSystemPrompt}\n\nAdditional instructions:\n${extraInstructions}`
  : baseSystemPrompt;

const ignoredColumns = [
  "timestamp",
  "email address",
  "name",
  "phone number",
  "column 17",
  "column 31",
  "column 32",
  "column 33",
  "do you consent to participating in this?",
  "do you consent to participating in this form under the above conditions?"
];

const stageFileMap = {
  school:
    process.env.SCHOOL_RESPONSES_CSV ||
    path.join(repoRoot, "data", "Maitri-school-responses.csv"),
  college:
    process.env.COLLEGE_RESPONSES_CSV ||
    path.join(repoRoot, "data", "Maitri-college-responses.csv"),
  "early work":
    process.env.WORKING_WOMEN_RESPONSES_CSV ||
    path.join(repoRoot, "data", "Maitri-working-women-responses.csv"),
  work:
    process.env.WORKING_WOMEN_RESPONSES_CSV ||
    path.join(repoRoot, "data", "Maitri-working-women-responses.csv")
};
const topicFileMap = {
  scholarships:
    process.env.SCHOLARSHIP_RESPONSES_CSV ||
    path.join(
      "C:\\Users\\anjgu\\Maitri\\Sakhi",
      "Maitri's Scholars form - Give back to your juniors by sharing your journey (Responses) - Form Responses 1.csv"
    ),
  internships:
    process.env.INTERNSHIP_RESPONSES_CSV ||
    path.join(repoRoot, "data", "college-internships-community.csv")
};
const structuredTopicFileMap = {
  scholarships:
    process.env.SCHOOL_SCHOLARSHIPS_OPTIONS_CSV ||
    path.join(repoRoot, "data", "school-scholarships-options.csv")
};

function normalizeStage(stage) {
  return String(stage || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function normalizeHeader(value) {
  return String(value || "")
    .replace(/\uFFFD/g, "")
    .replace(/[^\w\s]/g, " ")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

function loadStructuredRows(filePath) {
  const resolved = resolveDataFile(filePath);
  if (!resolved || !fs.existsSync(resolved)) {
    return [];
  }

  try {
    const csvText = fs.readFileSync(resolved, "utf8");
    return parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
      bom: true
    }).map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([key, value]) => [normalizeHeader(key).replace(/\s+/g, "_"), String(value || "").trim()])
      )
    );
  } catch {
    return [];
  }
}

function classifyMessage(message) {
  const trimmed = String(message || "").trim();
  const lowered = trimmed.toLowerCase();
  const greetingOnly = /^(hi+|hey+|hello|helo|ello|elo|yo+|sup)\b[.!? ]*$/i.test(trimmed);
  const signoffOnly = /^(bye+|byee+|goodbye|gn|good night|see you|cya|ttyl|take care|thanks|thank you|ok|okay)\b[.!? ]*$/i.test(trimmed);
  const casualPatterns = [
    "how are you",
    "what's up",
    "whats up",
    "good morning",
    "good evening",
    "good afternoon"
  ];

  if (greetingOnly || signoffOnly || casualPatterns.some((pattern) => lowered.includes(pattern))) {
    return "casual";
  }

  return "reflective";
}

function detectLanguage(message) {
  const text = String(message || "").trim();
  const lowered = text.toLowerCase();
  const hasDevanagari = /[\u0900-\u097F]/.test(text);
  const hinglishMarkers = [
    "mujhe",
    "mera",
    "meri",
    "kyu",
    "kyun",
    "nahi",
    "nahin",
    "hai",
    "hoon",
    "karna",
    "karni",
    "karu",
    "karun",
    "kya",
    "kaise",
    "acha",
    "accha",
    "samajh",
    "bata",
    "batao",
    "lag",
    "raha",
    "rahi",
    "chahiye"
  ];
  const latinWords = lowered.match(/[a-z]+/g) || [];
  const hinglishHits = hinglishMarkers.filter((word) => lowered.includes(word)).length;

  if (hasDevanagari && latinWords.length > 0) return "hinglish";
  if (hasDevanagari) return "hindi";
  if (hinglishHits >= 2) return "hinglish";
  return "english";
}

function inferEffectiveTopic(stage, topic, message) {
  const normalizedTopic = normalizeStage(topic);
  if (normalizedTopic && normalizedTopic !== "open concern" && normalizedTopic !== "general") {
    return normalizedTopic;
  }

  const normalizedStage = normalizeStage(stage);
  const lowered = String(message || "").toLowerCase();

  if (normalizedStage === "school" && /(scholar|scholarship|fees?|financial support|finance|fund|vidyadhan|kotak|cadence|udayan|disha|karm)/i.test(lowered)) {
    return "scholarships";
  }

  if (normalizedStage === "college" && /(intern|internship|resume|cv|job|career opportunity|part time job|part-time job)/i.test(lowered)) {
    return "internships";
  }

  return normalizedTopic || "open concern";
}

function isInformationSeeking(message) {
  const lowered = String(message || "").toLowerCase();
  return /(what|which|who|where|how|can you|do you have|tell me|information|info|details|program|programs|list|share)/i.test(
    lowered
  );
}

function getLanguageInstruction(language) {
  if (language === "hindi") return "Reply fully in Hindi.";
  if (language === "hinglish") {
    return "Reply naturally in Hinglish, using the same kind of Hindi-English mix as the user.";
  }
  return "Reply fully in English.";
}

function isHighRiskMessage(message) {
  const text = String(message || "").toLowerCase();
  const patterns = [
    "suicide",
    "kill myself",
    "end my life",
    "want to die",
    "don't want to live",
    "self harm",
    "self-harm",
    "hurt myself",
    "harm myself",
    "cut myself",
    "marna chahti",
    "marna chahta",
    "jeena nahi",
    "jeena nahin",
    "khud ko nuksan",
    "khud ko maar",
    "i want to disappear"
  ];

  return patterns.some((pattern) => text.includes(pattern));
}

function getSafetyReply(language) {
  if (language === "hindi") {
    return "Mujhe lag raha hai ki aap abhi bahut zyada takleef mein ho. Agar aapko lag raha hai ki aap khud ko nuksan pahucha sakte ho, abhi kisi trusted insaan ko call kijiye ya unke paas jaiye. Agar immediate danger ho, apne local emergency number par abhi call kijiye. Aapko is waqt akela nahi rehna chahiye.";
  }

  if (language === "hinglish") {
    return "Mujhe lag raha hai ki tum abhi bahut zyada distress mein ho. Agar tumhe lag raha hai ki tum khud ko nuksan pahucha sakti ho, please abhi kisi trusted person ko call karo ya unke paas chale jao. Agar immediate danger hai, apne local emergency number par abhi call karo. Is waqt akeli mat raho.";
  }

  return "It sounds like you may be in immediate distress. If you might hurt yourself or are in immediate danger, call your local emergency number right now or go to a trusted person nearby immediately. Please do not stay alone with this right now.";
}

function getTemporaryFailureReply(language) {
  if (language === "hindi") {
    return "Sakhi abhi kaam nahi kar pa rahi hai. Kripya thodi der baad phir se try kijiye.";
  }

  if (language === "hinglish") {
    return "Sakhi abhi kaam nahi kar pa rahi hai. Please thodi der baad phir se try karo.";
  }

  return "Sakhi is not working right now. Please come back a little later and try again.";
}

function formatScholarshipRow(row) {
  const name = row.name || "Scholarship option";
  const marks = row.minimum_marks ? `${row.minimum_marks} marks` : "eligibility to be checked";
  const process = row.selection_process || "selection details to be checked";
  const subStage = row.sub_stage === "post_class_10" ? "post-10" : row.sub_stage === "post_12" ? "post-12" : "";
  const incomeCriteria = row.income_criteria || "";
  const incomeCertificateTiming = row.income_certificate_timing || "";
  const extraRequirement = row.extra_requirement || "";
  const whoItIsFor = row.who_it_is_for || "";
  const communitySupportNote = row.community_support_note || "";
  const practicalNote = row.practical_note || "";
  return {
    name,
    marks,
    process,
    subStage,
    incomeCriteria,
    incomeCertificateTiming,
    extraRequirement,
    whoItIsFor,
    communitySupportNote,
    practicalNote
  };
}

function isAffirmativeReply(message) {
  return /^(yes|yeah|yep|yup|haan|han|ha|ji|sure|okay|ok)\b/i.test(String(message || "").trim());
}

function getScholarshipLearningReply(language) {
  if (language === "hinglish") {
    return [
      "Aapki kuch seniors ne scholarship process se guzarte hue yeh learnings share ki hain:",
      "- Jaldi start karna helpful hota hai, kyunki documents, deadlines, aur interview prep last minute mein stressful ho jata hai.",
      "- Ek trusted teacher ya mentor se form aur eligibility check karwana kaafi useful raha.",
      "- Interviews mein marks ke saath yeh bhi matter karta hai ki tum apni padhai aur goals ko kitni clearly samjha paati ho.",
      "- Ek option miss ho jaaye to bhi rukna nahi chahiye, kyunki usually ek se zyada scholarships apply karne layak hoti hain."
    ].join("\n");
  }

  if (language === "hindi") {
    return [
      "Aapki kuch seniors ne scholarship process se guzarte hue yeh learnings share ki hain:",
      "- Jaldi shuru karna helpful hota hai, kyunki documents, deadlines aur interview preparation last minute mein stressful ho jati hai.",
      "- Kisi trusted teacher ya mentor se form aur eligibility ko ek baar check karwana kaafi upyogi raha.",
      "- Interviews mein marks ke saath yeh bhi maayne rakhta hai ki aap apni padhai aur goals ko kitni clarity se samjha paati hain.",
      "- Agar ek option miss ho jaaye to bhi rukna nahi chahiye, kyunki aam taur par ek se adhik scholarships apply karne layak hoti hain."
    ].join("\n");
  }

  return [
    "Some of your seniors who went through the scholarship process have shared a few things that helped them:",
    "- Starting early made a real difference, because documents, deadlines, and interview prep became much easier to manage.",
    "- Getting one teacher or mentor to review forms and eligibility details helped them avoid small mistakes.",
    "- In interviews, clarity about their studies, interests, and future goals mattered as much as marks.",
    "- Even if one application did not work out, applying to more than one option gave them a better chance."
  ].join("\n");
}

function getScholarshipChecklistReply(language) {
  if (language === "hinglish") {
    return [
      "Yes. Aapki seniors usually yeh simple documents ready rakhti thi:",
      "- Aadhaar card ya koi basic identity proof",
      "- Recent passport-size photos",
      "- Class 10 marksheet ya jo latest marksheet form mein maangi gayi ho",
      "- Income certificate",
      "- Address proof, agar required ho",
      "- Student ya parent bank details, agar scholarship form mein poochha gaya ho",
      "- School ID ya bonafide letter, agar maanga gaya ho",
      "Ek practical cheez jo seniors ko useful lagi: saare documents ki clear phone photos aur scanned copies ek hi folder mein rakhna. Agar tum chaho, main income certificate banwane ka usual process bhi bata sakti hoon."
    ].join("\n");
  }

  if (language === "hindi") {
    return [
      "Haan. Aapki seniors aam taur par yeh simple documents ready rakhti thi:",
      "- Aadhaar card ya koi basic identity proof",
      "- Recent passport-size photos",
      "- Class 10 marksheet ya jo latest marksheet form mein maangi gayi ho",
      "- Income certificate",
      "- Address proof, agar required ho",
      "- Student ya parent bank details, agar scholarship form mein poochha gaya ho",
      "- School ID ya bonafide letter, agar maanga gaya ho",
      "Ek practical baat jo seniors ko useful lagi: saare documents ki clear phone photos aur scanned copies ek hi folder mein rakhna. Agar aap chahen, main income certificate banwane ka usual process bhi bata sakti hoon."
    ].join("\n");
  }

  return [
    "Yes. A simple checklist your seniors usually kept ready was:",
    "- Aadhaar card or another identity proof",
    "- Recent passport-size photos",
    "- Class 10 marksheet or the latest marksheet asked for in the form",
    "- Income certificate",
    "- Address proof, if required",
    "- Student or parent bank details, if the scholarship asks for them",
    "- School ID or bonafide letter, if requested",
    "One practical thing seniors found useful was keeping clear phone photos and scanned copies of everything in one folder. If you want, I can also tell you the usual process for getting an income certificate made."
  ].join("\n");
}

function getScholarshipIncomeCertificateProcessReply(language) {
  if (language === "hinglish") {
    return [
      "Yes. Aapki seniors ke hisaab se usual process kuch is tarah hota hai:",
      "- Pehle school, local tehsil office, ya revenue office se check karo ki tumhare area mein income certificate kis route se banta hai",
      "- Basic documents ready rakho: identity proof, address proof, ration card agar available ho, aur parents ya guardians ki income details",
      "- Form online state portal par ya offline local office mein fill karo",
      "- Supporting documents submit karo",
      "- Acknowledgement ya application number safely save karke rakho",
      "- Follow-up karte raho, kyunki district ke hisaab se timeline vary kar sakti hai",
      "Kaafi seniors ko yeh helpful laga ki final submit karne se pehle ek teacher, mentor, ya ghar ke kisi bade se form ek baar check kara liya jaye."
    ].join("\n");
  }

  if (language === "hindi") {
    return [
      "Haan. Aapki seniors ke anubhav ke hisaab se usual process kuch is tarah hota hai:",
      "- Pehle school, local tehsil office, ya revenue office se check kijiye ki aapke area mein income certificate kis route se banta hai",
      "- Basic documents ready rakhiye: identity proof, address proof, ration card agar available ho, aur parents ya guardians ki income details",
      "- Form online state portal par ya offline local office mein bhariye",
      "- Supporting documents submit kijiye",
      "- Acknowledgement ya application number safely save karke rakhiye",
      "- Follow-up karte rahiye, kyunki district ke hisaab se timeline alag ho sakti hai",
      "Kaafi seniors ko yeh helpful laga ki final submit karne se pehle ek teacher, mentor, ya ghar ke kisi bade se form ek baar check kara liya jaye."
    ].join("\n");
  }

  return [
    "Yes. The usual process seniors described was:",
    "- First check with your school, local tehsil office, or revenue office which route is used in your area for an income certificate",
    "- Keep the basic documents ready: identity proof, address proof, ration card if available, and parent or guardian income details",
    "- Fill the form either through the state portal or at the local office",
    "- Submit the supporting documents",
    "- Keep the acknowledgement or application number safely saved",
    "- Follow up until it is issued, because timelines can vary by district",
    "Many seniors found it helpful to ask one teacher, mentor, or family elder to review the form once before final submission."
  ].join("\n");
}

function getScholarshipIncomeReply(rows, language) {
  const eligible = rows.filter((row) => row.incomeCriteria || row.incomeCertificateTiming);
  if (!eligible.length) {
    return "";
  }

  const lines = eligible.map((item) => {
    const detailParts = [];
    if (item.incomeCriteria) detailParts.push(item.incomeCriteria);
    if (item.incomeCertificateTiming) detailParts.push(item.incomeCertificateTiming);
    if (item.extraRequirement) detailParts.push(item.extraRequirement);
    return `- ${item.name}: ${detailParts.join(". ")}.`;
  });

  const eyDisha = eligible.find((item) => /ey disha/i.test(item.name));
  const communityLine = eyDisha?.communitySupportNote || "";

  if (language === "hinglish") {
    const parts = [
      "Aapki seniors ke experience se income certificate ke around yeh cheezein sabse useful lagti hain:",
      ...lines,
      "In teenon mein Vidyadhan mein income certificate sabse jaldi, yani application stage par hi chahiye hota hai.",
      "Income certificate aam taur par local tehsil, revenue office, ya state government ke online service portal se milta hai."
    ];
    if (communityLine) parts.push(communityLine);
    parts.push("Agar tum chaho, main next step mein simple document checklist bhi de sakti hoon.");
    return parts.join("\n");
  }

  if (language === "hindi") {
    const parts = [
      "Aapki seniors ke anubhav se income certificate ke around yeh baatein sabse upyogi lagti hain:",
      ...lines,
      "In teenon mein Vidyadhan mein income certificate sabse jaldi, yani application stage par hi chahiye hota hai.",
      "Income certificate aam taur par local tehsil, revenue office, ya state government ke online service portal se milta hai."
    ];
    if (communityLine) parts.push(communityLine);
    parts.push("Agar aap chahen, main agle step mein simple document checklist bhi de sakti hoon.");
    return parts.join("\n");
  }

  const parts = [
    "From what seniors in the community have found useful, these are the key income-certificate differences across the options currently in Sakhi's scholarship set:",
    ...lines,
    "Of these, Vidyadhan places the earliest importance on the income certificate because it is needed during the application process itself.",
    "You can usually get an income certificate through your local tehsil or revenue office, or through your state government's online service portal."
  ];
  if (communityLine) parts.push(communityLine);
  parts.push("If you want, I can next give you a simple document checklist for getting it ready.");
  return parts.join("\n");
}

function getPost12ScholarshipOptionsReply(rows, language) {
  const selected = rows.filter((row) => row.subStage === "post-12").slice(0, 3);
  if (!selected.length) {
    return "";
  }

  if (language === "hinglish") {
    const lines = selected.map((item) => {
      const details = [];
      if (item.whoItIsFor) details.push(item.whoItIsFor);
      if (item.marks) details.push(`usually ${item.marks}`);
      if (item.practicalNote) details.push(item.practicalNote);
      return `- ${item.name}: ${details.join("; ")}.`;
    });
    return [
      "Post-12 financial support ke liye aapki seniors ne in jaise options explore kiye hain:",
      ...lines,
      "In options ko dekhte hue ek helpful strategy yeh hoti hai ki documents, personal story, aur course direction ko saath mein prepare kiya jaye.",
      "Agar tum chaho, main next step mein in teenon ko compare karke bata sakti hoon ki kis mein marks, docs, aur personal story ka weight zyada hai."
    ].join("\n");
  }

  if (language === "hindi") {
    const lines = selected.map((item) => {
      const details = [];
      if (item.whoItIsFor) details.push(item.whoItIsFor);
      if (item.marks) details.push(`usually ${item.marks}`);
      if (item.practicalNote) details.push(item.practicalNote);
      return `- ${item.name}: ${details.join("; ")}.`;
    });
    return [
      "Post-12 financial support ke liye aapki seniors ne in jaise options explore kiye hain:",
      ...lines,
      "In options ko dekhte hue ek upyogi strategy yeh hoti hai ki documents, personal story aur course direction ko saath mein prepare kiya jaye.",
      "Agar aap chahen, main next step mein in teenon ko compare karke bata sakti hoon ki kis mein marks, docs aur personal story ka weight zyada hai."
    ].join("\n");
  }

  const lines = selected.map((item) => {
    const details = [];
    if (item.whoItIsFor) details.push(item.whoItIsFor);
    if (item.marks) details.push(`usually ${item.marks}`);
    if (item.practicalNote) details.push(item.practicalNote);
    return `- ${item.name}: ${details.join("; ")}.`;
  });

  return [
    "Some of your seniors explored post-12 support options like:",
    ...lines,
    "Across these, one useful pattern is to prepare your documents, personal story, and course direction together rather than treating each scholarship separately.",
    "If you want, I can next compare these three in terms of where marks, documentation, and personal story matter most."
  ].join("\n");
}

function getPost12ScholarshipComparisonReply(rows, language) {
  const selected = rows.filter((row) => row.subStage === "post-12").slice(0, 3);
  if (!selected.length) {
    return "";
  }

  const byName = Object.fromEntries(selected.map((item) => [item.name.toLowerCase(), item]));
  const cadence = byName["cadence"];
  const kotak = byName["kotak kanya"];
  const karm = byName["karm"];

  if (language === "hinglish") {
    const lines = [];
    if (cadence) {
      lines.push(`- Cadence: yahan marks aur STEM direction dono matter karte hain. Seniors ko laga ki strong interview prep aur clear \"why STEM\" answer bahut important hota hai.`);
    }
    if (kotak) {
      lines.push(`- Kotak Kanya: yahan documents aur eligibility precision sabse zyada matter karti hai. College eligibility aur paperwork mein chhoti galti bhi rejection la sakti hai.`);
    }
    if (karm) {
      lines.push(`- Karm: yahan personal story aur growth potential ka weight zyada hota hai. Seniors ko laga ki generic answers yahan kaam nahi karte.`);
    }
    return [
      "Haan. Aapki seniors ke experience se agar compare karein, to roughly picture kuch aisi dikhti hai:",
      ...lines,
      "Agar tum documents aur college eligibility ko lekar strong ho, to Kotak Kanya practical route lag sakta hai. Agar tumhari story aur drive strong hai, to Karm interesting ho sakta hai. Agar tum STEM direction mein clear ho, to Cadence worth exploring hai.",
      "Agar tum chaho, main next step mein in teenon ke liye ek simple apply-order strategy bhi bata sakti hoon."
    ].join("\n");
  }

  if (language === "hindi") {
    const lines = [];
    if (cadence) {
      lines.push(`- Cadence: yahan marks aur STEM direction dono maayne rakhte hain. Seniors ko laga ki strong interview preparation aur clear \"why STEM\" answer bahut important hota hai.`);
    }
    if (kotak) {
      lines.push(`- Kotak Kanya: yahan documents aur eligibility precision sabse zyada maayne rakhti hai. College eligibility aur paperwork mein chhoti galti bhi rejection la sakti hai.`);
    }
    if (karm) {
      lines.push(`- Karm: yahan personal story aur growth potential ka weight zyada hota hai. Seniors ko laga ki generic answers yahan kaam nahi karte.`);
    }
    return [
      "Haan. Aapki seniors ke anubhav se agar compare karein, to roughly picture kuch aisi dikhti hai:",
      ...lines,
      "Agar aap documents aur college eligibility ko lekar strong hain, to Kotak Kanya ek practical route lag sakta hai. Agar aapki story aur drive strong hai, to Karm interesting ho sakta hai. Agar aap STEM direction mein clear hain, to Cadence worth exploring hai.",
      "Agar aap chahen, main next step mein in teenon ke liye ek simple apply-order strategy bhi bata sakti hoon."
    ].join("\n");
  }

  const lines = [];
  if (cadence) {
    lines.push("- Cadence: marks and STEM direction both matter here. Seniors found that interview prep and a clear answer to why STEM made a real difference.");
  }
  if (kotak) {
    lines.push("- Kotak Kanya: documentation and eligibility precision matter the most here. Small paperwork mistakes or college-eligibility issues can block an otherwise strong application.");
  }
  if (karm) {
    lines.push("- Karm: personal story and growth potential carry more weight here. Seniors found that generic answers did not help much.");
  }

  return [
    "Yes. From what seniors in the community have found, the rough comparison looks like this:",
    ...lines,
    "So if you feel strongest on documents and college eligibility, Kotak Kanya may be the most practical route. If your story and drive are your biggest strengths, Karm may suit you better. If you are clear about a STEM direction, Cadence is worth exploring seriously.",
    "If you want, I can next suggest a simple apply-order strategy across these three."
  ].join("\n");
}

function getInternshipCommunityRows() {
  return (topicResponses.internships || []).map((row) => ({
    organization: String(row.organization || "").trim(),
    roleSummary: String(row.role_summary || "").trim(),
    viaMaitriSupport: String(row.via_maitri_support || "").trim(),
    mode: String(row.mode || "").trim(),
    location: String(row.location || "").trim(),
    compensation: String(row.compensation || "").trim(),
    gains: String(row.gains || "").trim(),
    duringGraduation: String(row.during_graduation || "").trim(),
    learnings: String(row.learnings || "").trim(),
    canRecommendJuniors: String(row.can_recommend_juniors || "").trim()
  }));
}

function getInternshipStartReply(language) {
  const rows = getInternshipCommunityRows();
  const paidDuringCollege = rows.some(
    (row) => /paid/i.test(row.compensation) && /yes/i.test(row.duringGraduation)
  );
  const onlinePossible = rows.some((row) => /online/i.test(row.mode));
  const maitriSupported = rows.some((row) => /yes/i.test(row.viaMaitriSupport));

  if (language === "hinglish") {
    const lines = [
      "Aapki kuch seniors ne internships graduation ke saath hi explore ki thi, aur young women in the community ne bhi yeh cheezein useful payi hain:",
      "- Sabse pehle ek realistic starting bucket chuno, jaise research, data / operations, analytics support, content, ya outreach jahan tum quickly contribute kar sako.",
      onlinePossible
        ? "- Online internships bhi possible hoti hain, isliye college ke saath start karna practical ho sakta hai."
        : "- College ke saath manageable roles dhoondhna important hota hai, taaki load realistic rahe.",
      paidDuringCollege
        ? "- Community sharing se yeh bhi dikha ki paid internships confidence aur financial support dono de sakti hain, isliye unpaid role ko default mat maano."
        : "- Experience ke saath compensation aur learning dono dekhna useful hota hai.",
      maitriSupported
        ? "- Maitri network, seniors, teachers, aur mentors se puchhna worth it hota hai, kyunki referrals aur introductions difference la sakte hain."
        : "- Seniors, teachers, aur mentors se puchhna worth it hota hai, kyunki referrals aur introductions difference la sakte hain."
    ];
    lines.push("Agar tum chaho, main next step mein yeh bhi share kar sakti hoon ki seniors ne college ke saath internship balance karte waqt kya learnings share ki.");
    return lines.join("\n");
  }

  if (language === "hindi") {
    const lines = [
      "Aapki kuch seniors ne graduation ke saath internships explore ki thi, aur community mein aage badh chuki young women ne bhi yeh baatein useful payi hain:",
      "- Sabse pehle ek realistic starting bucket chuniye, jaise research, data / operations, analytics support, content, ya outreach jahan aap jaldi contribute kar sakein.",
      onlinePossible
        ? "- Online internships bhi possible hoti hain, isliye college ke saath shuru karna practical ho sakta hai."
        : "- College ke saath manageable roles dhoondhna important hota hai, taaki load realistic rahe.",
      paidDuringCollege
        ? "- Community sharing se yeh bhi dikha ki paid internships confidence aur financial support dono de sakti hain, isliye unpaid role ko default mat maaniye."
        : "- Experience ke saath compensation aur learning dono dekhna useful hota hai.",
      maitriSupported
        ? "- Maitri network, seniors, teachers, aur mentors se poochhna worth it hota hai, kyunki referrals aur introductions difference la sakte hain."
        : "- Seniors, teachers, aur mentors se poochhna worth it hota hai, kyunki referrals aur introductions difference la sakte hain."
    ];
    lines.push("Agar aap chahen, main next step mein yeh bhi share kar sakti hoon ki seniors ne college ke saath internship balance karte waqt kya learnings share ki.");
    return lines.join("\n");
  }

  const lines = [
    "Some of your seniors explored internships alongside college, and young women in the community who are now working have found a few starting routes helpful:",
    "- Start with a realistic bucket such as research, data or operations support, analytics support, content, or outreach where you can contribute quickly.",
    onlinePossible
      ? "- Online internships are possible too, so starting alongside college can be more manageable than it first seems."
      : "- It helps to look for roles that are manageable alongside college rather than trying to do everything at once.",
    paidDuringCollege
      ? "- Community sharings also show that paid internships can bring both confidence and financial support, so do not assume unpaid work is the only way to start."
      : "- It helps to weigh learning and compensation together instead of chasing any internship label.",
    maitriSupported
      ? "- Asking through the Maitri network, seniors, teachers, and mentors can genuinely help, because introductions and referrals often make the first step easier."
      : "- Asking seniors, teachers, and mentors can genuinely help, because introductions and referrals often make the first step easier."
  ];
  lines.push("If you want, I can next share what seniors found most useful while balancing internships with college.");
  return lines.join("\n");
}

function getInternshipLearningsReply(language) {
  if (language === "hinglish") {
    return [
      "Haan. Internship form sharings aur community experiences se kuch clear learnings saamne aayi hain:",
      "- Agar possible ho, paid opportunity ko seriously consider karo, kyunki seniors ne feel kiya ki isse professionalism aur self-worth dono strong hote hain.",
      "- Boundaries important hoti hain. Seniors ne kaha ki authority ko respect karo, but apni limits bhi samjho.",
      "- Questions poochhna weakness nahi hoti. Team se clarify karna aur collaborate karna kaafi helpful raha.",
      "- Detail aur accuracy kaafi matter karti hai, especially data ya research type roles mein.",
      "- College ke saath internship karna possible hai, lekin realistic workload choose karna important hota hai."
    ].join("\n");
  }

  if (language === "hindi") {
    return [
      "Haan. Internship form sharings aur community experiences se kuch clear learnings saamne aayi hain:",
      "- Agar possible ho, paid opportunity ko seriously consider kijiye, kyunki seniors ne mehsoos kiya ki isse professionalism aur self-worth dono strong hote hain.",
      "- Boundaries important hoti hain. Seniors ne kaha ki authority ko respect kijiye, lekin apni limits bhi samajhiye.",
      "- Questions poochhna weakness nahi hoti. Team se clarify karna aur collaborate karna kaafi helpful raha.",
      "- Detail aur accuracy kaafi maayne rakhti hai, especially data ya research type roles mein.",
      "- College ke saath internship karna possible hai, lekin realistic workload choose karna important hota hai."
    ].join("\n");
  }

  return [
    "Yes. A few clear learnings keep coming up from the internship sharings and from young women in the community:",
    "- If possible, take paid opportunities seriously, because seniors found that payment affected both professionalism and self-worth.",
    "- Boundaries matter. Seniors said it helps to respect authority without losing sight of your own limits.",
    "- Asking questions is not a weakness. Clarifying tasks and collaborating with the team helped a lot.",
    "- Accuracy and detail matter, especially in research and data-oriented roles.",
    "- Doing an internship alongside college is possible, but choosing a realistic workload makes a big difference."
  ].join("\n");
}

function getInternshipTypesReply(language) {
  if (language === "hinglish") {
    return [
      "Haan. Community sharings ko dekh kar, college ke saath realistically in jaise internships se start kiya ja sakta hai:",
      "- Research ya media support roles, jahan fact-checking, content research, ya background work hota hai.",
      "- Data entry, operations, ya backend support roles, jahan process discipline aur consistency matter karti hai.",
      "- Data ya analytics support roles, jahan Excel, accuracy, aur detail useful hote hain.",
      "- Small team ya startup-style roles, jahan ek intern ko multiple basic responsibilities mil sakti hain.",
      "Agar tum bilkul shuruat par ho, to operations, research support, data support, ya outreach-type roles usually sabse realistic entry point hote hain.",
      "Agar tum chaho, main next step mein simple apply process bhi bata sakti hoon."
    ].join("\n");
  }

  if (language === "hindi") {
    return [
      "Haan. Community sharings ko dekhkar, college ke saath realistically in jaise internships se shuru kiya ja sakta hai:",
      "- Research ya media support roles, jahan fact-checking, content research, ya background work hota hai.",
      "- Data entry, operations, ya backend support roles, jahan process discipline aur consistency maayne rakhti hai.",
      "- Data ya analytics support roles, jahan Excel, accuracy, aur detail useful hote hain.",
      "- Small team ya startup-style roles, jahan ek intern ko multiple basic responsibilities mil sakti hain.",
      "Agar aap bilkul shuruaat par hain, to operations, research support, data support, ya outreach-type roles aam taur par sabse realistic entry point hote hain.",
      "Agar aap chahen, main agle step mein simple apply process bhi bata sakti hoon."
    ].join("\n");
  }

  return [
    "Yes. From the community sharings, these are some realistic internship types students can often start with alongside college:",
    "- Research or media support roles, where the work may include fact-checking, content research, or background support.",
    "- Data entry, operations, or backend support roles, where consistency and process discipline matter.",
    "- Data or analytics support roles, where Excel, accuracy, and attention to detail help.",
    "- Small-team or startup-style roles, where one intern may handle a few basic responsibilities together.",
    "If you are just starting out, operations, research support, data support, or outreach-style roles are usually the most realistic entry points.",
    "If you want, I can next share a simple apply process."
  ].join("\n");
}

function getInternshipApplyReply(language) {
  if (language === "hinglish") {
    return [
      "Haan. Ek simple apply process kuch aisa ho sakta hai:",
      "- Pehle 1-page simple resume ready karo, jisme college, skills, projects, aur koi volunteering ya responsibility ho.",
      "- 2-3 internship buckets choose karo, jaise research, data support, content, ya operations.",
      "- LinkedIn, Internshala, company pages, aur seniors ya mentors ke network se openings dhoondo.",
      "- Har application ke saath ek chhota tailored message bhejo ki tum kyu interested ho aur kya contribute kar sakti ho.",
      "- Agar reply na aaye to 1 week baad polite follow-up karo.",
      "Seniors ko yeh useful laga ki random 50 applications bhejne se better hota hai 10 thoughtful applications bhejna.",
      "Agar tum chaho, main next step mein ek simple internship intro message draft bhi de sakti hoon."
    ].join("\n");
  }

  if (language === "hindi") {
    return [
      "Haan. Ek simple apply process kuch is tarah ho sakta hai:",
      "- Pehle 1-page simple resume ready kijiye, jisme college, skills, projects, aur koi volunteering ya responsibility ho.",
      "- 2-3 internship buckets choose kijiye, jaise research, data support, content, ya operations.",
      "- LinkedIn, Internshala, company pages, aur seniors ya mentors ke network se openings dhoondhiye.",
      "- Har application ke saath ek chhota tailored message bhejiye ki aap kyon interested hain aur kya contribute kar sakti hain.",
      "- Agar reply na aaye to 1 week baad polite follow-up kijiye.",
      "Seniors ko yeh useful laga ki random 50 applications bhejne se better hota hai 10 thoughtful applications bhejna.",
      "Agar aap chahen, main agle step mein ek simple internship intro message draft bhi de sakti hoon."
    ].join("\n");
  }

  return [
    "Yes. A simple apply process can look like this:",
    "- First, make a one-page resume with your college details, skills, projects, and any volunteering or responsibilities.",
    "- Choose 2 or 3 internship buckets such as research, data support, content, or operations.",
    "- Search through LinkedIn, Internshala, company pages, and seniors or mentors in your network.",
    "- Send a short tailored message with each application about why you are interested and what you can contribute.",
    "- If there is no response, do one polite follow-up after about a week.",
    "One thing seniors found useful was sending 10 thoughtful applications instead of 50 random ones.",
    "If you want, I can next draft a simple internship intro message."
  ].join("\n");
}

function getLocalKnowledgeReply({ stage, topic, message, language, history = [] }) {
  const effectiveTopic = inferEffectiveTopic(stage, topic, message);

  if (
    effectiveTopic === "internships" &&
    normalizeStage(stage) === "college" &&
    isAffirmativeReply(message) &&
    history.some(
      (item) =>
        item?.role === "sakhi" &&
        /what seniors found most useful while balancing internships with college|college ke saath internship balance karte waqt kya learnings/i.test(
          String(item?.text || "")
        )
    )
  ) {
    return getInternshipLearningsReply(language);
  }

  if (
    effectiveTopic === "internships" &&
    normalizeStage(stage) === "college" &&
    isAffirmativeReply(message) &&
    history.some(
      (item) =>
        item?.role === "sakhi" &&
        /simple apply process|simple internship intro message|apply process/i.test(String(item?.text || ""))
    )
  ) {
    return getInternshipApplyReply(language);
  }

  if (
    effectiveTopic === "scholarships" &&
    normalizeStage(stage) === "school" &&
    isAffirmativeReply(message) &&
    history.some(
      (item) =>
        item?.role === "sakhi" &&
        /Would you also like to know what learnings and experiences your seniors shared|Kya tum yeh bhi jaana chahogi|Kya aap yeh bhi jaana chahengi/i.test(
          String(item?.text || "")
        )
    )
  ) {
    return getScholarshipLearningReply(language);
  }

  if (
    effectiveTopic === "scholarships" &&
    normalizeStage(stage) === "school" &&
    isAffirmativeReply(message) &&
    history.some(
      (item) =>
        item?.role === "sakhi" &&
        /simple document checklist|simple documents ready|simple documents/i.test(String(item?.text || ""))
    )
  ) {
    return getScholarshipChecklistReply(language);
  }

  if (
    effectiveTopic === "scholarships" &&
    normalizeStage(stage) === "school" &&
    isAffirmativeReply(message) &&
    history.some(
      (item) =>
        item?.role === "sakhi" &&
        /usual process for getting an income certificate made|income certificate banwane ka usual process/i.test(
          String(item?.text || "")
        )
    )
  ) {
    return getScholarshipIncomeCertificateProcessReply(language);
  }

  if (
    effectiveTopic === "scholarships" &&
    normalizeStage(stage) === "school" &&
    isAffirmativeReply(message) &&
    history.some(
      (item) =>
        item?.role === "sakhi" &&
        /compare these three in terms of where marks, documentation, and personal story matter most|in teenon ko compare karke/i.test(
          String(item?.text || "")
        )
    )
  ) {
    const rows = structuredTopicRows.scholarships || [];
    const selected = rows.map(formatScholarshipRow);
    return getPost12ScholarshipComparisonReply(selected, language);
  }

  if (effectiveTopic === "scholarships" && normalizeStage(stage) === "school" && isInformationSeeking(message)) {
    const rows = structuredTopicRows.scholarships || [];
    if (!rows.length) {
      return "";
    }

    const lowered = String(message || "").toLowerCase();
    const post12Only = /(12th|post 12|after 12|graduation|college)/i.test(lowered);
    const post10Only = /(10th|post 10|after 10|boards)/i.test(lowered) && !post12Only;
    const filtered = rows.filter((row) => {
      if (post12Only) return row.sub_stage === "post_12";
      if (post10Only) return row.sub_stage === "post_class_10";
      return true;
    });
    const selected = filtered.slice(0, 4).map(formatScholarshipRow);
    if (!selected.length) {
      return "";
    }

    if (/(income certificate|income proof|income criteria|income limit|family income|certificate)/i.test(lowered)) {
      const incomeReply = getScholarshipIncomeReply(selected, language);
      if (incomeReply) {
        return incomeReply;
      }
    }

    if (post12Only) {
      const post12Reply = getPost12ScholarshipOptionsReply(selected, language);
      if (post12Reply) {
        return post12Reply;
      }
    }

    if (language === "hinglish") {
      const lines = selected.map(
        (item) => `- ${item.name}${item.subStage ? ` (${item.subStage})` : ""}: minimum ${item.marks}, process ${item.process}.`
      );
      return `Aapki kuch seniors jo boards ke baad alag-alag scholarship programs tak pahunchi hain, unhone in options jaise raaste explore kiye hain:\n${lines.join("\n")}\nKya tum yeh bhi jaana chahogi ki jo seniors is process se guzri aur successful hui, unhone kya learnings aur experiences share kiye hain?`;
    }

    if (language === "hindi") {
      const lines = selected.map(
        (item) => `- ${item.name}${item.subStage ? ` (${item.subStage})` : ""}: minimum ${item.marks}, process ${item.process}.`
      );
      return `Aapki kuch seniors jo boards ke baad vibhinna scholarship programs tak pahunchi hain, unhone in jaise options explore kiye hain:\n${lines.join("\n")}\nKya aap yeh bhi jaana chahengi ki jo seniors is process se guzri aur successful hui, unhone kaun si learnings aur experiences share kiye hain?`;
    }

    const lines = selected.map(
      (item) => `- ${item.name}${item.subStage ? ` (${item.subStage})` : ""}: minimum ${item.marks}, selection process ${item.process}.`
    );
    return `Some of your seniors who have become scholars in different programs after their boards have explored options like:\n${lines.join("\n")}\nWould you also like to know what learnings and experiences your seniors shared after going through the process and becoming successful?`;
  }

  if (effectiveTopic === "internships" && normalizeStage(stage) === "college" && isInformationSeeking(message)) {
    const lowered = String(message || "").toLowerCase();
    if (/(what kind|which kind|realistically apply|realistic internships|internship types|types of internships)/i.test(lowered)) {
      const internshipTypesReply = getInternshipTypesReply(language);
      if (internshipTypesReply) {
        return internshipTypesReply;
      }
    }

    if (/(how do i apply|how to apply|actually apply|apply for internships|internship apply process)/i.test(lowered)) {
      const internshipApplyReply = getInternshipApplyReply(language);
      if (internshipApplyReply) {
        return internshipApplyReply;
      }
    }

    if (/(start|begin|looking|look for|find|while managing college|along with college|during college|internships during college)/i.test(lowered)) {
      const internshipReply = getInternshipStartReply(language);
      if (internshipReply) {
        return internshipReply;
      }
    }
  }

  return "";
}

function getFallbackTopicLabel(topic, language) {
  const normalizedTopic = normalizeStage(topic);
  const labels = {
    english: {
      scholarships: "scholarships",
      internships: "internships",
      "after 12th options": "options after 12th",
      "courses & upskilling": "courses and upskilling",
      "courses and upskilling": "courses and upskilling",
      "open concern": "this"
    },
    hinglish: {
      scholarships: "scholarships",
      internships: "internships",
      "after 12th options": "12th ke baad ke options",
      "courses & upskilling": "courses aur upskilling",
      "courses and upskilling": "courses aur upskilling",
      "open concern": "is baat"
    },
    hindi: {
      scholarships: "scholarships",
      internships: "internships",
      "after 12th options": "12th ke baad ke options",
      "courses & upskilling": "courses aur upskilling",
      "courses and upskilling": "courses aur upskilling",
      "open concern": "is baat"
    }
  };

  return labels[language]?.[normalizedTopic] || labels[language]?.["open concern"] || "this";
}

function looksLikeQuestion(message) {
  const text = String(message || "").trim().toLowerCase();
  return (
    text.includes("?") ||
    /^(what|which|who|where|when|why|how|can|could|should|do you|tell me|share|is there|are there)\b/i.test(text)
  );
}

function getLocalFallbackReply({ message, topic, language }) {
  if (classifyMessage(message) === "casual") {
    return getCasualReply(message);
  }

  const topicLabel = getFallbackTopicLabel(topic, language);
  const normalizedTopic = normalizeStage(topic);
  const questionLike = looksLikeQuestion(message) || isInformationSeeking(message);

  if (language === "hindi") {
    if (normalizedTopic === "scholarships" && questionLike) {
      return "Main abhi poori scholarship detail pull nahi kar pa rahi hoon, lekin hum use useful tareeke se narrow kar sakte hain. Aap post-10 options dekhna chahte hain ya post-12?";
    }

    if (normalizedTopic === "internships" && questionLike) {
      return "Main abhi poori internship detail pull nahi kar pa rahi hoon, lekin hum isse roles, resume, ya apply karne ke steps mein break kar sakte hain. Aap kis part se shuru karna chahenge?";
    }

    if (questionLike) {
      return "Main abhi poora answer pull nahi kar pa rahi hoon, lekin hum isse ek clear next step se start kar sakte hain. Aapko sabse pehle kis part ka answer chahiye?";
    }

    return `${topicLabel === "is baat" ? "Theek hai, hum ise aaram se samajh sakte hain." : `${topicLabel} ko ek chhote aur clear step mein todte hain.`} Abhi mujhe bas itna batayiye ki sabse zyada confusion kis part mein hai.`;
  }

  if (language === "hinglish") {
    if (normalizedTopic === "scholarships" && questionLike) {
      return "Main abhi poori scholarship detail pull nahi kar pa rahi, but hum isse useful tareeke se narrow kar sakte hain. Tum post-10 options dekhna chahti ho ya post-12?";
    }

    if (normalizedTopic === "internships" && questionLike) {
      return "Main abhi poori internship detail pull nahi kar pa rahi, but hum isse roles, resume, ya apply karne ke steps mein break kar sakte hain. Tum kis part se start karna chahti ho?";
    }

    if (questionLike) {
      return "Main abhi full answer pull nahi kar pa rahi, but hum isse ek clear next step se start kar sakte hain. Tumhe sabse pehle kis part ka answer chahiye?";
    }

    return `${topicLabel === "is baat" ? "Theek hai, hum isse aaram se samajh sakte hain." : `${topicLabel} ko ek chhote aur clear step mein todte hain.`} Abhi mujhe bas yeh batao ki sabse zyada confusion kis part mein hai.`;
  }

  if (normalizedTopic === "scholarships" && questionLike) {
    return "I can’t pull the full scholarship details right now, but we can still narrow this down. Do you want post-10 options first or post-12?";
  }

  if (normalizedTopic === "internships" && questionLike) {
    return "I can’t pull the full internship details right now, but we can still make this concrete. Do you want to start with types of internships, resume basics, or where to apply?";
  }

  if (questionLike) {
    return "I can’t pull the full answer right now, but we can still move this forward. Which part do you want first?";
  }

  return `${topicLabel === "this" ? "Okay, we can work through this calmly." : `Let’s break ${topicLabel} into one clear next step.`} Tell me which part feels most confusing or stuck.`;
}

function isRetryableModelError(error) {
  const message = String(error?.message || error || "").toLowerCase();
  return /429|503|rate|quota|too many|service unavailable|overloaded|unavailable|api key expired|api_key_invalid|invalid api key|invalid_argument/.test(
    message
  );
}

function looksIncompleteResponse(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return true;
  if (trimmed.length < 80) return false;
  if (/[.!?)"'\u0964]$/.test(trimmed)) return false;
  return /[a-z0-9\u0900-\u097F]$/i.test(trimmed);
}

function looksTooLongForMobile(text) {
  return String(text || "").trim().length > 1000;
}

function getCasualReply(message) {
  const lowered = String(message || "").trim().toLowerCase();

  if (/^(hi+|hey+|hello|helo|ello|elo)\b/.test(lowered)) {
    return "Hey :) what's on your mind?";
  }

  if (lowered === "sup" || lowered.startsWith("yo") || lowered.startsWith("yoo")) {
    return "yo :) what's up?";
  }

  if (lowered.includes("how are you")) {
    return "I'm here :) what's been going on?";
  }

  if (/^(bye+|byee+|goodbye|take care|see you|cya)\b/.test(lowered)) {
    return "Bye :) come back anytime.";
  }

  if (/^(thanks|thank you|thx)\b/.test(lowered)) {
    return "Anytime :)";
  }

  if (/^(ok|okay|cool|nice)\b/.test(lowered)) {
    return "okay :)";
  }

  return "You can take your time. What's been sitting with you lately?";
}

function resolveDataFile(filePath) {
  if (!filePath) {
    return "";
  }
  return path.isAbsolute(filePath) ? filePath : path.resolve(repoRoot, filePath);
}

function loadStageResponses(filePath, stageLabel) {
  const resolved = resolveDataFile(filePath);
  if (!resolved || !fs.existsSync(resolved)) {
    return [];
  }

  const csvText = fs.readFileSync(resolved, "utf8");
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true
  });

  const snippets = [];

  for (const row of rows) {
    for (const [header, rawValue] of Object.entries(row)) {
      const headerKey = normalizeHeader(header);
      if (!headerKey || ignoredColumns.includes(headerKey)) {
        continue;
      }

      const text = String(rawValue || "").replace(/\s+/g, " ").trim();
      if (text.length < 35) {
        continue;
      }

      if (/^(yes|no|maybe|n\/a|none|not applicable|na)$/i.test(text)) {
        continue;
      }

      snippets.push({
        stage: stageLabel,
        header: headerKey,
        text
      });
    }
  }

  return snippets;
}

const stageResponses = {
  school: loadStageResponses(stageFileMap.school, "School"),
  college: loadStageResponses(stageFileMap.college, "College"),
  "early work": loadStageResponses(stageFileMap["early work"], "Early Work")
};
const topicResponses = {
  scholarships: loadStageResponses(topicFileMap.scholarships, "Scholarships"),
  internships: loadStageResponses(topicFileMap.internships, "Internships")
};
const structuredTopicRows = {
  scholarships: loadStructuredRows(structuredTopicFileMap.scholarships)
};

const memoryStoreFile =
  process.env.MEMORY_STORE_FILE || path.join(repoRoot, "data", "sakhi-memory.json");
const analyticsStoreFile =
  process.env.ANALYTICS_STORE_FILE || path.join(repoRoot, "data", "sakhi-analytics.json");
const memoryRetentionMs =
  Number(process.env.MEMORY_RETENTION_DAYS || 30) * 24 * 60 * 60 * 1000;
const transientMemoryRetentionMs =
  Number(process.env.TRANSIENT_MEMORY_RETENTION_MINUTES || 20) * 60 * 1000;
const MAX_TURNS_PER_SESSION = 2;
const practicalTopics = new Set([
  "scholarships",
  "after 12th options",
  "internships",
  "courses & upskilling",
  "courses and upskilling"
]);
const analytics = {
  totalRequests: 0,
  successes: 0,
  failures: 0,
  rateLimitErrors: 0,
  totalResponseChars: 0,
  truncatedResponses: 0,
  totalLatencyMs: 0,
  slowResponses: 0,
  topics: {},
  stages: {},
  modes: {},
  languages: {},
  totalUsers: 0,
  totalSessions: 0,
  repeatSessions: 0,
  safetyResponses: 0,
  recentErrors: [],
  recentTruncations: []
};
const conversationStore = loadPersistentConversationStore();
const { analytics: persistedAnalytics, sessionCounts, userKeys } = loadPersistentAnalyticsState();
Object.assign(analytics, persistedAnalytics);
const sessionStats = new Map(Object.entries(sessionCounts));
const knownUserKeys = new Set(userKeys);
let persistMemoryTimer = null;
let persistAnalyticsTimer = null;

function bumpCounter(bucket, key) {
  const safeKey = key || "general";
  bucket[safeKey] = (bucket[safeKey] || 0) + 1;
}

function pushRecent(list, item, limit = 10) {
  list.unshift(item);
  if (list.length > limit) {
    list.length = limit;
  }
}

function normalizeConversationEntry(value) {
  const history = Array.isArray(value?.history)
    ? value.history
    : Array.isArray(value)
      ? value
      : [];
  const sanitizedHistory = history
    .map((item) => ({
      role: String(item?.role || "").trim(),
      text: String(item?.text || "").trim()
    }))
    .filter((item) => item.role && item.text)
    .slice(-MAX_TURNS_PER_SESSION);

  return {
    history: sanitizedHistory,
    updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : new Date().toISOString()
  };
}

function isExpiredTimestamp(timestamp) {
  return isExpiredTimestampForRetention(timestamp, memoryRetentionMs);
}

function isExpiredTimestampForRetention(timestamp, retentionMs) {
  const time = new Date(timestamp).getTime();
  if (!Number.isFinite(time)) {
    return true;
  }
  return Date.now() - time > retentionMs;
}

function loadPersistentConversationStore() {
  try {
    if (!fs.existsSync(memoryStoreFile)) {
      return new Map();
    }

    const raw = JSON.parse(fs.readFileSync(memoryStoreFile, "utf8"));
    const entries = Object.entries(raw || {});
    const map = new Map();

    for (const [key, value] of entries) {
      const normalized = normalizeConversationEntry(value);
      if (normalized.history.length && !isExpiredTimestamp(normalized.updatedAt)) {
        map.set(key, normalized);
      }
    }

    return map;
  } catch (error) {
    console.log(
      JSON.stringify({
        type: "sakhi_memory_load",
        outcome: "failed",
        error: String(error?.message || error).slice(0, 200)
      })
    );
    return new Map();
  }
}

function serializeConversationStore() {
  const output = {};
  for (const [key, value] of conversationStore.entries()) {
    if (String(key).startsWith("transient:")) {
      continue;
    }
    output[key] = {
      history: value.history,
      updatedAt: value.updatedAt
    };
  }
  return output;
}

function isPersistentConversationKey(sessionKey) {
  return !String(sessionKey || "").startsWith("transient:");
}

function getConversationRetentionMs(sessionKey) {
  return isPersistentConversationKey(sessionKey)
    ? memoryRetentionMs
    : transientMemoryRetentionMs;
}

function pruneConversationStore() {
  let changed = false;
  for (const [key, value] of conversationStore.entries()) {
    if (isExpiredTimestampForRetention(value?.updatedAt, getConversationRetentionMs(key))) {
      conversationStore.delete(key);
      if (isPersistentConversationKey(key)) {
        changed = true;
      }
    }
  }
  return changed;
}

function persistConversationStore() {
  persistMemoryTimer = null;
  try {
    const pruned = pruneConversationStore();
    fs.mkdirSync(path.dirname(memoryStoreFile), { recursive: true });
    fs.writeFileSync(memoryStoreFile, JSON.stringify(serializeConversationStore(), null, 2), "utf8");
    if (pruned) {
      console.log(JSON.stringify({ type: "sakhi_memory_prune", outcome: "success" }));
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        type: "sakhi_memory_persist",
        outcome: "failed",
        error: String(error?.message || error).slice(0, 200)
      })
    );
  }
}

function schedulePersistConversationStore() {
  if (persistMemoryTimer) {
    clearTimeout(persistMemoryTimer);
  }
  persistMemoryTimer = setTimeout(persistConversationStore, 400);
}

function loadPersistentAnalyticsState() {
  try {
    if (!fs.existsSync(analyticsStoreFile)) {
      return {
        analytics: {},
        sessionCounts: {},
        userKeys: []
      };
    }

    const raw = JSON.parse(fs.readFileSync(analyticsStoreFile, "utf8"));
    return {
      analytics: raw?.analytics || {},
      sessionCounts: raw?.sessionCounts || {},
      userKeys: Array.isArray(raw?.userKeys) ? raw.userKeys : []
    };
  } catch (error) {
    console.log(
      JSON.stringify({
        type: "sakhi_analytics_load",
        outcome: "failed",
        error: String(error?.message || error).slice(0, 200)
      })
    );
    return {
      analytics: {},
      sessionCounts: {},
      userKeys: []
    };
  }
}

function persistAnalyticsState() {
  persistAnalyticsTimer = null;
  try {
    fs.mkdirSync(path.dirname(analyticsStoreFile), { recursive: true });
    fs.writeFileSync(
      analyticsStoreFile,
      JSON.stringify(
        {
          analytics,
          sessionCounts: Object.fromEntries(sessionStats.entries()),
          userKeys: Array.from(knownUserKeys)
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    console.log(
      JSON.stringify({
        type: "sakhi_analytics_persist",
        outcome: "failed",
        error: String(error?.message || error).slice(0, 200)
      })
    );
  }
}

function schedulePersistAnalyticsState() {
  if (persistAnalyticsTimer) {
    clearTimeout(persistAnalyticsTimer);
  }
  persistAnalyticsTimer = setTimeout(persistAnalyticsState, 400);
}

function recordSessionActivity(sessionKey, userKey) {
  if (!sessionKey) {
    return;
  }

  const currentCount = sessionStats.get(sessionKey) || 0;
  const nextCount = currentCount + 1;
  sessionStats.set(sessionKey, nextCount);

  if (currentCount === 0) {
    analytics.totalSessions += 1;
  } else if (currentCount === 1) {
    analytics.repeatSessions += 1;
  }

  if (userKey && !knownUserKeys.has(userKey)) {
    knownUserKeys.add(userKey);
    analytics.totalUsers += 1;
  }

  schedulePersistAnalyticsState();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasGeminiCredentials() {
  return geminiClients.length > 0;
}

function getGeminiClient(index = geminiClientIndex) {
  if (!geminiClients.length) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }
  const safeIndex = ((index % geminiClients.length) + geminiClients.length) % geminiClients.length;
  return {
    client: geminiClients[safeIndex],
    keyIndex: safeIndex
  };
}

function setGeminiClientIndex(index) {
  if (!geminiClients.length) {
    geminiClientIndex = 0;
    return geminiClientIndex;
  }

  geminiClientIndex = ((index % geminiClients.length) + geminiClients.length) % geminiClients.length;
  return geminiClientIndex;
}

function rotateGeminiClient(previousIndex) {
  if (!geminiClients.length) {
    return 0;
  }
  return setGeminiClientIndex((previousIndex ?? geminiClientIndex) + 1);
}

function getGeminiAttemptOrder() {
  if (!geminiClients.length) {
    return [];
  }

  return Array.from({ length: geminiClients.length }, (_, offset) =>
    ((geminiClientIndex + offset) % geminiClients.length + geminiClients.length) % geminiClients.length
  );
}

function scoreSnippet(snippet, queryTokens) {
  const haystackTokens = tokenize(`${snippet.header} ${snippet.text}`);
  const tokenSet = new Set(haystackTokens);
  let score = 0;

  for (const token of queryTokens) {
    if (tokenSet.has(token)) {
      score += 3;
    }
  }

  const compact = snippet.text.toLowerCase();
  if (compact.includes("confused") || compact.includes("self doubt")) score += 1;
  if (compact.includes("career") || compact.includes("college")) score += 1;
  if (compact.includes("friends") || compact.includes("family")) score += 1;

  return score;
}

function shouldUsePeerContext(message, peerSnippets) {
  const lowered = String(message || "").trim().toLowerCase();
  const queryTokens = tokenize(message);

  if (!peerSnippets.length) {
    return false;
  }

  const simpleEmotionOnly =
    queryTokens.length <= 4 &&
    /(sad|lonely|empty|low|tired|down|upset|bad)/.test(lowered) &&
    !/(because|about|career|future|friends?|family|college|school|work|job|money|compare|pressure)/.test(
      lowered
    );

  if (simpleEmotionOnly) {
    return false;
  }

  return peerSnippets[0].score >= 6;
}

function getTopicSpecificPeerPool(stage, topic) {
  const normalizedStage = normalizeStage(stage);
  const normalizedTopic = normalizeStage(topic);
  const stagePool =
    stageResponses[normalizedStage] ||
    stageResponses[
      normalizedStage.includes("work")
        ? "early work"
        : normalizedStage.includes("college")
          ? "college"
          : "school"
    ] ||
    [];

  if (normalizedTopic === "scholarships") {
    return [...(topicResponses.scholarships || []), ...stagePool];
  }

  if (normalizedTopic === "internships") {
    return [...(topicResponses.internships || []), ...stagePool];
  }

  return stagePool;
}

function getPeerContext(stage, topic, message) {
  const normalizedStage = normalizeStage(stage);
  const pool = getTopicSpecificPeerPool(normalizedStage, topic);

  const queryTokens = tokenize(message);
  const ranked = pool
    .map((snippet) => ({ ...snippet, score: scoreSnippet(snippet, queryTokens) }))
    .filter((snippet) => snippet.score > 0)
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length);

  const selected = [];
  const seenTexts = new Set();

  for (const snippet of ranked) {
    if (selected.length === 2) break;
    if (seenTexts.has(snippet.text)) continue;
    seenTexts.add(snippet.text);
    selected.push(snippet);
  }

  return shouldUsePeerContext(message, selected) ? selected : [];
}

function normalizeMemoryScope(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "keep") return "keep";
  if (normalized === "off") return "off";
  return "topic";
}

function shouldUseMemory(scope) {
  return ["off", "topic", "keep"].includes(normalizeMemoryScope(scope));
}

function isResetRequested(value) {
  return ["1", "true", "yes", "reset"].includes(String(value || "").trim().toLowerCase());
}

function getSessionKey({ req, source, sessionId, userId, stage, topic, memoryScope }) {
  const normalizedStage = normalizeStage(stage || "unknown");
  const normalizedTopic = normalizeStage(topic || "general");
  const scope = normalizeMemoryScope(memoryScope);
  const scopeSuffix = scope === "keep" ? "" : `:${normalizedStage}:${normalizedTopic}`;

  if (scope === "off") {
    if (typeof sessionId === "string" && sessionId.trim()) {
      return `transient:session:${sessionId.trim().slice(0, 120)}${scopeSuffix}`;
    }

    const ip = String(req.ip || req.headers["x-forwarded-for"] || "anon")
      .split(",")[0]
      .trim();
    return `transient:fallback:${source || "app"}:${ip}${scopeSuffix}`;
  }

  if (typeof userId === "string" && userId.trim()) {
    return `user:${userId.trim().slice(0, 120)}${scopeSuffix}`;
  }

  if (typeof sessionId === "string" && sessionId.trim()) {
    return `session:${sessionId.trim().slice(0, 120)}${scopeSuffix}`;
  }

  const ip = String(req.ip || req.headers["x-forwarded-for"] || "anon")
    .split(",")[0]
    .trim();
  return `fallback:${source || "app"}:${ip}:${normalizedStage}:${normalizedTopic}`;
}

function getConversationHistory(sessionKey) {
  const entry = conversationStore.get(sessionKey);
  if (!entry) {
    return [];
  }

  if (isExpiredTimestampForRetention(entry.updatedAt, getConversationRetentionMs(sessionKey))) {
    conversationStore.delete(sessionKey);
    if (isPersistentConversationKey(sessionKey)) {
      schedulePersistConversationStore();
    }
    return [];
  }

  return Array.isArray(entry.history) ? entry.history : [];
}

function storeConversationTurn(sessionKey, role, text) {
  if (!sessionKey) {
    return;
  }

  const existing = normalizeConversationEntry(conversationStore.get(sessionKey));
  existing.history.push({ role, text: String(text || "").trim() });
  existing.history = existing.history.slice(-MAX_TURNS_PER_SESSION);
  existing.updatedAt = new Date().toISOString();
  conversationStore.set(sessionKey, existing);
  if (isPersistentConversationKey(sessionKey)) {
    schedulePersistConversationStore();
  }
}

function clearConversationSession(sessionKey) {
  if (!sessionKey) return;
  if (conversationStore.delete(sessionKey)) {
    if (isPersistentConversationKey(sessionKey)) {
      schedulePersistConversationStore();
    }
  }
}

function clearAllConversationMemory() {
  conversationStore.clear();
  schedulePersistConversationStore();
}

function isPracticalTopic(topic) {
  return practicalTopics.has(normalizeStage(topic));
}

function getEffectivePeerSnippets(topic, peerSnippets) {
  if (!peerSnippets.length) {
    return [];
  }

  return isPracticalTopic(topic) ? peerSnippets.slice(0, 1) : peerSnippets.slice(0, 2);
}

function shouldLeadWithMaitriTag(topic) {
  const normalized = normalizeStage(topic);
  return normalized === "scholarships" || normalized === "internships";
}

function shouldUseMaitriOpening({ topic, message, peerSnippets = [], history = [] }) {
  if (!shouldLeadWithMaitriTag(topic)) {
    return false;
  }

  const messageText = String(message || "").trim();
  if (!messageText || classifyMessage(messageText) === "casual") {
    return false;
  }

  if (tokenize(messageText).length < 4) {
    return false;
  }

  if (!peerSnippets.length && history.length > 0) {
    return false;
  }

  const normalizedTopic = normalizeStage(topic);
  const lowered = messageText.toLowerCase();
  if (normalizedTopic === "scholarships") {
    return /(scholar|scholarship|fees?|finance|money|fund|apply|application|boards?|12th)/i.test(lowered);
  }

  if (normalizedTopic === "internships") {
    return /(intern|resume|cv|job|work|apply|application|career|experience)/i.test(lowered);
  }

  return false;
}

function ensureMaitriOpening(topic, language, text, message = "", peerSnippets = [], history = []) {
  if (!shouldUseMaitriOpening({ topic, message, peerSnippets, history })) {
    return text;
  }

  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return trimmed;
  }

  if (/maitri/i.test(trimmed.split(/[\r\n]/)[0])) {
    return trimmed;
  }

  let prefix = "Many of your seniors from Maitri have shared similar worries. ";
  const normalizedTopic = normalizeStage(topic);
  if (normalizedTopic === "scholarships") {
    prefix = "Some of your seniors who have become scholars in various programs after their boards have shared - ";
  } else if (normalizedTopic === "internships") {
    prefix = "Some of your seniors who have gone on to internships and early work opportunities have shared - ";
  }

  if (language === "hinglish") {
    if (normalizedTopic === "scholarships") {
      prefix = "Aapki kuch seniors jo boards ke baad alag-alag scholarship programs tak pahunchi hain, unhone share kiya hai - ";
    } else if (normalizedTopic === "internships") {
      prefix = "Aapki kuch seniors jo internships aur early work opportunities tak pahunchi hain, unhone share kiya hai - ";
    } else {
      prefix = "Maitri ki bahut si seniors ne aise concerns share kiye hain. ";
    }
  } else if (language === "hindi") {
    if (normalizedTopic === "scholarships") {
      prefix = "Aapki kuch seniors jo boards ke baad vibhinna scholarship programs tak pahunchi hain, unhone yeh share kiya hai - ";
    } else if (normalizedTopic === "internships") {
      prefix = "Aapki kuch seniors jo internships aur early work opportunities tak pahunchi hain, unhone yeh share kiya hai - ";
    } else {
      prefix = "Maitri ki bahut si seniors ne aisi chintayein share ki hain. ";
    }
  }

  return `${prefix}${trimmed}`;
}

function buildReflectivePrompt({ message, stage, topic, peerSnippets, history, language }) {
  const parts = [
    "mode: reflective",
    `stage: ${stage || "unspecified"}`,
    `topic: ${topic || "general"}`,
    `language: ${language}`,
    "",
    "User message",
    message.trim()
  ];

  if (history.length) {
    parts.push("", "Recent context");
    for (const item of history) {
      parts.push(`${item.role}: ${item.text}`);
    }
  }

  if (peerSnippets.length) {
    parts.push("", "Relevant anonymized Maitri reflections");
    for (const [index, snippet] of peerSnippets.entries()) {
      parts.push(`${index + 1}. (${snippet.stage}) ${snippet.text}`);
    }
  }

  parts.push(
    "",
    "Reply requirements",
    `- ${getLanguageInstruction(language)}`,
    "- First decide whether the user wants light conversation, practical help, or emotional support.",
    "- Do not default to phrases like 'this feels heavy' unless the user clearly sounds distressed or overwhelmed.",
    "- Acknowledge briefly, then either engage naturally or offer something useful.",
    "- Keep it warm, human, and concise.",
    "- If helpful, add one subtle peer-grounded line.",
    "- Offer one small next step or one focused question, not both unless very short.",
    "- Finish cleanly. Do not end mid-sentence."
  );

  return parts.join("\n");
}

function buildPracticalPrompt({ message, stage, topic, peerSnippets, history, language }) {
  const parts = [
    "mode: practical",
    `stage: ${stage || "unspecified"}`,
    `topic: ${topic || "general"}`,
    `language: ${language}`,
    "",
    "User question",
    message.trim()
  ];

  if (history.length) {
    parts.push("", "Minimal context");
    for (const item of history) {
      parts.push(`${item.role}: ${item.text}`);
    }
  }

  if (peerSnippets.length) {
    parts.push("", "One relevant Maitri reflection");
    parts.push(`1. (${peerSnippets[0].stage}) ${peerSnippets[0].text}`);
  }

  parts.push(
    "",
    "Reply requirements",
    `- ${getLanguageInstruction(language)}`,
    "- Stay anchored to the selected topic.",
    "- Do not assume the user already has a problem. If they are exploring, stay neutral and helpful.",
    "- Be practical, direct, and easy to read on a phone.",
    "- Use a brief intro, then 2 to 4 compact bullets or options only if useful.",
    "- If the user sounds emotional, validate briefly before the practical guidance. Otherwise skip the emotional framing.",
    "- Prefer criteria, next steps, and shortlists over long explanations.",
    "- Use Maitri senior grounding only when it genuinely strengthens the answer. Do not force it into every reply.",
    "- If you mention Maitri seniors, keep it brief and natural rather than as a repeated template.",
    "- Finish cleanly. Do not end mid-sentence."
  );

  return parts.join("\n");
}

function buildGeminiPrompt({ message, stage, topic, peerSnippets, history, language }) {
  return isPracticalTopic(topic)
    ? buildPracticalPrompt({ message, stage, topic, peerSnippets, history, language })
    : buildReflectivePrompt({ message, stage, topic, peerSnippets, history, language });
}

function getResponseTokenLimit(topic) {
  return isPracticalTopic(topic) ? Math.min(maxOutputTokens, 500) : Math.min(maxOutputTokens, 900);
}

async function generateGeminiText({ prompt, tokenLimit, keyIndex: requestedKeyIndex = geminiClientIndex }) {
  const { client, keyIndex } = getGeminiClient(requestedKeyIndex);
  const response = await client.models.generateContent({
    model,
    contents: prompt,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: tokenLimit,
      thinkingConfig: {
        thinkingBudget: 0
      }
    }
  });

  const parts = response?.candidates?.[0]?.content?.parts || [];
  const text =
    (typeof response?.text === "string" && response.text.trim()) ||
    parts
      .map((part) => (typeof part?.text === "string" ? part.text : ""))
      .join("")
      .trim() ||
    "No response text returned.";

  return {
    text,
    finishReason: String(response?.candidates?.[0]?.finishReason || "").toUpperCase(),
    keyIndex
  };
}

function isIncompleteGeneration(result) {
  if (!result?.text) {
    return true;
  }

  if (!result.finishReason || result.finishReason === "STOP") {
    return looksIncompleteResponse(result.text);
  }

  return true;
}

async function repairIncompleteResponse({ text, language, topic, shortMode = false }) {
  const repairPrompt = [
    `language: ${language}`,
    `topic: ${topic || "general"}`,
    "",
    "The following draft reply got cut off.",
    "Rewrite it as one complete reply in the same language and same tone.",
    "Keep the meaning, do not add major new ideas, and end cleanly.",
    shortMode
      ? "Keep it very short and mobile-friendly. Use at most 3 short sentences or 2 short bullets."
      : "Keep it concise and mobile-friendly.",
    "",
    "Draft reply",
    text
  ].join("\n");

  return generateGeminiText({
    prompt: repairPrompt,
    tokenLimit: shortMode ? 220 : Math.min(getResponseTokenLimit(topic), 360)
  });
}

async function rewriteForMobile({ text, language, topic }) {
  const prompt = [
    `language: ${language}`,
    `topic: ${topic || "general"}`,
    "",
    "Rewrite the reply below so it is easier to read on a phone.",
    "Keep the same meaning.",
    "Use at most 5 short sentences or up to 4 short bullets.",
    "End cleanly.",
    "",
    "Reply",
    text
  ].join("\n");

  return generateGeminiText({
    prompt,
    tokenLimit: 420
  });
}

async function generateSakhiReply({ message, stage, topic, language, peerSnippets, history }) {
  const prompt = buildGeminiPrompt({
    message,
    stage,
    topic,
    language,
    peerSnippets,
    history
  });
  const tokenLimit = getResponseTokenLimit(topic);

  let lastError;
  const keyOrder = getGeminiAttemptOrder();
  const attemptOrder = keyOrder.length ? keyOrder : [geminiClientIndex];

  for (let attempt = 0; attempt < attemptOrder.length; attempt += 1) {
    const keyIndex = attemptOrder[attempt];
    try {
      let result = await generateGeminiText({ prompt, tokenLimit, keyIndex });

      if (isIncompleteGeneration(result)) {
        analytics.truncatedResponses += 1;
        pushRecent(analytics.recentTruncations, {
          at: new Date().toISOString(),
          topic: topic || "general",
          finishReason: result.finishReason || "UNKNOWN",
          preview: String(result.text || "").slice(0, 160)
        });
        schedulePersistAnalyticsState();
        console.log(
          JSON.stringify({
            type: "sakhi_truncation",
            topic: topic || "general",
            finishReason: result.finishReason || "UNKNOWN",
            preview: String(result.text || "").slice(0, 160)
          })
        );
        try {
          result = await repairIncompleteResponse({
            text: result.text,
            language,
            topic,
            shortMode: isPracticalTopic(topic)
          });

          if (isIncompleteGeneration(result)) {
            result = await repairIncompleteResponse({
              text: result.text,
              language,
              topic,
              shortMode: true
            });
          }
        } catch (repairError) {
          console.log(
            JSON.stringify({
              type: "sakhi_repair",
              outcome: "failed",
              topic: topic || "general",
              error: String(repairError?.message || repairError).slice(0, 200)
            })
          );
        }
      }

      if (isIncompleteGeneration(result)) {
        throw new Error("Generated response remained incomplete after repair.");
      }

      if (looksTooLongForMobile(result.text)) {
        try {
          const shortened = await rewriteForMobile({
            text: result.text,
            language,
            topic
          });
          if (!isIncompleteGeneration(shortened)) {
            result = shortened;
          }
        } catch (rewriteError) {
          console.log(
            JSON.stringify({
              type: "sakhi_mobile_rewrite",
              outcome: "failed",
              topic: topic || "general",
              error: String(rewriteError?.message || rewriteError).slice(0, 200)
            })
          );
        }
      }

      setGeminiClientIndex(keyIndex);
      return ensureMaitriOpening(topic, language, result.text, message, peerSnippets, history);
    } catch (error) {
      lastError = error;
      const retryable = isRetryableModelError(error);
      if (!retryable || attempt === attemptOrder.length - 1) {
        throw error;
      }
      rotateGeminiClient(keyIndex);
    }
  }

  throw lastError;
}

function recordSuccess(topic, responseText, meta = {}) {
  analytics.totalRequests += 1;
  analytics.successes += 1;
  analytics.totalResponseChars += String(responseText || "").length;
  analytics.totalLatencyMs += Number(meta.latencyMs || 0);
  if (Number(meta.latencyMs || 0) >= 4000) {
    analytics.slowResponses += 1;
  }
  recordSessionActivity(meta.sessionKey, meta.userKey);
  bumpCounter(analytics.topics, topic || "general");
  bumpCounter(analytics.stages, meta.stage || "unknown");
  bumpCounter(analytics.modes, meta.mode || "unknown");
  bumpCounter(analytics.languages, meta.language || "unknown");
  if (meta.mode === "safety") {
    analytics.safetyResponses += 1;
  }
  schedulePersistAnalyticsState();
  console.log(
    JSON.stringify({
      type: "sakhi_analytics",
      outcome: "success",
      topic: topic || "general",
      stage: meta.stage || "unknown",
      mode: meta.mode || "unknown",
      language: meta.language || "unknown",
      latencyMs: Number(meta.latencyMs || 0),
      averageResponseChars: analytics.successes
        ? Math.round(analytics.totalResponseChars / analytics.successes)
        : 0
    })
  );
}

function recordFailure(topic, error, meta = {}) {
  analytics.totalRequests += 1;
  analytics.failures += 1;
  analytics.totalLatencyMs += Number(meta.latencyMs || 0);
  if (Number(meta.latencyMs || 0) >= 4000) {
    analytics.slowResponses += 1;
  }
  recordSessionActivity(meta.sessionKey, meta.userKey);
  bumpCounter(analytics.topics, topic || "general");
  bumpCounter(analytics.stages, meta.stage || "unknown");
  bumpCounter(analytics.modes, meta.mode || "unknown");
  bumpCounter(analytics.languages, meta.language || "unknown");
  const message = String(error?.message || error || "");
  if (message.includes("429") || /rate|quota|too many/i.test(message)) {
    analytics.rateLimitErrors += 1;
  }
  pushRecent(analytics.recentErrors, {
    at: new Date().toISOString(),
    topic: topic || "general",
    stage: meta.stage || "unknown",
    mode: meta.mode || "unknown",
    language: meta.language || "unknown",
    latencyMs: Number(meta.latencyMs || 0),
    error: message.slice(0, 180)
  });
  schedulePersistAnalyticsState();
  console.log(
    JSON.stringify({
      type: "sakhi_analytics",
      outcome: "failure",
      topic: topic || "general",
      mode: meta.mode || "unknown",
      language: meta.language || "unknown",
      latencyMs: Number(meta.latencyMs || 0),
      rateLimitErrors: analytics.rateLimitErrors,
      error: message.slice(0, 300)
    })
  );
}

app.use(
  cors({
    origin: allowedOrigin === "*" ? true : allowedOrigin
  })
);
app.use(express.json({ limit: "1mb" }));
app.use(express.text({ type: "*/*", limit: "64kb" }));
app.use(express.static(publicDir));

app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(publicDir, "dashboard.html"));
});

function requireConfiguredApiKey(_req, res, next) {
  if (!hasGeminiCredentials()) {
    res.status(500).json({ error: "GEMINI_API_KEY is not configured." });
    return;
  }

  next();
}

function requireAppToken(req, res, next) {
  if (!sharedAccessToken) {
    res.status(500).json({ error: "APP_ACCESS_TOKEN is not configured." });
    return;
  }

  const token = req.header("x-app-token");
  if (token !== sharedAccessToken) {
    res.status(401).json({ error: "Unauthorized." });
    return;
  }

  next();
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    model,
    protected: Boolean(sharedAccessToken),
    analytics: {
      totalRequests: analytics.totalRequests,
      successes: analytics.successes,
      failures: analytics.failures,
      rateLimitErrors: analytics.rateLimitErrors,
      truncatedResponses: analytics.truncatedResponses,
      averageLatencyMs: analytics.totalRequests
        ? Math.round(analytics.totalLatencyMs / analytics.totalRequests)
        : 0,
      slowResponses: analytics.slowResponses,
      totalUsers: analytics.totalUsers,
      totalSessions: analytics.totalSessions,
      repeatSessions: analytics.repeatSessions,
      safetyResponses: analytics.safetyResponses,
      averageResponseChars: analytics.successes
        ? Math.round(analytics.totalResponseChars / analytics.successes)
        : 0
    }
  });
});

app.post("/api/memory/reset", requireAppToken, (_req, res) => {
  clearAllConversationMemory();
  res.json({ ok: true, cleared: "all" });
});

app.get("/api/dashboard-metrics", (_req, res) => {
  res.json({
    ok: true,
    model,
    protected: Boolean(sharedAccessToken),
    uptimeSeconds: Math.round(process.uptime()),
    totals: {
      totalRequests: analytics.totalRequests,
      successes: analytics.successes,
      failures: analytics.failures,
      successRate:
        analytics.totalRequests > 0
          ? Number(((analytics.successes / analytics.totalRequests) * 100).toFixed(1))
          : 0,
      rateLimitErrors: analytics.rateLimitErrors,
      truncatedResponses: analytics.truncatedResponses,
      averageLatencyMs: analytics.totalRequests
        ? Math.round(analytics.totalLatencyMs / analytics.totalRequests)
        : 0,
      slowResponses: analytics.slowResponses,
      totalUsers: analytics.totalUsers,
      totalSessions: analytics.totalSessions,
      repeatSessions: analytics.repeatSessions,
      repeatSessionRate:
        analytics.totalSessions > 0
          ? Number(((analytics.repeatSessions / analytics.totalSessions) * 100).toFixed(1))
          : 0,
      safetyResponses: analytics.safetyResponses,
      averageResponseChars: analytics.successes
        ? Math.round(analytics.totalResponseChars / analytics.successes)
        : 0
    },
    breakdowns: {
      topics: analytics.topics,
      stages: analytics.stages,
      modes: analytics.modes,
      languages: analytics.languages
    },
    recentErrors: analytics.recentErrors,
    recentTruncations: analytics.recentTruncations
  });
});

app.get(
  "/api/chat-text",
  requireConfiguredApiKey,
  (req, res, next) => {
    const token = req.query?.token;
    if (!sharedAccessToken || token !== sharedAccessToken) {
      res.status(401).type("text/plain").send("Unauthorized.");
      return;
    }

    next();
  },
  async (req, res) => {
    const startedAt = Date.now();
    const message = typeof req.query?.message === "string" ? req.query.message : "";
    const stage = typeof req.query?.stage === "string" ? req.query.stage : "";
    const topic = typeof req.query?.topic === "string" ? req.query.topic : "";
    const source = typeof req.query?.source === "string" ? req.query.source : "appinventor";
    const sessionId = typeof req.query?.sessionId === "string" ? req.query.sessionId : "";
    const userId = typeof req.query?.userId === "string" ? req.query.userId : "";
    const memoryScope = normalizeMemoryScope(req.query?.memoryMode || req.query?.memoryScope);
    const sessionKey = getSessionKey({ req, source, sessionId, userId, stage, topic, memoryScope });
    const useMemory = shouldUseMemory(memoryScope);
    if (isResetRequested(req.query?.resetMemory)) {
      clearConversationSession(sessionKey);
    }

    if (!message.trim()) {
      res.status(400).type("text/plain").send("message must be a non-empty string.");
      return;
    }

    try {
      const mode = classifyMessage(message);
      const language = detectLanguage(message);

      if (isHighRiskMessage(message)) {
        const reply = getSafetyReply(language);
        if (useMemory) {
          storeConversationTurn(sessionKey, "user", message);
          storeConversationTurn(sessionKey, "sakhi", reply);
        }
        recordSuccess(topic, reply, {
          mode: "safety",
          language,
          stage,
          sessionKey,
          userKey: typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "",
          latencyMs: Date.now() - startedAt
        });
        res.type("text/plain").send(reply);
        return;
      }

      if (mode === "casual") {
        const reply = getCasualReply(message);
        if (useMemory) {
          storeConversationTurn(sessionKey, "user", message);
          storeConversationTurn(sessionKey, "sakhi", reply);
        }
        recordSuccess(topic, reply, {
          mode,
          language,
          stage,
          sessionKey,
          userKey: typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "",
          latencyMs: Date.now() - startedAt
        });
        res.type("text/plain").send(reply);
        return;
      }

      const history = useMemory ? getConversationHistory(sessionKey) : [];
      const localKnowledgeReply = getLocalKnowledgeReply({ stage, topic, message, language, history });
      if (localKnowledgeReply) {
        if (useMemory) {
          storeConversationTurn(sessionKey, "user", message);
          storeConversationTurn(sessionKey, "sakhi", localKnowledgeReply);
        }
        recordSuccess(topic, localKnowledgeReply, {
          mode: "practical",
          language,
          stage,
          sessionKey,
          userKey: typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "",
          latencyMs: Date.now() - startedAt
        });
        res.type("text/plain").send(localKnowledgeReply);
        return;
      }

      const peerSnippets = getEffectivePeerSnippets(topic, getPeerContext(stage, topic, message));
      const text = await generateSakhiReply({
        message,
        stage,
        topic,
        language,
        peerSnippets,
        history
      });
      if (useMemory) {
        storeConversationTurn(sessionKey, "user", message);
        storeConversationTurn(sessionKey, "sakhi", text);
      }
      recordSuccess(topic, text, {
        mode,
        language,
        stage,
        sessionKey,
        userKey: typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "",
        latencyMs: Date.now() - startedAt
      });
      res.type("text/plain").send(text);
    } catch (error) {
      const language = detectLanguage(message);
      recordFailure(topic, error, {
        mode: classifyMessage(message),
        language,
        stage,
        sessionKey,
        userKey: typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "",
        latencyMs: Date.now() - startedAt
      });
      const fallback = getLocalFallbackReply({ message, topic, language });
      if (useMemory) {
        storeConversationTurn(sessionKey, "user", message);
      }
      res.type("text/plain").send(fallback);
    }
  }
);

app.post(
  "/api/chat-text",
  requireConfiguredApiKey,
  (req, res, next) => {
    const token = req.query?.token || req.header("x-app-token");
    if (!sharedAccessToken || token !== sharedAccessToken) {
      res.status(401).type("text/plain").send("Unauthorized.");
      return;
    }

    next();
  },
  async (req, res) => {
    const startedAt = Date.now();
    const message = typeof req.body === "string" ? req.body : "";
    const stage = typeof req.query?.stage === "string" ? req.query.stage : "";
    const topic = typeof req.query?.topic === "string" ? req.query.topic : "";
    const source = typeof req.query?.source === "string" ? req.query.source : "appinventor";
    const sessionId = typeof req.query?.sessionId === "string" ? req.query.sessionId : "";
    const userId = typeof req.query?.userId === "string" ? req.query.userId : "";
    const memoryScope = normalizeMemoryScope(req.query?.memoryMode || req.query?.memoryScope);
    const sessionKey = getSessionKey({ req, source, sessionId, userId, stage, topic, memoryScope });
    const useMemory = shouldUseMemory(memoryScope);
    if (isResetRequested(req.query?.resetMemory)) {
      clearConversationSession(sessionKey);
    }

    if (!message.trim()) {
      res.status(400).type("text/plain").send("message must be a non-empty string.");
      return;
    }

    try {
      const mode = classifyMessage(message);
      const language = detectLanguage(message);

      if (isHighRiskMessage(message)) {
        const reply = getSafetyReply(language);
        if (useMemory) {
          storeConversationTurn(sessionKey, "user", message);
          storeConversationTurn(sessionKey, "sakhi", reply);
        }
        recordSuccess(topic, reply, {
          mode: "safety",
          language,
          stage,
          sessionKey,
          userKey: typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "",
          latencyMs: Date.now() - startedAt
        });
        res.type("text/plain").send(reply);
        return;
      }

      if (mode === "casual") {
        const reply = getCasualReply(message);
        if (useMemory) {
          storeConversationTurn(sessionKey, "user", message);
          storeConversationTurn(sessionKey, "sakhi", reply);
        }
        recordSuccess(topic, reply, {
          mode,
          language,
          stage,
          sessionKey,
          userKey: typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "",
          latencyMs: Date.now() - startedAt
        });
        res.type("text/plain").send(reply);
        return;
      }

      const history = useMemory ? getConversationHistory(sessionKey) : [];
      const localKnowledgeReply = getLocalKnowledgeReply({ stage, topic, message, language, history });
      if (localKnowledgeReply) {
        if (useMemory) {
          storeConversationTurn(sessionKey, "user", message);
          storeConversationTurn(sessionKey, "sakhi", localKnowledgeReply);
        }
        recordSuccess(topic, localKnowledgeReply, {
          mode: "practical",
          language,
          stage,
          sessionKey,
          userKey: typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "",
          latencyMs: Date.now() - startedAt
        });
        res.type("text/plain").send(localKnowledgeReply);
        return;
      }

      const peerSnippets = getEffectivePeerSnippets(topic, getPeerContext(stage, topic, message));
      const text = await generateSakhiReply({
        message,
        stage,
        topic,
        language,
        peerSnippets,
        history
      });
      if (useMemory) {
        storeConversationTurn(sessionKey, "user", message);
        storeConversationTurn(sessionKey, "sakhi", text);
      }
      recordSuccess(topic, text, {
        mode,
        language,
        stage,
        sessionKey,
        userKey: typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "",
        latencyMs: Date.now() - startedAt
      });
      res.type("text/plain").send(text);
    } catch (error) {
      const language = detectLanguage(message);
      recordFailure(topic, error, {
        mode: classifyMessage(message),
        language,
        stage,
        sessionKey,
        userKey: typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "",
        latencyMs: Date.now() - startedAt
      });
      const fallback = getLocalFallbackReply({ message, topic, language });
      if (useMemory) {
        storeConversationTurn(sessionKey, "user", message);
      }
      res.type("text/plain").send(fallback);
    }
  }
);

app.post("/api/chat", requireConfiguredApiKey, requireAppToken, async (req, res) => {
  const startedAt = Date.now();
  const { message, userId, sessionId, stage, topic, memoryMode, memoryScope, resetMemory } = req.body ?? {};
  const normalizedMemoryScope = normalizeMemoryScope(memoryMode || memoryScope);
  const sessionKey = getSessionKey({
    req,
    source: "mit-app-inventor-ai2a",
    sessionId,
    userId,
    stage,
    topic,
    memoryScope: normalizedMemoryScope
  });
  const useMemory = shouldUseMemory(normalizedMemoryScope);
  const userKey = typeof userId === "string" && userId.trim() ? userId.trim().slice(0, 120) : "";
  if (isResetRequested(resetMemory)) {
    clearConversationSession(sessionKey);
  }

  if (typeof message !== "string" || !message.trim()) {
    res.status(400).json({ error: "message must be a non-empty string." });
    return;
  }

  try {
    const mode = classifyMessage(message);
    const language = detectLanguage(message);

    if (isHighRiskMessage(message)) {
      const reply = getSafetyReply(language);
      if (useMemory) {
        storeConversationTurn(sessionKey, "user", message);
        storeConversationTurn(sessionKey, "sakhi", reply);
      }
      recordSuccess(topic, reply, {
        mode: "safety",
        language,
        stage,
        sessionKey,
        userKey,
        latencyMs: Date.now() - startedAt
      });
      res.json({
        reply,
        model,
        mode: "safety",
        peerContextCount: 0,
        topic
      });
      return;
    }

    if (mode === "casual") {
      const reply = getCasualReply(message);
      if (useMemory) {
        storeConversationTurn(sessionKey, "user", message);
        storeConversationTurn(sessionKey, "sakhi", reply);
      }
      recordSuccess(topic, reply, {
        mode,
        language,
        stage,
        sessionKey,
        userKey,
        latencyMs: Date.now() - startedAt
      });
      res.json({
        reply,
        model,
        mode,
        peerContextCount: 0
      });
      return;
    }

    const history = useMemory ? getConversationHistory(sessionKey) : [];
    const localKnowledgeReply = getLocalKnowledgeReply({ stage, topic, message, language, history });
    if (localKnowledgeReply) {
      if (useMemory) {
        storeConversationTurn(sessionKey, "user", message);
        storeConversationTurn(sessionKey, "sakhi", localKnowledgeReply);
      }
      recordSuccess(topic, localKnowledgeReply, {
        mode: "practical",
        language,
        stage,
        sessionKey,
        userKey,
        latencyMs: Date.now() - startedAt
      });
      res.json({
        reply: localKnowledgeReply,
        model,
        mode: "practical",
        peerContextCount: 0,
        topic: inferEffectiveTopic(stage, topic, message)
      });
      return;
    }

    const peerSnippets = getEffectivePeerSnippets(topic, getPeerContext(stage, topic, message));
    const text = await generateSakhiReply({
      message,
      stage,
      topic,
      language,
      peerSnippets,
      history
    });
    if (useMemory) {
      storeConversationTurn(sessionKey, "user", message);
      storeConversationTurn(sessionKey, "sakhi", text);
    }
    recordSuccess(topic, text, {
      mode,
      language,
      stage,
      sessionKey,
      userKey,
      latencyMs: Date.now() - startedAt
    });

    res.json({
      reply: text,
      model,
      mode,
      peerContextCount: peerSnippets.length,
      topic
    });
  } catch (error) {
    const language = detectLanguage(message);
    recordFailure(topic, error, {
      mode: classifyMessage(message),
      language,
      stage,
      sessionKey,
      userKey,
      latencyMs: Date.now() - startedAt
    });
    const fallback = getLocalFallbackReply({ message, topic, language });
    if (useMemory) {
      storeConversationTurn(sessionKey, "user", message);
    }
    res.json({
      reply: fallback,
      model,
      mode: "fallback",
      peerContextCount: 0,
      topic
    });
  }
});

app.listen(port, () => {
  console.log(`Server listening on http://localhost:${port}`);
});

process.on("SIGTERM", () => {
  persistConversationStore();
  persistAnalyticsState();
  process.exit(0);
});

process.on("SIGINT", () => {
  persistConversationStore();
  persistAnalyticsState();
  process.exit(0);
});
