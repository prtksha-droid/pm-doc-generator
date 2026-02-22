
/*
PM DOC GENERATOR — OPTION B (Download + Attach Documents)
NO existing functionality removed.
Adds:
- BRD / FRS / SOW / RAID DOCX generation
- ZIP download
- Confluence attachment upload
*/

require("dotenv").config();
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const OpenAI = require("openai");
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");
const archiver = require("archiver");

const app = express();
app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static("public"));

const PORT = process.env.PORT || 3000;

if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const uploadMemory = multer({ storage: multer.memoryStorage() });

function maybeMulterAny(req, res, next) {
  const ct = req.headers["content-type"] || "";
  if (ct.includes("multipart/form-data")) {
    return uploadMemory.any()(req, res, next);
  }
  return next();
}

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function stripSlash(u) {
  return String(u || "").replace(/\/+$/, "");
}

function buildHeaders(email, token) {
  const basic = Buffer.from(`${email}:${token}`).toString("base64");
  return {
    Authorization: `Basic ${basic}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function readJsonSafe(res) {
  const text = await res.text();
  try { return JSON.parse(text); } catch { return {}; }
}

async function confluenceCreatePage({
  confluenceBaseUrl,
  email,
  token,
  spaceKey,
  title,
  html,
  parentId,
}) {
  const headers = buildHeaders(email, token);

  const payload = {
    type: "page",
    title,
    space: { key: spaceKey },
    body: { storage: { value: html, representation: "storage" } },
  };

  if (parentId) payload.ancestors = [{ id: String(parentId) }];

  const res = await fetch(
    `${stripSlash(confluenceBaseUrl)}/rest/api/content`,
    { method: "POST", headers, body: JSON.stringify(payload) }
  );

  const rawText = await res.text();

if (!res.ok) {
  console.error("❌ Confluence RAW RESPONSE:", rawText);
  throw new Error(`Confluence error ${res.status}: ${rawText}`);
}

let data = {};
try {
  data = rawText ? JSON.parse(rawText) : {};
} catch {
  console.warn("⚠️ Confluence response not JSON");
}

return data;
}

async function attachFile({
  confluenceBaseUrl,
  email,
  token,
  pageId,
  filePath,
}) {
  const FormData = require("form-data");
  const fetch = global.fetch;
  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));

  const basic = Buffer.from(`${email}:${token}`).toString("base64");

  await fetch(
    `${stripSlash(confluenceBaseUrl)}/rest/api/content/${pageId}/child/attachment`,
    {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "X-Atlassian-Token": "no-check",
      },
      body: form,
    }
  );
}

async function jiraCreateIssue({ jiraBaseUrl, email, token, fields }) {
  const headers = buildHeaders(email, token);
  const res = await fetch(`${stripSlash(jiraBaseUrl)}/rest/api/3/issue`, {
    method: "POST",
    headers,
    body: JSON.stringify({ fields }),
  });
  return await readJsonSafe(res);
}

async function generateDocHtml(type, requirementsText, title) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: `Create a ${type} document in professional format.\nTitle:${title}\nRequirements:${requirementsText}`,
      },
    ],
  });
  return resp.choices?.[0]?.message?.content || "";
}

async function htmlToDocx(fileName, content) {
  const doc = new Document({
    sections: [{
      children: [
        new Paragraph({
          text: fileName,
          heading: HeadingLevel.HEADING_1,
        }),
        new Paragraph(new TextRun(content)),
      ],
    }],
  });

  const buffer = await Packer.toBuffer(doc);
  const filePath = path.join("uploads", fileName + ".docx");
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function createZip(files, title) {
  const zipPath = path.join("uploads", `${title}-docs.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip");
  archive.pipe(output);
  files.forEach(f => archive.file(f, { name: path.basename(f) }));
  await archive.finalize();
  return zipPath;
}

app.post("/fully-automate", maybeMulterAny, async (req, res) => {
  try {
    const {
      jiraBaseUrl,
      confluenceBaseUrl,
      atlassianEmail,
      atlassianApiToken,
      confluenceSpaceKey,
      jiraProjectKey,
      title,
      requirementsText,
    } = req.body;

    const safeTitle =
  (title || "PM Docs") +
  " - " +
  new Date().toISOString().replace(/[:.]/g, "-");

    const resolvedJiraBaseUrl = jiraBaseUrl || process.env.JIRA_BASE_URL;
    const resolvedConfluenceBaseUrl =
      confluenceBaseUrl || process.env.CONFLUENCE_BASE_URL;
    const resolvedEmail = atlassianEmail || process.env.ATLASSIAN_EMAIL;
    const resolvedToken =
      atlassianApiToken || process.env.ATLASSIAN_API_TOKEN;

    const parentPage = await confluenceCreatePage({
      confluenceBaseUrl: resolvedConfluenceBaseUrl,
      email: resolvedEmail,
      token: resolvedToken,
      spaceKey: confluenceSpaceKey,
      title: safeTitle,
      html: "<p>Generated Project Pack</p>",
    });

    const types = ["BRD", "FRS", "SOW", "RAID"];
    const files = [];

    for (const t of types) {
      const html = await generateDocHtml(t, requirementsText, safeTitle);
      const file = await htmlToDocx(`${t}-${safeTitle}`, html);
      files.push(file);

      await attachFile({
        confluenceBaseUrl: resolvedConfluenceBaseUrl,
        email: resolvedEmail,
        token: resolvedToken,
        pageId: parentPage.id,
        filePath: file,
      });
    }

    const zipPath = await createZip(files, safeTitle);

    let jiraIssue = null;
    if (jiraProjectKey) {
      jiraIssue = await jiraCreateIssue({
        jiraBaseUrl: resolvedJiraBaseUrl,
        email: resolvedEmail,
        token: resolvedToken,
        fields: {
          project: { key: jiraProjectKey },
          summary: safeTitle,
          issuetype: { name: "Task" },
        },
      });
    }

    res.json({
      confluencePageId: parentPage.id,
      downloadZip: `/` + zipPath,
      jiraIssue,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () =>
  console.log("PM Doc Generator running with DOCUMENT MODE B")
);
