require("dotenv").config();

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const OpenAI = require("openai");
const path = require("path");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const pdfParse = require("pdf-parse");
const { Document, Packer, Paragraph, HeadingLevel, TextRun } = require("docx");
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

function extractPlaceholders(doc) {
  const text = doc.getFullText();
  const matches = text.match(/{([^}]+)}/g) || [];
  return [...new Set(matches.map(m => m.replace(/[{}]/g, "").trim()))];
}

/* =========================
   UPLOADS (Render-safe)
========================= */
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads");

const upload = multer({ dest: "uploads/" });
const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 20 * 1024 * 1024,   // ⭐ allow 20MB files
    fieldSize: 20 * 1024 * 1024,  // ⭐ allow large text fields
  },
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

Generate ONLY a ${type} document.

VERY IMPORTANT:
Formatting Rules:

- DO NOT add manual numbering like "1." or "2." in the text.
- Write clean section headings only.
- The system will apply numbering automatically.
- Use headings like:
  Introduction
  Scope
  Test Strategy
  Risks
Create ONLY the ${type}.
Do NOT include any other document type.
Do NOT mix FRS, SOW, RAID, or TestPlan structures.

Use professional numbered headings and "- " bullets.
Plain text only (NO HTML).

IF type is TestPlan:

Create a DETAILED QA Test Plan derived from the SRS.

The Test Plan MUST include:

Introduction
Test Objectives
Scope based on SRS modules
Features to be Tested (mapped from SRS requirements)
Features NOT to be Tested
Test Strategy
Test Levels (Unit, Integration, System, UAT)
Functional Testing Approach
Non-Functional Testing (Performance, Security, Accessibility)
Test Environment
Test Data Strategy
Entry Criteria
Exit Criteria
Risk Analysis
Traceability Matrix (Requirement → Test Area)

Formatting Rules:
- DO NOT manually add numbering like "1."
- Write clean headings only.
- The system will apply numbering automatically.

Document Title: ${title}

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

app.post(
  "/generate-docx",
  uploadMemory.fields([
    { name: "templateDocx", maxCount: 1 },
    { name: "requirementsFile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const data = { ...req.body };
	  // ⭐ Read uploaded requirements file (PDF or TXT)
if (req.files?.requirementsFile?.[0]) {
  const file = req.files.requirementsFile[0];

  if (file.mimetype === "application/pdf") {
    const pdf = await pdfParse(file.buffer);
    data.requirements = pdf.text;
  } else {
    data.requirements = file.buffer.toString("utf8");
  }
}
      const docType = (req.body.docType || "").toLowerCase();

      data.background = data.background || data.executiveSummary || "";
      data.objectives = data.objectives || data.highLevelReqs || "";
      data.inScope = data.inScope || data.cleanedRequirements || "";
      data.requirements = data.requirements || data.cleanedRequirements || "";

      console.log("FORM DATA RECEIVED:", data);

      // ⭐ SAME AI AS FULLY AUTOMATE
      // ⭐ GENERATE STRUCTURED CONTENT FOR ALL DOC TYPES
if (docType) {
  const reqText = data.requirements || "";

  const structured = await generateDocHtml(
    docType.toUpperCase(),
    reqText,
    data.projectName || "Project Document"
  );

  if (structured) {
    data.generatedContent = structured;
  }
}

      const children = [];

      children.push(
        new Paragraph({
          text: data.projectName || "Project Document",
          heading: HeadingLevel.HEADING_1,
        })
      );

      Object.entries(data).forEach(([key, value]) => {
        // ⭐ If AI structured content exists, render ONLY that
if (data.generatedContent && key !== "generatedContent") return;

        const title = key
          .replace(/([A-Z])/g, " $1")
          .replace(/^./, (s) => s.toUpperCase());

        

    // ⭐ Detect numbered headings like "1. Introduction"

        String(value)
  .split(/\n+/)
  .forEach(line => {
    const clean = line.trim();
    if (!clean) return;

    // ⭐ MAIN NUMBERED SECTIONS → BIG HEADING
    if (/^\d+\.\s/.test(clean)) {
  children.push(
    new Paragraph({
      text: clean.replace(/^\d+\.\s/, ""),
      numbering: {
        reference: "default-numbering",
        level: 0,
      },
      spacing: { after: 120 },
    })
  );
}

    // ⭐ BULLET LINES
    else if (clean.startsWith("-")) {
      children.push(
        new Paragraph({
          text: clean.replace(/^-+\s*/, ""),
          bullet: { level: 0 },
          spacing: { after: 80 },
        })
      );
    }

    // ⭐ NORMAL TEXT
    else {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: clean,
              size: 24,   // nicer readable font size
            }),
          ],
          spacing: { after: 120 },
        })
      );
    }
  });
      });

// ⭐ IF TEMPLATE EXISTS → USE TEMPLATE ENGINE
if (req.files?.templateDocx?.[0]) {
  const content = req.files.templateDocx[0].buffer;

  const zip = new PizZip(content);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true,
  });

  doc.setData(data);
  doc.render();

  const buffer = doc.getZip().generate({
    type: "nodebuffer",
  });

  res.status(200);
  res.set({
    "Content-Type":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "Content-Disposition": 'attachment; filename="generated.docx"',
    "Content-Length": buffer.length,
  });

  return res.end(buffer);
}

      const autoDoc = new Document({

  numbering: {
    config: [
      {
        reference: "default-numbering",
        levels: [
          {
            level: 0,
            format: "decimal",
            text: "%1.",
            alignment: "start",
          },
        ],
      },
    ],
  },

  styles: {
    paragraphStyles: [
      {
        id: "Heading1",
        name: "Heading 1",
        basedOn: "Normal",
        next: "Normal",
        run: { bold: true, size: 32 },
        paragraph: { spacing: { after: 240 } },
      },
      {
        id: "Heading2",
        name: "Heading 2",
        basedOn: "Normal",
        next: "Normal",
        run: { bold: true, size: 26 },
        paragraph: { spacing: { after: 160 } },
      },
    ],
  },

  sections: [
    {
      children,
    },
  ],
});

      const buffer = await Packer.toBuffer(autoDoc);

      res.status(200);
      res.set({
        "Content-Type":
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "Content-Disposition": 'attachment; filename="generated.docx"',
        "Content-Length": buffer.length,
      });

      return res.end(Buffer.from(buffer));
    } catch (err) {
      console.error("generate-docx error:", err);
      return res.status(500).send("Unexpected error generating document.");
    }
  }
);

const ExcelJS = require("exceljs");

app.post("/download-user-stories-excel", async (req, res) => {
  try {
    const { userStories, projectName } = req.body;

    if (!userStories || !Array.isArray(userStories)) {
      return res.status(400).json({ error: "No stories provided" });
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("User Stories");

    sheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Epic", key: "epic", width: 30 },
      { header: "User Story", key: "story", width: 70 },
      { header: "Story Points", key: "storyPoints", width: 15 }
    ];

    userStories.forEach((s, i) => {
      sheet.addRow({
        id: `US-${i + 1}`,
        epic: s.epic,
        story: s.story,
        storyPoints: s.storyPoints
      });
    });

    sheet.getRow(1).font = { bold: true };

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );

    res.setHeader(
      "Content-Disposition",
      `attachment; filename=${(projectName || "user-stories")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")}.xlsx`
    );

    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error("Excel error:", err);
    res.status(500).json({ error: "Excel generation failed" });
  }
});

app.post("/generate-test-cases", uploadMemory.any(), async (req,res)=>{
 try{
   let text="";
   if(req.files?.[0]){
     const file=req.files[0];
     if(file.mimetype==="application/pdf"){
       const pdf=await pdfParse(file.buffer);
       text=pdf.text;
     }else{
       text=file.buffer.toString("utf8");
     }
   }

const prompt=`
You are a Senior QA Architect.

Generate VERY DETAILED test cases.

Return JSON ONLY:

{
 "testCases":[
   {
     "feature":"Login",
     "scenario":"Valid login",
     "steps":"1. Open login page...",
     "expected":"User logged in",
     "priority":"High"
   }
 ]
}

Requirements:
${text}
`;

const resp=await openai.chat.completions.create({
 model:"gpt-4.1-mini",
 messages:[{role:"user",content:prompt}]
});

const raw=resp.choices[0].message.content;
const match=raw.match(/\{[\s\S]*\}/);
res.json(JSON.parse(match[0]));

}catch(e){
 console.error(e);
 res.status(500).json({error:"TC generation failed"});
}
});

async function generateEpicsAndStories({ requirementsText }) {
  if (!openai) {
    throw new Error("OPENAI_API_KEY missing — cannot generate backlog");
  }

  const prompt = `
You are a Senior Scrum Master creating a VERY LARGE Agile backlog.

CRITICAL RULE:

DO NOT summarise.
DO NOT combine features.
DECOMPOSE EVERYTHING.

Your goal is to EXPAND the backlog into MANY SMALL USER STORIES.

Backlog Expansion Rules:

- Break EACH feature into multiple stories:
  UI story
  validation story
  backend processing story
  error handling story
  permissions story
  reporting story

- Prefer MANY SMALL STORIES over few big ones.
- If unsure, SPLIT into separate stories.

Target behaviour:
Generate a HIGH VOLUME backlog similar to enterprise Jira boards.

Each story must include:

title
description (LONG and detailed)
storyPoints (1,2,3,5,8,13)
severity
priority
acceptanceCriteria (6–10 items)

Descriptions MUST include:
- user interaction
- system processing
- edge cases
- business value

RETURN STRICT JSON:

{
  "epics":[
    {
      "title":"Epic title",
      "stories":[
        {
          "title":"Story title",
          "description":"Detailed explanation...",
          "storyPoints":5,
          "severity":"High",
          "priority":"P1",
          "acceptanceCriteria":[
            "criteria 1",
            "criteria 2"
          ]
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

app.post("/ai-draft", async (req, res) => {
  try {
    const { prompt } = req.body;
    if (!prompt) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [{ role: "user", content: prompt }],
      temperature: 0.2,
    });

    const text = response.choices?.[0]?.message?.content || "";

    let parsed = {};

try {
  // ⭐ Use the correct variable name (text)
  let clean = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  parsed = JSON.parse(clean);
} catch (e) {
  console.error("AI returned invalid JSON:", text);
}

    res.json({ parsed });
  } catch (err) {
    console.error("ai-draft error:", err);
    res.status(500).json({ error: err.message });
  }
});


// ⭐ Generate User Stories Only (reuses existing AI logic)
app.post("/generate-user-stories", uploadMemory.any(), async (req, res) => {
  try {
    let requirementsText = (req.body?.requirementsText || "").trim();

    // ⭐ If file uploaded from user-stories.html
    if (!requirementsText && req.files && req.files.length > 0) {
      const file = req.files[0];

      // PDF
      if (file.mimetype === "application/pdf") {
        const pdf = await pdfParse(file.buffer);
        requirementsText = pdf.text || "";
      }

      // DOCX or TXT
      else {
        requirementsText = file.buffer.toString("utf8");
      }
    }

    if (!requirementsText) {
      return res.status(400).json({
        error: "No requirements text or file provided."
      });
    }

    // ⭐ Reuse your existing AI backlog generator
    const backlog = await generateEpicsAndStories({
      requirementsText
    });

    // ⭐ Convert to UI format expected by user-stories.html
    const epics = (backlog.epics || []).map(e => ({
      name: e.title || "",
      description: ""
    }));

    const userStories = [];

    (backlog.epics || []).forEach(epic => {
      (epic.stories || []).forEach(st => {
        userStories.push({
          epic: epic.title || "",
          story: st.title || "",
          storyPoints: st.storyPoints || ""
        });
      });
    });

    return res.json({
      epics,
      userStories
    });

  } catch (err) {
    console.error("generate-user-stories error:", err);
    res.status(500).json({ error: "Could not generate user stories." });
  }
});

app.post("/download-testcases-excel", async(req,res)=>{
 const ExcelJS=require("exceljs");
 const wb=new ExcelJS.Workbook();
 const ws=wb.addWorksheet("Test Cases");

 ws.columns=[
 {header:"ID",key:"id",width:10},
 {header:"Feature",key:"feature",width:20},
 {header:"Scenario",key:"scenario",width:30},
 {header:"Steps",key:"steps",width:60},
 {header:"Expected Result",key:"expected",width:40},
 {header:"Priority",key:"priority",width:15}
 ];

 (req.body.testCases||[]).forEach((t,i)=>{
  ws.addRow({id:`TC-${i+1}`,...t});
 });

 res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
 res.setHeader("Content-Disposition","attachment; filename=test-cases.xlsx");

 await wb.xlsx.write(res);
 res.end();
});
/* =========================
   START
========================= */
app.listen(PORT, () => {
  console.log(`✅ PM Doc Generator running on ${PORT}`);
});
