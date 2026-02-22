require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const OpenAI = require("openai");

const app = express();

/* =========================
   EXPRESS SETUP
========================= */
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

// Serve UI if you have /public/index.html
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

/* =========================
   UPLOADS (Render-safe)
========================= */
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const upload = multer({ dest: "uploads/" });
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

// ✅ Run multer only when request is multipart/form-data (fixes “Failed to fetch” for JSON)
function maybeMulterAny(req, res, next) {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    return uploadMemory.any()(req, res, next);
  }
  return next();
}

/* =========================
   OPENAI
========================= */
const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

if (!openai) console.warn("⚠️ OPENAI_API_KEY missing in environment");

/* =========================
   HELPERS
========================= */
function extractRequirements(req) {
  // 1. Prefer textarea
  let text = (req.body?.requirementsText || "").toString().trim();

  // 2. Fallback to uploaded file (txt / doc text)
  if (!text && req.files && req.files.length > 0) {
    const f = req.files[0];
    if (f.buffer) {
      text = f.buffer.toString("utf8").trim();
    }
  }

  return text;
}

function stripSlash(u) {
  return String(u || "").replace(/\/+$/, "");
}

function buildHeaders(email, token) {
  if (!email || !token) throw new Error("Missing Atlassian credentials");
  const basic = Buffer.from(`${email}:${token}`).toString("base64");
  return {
    Authorization: `Basic ${basic}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function readJsonSafe(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    // Atlassian sometimes returns HTML (login/error page); show first part for debugging
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
}

/* =========================
   CONFLUENCE (generic)
========================= */
async function confluenceCreatePage({
  confluenceBaseUrl,
  email,
  token,
  spaceKey,
  title,
  html,
  parentId,
}) {
  const base = stripSlash(confluenceBaseUrl);
  const headers = buildHeaders(email, token);

  const payload = {
    type: "page",
    title,
    space: { key: spaceKey },
    body: {
      storage: {
        value: html,
        representation: "storage",
      },
    },
  };

  if (parentId) payload.ancestors = [{ id: String(parentId) }];

  const res = await fetch(`${base}/rest/api/content`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(`Confluence create page failed: ${JSON.stringify(data)}`);
  }

  return data;
}

/* =========================
   JIRA (generic)
========================= */
async function jiraCreateIssue({ jiraBaseUrl, email, token, fields }) {
  const base = stripSlash(jiraBaseUrl);
  const headers = buildHeaders(email, token);

  const res = await fetch(`${base}/rest/api/3/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fields }),
  });

  const data = await readJsonSafe(res);
  if (!res.ok) {
    throw new Error(`Jira create issue failed: ${JSON.stringify(data)}`);
  }

  return data;
}

/* =========================
   BRD GENERATOR (NEW)
========================= */
async function generateBrdHtml({ reqText, title }) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY missing in Render Environment");
  }

  const prompt = `
You are a Senior Project Manager. Create a detailed BRD in clean HTML.
Use clear headings and bullet lists.

Include sections:
1. Executive Summary
2. Objective
3. Scope (In Scope / Out of Scope)
4. Stakeholders & Roles
5. Assumptions & Dependencies
6. High-level Requirements (numbered)
7. Acceptance Criteria
8. Risks & Mitigations (table-like bullets)
9. Non-Functional Requirements
10. Milestones / Timeline (high level)
11. Open Questions

BRD Title: ${title}

Requirements:
${reqText}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

/* =========================
   GENERIC DOCUMENT GENERATOR (NEW)
========================= */
async function generateDocHtml(type, reqText, title) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY missing in Render Environment");
  }

  const prompt = `
You are a Senior Technical Program Manager.

Create a professional ${type} document in CLEAN HTML format.

Document Title: ${title}

Use structured headings and bullet lists.

Requirements:
${reqText}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  return resp.choices?.[0]?.message?.content?.trim() || "";
}

/* =========================
   ROUTES
========================= */
app.get("/health", (req, res) => res.send("OK"));

async function generateUserStories({ requirementsText, maxStories = 12 }) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY missing — cannot generate user stories");
  }

  const prompt = `
You are a Senior Product Manager.

Create Jira user stories.

VERY IMPORTANT:
- summary MUST be the FUNCTIONALITY NAME
- do NOT use generic titles

Return STRICT JSON.

Requirements:
${requirementsText}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  const raw = resp.choices?.[0]?.message?.content || "{}";

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.error("❌ Failed to parse user stories:", raw);
    return [];
  }

  const stories = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.stories)
    ? parsed.stories
    : [];

  return stories.slice(0, maxStories);
}

app.post("/fully-automate", maybeMulterAny, async (req, res) => {
  try {
    const {
  jiraBaseUrl,
  confluenceBaseUrl,
  atlassianEmail,
  atlassianApiToken,
  confluenceSpaceKey,
  confluenceParentId,
  jiraProjectKey,
  jiraIssueType,   // ⭐ ADD THIS
  title,
  requirementsText,
  htmlContent,
  createUserStories,
  maxStories,
  jiraStoryIssueType,
} = req.body;
const reqText = extractRequirements(req);
    // ✅ title fallback so Jira/Confluence never fail
    const safeTitle =
      (typeof title === "string" ? title.trim() : "") ||
      `PM Doc - ${new Date().toISOString()}`;

    const tenantDomain = (req.body.tenantDomain || "").trim(); // e.g. "prtksha.atlassian.net"

const resolvedJiraBaseUrl =
  (req.body.jiraBaseUrl || "").trim() ||
  (process.env.JIRA_BASE_URL || "").trim() ||
  (tenantDomain ? `https://${tenantDomain}` : "");

const resolvedConfluenceBaseUrl =
  (req.body.confluenceBaseUrl || "").trim() ||
  (process.env.CONFLUENCE_BASE_URL || "").trim() ||
  (tenantDomain ? `https://${tenantDomain}/wiki` : "");

// ✅ Now validate using resolved values
if (!resolvedJiraBaseUrl || !resolvedConfluenceBaseUrl) {
  return res.status(400).json({
    error:
      "Missing Atlassian URLs. Provide tenantDomain (like prtksha.atlassian.net) or set JIRA_BASE_URL + CONFLUENCE_BASE_URL in Render.",
  });
}

    if (!atlassianEmail || !atlassianApiToken) {
      return res.status(400).json({ error: "Missing Atlassian credentials" });
    }
    if (!confluenceSpaceKey) {
      return res.status(400).json({ error: "Missing confluenceSpaceKey" });
    }

    // ✅ NEW: If htmlContent is empty, generate BRD HTML from requirementsText
    let finalHtml = (htmlContent || "").toString().trim();

    if (!finalHtml) {
      const reqText = extractRequirements(req);

if (!reqText && !htmlContent) {
  return res.status(400).json({
    error:
      "Empty content: provide htmlContent OR requirementsText OR upload a file",
  });
}
      finalHtml = await generateBrdHtml({ reqText, title: safeTitle });

      if (!finalHtml) {
        return res.status(500).json({ error: "BRD generation returned empty output" });
      }
    }

    // Create Confluence page
    const page = await confluenceCreatePage({
      confluenceBaseUrl,
      email: atlassianEmail,
      token: atlassianApiToken,
      spaceKey: confluenceSpaceKey,
      title: safeTitle,
      html: finalHtml,
      parentId: confluenceParentId,
    });

    // Create Jira issue (optional)
    let createdStories = [];
if (jiraProjectKey && (String(createUserStories || "true").toLowerCase() !== "false")) {
  // Generate user stories from the same requirements used for the documents
  const stories = await generateUserStories({
    requirementsText: reqText || "",
    maxStories: Number(maxStories || 12),
  });

  for (const st of stories) {
    const descParts = [];
    if (st.description) descParts.push(st.description);
    if (st.acceptanceCriteria?.length) {
      descParts.push("\nAcceptance Criteria:");
      st.acceptanceCriteria.forEach((ac, i) => descParts.push(`${i + 1}. ${ac}`));
    }

    const issue = await jiraCreateIssue({
      jiraBaseUrl: resolvedJiraBaseUrl,
      email: atlassianEmail,
token: atlassianApiToken,
      fields: {
        project: { key: jiraProjectKey },
        summary: st.summary,
        issuetype: { name: jiraStoryIssueType || "Story" },
        description: textToAdf(descParts.join("\n").trim()),
        labels: st.labels?.slice(0, 10) || [],
      },
    });
    createdStories.push(issue);
  }
}

let jiraIssue = null;
    if (jiraProjectKey) {
      jiraIssue = await jiraCreateIssue({
        jiraBaseUrl,
        email: atlassianEmail,
        token: atlassianApiToken,
        fields: {
  project: { key: jiraProjectKey },

  // ⭐ Functionality-based name
  summary: st.summary || "Generated Story",

  issuetype: { name: jiraStoryIssueType || "Story" },

  // ⭐ Proper Jira description (ADF format)
  description: textToAdf(
    [
      `Functionality: ${st.summary}`,
      "",
      st.description || "",
      "",
      "Acceptance Criteria:",
      ...(st.acceptanceCriteria || []).map((a, i) => `${i + 1}. ${a}`),
    ].join("\n")
  ),

  labels: st.labels || ["pm-doc-generator"],
}
      });
    }

    res.json({
      confluencePageId: page.id,
      confluenceUrl: page._links?.webui,
      jiraIssue,
      usedTitle: safeTitle,
      generated: !((htmlContent || "").toString().trim()),
    });
  } catch (err) {
    console.error("❌ /fully-automate error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`✅ PM Doc Generator running on ${PORT}`);
});
