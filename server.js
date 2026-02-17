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
async function generateBrdHtml({ requirementsText, title }) {
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
${requirementsText}
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

app.post("/fully-automate", maybeMulterAny, async (req, res) => {
  try {
    const {
      // Multi-tenant inputs (public testing)
      jiraBaseUrl,
      confluenceBaseUrl,
      atlassianEmail,
      atlassianApiToken,

      // Confluence/Jira settings
      confluenceSpaceKey,
      confluenceParentId,
      jiraProjectKey,
      jiraIssueType,

      // Content inputs
      title,
      htmlContent,
      requirementsText,
    } = req.body || {};

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

    const resolvedAtlassianEmail =
  (atlassianEmail || "").trim() || (process.env.ATLASSIAN_EMAIL || "").trim();

const resolvedAtlassianApiToken =
  (atlassianApiToken || "").trim() || (process.env.ATLASSIAN_API_TOKEN || "").trim();

if (!resolvedAtlassianEmail || !resolvedAtlassianApiToken) {
  return res.status(400).json({
    error:
      "Missing Atlassian credentials. Set ATLASSIAN_EMAIL and ATLASSIAN_API_TOKEN in Render Environment (recommended), or provide atlassianEmail + atlassianApiToken in the request.",
  });
}

    if (!confluenceSpaceKey) {
      return res.status(400).json({ error: "Missing confluenceSpaceKey" });
    }

    // ✅ NEW: If htmlContent is empty, generate BRD HTML from requirementsText
    let finalHtml = (htmlContent || "").toString().trim();

    if (!finalHtml) {
      const reqText = (requirementsText || "").toString().trim();
      if (!reqText) {
        return res.status(400).json({
          error:
            "Empty content: provide htmlContent OR requirementsText to generate BRD",
        });
      }
      finalHtml = await generateBrdHtml({ requirementsText: reqText, title: safeTitle });

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
    let jiraIssue = null;
    if (jiraProjectKey) {
      jiraIssue = await jiraCreateIssue({
        jiraBaseUrl,
        email: atlassianEmail,
        token: atlassianApiToken,
        fields: {
          project: { key: jiraProjectKey },
          summary: safeTitle, // ✅ FIX: never blank
          issuetype: { name: jiraIssueType || "Task" },
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: "Created via PM Doc Generator" },
                ],
              },
            ],
          },
        },
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
