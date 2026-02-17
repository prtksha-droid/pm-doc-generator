require("dotenv").config();
const express = require("express");
const path = require("path");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const OpenAI = require("openai");

const app = express();

/* =========================
   EXPRESS SETUP
========================= */
app.use(cors());
app.use(express.static("public"));

app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;

/* =========================
   RENDER UPLOAD FIX
========================= */
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

const upload = multer({ dest: "uploads/" });
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});


// ✅ Run multer only when the request is multipart/form-data
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

if (!openai) {
  console.warn("⚠️ OPENAI_API_KEY missing");
}

/* =========================
   SAFE HELPERS
========================= */

function stripSlash(u) {
  return String(u || "").replace(/\/+$/, "");
}

function buildHeaders(email, token) {
  if (!email || !token) {
    throw new Error("Missing Atlassian credentials");
  }

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
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
  }
}

/* =========================
   CONFLUENCE GENERIC
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

  if (parentId) {
    payload.ancestors = [{ id: String(parentId) }];
  }

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
   JIRA GENERIC
========================= */
async function jiraCreateIssue({
  jiraBaseUrl,
  email,
  token,
  fields,
}) {
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


app.get("/", (req, res) => {
  res.status(200).send(
    "PM Doc Generator is running ✅<br/><br/>" +
    "Try: <a href='/health'>/health</a><br/>" +
    "POST endpoint: /fully-automate"
  );
});



/* =========================
   ROUTES
========================= */

app.get("/health", (req, res) => res.send("OK"));

/* =========================
   FULL AUTOMATION ROUTE
========================= */
app.post("/fully-automate", maybeMulterAny, async (req, res) => {

  try {
    const {
  jiraProjectKey,
  jiraIssueType,
  title,
  htmlContent,
  confluenceSpaceKey,
  confluenceParentId,
} = req.body;

const safeTitle =
  (typeof title === "string" ? title.trim() : "") || `PM Doc - ${new Date().toISOString()}`;

if (!safeTitle) {
  return res.status(400).json({ error: "Missing title" });
}

const jiraBaseUrl = process.env.JIRA_BASE_URL;
const confluenceBaseUrl = process.env.CONFLUENCE_BASE_URL;
const atlassianEmail = process.env.ATLASSIAN_EMAIL;
const atlassianApiToken = process.env.ATLASSIAN_API_TOKEN;
 

    if (!confluenceBaseUrl || !jiraBaseUrl) {
      return res.status(400).json({ error: "Missing Atlassian URLs" });
    }

    if (!confluenceSpaceKey) {
      return res.status(400).json({ error: "Missing confluenceSpaceKey" });
    }

console.log("DEBUG safeTitle:", safeTitle);
console.log("DEBUG htmlContent length:", (htmlContent || "").length);
console.log("DEBUG spaceKey:", confluenceSpaceKey);
console.log("DEBUG confluenceBaseUrl:", confluenceBaseUrl);


    /* ===== CREATE CONFLUENCE PAGE ===== */
    const page = await confluenceCreatePage({
      confluenceBaseUrl,
  email: atlassianEmail,
  token: atlassianApiToken,
  spaceKey: confluenceSpaceKey,
  title: safeTitle,
  html: htmlContent,
  parentId: confluenceParentId,
    });

    /* ===== CREATE JIRA ISSUE ===== */
    let jiraIssue = null;

    if (jiraProjectKey) {
      jiraIssue = await jiraCreateIssue({
        jiraBaseUrl,
        email: atlassianEmail,
        token: atlassianApiToken,
        fields: {
          project: { key: jiraProjectKey },
          summary: title,
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
    });
  } catch (err) {
    console.error("❌ Automation Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

/* =========================
   SERVER START
========================= */
app.listen(PORT, () => {
  console.log(`✅ PM Doc Generator running on ${PORT}`);
});
