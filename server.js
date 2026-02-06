import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import OpenAI from "openai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const DATA_PATH = path.join(__dirname, "data", "sample200.csv");
const OCR_PROMPT_PATH = path.join(__dirname, "prompts", "ocr_ad_prompt.txt");
const REPRO_PROMPT_PATH = path.join(__dirname, "prompts", "repro_classify_prompt.txt");
const GROUND_TRUTH_PATH = path.join(__dirname, "data", "ground_truth.csv");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY || "" });

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

app.get("/api/rows", (req, res) => {
  try {
    const rows = getRows();
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: "Failed to load CSV" });
  }
});

app.post("/api/ocr-correct", async (req, res) => {
  if (!requireApiKey(res)) return;

  const text = (req.body && req.body.text) || "";
  if (!text.trim()) {
    res.status(400).json({ error: "Missing text" });
    return;
  }

  try {
    const prompt = fs.readFileSync(OCR_PROMPT_PATH, "utf-8");
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
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
  if (!text.trim()) {
    res.status(400).json({ error: "Missing text" });
    return;
  }

  try {
    const prompt = fs.readFileSync(REPRO_PROMPT_PATH, "utf-8");
    const response = await openai.responses.create({
      model: process.env.OPENAI_MODEL || "gpt-4.1-mini",
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

app.post("/api/ground-truth", (req, res) => {
  const allowed = new Set(["ADS_REPRO", "ART", "OTHER", "UNCLEAR"]);
  const label = (req.body && req.body.label) || "";
  if (!allowed.has(label)) {
    res.status(400).json({ error: "Invalid label" });
    return;
  }

  try {
    ensureGroundTruthFile();
    const timestamp = new Date().toISOString();
    const line = [
      timestamp,
      (req.body && req.body.json_path) || "",
      (req.body && req.body.year) || "",
      (req.body && req.body.full_article_id) || "",
      (req.body && req.body.block_id) || "",
      label
    ].map(csvEscape).join(",") + "\n";
    fs.appendFileSync(GROUND_TRUTH_PATH, line, "utf-8");
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: "Failed to save label" });
  }
});

app.listen(PORT, () => {
  console.log(`fertility_ads running on http://localhost:${PORT}`);
});
