const {setGlobalOptions} = require("firebase-functions/v2");
const {onCall, HttpsError} = require("firebase-functions/v2/https");

setGlobalOptions({maxInstances: 10});

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "from", "your", "you", "are", "our",
  "this", "will", "have", "has", "into", "use", "using", "job", "role",
  "work", "team", "years", "year", "plus", "who", "all", "any", "not", "but",
]);

function normalizeText(text) {
  return (text || "").toLowerCase().replace(/[^a-z0-9+\s]/g, " ");
}

function extractKeywords(text) {
  const words = normalizeText(text).split(/\s+/).filter(Boolean);
  const filtered = words.filter((word) => word.length > 2 && !STOP_WORDS.has(word));
  return [...new Set(filtered)];
}

function buildHeuristicAnalysis(resumeText, jdText) {
  const resumeKeywords = extractKeywords(resumeText);
  const jdKeywords = extractKeywords(jdText);
  const resumeSet = new Set(resumeKeywords);

  const matched = jdKeywords.filter((word) => resumeSet.has(word));
  const missing = jdKeywords.filter((word) => !resumeSet.has(word)).slice(0, 10);

  const jdKeywordCount = Math.max(jdKeywords.length, 1);
  const overlapRatio = matched.length / jdKeywordCount;
  const fitScore = Math.min(100, Math.max(10, Math.round(overlapRatio * 100)));

  const topMatched = matched.slice(0, 3);
  const topMissing = missing.slice(0, 2);
  const skillPhrase = topMatched.length ?
    topMatched.join(", ") :
    "backend APIs, debugging, and delivery ownership";
  const gapPhrase = topMissing.length ? ` (${topMissing.join(", ")})` : "";
  const suggestedBullets = [
    "Built and shipped production-ready features with clear ownership from implementation to testing.",
    `Delivered measurable improvements using ${skillPhrase}, and documented architectural trade-offs for maintainability.`,
    "Collaborated across product and engineering to convert requirements into reliable deliverables and faster release cycles.",
    `Improved profile fit by aligning outcomes to JD expectations${gapPhrase} and quantifying impact in resume bullets.`,
  ];

  return {
    fitScore,
    matchedSkills: matched.slice(0, 12),
    missingSkills: missing,
    suggestedBullets,
    explanation: `Estimated fit is ${fitScore}% based on resume and job description overlap. Add stronger project evidence for missing skills to improve match quality.`,
  };
}

async function maybeRunOpenAi(resumeText, jdText, role, company) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const prompt = [
    "You are a career assistant for software roles.",
    "Given the same input, produce a stable deterministic result.",
    "Return strict JSON with keys:",
    "fitScore (number 0-100), matchedSkills (string[]), missingSkills (string[]),",
    "suggestedBullets (string[] max 5), explanation (string max 260 chars).",
    `Role: ${role || "unknown"}`,
    `Company: ${company || "unknown"}`,
    `Resume: ${resumeText}`,
    `JobDescription: ${jdText}`,
  ].join("\n");

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      seed: 42,
      response_format: {type: "json_object"},
      messages: [
        {role: "system", content: "Return only valid JSON."},
        {role: "user", content: prompt},
      ],
    }),
  });

  if (!response.ok) return null;
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) return null;

  const parsed = JSON.parse(content);
  return {
    fitScore: Number(parsed.fitScore) || 0,
    matchedSkills: Array.isArray(parsed.matchedSkills) ? parsed.matchedSkills : [],
    missingSkills: Array.isArray(parsed.missingSkills) ? parsed.missingSkills : [],
    suggestedBullets: Array.isArray(parsed.suggestedBullets) ? parsed.suggestedBullets : [],
    explanation: typeof parsed.explanation === "string" ? parsed.explanation : "",
  };
}

exports.analyzeJobFit = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Sign in is required.");
  }

  const resumeText = String(request.data?.resumeText || "").trim();
  const jdText = String(request.data?.jdText || "").trim();
  const role = String(request.data?.role || "").trim();
  const company = String(request.data?.company || "").trim();

  if (!resumeText) {
    throw new HttpsError("invalid-argument", "resumeText is required.");
  }
  if (!jdText) {
    throw new HttpsError("invalid-argument", "jdText is required.");
  }

  try {
    const aiAnalysis = await maybeRunOpenAi(resumeText, jdText, role, company);
    if (aiAnalysis) return aiAnalysis;
  } catch (error) {
    console.error("OpenAI analysis failed, using heuristic fallback.", error);
  }

  return buildHeuristicAnalysis(resumeText, jdText);
});
