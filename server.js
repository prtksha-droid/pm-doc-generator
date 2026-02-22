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

async function generateEpicsAndStories({ requirementsText }) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY missing — cannot generate backlog");
  }

  const prompt = `
You are a Senior Agile Product Manager.

Break the requirements into MULTIPLE EPICS.
Each Epic must contain STORIES.

Return STRICT JSON in this exact format:

{
  "epics": [
    {
      "summary": "Epic Name",
      "description": "Epic description",
      "stories": [
        {
          "summary": "Story title",
          "description": "Detailed description",
          "acceptanceCriteria": ["AC1", "AC2"]
        }
      ]
    }
  ]
}

Requirements:
${requirementsText}
`;

  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
  });

  const raw = resp.choices?.[0]?.message?.content || "";

  // ⭐ Extract JSON safely even if GPT adds text
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) {
    console.error("❌ No JSON found:", raw);
    return { epics: [] };
  }

  try {
    return JSON.parse(match[0]);
  } catch (e) {
    console.error("❌ JSON parse failed:", match[0]);
    return { epics: [] };
  }
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
      jiraIssueType,
      jiraStoryIssueType,
      title,
      requirementsText, // kept for UI compatibility
      htmlContent,
      createUserStories,
      maxStories,
      tenantDomain,
    } = req.body;

    const reqText = extractRequirements(req);

    // ✅ title fallback so Jira/Confluence never fail
    const safeTitle =
      (typeof title === "string" ? title.trim() : "") ||
      `PM Doc - ${new Date().toISOString()}`;

    const tenant = (tenantDomain || "").trim(); // e.g. "prtksha.atlassian.net"

    const resolvedJiraBaseUrl =
      (String(jiraBaseUrl || "").trim()) ||
      (String(process.env.JIRA_BASE_URL || "").trim()) ||
      (tenant ? `https://${tenant}` : "");

    const resolvedConfluenceBaseUrl =
      (String(confluenceBaseUrl || "").trim()) ||
      (String(process.env.CONFLUENCE_BASE_URL || "").trim()) ||
      (tenant ? `https://${tenant}/wiki` : "");

    // ✅ Validate using resolved values
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

    // ✅ Ensure we have content to generate documents if htmlContent is not provided
    let finalHtml = (htmlContent || "").toString().trim();
    if (!finalHtml) {
      if (!reqText) {
        return res.status(400).json({
          error:
            "Empty content: provide htmlContent OR requirementsText OR upload a file",
        });
      }

      finalHtml = await generateBrdHtml({ reqText, title: safeTitle });

      if (!finalHtml) {
        return res
          .status(500)
          .json({ error: "BRD generation returned empty output" });
      }
    }

    // 1) Create BRD Confluence page
    const page = await confluenceCreatePage({
      confluenceBaseUrl: resolvedConfluenceBaseUrl,
      email: atlassianEmail,
      token: atlassianApiToken,
      spaceKey: confluenceSpaceKey,
      title: safeTitle,
      html: finalHtml,
      parentId: confluenceParentId,
    });

    // 2) Create additional documents as child pages (FRS / SOW / RAID / TestPlan)
    const docTypes = ["FRS", "SOW", "RAID", "TestPlan"];
    const createdDocs = [];

    for (const type of docTypes) {
      const html = await generateDocHtml(type, reqText || finalHtml, safeTitle);
      if (!html) continue;

      const docPage = await confluenceCreatePage({
        confluenceBaseUrl: resolvedConfluenceBaseUrl,
        email: atlassianEmail,
        token: atlassianApiToken,
        spaceKey: confluenceSpaceKey,
        title: `${safeTitle} - ${type}`,
        html,
        parentId: page.id,
      });

      createdDocs.push({ type, id: docPage.id, url: docPage._links?.webui });
    }

    // 3) Jira: create a parent issue (optional) + user stories (optional)
    // 3) Jira: TEAM MANAGED – MULTIPLE EPICS + STORIES
let createdStories = [];
let createdEpics = [];

if (jiraProjectKey) {

  const runStories =
    createUserStories === undefined
      ? true
      : String(createUserStories).toLowerCase() !== "false";

  if (runStories) {

    const backlog = await generateEpicsAndStories({
      requirementsText: reqText || "",
    });

    for (const epic of backlog.epics || []) {

      // ⭐ CREATE EPIC
      const epicIssue = await jiraCreateIssue({
        jiraBaseUrl: resolvedJiraBaseUrl,
        email: atlassianEmail,
        token: atlassianApiToken,
        fields: {
          project: { key: jiraProjectKey },
          summary: epic.summary || safeTitle,
          issuetype: { name: "Epic" },
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: epic.description || reqText || safeTitle },
                ],
              },
            ],
          },
        },
      });

      createdEpics.push(epicIssue);

      // ⭐ CREATE STORIES UNDER THIS EPIC (TEAM MANAGED MAGIC)
      for (const st of epic.stories || []) {

        const descParts = [];
        if (st.description) descParts.push(st.description);

        if (st.acceptanceCriteria?.length) {
          descParts.push("\nAcceptance Criteria:");
          st.acceptanceCriteria.forEach((ac, i) =>
            descParts.push(`${i + 1}. ${ac}`)
          );
        }

        const storyIssue = await jiraCreateIssue({
          jiraBaseUrl: resolvedJiraBaseUrl,
          email: atlassianEmail,
          token: atlassianApiToken,
          fields: {
            project: { key: jiraProjectKey },
            summary: st.summary || safeTitle,
            issuetype: { name: jiraStoryIssueType || "Story" },

            // ⭐ THIS LINKS STORY TO EPIC (TEAM MANAGED)
            parent: { key: epicIssue.key },

            description: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text:
                        descParts.join("\n") ||
                        st.description ||
                        safeTitle,
                    },
                  ],
                },
              ],
            },
          },
        });

        createdStories.push(storyIssue);
      }
    }
  }
}


    return res.json({
		
		
		// ⭐ THIS IS WHAT YOUR UI EXPECTS
  backlog: {
    epics: createdEpics || [],
    stories: createdStories || [],
  },
      confluencePageId: page.id,
      confluenceUrl: page._links?.webui,
      docs: createdDocs,
      createdStories,
      usedTitle: safeTitle,
      generated: !((htmlContent || "").toString().trim()),
	  
	   
	  
    });
  } catch (err) {
    console.error("❌ /fully-automate error:", err.message);
    return res.status(500).json({ error: err.message });
  }
});


/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`✅ PM Doc Generator running on ${PORT}`);
});
