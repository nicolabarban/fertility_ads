import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";
import { google } from "googleapis";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DATA_PATH = path.join(__dirname, "data", "sample200.csv");
const OCR_PROMPT_PATH = path.join(__dirname, "prompts", "ocr_ad_prompt.txt");
const REPRO_PROMPT_PATH = path.join(__dirname, "prompts", "repro_classify_prompt.txt");
const REPRO_EXTRACT_PROMPT_PATH = path.join(__dirname, "prompts", "repro_extract_prompt.txt");
const GROUND_TRUTH_PATH = path.join(__dirname, "data", "ground_truth.csv");
const REPRO_EXTRACT_PATH = path.join(__dirname, "data", "repro_extract.csv");
const SHEETS_ID = process.env.GOOGLE_SHEETS_ID || "";
const SHEETS_TAB = process.env.GOOGLE_SHEETS_TAB || "classification";
const SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });
let sheetsClient = null;
let sheetsInitError = "";

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (inQuotes) {
      if (char === "\"") {
        if (next === "\"") {
          field += "\"";
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
    } else {
      if (char === "\"") {
        inQuotes = true;
      } else if (char === ",") {
        row.push(field);
        field = "";
      } else if (char === "\n") {
        row.push(field);
        rows.push(row);
        row = [];
        field = "";
      } else if (char === "\r") {
        continue;
      } else {
        field += char;
      }
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function loadRows() {
  const csvText = fs.readFileSync(DATA_PATH, "utf-8");
  const [header, ...dataRows] = parseCSV(csvText);

  return dataRows.map((cells, idx) => {
    const obj = { _rowIndex: idx };
    header.forEach((key, i) => {
      obj[key] = cells[i] ?? "";
    });
    return obj;
  });
}

let cachedRows = null;
function getRows() {
  if (!cachedRows) {
    cachedRows = loadRows();
  }
  return cachedRows;
}

function requireApiKey(res) {
  if (!process.env.OPENAI_API_KEY) {
    res.status(500).json({ error: "OPENAI_API_KEY is not set" });
    return false;
  }
  return true;
}

function extractOutputText(response) {
  if (response.output_text) return response.output_text;
  const parts = [];
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      if (item.type === "message" && Array.isArray(item.content)) {
        for (const content of item.content) {
          if (content.type === "output_text" && content.text) {
            parts.push(content.text);
          }
        }
      }
    }
  }
  return parts.join("").trim();
}

function csvEscape(value) {
  const str = value === undefined || value === null ? "" : String(value);
  if (/[",\n]/.test(str)) {
    return `"${str.replace(/"/g, "\"\"")}"`;
  }
  return str;
}

function ensureGroundTruthFile() {
  if (!fs.existsSync(GROUND_TRUTH_PATH)) {
    fs.writeFileSync(
      GROUND_TRUTH_PATH,
      "timestamp,json_path,year,full_article_id,block_id,manual_label\n",
      "utf-8"
    );
  }
}

function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!SHEETS_ID || !SERVICE_ACCOUNT_JSON) {
    sheetsInitError = "Missing GOOGLE_SHEETS_ID or GOOGLE_SERVICE_ACCOUNT_JSON.";
    return null;
  }
  let creds = null;
  try {
    const raw = SERVICE_ACCOUNT_JSON.replace(/\\n/g, "\n");
    creds = JSON.parse(raw);
  } catch (err) {
    sheetsInitError = "Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON. Ensure it is a single-line JSON string.";
    return null;
  }
  if (!creds.client_email || !creds.private_key) {
    sheetsInitError = "Service account JSON is missing client_email or private_key.";
    return null;
  }
  const auth = new google.auth.JWT(
    creds.client_email,
    null,
    creds.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  sheetsClient = google.sheets({ version: "v4", auth });
  return sheetsClient;
}

async function appendGroundTruthToSheet(row) {
  const sheets = getSheetsClient();
  if (!sheets) {
    throw new Error("Google Sheets not configured");
  }
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: `${SHEETS_TAB}!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] }
  });
}

async function readGroundTruthFromSheet() {
  const sheets = getSheetsClient();
  if (!sheets) return null;
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: `${SHEETS_TAB}!A1:Z`
  });
  const values = response.data.values || [];
  if (values.length === 0) return [];
  const [header, ...rows] = values;
  return rows.map((cells) => {
    const obj = {};
    header.forEach((key, i) => {
      obj[key] = cells[i] ?? "";
    });
    return obj;
  });
}

function ensureExtractFile() {
  if (!fs.existsSync(REPRO_EXTRACT_PATH)) {
    fs.writeFileSync(
      REPRO_EXTRACT_PATH,
      "timestamp,json_path,year,full_article_id,block_id,named_brands_and_lifecycles,pricing,distribution_channels,location_manufacturing,location_purchase,type,symptoms,direction_of_use,health_warnings,order_by_post,raw_output\n",
      "utf-8"
    );
  }
}

function formatSheetsError(err) {
  if (!err) return "Unknown error";
  const code = err.code || err.status || err.response?.status;
  const message =
    err.response?.data?.error?.message ||
    err.message ||
    "Unknown error";
  if (code === 403) {
    return `Permission denied (403). Share the sheet with the service account email. Details: ${message}`;
  }
  if (code === 404) {
    return `Not found (404). Check GOOGLE_SHEETS_ID or tab name. Details: ${message}`;
  }
  if (code === 400) {
    return `Bad request (400). Check GOOGLE_SHEETS_TAB and range. Details: ${message}`;
  }
  return `Error${code ? ` (${code})` : ""}: ${message}`;
}

app.get("/api/rows", (req, res) => {
  try {
    const rows = getRows();
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to load CSV" });
  }
});

app.get("/api/ground-truth/health", (req, res) => {
  (async () => {
    try {
      if (!SHEETS_ID || !SERVICE_ACCOUNT_JSON) {
        res.status(500).json({
          ok: false,
          error: "Google Sheets not configured. Set GOOGLE_SHEETS_ID and GOOGLE_SERVICE_ACCOUNT_JSON."
        });
        return;
      }
      const sheets = getSheetsClient();
      if (!sheets) {
        res.status(500).json({
          ok: false,
          error: sheetsInitError || "Failed to initialize Google Sheets client."
        });
        return;
      }
      await sheets.spreadsheets.values.get({
        spreadsheetId: SHEETS_ID,
        range: `${SHEETS_TAB}!A1`
      });
      res.json({ ok: true, message: "Google Sheets connection OK." });
    } catch (err) {
      res.status(500).json({ ok: false, error: formatSheetsError(err) });
    }
  })();
});

app.post("/api/ocr-correct", async (req, res) => {
  if (!requireApiKey(res)) return;

  const text = (req.body && req.body.text) || "";
  const model = (req.body && req.body.model) || process.env.OPENAI_MODEL || "gpt-5.2";
  if (!text.trim()) {
    res.status(400).json({ error: "Missing text" });
    return;
  }

  try {
    const prompt = fs.readFileSync(OCR_PROMPT_PATH, "utf-8");
    const response = await openai.responses.create({
      model,
      input: [
        { role: "system", content: prompt },
        { role: "user", content: text }
      ],
      max_output_tokens: 1200
    });

    res.json({ output: extractOutputText(response) });
  } catch (err) {
    res.status(500).json({ error: "OpenAI request failed" });
  }
});

app.post("/api/repro-classify", async (req, res) => {
  if (!requireApiKey(res)) return;

  const text = (req.body && req.body.text) || "";
  const model = (req.body && req.body.model) || process.env.OPENAI_MODEL || "gpt-5.2";
  if (!text.trim()) {
    res.status(400).json({ error: "Missing text" });
    return;
  }

  try {
    const prompt = fs.readFileSync(REPRO_PROMPT_PATH, "utf-8");
    const response = await openai.responses.create({
      model,
      input: [
        { role: "system", content: prompt },
        { role: "user", content: text }
      ],
      max_output_tokens: 50
    });

    res.json({ output: extractOutputText(response) });
  } catch (err) {
    res.status(500).json({ error: "OpenAI request failed" });
  }
});

app.post("/api/repro-extract", async (req, res) => {
  if (!requireApiKey(res)) return;

  const text = (req.body && req.body.text) || "";
  const model = (req.body && req.body.model) || process.env.OPENAI_MODEL || "gpt-5.2";
  if (!text.trim()) {
    res.status(400).json({ error: "Missing text" });
    return;
  }

  try {
    const prompt = fs.readFileSync(REPRO_EXTRACT_PROMPT_PATH, "utf-8");
    const response = await openai.responses.create({
      model,
      input: [
        { role: "system", content: prompt },
        { role: "user", content: text }
      ],
      max_output_tokens: 500
    });

    const output = extractOutputText(response);

    try {
      ensureExtractFile();
      const parsed = (() => {
        try { return JSON.parse(output); } catch { return null; }
      })();
      const fields = parsed || {};
      const line = [
        new Date().toISOString(),
        (req.body && req.body.json_path) || "",
        (req.body && req.body.year) || "",
        (req.body && req.body.full_article_id) || "",
        (req.body && req.body.block_id) || "",
        fields.named_brands_and_lifecycles || "Not present/unclear",
        fields.pricing || "Not present/unclear",
        fields.distribution_channels || "Not present/unclear",
        fields.location_manufacturing || "Not present/unclear",
        fields.location_purchase || "Not present/unclear",
        fields.type || "Not present/unclear",
        fields.symptoms || "Not present/unclear",
        fields.direction_of_use || "Not present/unclear",
        fields.health_warnings || "Not present/unclear",
        fields.order_by_post || "Not present/unclear",
        output
      ].map(csvEscape).join(",") + "\n";
      fs.appendFileSync(REPRO_EXTRACT_PATH, line, "utf-8");
    } catch (err) {
      // If saving fails, still return output
    }

    res.json({ output });
  } catch (err) {
    res.status(500).json({ error: "OpenAI request failed" });
  }
});

app.get("/api/ground-truth", (req, res) => {
  (async () => {
    try {
      const sheetRows = await readGroundTruthFromSheet();
      if (sheetRows !== null) {
        res.json({ rows: sheetRows });
        return;
      }
      if (!fs.existsSync(GROUND_TRUTH_PATH)) {
        res.json({ rows: [] });
        return;
      }
      const csvText = fs.readFileSync(GROUND_TRUTH_PATH, "utf-8");
      const [header, ...dataRows] = parseCSV(csvText);
      const rows = dataRows.map((cells) => {
        const obj = {};
        header.forEach((key, i) => {
          obj[key] = cells[i] ?? "";
        });
        return obj;
      });
      res.json({ rows });
    } catch (err) {
      res.status(500).json({ error: "Failed to load ground truth" });
    }
  })();
});

app.post("/api/ground-truth", (req, res) => {
  const allowed = new Set(["ADS_REPRO", "ART", "OTHER"]);
  const label = (req.body && req.body.label) || "";
  if (!allowed.has(label)) {
    res.status(400).json({ error: "Invalid label" });
    return;
  }

  (async () => {
    try {
      const timestamp = new Date().toISOString();
      const row = [
        timestamp,
        (req.body && req.body.json_path) || "",
        (req.body && req.body.year) || "",
        (req.body && req.body.full_article_id) || "",
        (req.body && req.body.block_id) || "",
        label
      ];
      await appendGroundTruthToSheet(row);
      try {
        ensureGroundTruthFile();
        const line = row.map(csvEscape).join(",") + "\n";
        fs.appendFileSync(GROUND_TRUTH_PATH, line, "utf-8");
      } catch (err) {
        // If local backup fails, still succeed since Sheets saved.
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: "Failed to save label to Google Sheets" });
    }
  })();
});

app.listen(PORT, () => {
  console.log(`fertility_ads running on http://localhost:${PORT}`);
});
