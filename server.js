const express = require("express");
const path = require("path");
const multer = require("multer");
const cors = require("cors");
const PizZip = require("pizzip");
const Docxtemplater = require("docxtemplater");
const OpenAI = require("openai");
const ExcelJS = require("exceljs");
const fs = require("fs");
const nodemailer = require("nodemailer");



const app = express();
const PORT = process.env.PORT || 3000;


let mailTransporter = null;

function getMailTransporter() {
  if (mailTransporter) return mailTransporter;

  const { EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS, EMAIL_SECURE } =
    process.env;

  if (!EMAIL_HOST || !EMAIL_PORT || !EMAIL_USER || !EMAIL_PASS) {
    throw new Error(
      "Email is not configured. Please set EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS (and optionally EMAIL_SECURE, EMAIL_FROM)."
    );
  }

  mailTransporter = nodemailer.createTransport({
    host: EMAIL_HOST,
    port: parseInt(EMAIL_PORT, 10),
    secure: EMAIL_SECURE === "true", // true for SSL, false for STARTTLS
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });

  return mailTransporter;
}


// ---------- OpenAI client (SAFE INIT) ----------
const openai =
  process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim()
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

// ---------- Middleware ----------
app.use(express.static(path.join(__dirname, "public")));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Multer in-memory storage
const upload = multer({ storage: multer.memoryStorage() });

const getField = (body, name) =>
  body && body[name] ? body[name].toString() : "";

// =====================================================
//  AI endpoint: /ai-draft  (for structuring requirements into sections)
// =====================================================
app.post("/ai-draft", async (req, res) => {
  try {
    if (!openai) {
      return res.status(500).json({
        error:
          "AI is not configured on the server. Please set the OPENAI_API_KEY environment variable.",
      });
    }

    const { projectName, docType, requirementsText } = req.body;

    if (!requirementsText || !requirementsText.trim()) {
      return res
        .status(400)
        .json({ error: "Please provide some requirements text for AI." });
    }

    const normalizedType = (docType || "brd").toLowerCase();

    let docTypeInstructions = "";

    if (normalizedType === "brd") {
      docTypeInstructions = `
Document type is BRD (Business Requirements Document).
Focus on business context, business objectives, scope, stakeholders, high-level business requirements,
assumptions and risks.
Stakeholders should include any business units, departments, roles or individuals mentioned in the text
(e.g. "Marketing Unit", "Sales Team", "Operations", "Sponsor").
`;
    } else if (normalizedType === "frs") {
      docTypeInstructions = `
Document type is FRS (Functional Requirements Specification).
Interpret the requirements as system behaviour, data flows, integrations, interfaces and constraints,
but still map content into: background, objectives, inScope, outScope, stakeholders, highLevelReqs,
assumptions, risks.
Stakeholders should include functional owners, consuming systems, user groups and any named departments.
`;
    } else if (normalizedType === "sow") {
      docTypeInstructions = `
Document type is SOW (Statement of Work).
Interpret the requirements in terms of deliverables, scope, responsibilities, timelines and assumptions,
but still map content into: background, objectives, inScope, outScope, stakeholders, highLevelReqs,
assumptions, risks.
Stakeholders should reflect client organisation units, vendor teams, approvers and key contacts.
`;
    } else if (normalizedType === "raid") {
      docTypeInstructions = `
Document type is RAID (Risks, Assumptions, Issues, Dependencies).
Emphasise assumptions and risks; use objectives/inScope/outScope to summarise initiative framing.
Stakeholders reflect key owners and impacted parties.
`;
    } else if (normalizedType === "minutes") {
      docTypeInstructions = `
Document type is Minutes of Meeting.
Interpret:
- background as meeting context,
- objectives as meeting objectives,
- inScope/outScope as topics covered vs parked,
- stakeholders as attendees,
- highLevelReqs as action items / decisions,
- assumptions and risks as follow-ups or concerns.
Stakeholders should list all functional groups or individuals involved in the meeting.
`;
    } else {
      docTypeInstructions = `
Treat this as a general project document.
Use sensible defaults for each field, and still detect stakeholders from the text.
`;
    }

    const systemPrompt = `
You are an expert IT project manager and business analyst.
You write documentation in a concise, highly professional, consulting-style tone.
You ALWAYS respond with valid JSON only, with no additional commentary.
`.trim();

    const userPrompt = `
Project Name: ${projectName || "[Not Provided]"}
Document Type: ${normalizedType}

${docTypeInstructions}

Raw Requirements / Notes:
${requirementsText}

Tasks:
1. Clean and structure the raw requirements text.
2. ALWAYS detect and extract stakeholders from the text:
   - business units (e.g. "Marketing Unit", "Sales", "Operations"),
   - roles (e.g. "Product Owner", "Project Manager"),
   - user groups and named individuals.
   Represent them as a clear list in the "stakeholders" field.
3. Allocate content into the following fields, if relevant:
   - cleanedRequirements  (a cleaned version of the full text)
   - background
   - objectives
   - inScope
   - outScope
   - stakeholders
   - highLevelReqs
   - assumptions
   - risks

Return ONLY JSON with this structure (omit fields that are not applicable):

{
  "cleanedRequirements": "...",
  "background": "...",
  "objectives": "...",
  "inScope": "...",
  "outScope": "...",
  "stakeholders": "...",
  "highLevelReqs": "...",
  "assumptions": "...",
  "risks": "..."
}
`.trim();

    const completion = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0].message.content;
    let json;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      console.error("Failed to parse AI JSON:", raw);
      return res
        .status(500)
        .json({ error: "AI response parsing failed. Please try again." });
    }

    return res.json(json);
  } catch (err) {
    console.error("AI draft error:", err);
    return res
      .status(500)
      .json({ error: "AI draft generation failed on server side." });
  }
});

// =====================================================
//  User Story Generator endpoint: /generate-user-stories
//  Accepts BRD DOCX and returns user stories grouped into epics.
// =====================================================
app.post(
  "/generate-user-stories",
  upload.single("brdDocx"),
  async (req, res) => {
    try {
      if (!openai) {
        return res.status(500).json({
          error:
            "AI is not configured on the server. Please set the OPENAI_API_KEY environment variable.",
        });
      }

      const { projectName, docType } = req.body || {};
      let brdRawText = "";

      // 1) Extract text from uploaded BRD .docx
      if (req.file) {
        const originalName = (req.file.originalname || "").toLowerCase();
        if (!originalName.endsWith(".docx")) {
          return res
            .status(400)
            .json({ error: "Please upload a .docx BRD file." });
        }

        try {
          const zipReq = new PizZip(req.file.buffer);
          const documentXml = zipReq.file("word/document.xml").asText();
          brdRawText = documentXml
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        } catch (err) {
          console.error("Could not read BRD DOCX:", err);
          return res.status(400).json({
            error:
              "Could not extract text from the uploaded BRD DOCX. Please check the file.",
          });
        }
      }

      if (!brdRawText || !brdRawText.trim()) {
        return res.status(400).json({
          error:
            "No BRD content found. Please upload a valid BRD .docx or provide BRD text.",
        });
      }

      const normalizedType = (docType || "brd").toLowerCase();

      const systemPrompt = `
You are an expert Product Owner and Business Analyst.
You create clear, well-structured agile user stories from BRDs and group them into epics.
You use FUNCTIONAL / FEATURE-BASED epic names (e.g. "Landing Page Content Management", "User Access & Permissions").
You ALWAYS respond with valid JSON only, no extra commentary.
`.trim();

      const userPrompt = `
Project Name: ${projectName || "[Not Provided]"}
Source Document Type: ${normalizedType}

Source BRD / Business Requirements Text (raw, extracted from DOCX):
${brdRawText}

Tasks:
1. Read and understand the BRD/business requirements.
2. Generate a set of agile user stories in the format:
   "As a <role>, I want <capability> so that <business value>."
3. Group these stories into EPICS with FUNCTIONAL / FEATURE-BASED names (not release names).
   Examples of epic naming style:
   - "Landing Page Content Management"
   - "User Authentication & Access"
   - "Campaign Performance Reporting"
4. Each user story MUST belong to EXACTLY ONE epic.
5. For each epic, provide a short epic description (1–2 lines) explaining what it covers.
6. Keep language simple and suitable for a Jira backlog.

Return ONLY JSON in this form:

{
  "epics": [
    { "name": "Epic Name 1", "description": "Short epic description..." },
    { "name": "Epic Name 2", "description": "Short epic description..." }
  ],
  "userStories": [
    {
      "epic": "Epic Name 1",
      "story": "As a <role>, I want ..."
    },
    {
      "epic": "Epic Name 2",
      "story": "As a <role>, I want ..."
    }
  ]
}
`.trim();

      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        response_format: { type: "json_object" },
      });

      const raw = completion.choices[0].message.content;
      let json;
      try {
        json = JSON.parse(raw);
      } catch (e) {
        console.error("Failed to parse User Stories JSON:", raw);
        return res
          .status(500)
          .json({ error: "AI response parsing failed for user stories." });
      }

      // Normalise output
      const userStoriesRaw = json.userStories || [];
      const epicsRaw = json.epics || [];

      // Ensure userStories are objects { epic, story }
      const userStories = userStoriesRaw.map((item) => {
        if (typeof item === "string") {
          return { epic: "", story: item };
        }
        return {
          epic: item.epic || "",
          story: item.story || "",
        };
      });

      // Ensure epics have name & description
      const epics = epicsRaw
        .map((e) => ({
          name: (e && e.name) || "",
          description: (e && e.description) || "",
        }))
        .filter((e) => e.name);

      // Guarantee every story has some epic (if missing, fallback to first epic or "General")
      if (userStories.length > 0) {
        const defaultEpicName =
          (epics[0] && epics[0].name) || "General Functional Requirements";
        userStories.forEach((s) => {
          if (!s.epic || !s.epic.trim()) {
            s.epic = defaultEpicName;
          }
        });
      }

      return res.json({
        epics,
        userStories,
      });
    } catch (err) {
      console.error("User stories generation error:", err);
      return res
        .status(500)
        .json({ error: "User stories generation failed on server side." });
    }
  }
);

// =====================================================
//  User Stories → Excel endpoint (with Epics + AI Story Points + Sprint)
//  Expects JSON { projectName, userStories[], sprintLengthWeeks?, sprintStart?, sprintEnd? }
// =====================================================
app.post("/user-stories-xlsx", async (req, res) => {
  try {
    const {
      projectName,
      userStories,
      sprintLengthWeeks,
      sprintStart,
      sprintEnd
    } = req.body || {};

    if (!userStories || !Array.isArray(userStories) || userStories.length === 0) {
      return res
        .status(400)
        .json({ error: "No user stories provided to generate Excel." });
    }

    // ---- 0) Normalise into { epic, story } ----
    const normalizedStories = userStories.map((item) => {
      if (typeof item === "string") {
        return { epic: "", story: item };
      }
      return {
        epic: item.epic || "",
        story: item.story || ""
      };
    });

    // ---------- 1) Try to get AI story point estimates ----------
    let aiPoints = new Array(normalizedStories.length).fill("");

    if (openai) {
      try {
        const systemPrompt = `
You are an experienced Agile coach and Scrum practitioner.
You estimate story points using a Fibonacci-like scale: 1, 2, 3, 5, 8, 13, 20.
You consider complexity, uncertainty, and effort, not hours.
You ALWAYS respond with valid JSON only, no extra commentary.
`.trim();

        const numberedStories = normalizedStories
          .map((s, i) => `US-${i + 1}: ${s.story}`)
          .join("\n");

        const userPrompt = `
Estimate story points for the following user stories.

User stories:
${numberedStories}

Tasks:
1. For each user story, select a story point from: 1, 2, 3, 5, 8, 13, 20.
2. Do NOT explain your reasoning.
3. Return ONLY JSON with this structure:

{
  "estimates": [
    { "id": "US-1", "points": 3 },
    { "id": "US-2", "points": 5 }
  ]
}
`.trim();

        const completion = await openai.chat.completions.create({
          model: "gpt-4.1-mini",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          response_format: { type: "json_object" }
        });

        const raw = completion.choices[0].message.content;
        let json;
        try {
          json = JSON.parse(raw);
        } catch (e) {
          console.error("Failed to parse AI SP JSON:", raw);
          json = null;
        }

        if (json && Array.isArray(json.estimates)) {
          const map = {};
          json.estimates.forEach((item) => {
            if (!item || typeof item.id !== "string") return;
            const idxMatch = item.id.match(/^US-(\d+)$/i);
            if (!idxMatch) return;
            const idx = parseInt(idxMatch[1], 10) - 1;
            if (idx >= 0 && idx < normalizedStories.length) {
              map[idx] = item.points;
            }
          });

          aiPoints = aiPoints.map((_, idx) =>
            map[idx] !== undefined && map[idx] !== null ? String(map[idx]) : ""
          );
        }
      } catch (err) {
        console.error(
          "AI Story Points error (ignored, Excel will still download):",
          err
        );
        // leave aiPoints as empty strings if AI fails
      }
    } else {
      console.warn(
        "OPENAI_API_KEY not configured. Story Points column will be blank."
      );
    }

    // ---------- 2) Sprint planning ----------
    const sprintAssignments = new Array(normalizedStories.length).fill("");

    const sprintLenWeeksNum = sprintLengthWeeks
      ? parseInt(sprintLengthWeeks, 10)
      : NaN;

    const hasSprintInputs =
      sprintLenWeeksNum > 0 &&
      sprintStart && sprintStart.trim() &&
      sprintEnd && sprintEnd.trim();

    let sprints = [];

    if (hasSprintInputs) {
      const startDate = new Date(sprintStart);
      const endDate = new Date(sprintEnd);
      if (!isNaN(startDate.getTime()) && !isNaN(endDate.getTime()) && endDate >= startDate) {
        const msPerDay = 24 * 60 * 60 * 1000;
        const sprintLenDays = sprintLenWeeksNum * 7;
        const diffDays =
          Math.floor((endDate.getTime() - startDate.getTime()) / msPerDay) + 1;
        const numSprints = Math.max(
          1,
          Math.ceil(diffDays / sprintLenDays)
        );

        const fmtDate = (d) => {
          const yyyy = d.getFullYear();
          const mm = String(d.getMonth() + 1).padStart(2, "0");
          const dd = String(d.getDate()).padStart(2, "0");
          return `${yyyy}-${mm}-${dd}`;
        };

        for (let i = 0; i < numSprints; i++) {
          const sStart = new Date(
            startDate.getTime() + i * sprintLenDays * msPerDay
          );
          let sEnd = new Date(
            sStart.getTime() + sprintLenDays * msPerDay - msPerDay
          );
          if (sEnd > endDate) sEnd = endDate;
          sprints.push({
            name: `Sprint ${i + 1} (${fmtDate(sStart)} – ${fmtDate(sEnd)})`,
            start: sStart,
            end: sEnd
          });
        }
      }
    }

    if (sprints.length > 0) {
      // Use AI story points to distribute load across sprints
      const pointValues = aiPoints.map((p) => {
        const n = parseInt(p, 10);
        return isNaN(n) ? 0 : n;
      });
      const totalPoints = pointValues.reduce((sum, v) => sum + v, 0);

      if (totalPoints > 0) {
        const idealPerSprint = totalPoints / sprints.length;
        let currentSprint = 0;
        let currentSprintPoints = 0;

        normalizedStories.forEach((_, idx) => {
          sprintAssignments[idx] = sprints[currentSprint].name;
          currentSprintPoints += pointValues[idx] || 0;
          if (
            currentSprint < sprints.length - 1 &&
            currentSprintPoints >= idealPerSprint
          ) {
            currentSprint++;
            currentSprintPoints = 0;
          }
        });
      } else {
        // No points (AI failed) → simple even distribution by count
        const perSprint = Math.ceil(
          normalizedStories.length / sprints.length
        );
        normalizedStories.forEach((_, idx) => {
          const sprintIndex = Math.min(
            sprints.length - 1,
            Math.floor(idx / perSprint)
          );
          sprintAssignments[idx] = sprints[sprintIndex].name;
        });
      }
    }
    // If no valid sprint config, Sprint column will just be blank.

    // ---------- 3) Build Excel with ExcelJS ----------
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("User Stories");

    // Sprint column added before Epic
    sheet.columns = [
      { header: "ID", key: "id", width: 10 },
      { header: "Sprint", key: "sprint", width: 24 },
      { header: "Epic", key: "epic", width: 30 },
      { header: "User Story", key: "story", width: 80 },
      { header: "Story Points (AI)", key: "points", width: 20 },
      { header: "Priority", key: "priority", width: 12 },
      { header: "Status", key: "status", width: 12 }
    ];

    normalizedStories.forEach((item, index) => {
      sheet.addRow({
        id: `US-${index + 1}`,
        sprint: sprintAssignments[index] || "",
        epic: item.epic || "",
        story: item.story,
        points: aiPoints[index] || "",
        priority: "",
        status: ""
      });
    });

    sheet.getRow(1).font = { bold: true };

    const buffer = await workbook.xlsx.writeBuffer();

    const safeProject = (projectName || "user-stories")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const fileName = `${safeProject || "user-stories"}-stories.xlsx`;

    // Save Excel for later emailing (if you kept email feature)
    const fileId =
      Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
    const generatedDir = path.join(__dirname, "generated");
    fs.mkdirSync(generatedDir, { recursive: true });
    const storedFileName = `${fileId}-${fileName}`;
    const storedPath = path.join(generatedDir, storedFileName);
    fs.writeFileSync(storedPath, Buffer.from(buffer));

    res.setHeader("X-Generated-File-Id", fileId);

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fileName}"`
    );

    return res.send(Buffer.from(buffer));
  } catch (err) {
    console.error("User stories Excel generation error:", err);
    return res
      .status(500)
      .json({ error: "Failed to generate Excel for user stories." });
  }
});

// =====================================================
//  DOCX generation endpoint: /generate-docx
// =====================================================
app.post(
  "/generate-docx",
  upload.fields([
    { name: "templateDocx", maxCount: 1 },
    { name: "requirementsFile", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const templateFile =
        req.files &&
        req.files["templateDocx"] &&
        req.files["templateDocx"][0];

      if (!templateFile) {
        return res.status(400).send("No DOCX template uploaded.");
      }

      const templateBuffer = templateFile.buffer;

      let requirementsAttachmentText = "";
      const reqFile =
        req.files &&
        req.files["requirementsFile"] &&
        req.files["requirementsFile"][0];

      if (reqFile) {
        const originalName = (reqFile.originalname || "").toLowerCase();
        const mimeType = reqFile.mimetype || "";

        if (mimeType === "text/plain" || originalName.endsWith(".txt")) {
          requirementsAttachmentText = reqFile.buffer.toString("utf-8");
        } else if (originalName.endsWith(".docx")) {
          try {
            const zipReq = new PizZip(reqFile.buffer);
            const documentXml = zipReq.file("word/document.xml").asText();
            requirementsAttachmentText = documentXml
              .replace(/<[^>]+>/g, " ")
              .replace(/\s+/g, " ")
              .trim();
          } catch (err) {
            console.error("Could not read DOCX requirements:", err);
            requirementsAttachmentText =
              "[Could not extract text from DOCX requirements attachment]";
          }
        } else {
          requirementsAttachmentText =
            "[Unsupported requirements attachment format]";
        }
      }

      let zip;
      try {
        zip = new PizZip(templateBuffer);
      } catch (e) {
        console.error("Error reading DOCX as zip:", e);
        return res.status(400).send("Invalid DOCX template file.");
      }

      let doc;
      try {
        doc = new Docxtemplater(zip, {
          paragraphLoop: true,
          linebreaks: true,
        });
      } catch (e) {
        console.error("Error loading DOCX template:", e);
        return res.status(400).send("Could not load DOCX template.");
      }

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
      } catch (e) {
        console.error("Error setting data:", e);
        return res
          .status(500)
          .send("Error setting template data: " + (e.message || ""));
      }

      try {
        doc.render();
      } catch (e) {
        console.error("Error rendering DOCX:", e);
        return res
          .status(500)
          .send(
            "Error rendering DOCX template. Check that placeholders in the template match field names. " +
              (e.message || "")
          );
      }

      const buf = doc.getZip().generate({ type: "nodebuffer" });

      const safeProject = (data.projectName || "document")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");

      const fileName = `${safeProject || "document"}-${data.docType ||
        "brd"}-generated.docx`;

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${fileName}"`
      );

      return res.send(buf);
    } catch (err) {
      console.error("Unexpected server error:", err);
      return res.status(500).send("Unexpected server error.");
    }
  }
);
// =====================================================
//  Email endpoint: /email-doc
//  Body: { to, subject, text, fileId }
//  Uses the file saved in /generated whose name starts with `${fileId}-`
// =====================================================
app.post("/email-doc", async (req, res) => {
  try {
    const { to, subject, text, fileId } = req.body || {};

    if (!to || !fileId) {
      return res.status(400).json({
        error: "Recipient email address and fileId are required.",
      });
    }

    // Locate the generated file by fileId
    const generatedDir = path.join(__dirname, "generated");
    let filePath = null;
    let originalName = null;

    try {
      const files = fs.readdirSync(generatedDir);
      const match = files.find((f) => f.startsWith(fileId + "-"));
      if (match) {
        filePath = path.join(generatedDir, match);
        originalName = match.split("-").slice(1).join("-");
      }
    } catch (e) {
      // ignore, will be handled below if filePath stays null
    }

    if (!filePath) {
      return res.status(404).json({
        error: "File not found or expired. Please regenerate the document.",
      });
    }

    // Get configured Nodemailer transporter
    let transporter;
    try {
      transporter = getMailTransporter();
    } catch (e) {
      console.error("Email config error:", e);
      return res.status(500).json({
        error:
          e.message ||
          "Email is not configured on the server. Please set EMAIL_HOST, EMAIL_PORT, EMAIL_USER, EMAIL_PASS.",
      });
    }

    try {
      await transporter.sendMail({
        from: process.env.EMAIL_FROM || process.env.EMAIL_USER,
        to,
        subject: subject || "PM Doc Generator - User Stories Excel",
        text:
          text ||
          "Please find attached the latest user stories Excel generated from the PM Doc Generator.",
        attachments: [
          {
            filename: originalName || "user-stories.xlsx",
            path: filePath,
          },
        ],
      });

      return res.json({ success: true });
    } catch (err) {
      console.error("Email send error:", err);
      return res.status(500).json({
        error: err.message || "Failed to send email.",
      });
    }
  } catch (err) {
    console.error("Email-doc endpoint error:", err);
    return res
      .status(500)
      .json({ error: "Unexpected server error while sending email." });
  }
});

// Fallback route
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
