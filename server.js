require("dotenv").config();
const express = require("express");
const path = require("path");
const multer = require("multer");
const cors = require("cors");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const OpenAI = require("openai");
const upload = multer({ dest: "uploads/" });

/**
 * ✅ Ensure `fetch` exists in Node.
 * - Node 18+ has global fetch.
 * - Otherwise fall back to undici.
 */
let fetchFn = global.fetch;
if (!fetchFn) {
  try {
    fetchFn = require("undici").fetch;
  } catch (e) {
    console.warn("❗ fetch() not available. Use Node 18+ OR run: npm i undici");
  }
}
const fetch = (...args) => {
  if (!fetchFn) throw new Error("fetch() is not available. Use Node 18+ or install undici.");
  return fetchFn(...args);
};

const app = express();
const PORT = 3000;

// ---------- OpenAI client (SAFE) ----------
const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

if (!openai) {
  console.warn("Warning: OPENAI_API_KEY not set. /ai-draft and /fully-automate will error.");
}

console.log("Atlassian site:", process.env.ATLASSIAN_SITE);

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(express.static(path.join(__dirname, "public")));

// Multer setup: in-memory for template & attachments
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
});

/* =========================================================
   Atlassian (Jira + Confluence) helpers
   ========================================================= */

function getAtlassianConfig() {
  const site = process.env.ATLASSIAN_SITE;
  const email = process.env.ATLASSIAN_EMAIL;
  const token = process.env.ATLASSIAN_API_TOKEN;

  if (!site || !email || !token) {
    throw new Error("Missing ATLASSIAN_SITE / ATLASSIAN_EMAIL / ATLASSIAN_API_TOKEN in .env");
  }

  const basic = Buffer.from(`${email}:${token}`).toString("base64");
  return {
    site,
    headers: {
      Authorization: `Basic ${basic}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  };
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function makeStamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function uniqueTitle(base) {
  // Avoid Confluence "title already exists" by adding timestamp + short random
  const rand = Math.random().toString(16).slice(2, 6);
  return `${base} – ${makeStamp()}-${rand}`;
}

function safeString(s) {
  return (typeof s === "string" ? s : "").trim();
}

function ensureDocHasContent(doc, fallbackTitle, extracted) {
  // If AI gives empty doc, inject minimal useful content
  const out = doc && typeof doc === "object" ? doc : {};
  out.title = safeString(out.title) || fallbackTitle;

  const sections = Array.isArray(out.sections) ? out.sections : [];
  const hasAnyText =
    sections.some((x) => safeString(x?.h) || safeString(x?.body)) ||
    safeString(out.title);

  if (!hasAnyText || sections.length === 0) {
    out.sections = [
      { h: "Overview", body: extracted ? extracted.slice(0, 1200) : "(No requirements provided)" },
      {
        h: "Notes",
        body: "This document was generated automatically. If any sections are missing, add more detailed requirements and re-run.",
      },
    ];
  } else {
    // Clean: ensure each section has strings
    out.sections = sections.map((s) => ({
      h: safeString(s?.h),
      body: safeString(s?.body),
    }));
  }
  return out;
}

function docToConfluenceHtml(doc) {
  if (!doc) return "<p>(empty)</p>";
  const sections = Array.isArray(doc.sections) ? doc.sections : [];

  let html = `<h1>${escapeHtml(doc.title || "")}</h1>`;
  if (!sections.length) {
    html += `<p>(No sections)</p>`;
    return html;
  }

  sections.forEach((sec) => {
    html += `<h2>${escapeHtml(sec.h || "")}</h2>`;
    // Confluence storage format likes <p> blocks; preserve line breaks
    const body = escapeHtml(sec.body || "").replaceAll("\n", "<br/>");
    html += `<p>${body}</p>`;
  });

  return html;
}

function raidToConfluenceHtml(raid) {
  const r = raid && typeof raid === "object" ? raid : {};
  const title = safeString(r.title) || "RAID Log";

  const list = (items, withMitigation) => {
    const arr = Array.isArray(items) ? items : [];
    if (!arr.length) return `<p>(none)</p>`;
    return `
      <table>
        <tbody>
          ${arr
            .map((x) => {
              const item = escapeHtml(x?.item || "");
              const owner = escapeHtml(x?.owner || "TBD");
              const status = escapeHtml(x?.status || "TBD");
              const mit = withMitigation ? escapeHtml(x?.mitigation || "") : "";
              return `
                <tr>
                  <td><strong>${item}</strong><br/><em>Owner:</em> ${owner} &nbsp; <em>Status:</em> ${status}${
                withMitigation && mit ? `<br/><em>Mitigation:</em> ${mit}` : ""
              }</td>
                </tr>
              `;
            })
            .join("")}
        </tbody>
      </table>
    `;
  };

  return `
    <h1>${escapeHtml(title)}</h1>
    <h2>Risks</h2>
    ${list(r.risks, true)}
    <h2>Assumptions</h2>
    ${list(r.assumptions, false)}
    <h2>Issues</h2>
    ${list(r.issues, false)}
    <h2>Dependencies</h2>
    ${list(r.dependencies, false)}
  `;
}

async function confluenceGetSpace(spaceKey) {
  const { site, headers } = getAtlassianConfig();
  const url = `${site}/wiki/rest/api/space/${encodeURIComponent(spaceKey)}`;
  const res = await fetch(url, { headers });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) return null;
  return data;
}

async function confluenceCreatePage({ spaceKey, title, html, parentId }) {
  const { site, headers } = getAtlassianConfig();
  const url = `${site}/wiki/rest/api/content`;

  const body = {
    type: "page",
    title,
    space: { key: spaceKey },
    body: { storage: { value: html, representation: "storage" } },
  };
  if (parentId) body.ancestors = [{ id: String(parentId) }];

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    // Provide clearer “space not found / permission” signal
    const msg = data?.message || JSON.stringify(data);
    throw new Error(`Confluence create page failed: ${msg}`);
  }
  return data; // includes id + _links.webui
}

async function jiraCreateIssue(fields) {
  const { site, headers } = getAtlassianConfig();
  const url = `${site}/rest/api/3/issue`;

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ fields }),
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }

  if (!res.ok) {
    const details =
      (data?.errorMessages && data.errorMessages.join(", ")) ||
      (data?.errors && JSON.stringify(data.errors)) ||
      JSON.stringify(data);
    throw new Error(`Jira create issue failed: ${details}`);
  }
  return data; // { id, key }
}

// Cache Jira field list for “Epic Link” custom field detection
let _jiraFieldsCache = null;
async function jiraGetFields() {
  if (_jiraFieldsCache) return _jiraFieldsCache;
  const { site, headers } = getAtlassianConfig();
  const res = await fetch(`${site}/rest/api/3/field`, { headers });
  const text = await res.text();
  let data = [];
  try {
    data = text ? JSON.parse(text) : [];
  } catch {
    data = [];
  }
  if (!res.ok) throw new Error(`Jira field list failed: ${text.slice(0, 200)}`);
  _jiraFieldsCache = data;
  return data;
}
async function jiraFindEpicLinkFieldId() {
  const fields = await jiraGetFields();
  const epicLink = fields.find((f) => f?.name === "Epic Link");
  return epicLink?.id || null; // e.g., customfield_10014
}

async function jiraCreateStoryWithEpic({ jiraProjectKey, epicKey, summary, descText, labels }) {
  // 1) Team-managed: parent
  if (epicKey) {
    try {
      return await jiraCreateIssue({
        project: { key: jiraProjectKey },
        issuetype: { name: "Story" },
        summary,
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: descText }] }],
        },
        labels,
        parent: { key: epicKey },
      });
    } catch (e) {
      // fallthrough
    }
  }

  // 2) Company-managed: Epic Link field
  if (epicKey) {
    const epicLinkFieldId = await jiraFindEpicLinkFieldId();
    if (epicLinkFieldId) {
      try {
        const fields = {
          project: { key: jiraProjectKey },
          issuetype: { name: "Story" },
          summary,
          description: {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: descText }] }],
          },
          labels,
        };
        fields[epicLinkFieldId] = epicKey;
        return await jiraCreateIssue(fields);
      } catch (e) {
        // fallthrough
      }
    }
  }

  // 3) Fallback: create unlinked
  return await jiraCreateIssue({
    project: { key: jiraProjectKey },
    issuetype: { name: "Story" },
    summary,
    description: {
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: descText }] }],
    },
    labels,
  });
}

/* =========================================================
   Atlassian diagnose endpoint (keep BEFORE catch-all)
   ========================================================= */
app.get("/atlassian/diagnose", async (req, res) => {
  try {
    const { site, headers } = getAtlassianConfig();

    const r1 = await fetch(`${site}/rest/api/3/myself`, { headers });
    const t1 = await r1.text();

    const r2 = await fetch(`${site}/wiki/rest/api/space?limit=1`, { headers });
    const t2 = await r2.text();

    res.json({
      site,
      jiraMyselfStatus: r1.status,
      jiraMyselfSample: t1.slice(0, 200),
      confluenceSpaceStatus: r2.status,
      confluenceSpaceSample: t2.slice(0, 200),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* =========================================================
   AI Draft endpoint
   ========================================================= */
app.post("/ai-draft", async (req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({
        error: "AI is not configured on the server. Please set OPENAI_API_KEY.",
      });
    }

    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing or invalid prompt." });
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "You structure project management documents (BRD, FRS, SOW, RAID, etc.) into clean JSON fields.",
        },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
    });

    const content = completion.choices?.[0]?.message?.content || "{}";
    let parsed = {};
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {};
    }

    return res.json({ parsed });
  } catch (err) {
    console.error("AI draft error:", err);
    return res.status(500).json({
      error: "AI draft error: " + (err.message || "Unknown error."),
    });
  }
});

/* =========================================================
   Fully Automate (Preview + Optional Publish)
   ========================================================= */
app.post("/fully-automate", uploadMemory.single("requirementsFile"), async (req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({
        error: "AI is not configured on the server. Please set OPENAI_API_KEY.",
      });
    }

    const publish = String(req.body?.publish || "false") === "true";

    const {
      requirementsText = "",
      projectName = "",
      jiraProjectKey = "",
      confluenceSpaceKey = "",
      priorityScheme = "P0,P1,P2,P3",
      labels = "",
    } = req.body || {};

    // Publish validations early
    if (publish && !jiraProjectKey) {
      return res.status(400).json({ error: "publish=true requires jiraProjectKey" });
    }
    if (publish && !confluenceSpaceKey) {
      return res.status(400).json({ error: "publish=true requires confluenceSpaceKey" });
    }

    const file = req.file; // optional
    let extracted = requirementsText || "";
    if (file?.buffer) {
      extracted += "\n\n[FILE_CONTENT]\n" + file.buffer.toString("utf-8");
    }

    // Stronger prompt to reduce empty outputs
    const prompt = `
You are a PM automation engine.

Input requirements:
${extracted}

Generate STRICT JSON with these keys only:

{
  "meta": { "projectName": string, "jiraProjectKey": string, "confluenceSpaceKey": string },
  "docs": {
    "brd": { "title": string, "sections": [{ "h": string, "body": string }] },
    "frs": { "title": string, "sections": [{ "h": string, "body": string }] },
    "sow": { "title": string, "sections": [{ "h": string, "body": string }] },
    "raid": {
      "title": string,
      "risks": [{ "item": string, "mitigation": string, "owner": string, "status": string }],
      "assumptions": [{ "item": string, "owner": string, "status": string }],
      "issues": [{ "item": string, "owner": string, "status": string }],
      "dependencies": [{ "item": string, "owner": string, "status": string }]
    },
    "backlogSummary": { "title": string, "body": string }
  },
  "backlog": {
    "epics": [{ "name": string, "description": string }],
    "stories": [{
      "epicName": string,
      "summary": string,
      "story": string,
      "acceptanceCriteria": [string],
      "priority": "P0"|"P1"|"P2"|"P3",
      "storyPoints": 1|2|3|5|8|13
    }]
  },
  "notes": { "assumptions": [string], "openQuestions": [string] }
}

Rules:
- MUST populate docs.*.sections with meaningful content (at least 4 sections each) even if you must infer.
- RAID arrays must contain at least 2 items each; if unknown, add sensible placeholders and add to notes.assumptions.
- Story points must follow Fibonacci (1,2,3,5,8,13).
- No severity.
- If info is missing, add to notes.assumptions and proceed.
- Keep output concise but complete.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: "Return valid JSON only." },
        { role: "user", content: prompt },
      ],
      response_format: { type: "json_object" },
      temperature: 0.2,
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = { error: "JSON parse failed", raw };
    }

    // Ensure meta has values
    parsed.meta = parsed.meta || {};
    parsed.meta.projectName = parsed.meta.projectName || projectName || "Project";
    parsed.meta.jiraProjectKey = parsed.meta.jiraProjectKey || jiraProjectKey || "";
    parsed.meta.confluenceSpaceKey = parsed.meta.confluenceSpaceKey || confluenceSpaceKey || "";

    // Ensure docs not empty (fallback protection)
    parsed.docs = parsed.docs || {};
    parsed.docs.brd = ensureDocHasContent(parsed.docs.brd, "BRD", extracted);
    parsed.docs.frs = ensureDocHasContent(parsed.docs.frs, "FRS", extracted);
    parsed.docs.sow = ensureDocHasContent(parsed.docs.sow, "SOW", extracted);

    // Ensure RAID structure exists
    parsed.docs.raid = parsed.docs.raid || {
      title: "RAID Log",
      risks: [],
      assumptions: [],
      issues: [],
      dependencies: [],
    };
    parsed.docs.raid.title = safeString(parsed.docs.raid.title) || "RAID Log";
    parsed.docs.raid.risks = Array.isArray(parsed.docs.raid.risks) ? parsed.docs.raid.risks : [];
    parsed.docs.raid.assumptions = Array.isArray(parsed.docs.raid.assumptions) ? parsed.docs.raid.assumptions : [];
    parsed.docs.raid.issues = Array.isArray(parsed.docs.raid.issues) ? parsed.docs.raid.issues : [];
    parsed.docs.raid.dependencies = Array.isArray(parsed.docs.raid.dependencies) ? parsed.docs.raid.dependencies : [];

    // Preview mode (existing behavior)
    if (!publish) {
      return res.json({ runId: Date.now().toString(), output: parsed });
    }

    const labelArr = (labels || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    /* ---------------------------
       1) Publish to Confluence
       --------------------------- */
    // Validate space key before trying to create pages (gives much clearer error)
    const space = await confluenceGetSpace(confluenceSpaceKey);
    if (!space) {
      return res.status(400).json({
        error:
          `Confluence space not found or no permission for spaceKey="${confluenceSpaceKey}". ` +
          `Tip: Your personal space key usually looks like "~<accountId...>" (example from diagnose).`,
      });
    }

    const baseName = parsed?.meta?.projectName || "Project";

    const parent = await confluenceCreatePage({
      spaceKey: confluenceSpaceKey,
      title: uniqueTitle(`PM Doc Pack – ${baseName}`),
      html: `<p><strong>Auto-generated by PM Doc Generator.</strong></p>
<p>Includes BRD, FRS, SOW, RAID and a Jira backlog.</p>`,
    });

    const parentUrl =
      parent?._links?.webui ? `${process.env.ATLASSIAN_SITE}/wiki${parent._links.webui}` : "";

    const brd = await confluenceCreatePage({
      spaceKey: confluenceSpaceKey,
      title: uniqueTitle(`BRD – ${baseName}`),
      html: docToConfluenceHtml(parsed?.docs?.brd),
      parentId: parent.id,
    });

    const frs = await confluenceCreatePage({
      spaceKey: confluenceSpaceKey,
      title: uniqueTitle(`FRS – ${baseName}`),
      html: docToConfluenceHtml(parsed?.docs?.frs),
      parentId: parent.id,
    });

    const sow = await confluenceCreatePage({
      spaceKey: confluenceSpaceKey,
      title: uniqueTitle(`SOW – ${baseName}`),
      html: docToConfluenceHtml(parsed?.docs?.sow),
      parentId: parent.id,
    });

    const raid = await confluenceCreatePage({
      spaceKey: confluenceSpaceKey,
      title: uniqueTitle(`RAID – ${baseName}`),
      html: raidToConfluenceHtml(parsed?.docs?.raid),
      parentId: parent.id,
    });

    const pageUrl = (p) =>
      p?._links?.webui ? `${process.env.ATLASSIAN_SITE}/wiki${p._links.webui}` : "";

    /* ---------------------------
       2) Publish to Jira
       --------------------------- */
    const epicKeyByName = new Map();
    const createdEpics = [];
    const createdStories = [];

    // Create epics first
    for (const e of parsed?.backlog?.epics || []) {
      const created = await jiraCreateIssue({
        project: { key: jiraProjectKey },
        issuetype: { name: "Epic" },
        summary: e.name,
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: e.description || "" }] }],
        },
        labels: labelArr,
      });

      epicKeyByName.set(e.name, created.key);
      createdEpics.push(created.key);
    }

    // Create stories
    for (const s of parsed?.backlog?.stories || []) {
      const epicKey = epicKeyByName.get(s.epicName);

      const descText =
        `${s.story || ""}\n\n` +
        `Acceptance Criteria:\n- ${(s.acceptanceCriteria || []).join("\n- ")}\n\n` +
        (parentUrl ? `Docs: ${parentUrl}` : "");

      const created = await jiraCreateStoryWithEpic({
        jiraProjectKey,
        epicKey,
        summary: s.summary,
        descText,
        labels: labelArr,
      });

      createdStories.push(created.key);
    }

    return res.json({
      runId: Date.now().toString(),
      output: parsed,
      published: {
        confluence: {
          parent: parentUrl,
          brd: pageUrl(brd),
          frs: pageUrl(frs),
          sow: pageUrl(sow),
          raid: pageUrl(raid),
        },
        jira: {
          epics: createdEpics,
          stories: createdStories,
        },
      },
    });
  } catch (err) {
    console.error("Fully automate error:", err);
    return res.status(500).json({
      error: err.message || "Failed to run fully automate.",
    });
  }
});

/* =========================================================
   AI: Sprint Retrospective Analyze
   ========================================================= */
app.post("/sprint-retro-analyze", upload.single("retroExcel"), async (req, res) => {
  try {
    const { prompt } = req.body;
    const ExcelJS = require("exceljs");
    const fs = require("fs");

    let excelSummary = "";

    if (req.file) {
      try {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.readFile(req.file.path);
        const sheet = workbook.worksheets[0];

        const rows = [];
        sheet.eachRow((row) => {
          const values = row.values.slice(1, 6);
          rows.push(values);
        });

        excelSummary = JSON.stringify(rows.slice(0, 30));
      } catch (e) {
        console.warn("Sprint Retro: failed to read Excel:", e.message);
      } finally {
        fs.unlink(req.file.path, () => {});
      }
    }

    const fullPrompt = `
You are an Agile coach generating a Sprint Retrospective.

The user provided this context (free text / voice to text):
${prompt || "(no explicit context text)"}

User Stories Excel snapshot (if any, rows and columns, may be empty):
${excelSummary || "(no excel attached)"}

Create a concise retrospective in JSON with:
- whatWentWell: array of strings
- whatDidNotGoWell: array of strings
- improvements: array of strings
- actionItems: array of strings (each like "Item – Owner – Due Date")
- kudos: array of strings
- summary: a short narrative (3–6 sentences)

Return ONLY valid JSON, no markdown, no commentary.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "You are a precise JSON generator. Always return valid JSON only." },
        { role: "user", content: fullPrompt },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || "{}";

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.warn("Sprint Retro: JSON parse failed, returning raw:", e.message);
      parsed = { summary: raw };
    }

    return res.json({ retro: parsed });
  } catch (err) {
    console.error("Sprint Retro analyze error:", err);
    return res.status(500).json({
      error: "Failed to generate retrospective.",
      details: err.message || String(err),
    });
  }
});

/* =========================================================
   AI: Automated Code Review
   ========================================================= */
app.post("/code-review", express.json(), async (req, res) => {
  try {
    const { language = "unknown", context = "general", code = "" } = req.body || {};

    if (!code || code.trim().length < 10) {
      return res.status(400).json({
        error: "Please provide some code (at least 10 characters) to review.",
      });
    }

    const prompt = `
You are a senior software engineer and code reviewer.

Language: ${language}
Context: ${context}

Here is the code to review:

\`\`\`
${code}
\`\`\`

Perform a concise, structured code review with:
1. Summary
2. Issues by Severity
3. Design & Readability
4. Performance & Security
5. Recommended Refactors
6. Overall Score

Return markdown-style text.
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.3,
      messages: [
        { role: "system", content: "You are strict but constructive. Be specific and actionable." },
        { role: "user", content: prompt },
      ],
    });

    const reviewText = completion.choices?.[0]?.message?.content || "";
    return res.json({ review: reviewText });
  } catch (err) {
    console.error("Code review error:", err);
    return res.status(500).json({
      error: "Failed to run code review.",
      details: err.message || String(err),
    });
  }
});

/* =========================================================
   DOCX generation endpoint (unchanged)
   ========================================================= */
app.post(
  "/generate-docx",
  uploadMemory.fields([
    { name: "templateDocx", maxCount: 1 },
    { name: "requirementsFile", maxCount: 1 },
  ]),
  (req, res) => {
    try {
      const files = req.files || {};
      const templateFiles = files["templateDocx"] || [];
      if (!templateFiles.length) {
        return res.status(400).send("No DOCX template uploaded.");
      }

      const templateBuffer = templateFiles[0].buffer;
      let requirementsAttachmentText = "";

      const requirementsFiles = files["requirementsFile"] || [];
      if (requirementsFiles.length) {
        const buf = requirementsFiles[0].buffer;
        requirementsAttachmentText = buf.toString("utf-8");
      }

      let zip;
      try {
        zip = new PizZip(templateBuffer);
      } catch (zipErr) {
        console.error("Error reading DOCX template as zip:", zipErr);
        return res.status(400).send("Could not read the DOCX template. Is it a valid .docx file?");
      }

      let doc;
      try {
        doc = new Docxtemplater(zip, { paragraphLoop: true, linebreaks: true });
      } catch (templErr) {
        console.error("Error initializing Docxtemplater:", templErr);
        return res.status(500).send("Error initializing the DOCX template engine: " + (templErr.message || ""));
      }

      const getField = (body, name) => (typeof body[name] === "string" ? body[name] : "");
      const body = req.body || {};

      const data = {
        projectName: getField(body, "projectName"),
        clientName: getField(body, "clientName"),
        preparedBy: getField(body, "preparedBy"),
        date: getField(body, "date"),
        version: getField(body, "version"),
        docType: getField(body, "docType"),

        background: getField(body, "background"),
        objectives: getField(body, "objectives"),
        inScope: getField(body, "inScope"),
        outScope: getField(body, "outScope"),
        stakeholders: getField(body, "stakeholders"),
        highLevelReqs: getField(body, "highLevelReqs"),
        assumptions: getField(body, "assumptions"),
        risks: getField(body, "risks"),

        requirementsTextArea: getField(body, "requirements"),
        requirements: requirementsAttachmentText,
      };

      try {
        doc.setData(data);
        doc.render();
      } catch (e) {
        console.error("Error rendering DOCX:", e);
        return res.status(500).send("Error rendering DOCX: " + (e.message || ""));
      }

      const buf = doc.getZip().generate({ type: "nodebuffer" });

      const docType = (data.docType || "brd").toLowerCase();
      const normalizedType = ["brd", "frs", "sow", "raid", "status", "minutes"].includes(docType)
        ? docType
        : "brd";

      const projectNameSafe = (data.projectName || "project")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      const fileName = `${projectNameSafe || "project"}-${normalizedType || "brd"}-generated.docx`;

      res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
      res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
      return res.send(buf);
    } catch (err) {
      console.error("Unexpected server error:", err);
      return res.status(500).send("Unexpected server error.");
    }
  }
);

/* =========================================================
   API: Chatbot (Scrum Book Assistant)
   ========================================================= */
app.post("/api/chat", async (req, res) => {
  try {
    const { mode = "scrum", messages = [] } = req.body || {};

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Missing messages." });
    }

    const systemByMode = {
      scrum:
        "You are a helpful Scrum Coach. Answer questions about Scrum, Agile, ceremonies, roles, artifacts, estimation, SAFe basics, and best practices. Be practical and concise. Ask a short clarifying question if needed.",
      app:
        "You are the in-app assistant for 'The Scrum Book'. Explain how to use features like BRD generation, user stories/epics, story points, sprint planning, sprint review, sprint retro, scrum voice updates, and code review. Give step-by-step guidance and troubleshooting.",
    };

    const system = systemByMode[mode] || systemByMode.scrum;

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      temperature: 0.4,
      messages: [{ role: "system", content: system }, ...messages],
    });

    const reply = completion.choices?.[0]?.message?.content || "";
    res.json({ reply });
  } catch (err) {
    console.error("Chatbot error:", err);
    res.status(500).json({ error: "Failed to generate chatbot response." });
  }
});

/**
 * ✅ JSON error middleware (prevents HTML error pages for API issues)
 */
app.use((err, req, res, next) => {
  console.error("Unhandled Express error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err?.message || "Internal server error" });
});

// Keep this at the very end:
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`✅ The Scrum Book server running on http://localhost:${PORT}`);
});
