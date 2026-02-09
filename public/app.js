const articleSelect = document.getElementById("articleSelect");
const rowCount = document.getElementById("rowCount");
const searchInput = document.getElementById("searchInput");
const yearFilter = document.getElementById("yearFilter");
const articleText = document.getElementById("articleText");
const articleMeta = document.getElementById("articleMeta");
const newspaperInfo = document.getElementById("newspaperInfo");
const ocrOutput = document.getElementById("ocrOutput");
const reproLabel = document.getElementById("reproLabel");
const reproExplanation = document.getElementById("reproExplanation");
const reproExtract = document.getElementById("reproExtract");
const statusEl = document.getElementById("status");
const btnCleanAd = document.getElementById("btnCleanAd");
const btnRepro = document.getElementById("btnRepro");
const manualLabel = document.getElementById("manualLabel");
const saveManual = document.getElementById("saveManual");
const manualStatus = document.getElementById("manualStatus");
const modelSelect = document.getElementById("modelSelect");
const modelInput = document.getElementById("modelInput");
const modelLabels = document.getElementById("modelLabels");
const groundTruthSelect = document.getElementById("groundTruthSelect");
const accuracyStats = document.getElementById("accuracyStats");

const state = {
  rows: [],
  filtered: [],
  selected: null,
  rowByIndex: new Map(),
  lccnMap: {},
  classifications: {
    gemini: {},
    gpt: {}
  },
  groundTruth: {}
};

function setStatus(message) {
  statusEl.textContent = message;
}

function setManualStatus(message) {
  manualStatus.textContent = message;
}

function getSelectedModel() {
  const custom = modelInput.value.trim();
  if (custom) return custom;
  return modelSelect.value || "gpt-5.2";
}

function normalizeLabel(value) {
  return (value || "").toString().trim().toUpperCase();
}

function renderExtraction(output) {
  if (!output) {
    reproExtract.textContent = "No extraction yet.";
    return;
  }
  let data = null;
  try {
    data = JSON.parse(output);
  } catch (err) {
    reproExtract.textContent = output;
    return;
  }
  const fields = [
    ["Named brands & lifecycles", "named_brands_and_lifecycles"],
    ["Pricing", "pricing"],
    ["Distribution channels", "distribution_channels"],
    ["Location (manufacturing)", "location_manufacturing"],
    ["Location (purchase)", "location_purchase"],
    ["Type", "type"],
    ["Symptoms", "symptoms"],
    ["Direction of use", "direction_of_use"],
    ["Health warnings", "health_warnings"],
    ["Order by post", "order_by_post"]
  ];
  const lines = fields.map(([label, key]) => {
    const value = data && data[key] ? data[key] : "Not present/unclear";
    return `<div class="extract-line"><span class="extract-label">${label}</span><span class="extract-value">${escapeHtml(String(value))}</span></div>`;
  });
  reproExtract.innerHTML = lines.join("");
}

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

function csvToObjects(csvText) {
  const [header, ...dataRows] = parseCSV(csvText);
  return dataRows.map((cells, idx) => {
    const obj = { _rowIndex: idx };
    header.forEach((key, i) => {
      obj[key] = cells[i] ?? "";
    });
    return obj;
  });
}

function detectLabelKey(sample) {
  if (!sample) return "";
  if (sample.Gemini_classification !== undefined) return "Gemini_classification";
  const key = Object.keys(sample).find((k) => k.toLowerCase().includes("classification"));
  return key || "";
}

function buildLabelMap(rows) {
  const labelKey = detectLabelKey(rows[0]);
  const map = {};
  rows.forEach((row) => {
    if (!row.json_path) return;
    const label = labelKey ? row[labelKey] : "";
    map[row.json_path] = normalizeLabel(label);
  });
  return map;
}

function attachClassificationToRows() {
  if (!state.rows.length) return;
  state.rows.forEach((row) => {
    const path = row.json_path;
    row.gemini_label = state.classifications.gemini[path] || "";
    row.gpt_label = state.classifications.gpt[path] || "";
    row.manual_label = state.groundTruth[path] || "";
  });
}

function updateModelLabels(row) {
  if (!row) {
    modelLabels.textContent = "No model labels loaded.";
    return;
  }
  const lines = [
    ["Gemini (g1)", row.gemini_label || "Not available"],
    ["GPT5.2 nano-flash", row.gpt_label || "Not available"],
    ["Manual label", row.manual_label || "Not labeled"]
  ];
  modelLabels.innerHTML = lines.map(([label, value]) => (
    `<div class="analysis-line"><span class="analysis-label">${label}</span><span>${escapeHtml(value)}</span></div>`
  )).join("");
}

function computeAccuracy(gtMap, predMap) {
  let total = 0;
  let correct = 0;
  Object.keys(gtMap).forEach((key) => {
    const gt = normalizeLabel(gtMap[key]);
    const pred = normalizeLabel(predMap[key]);
    if (!gt || !pred) return;
    total += 1;
    if (gt === pred) correct += 1;
  });
  return { total, correct, accuracy: total ? (correct / total) : 0 };
}

function getGroundTruthMap(source) {
  if (source === "gemini") return state.classifications.gemini;
  if (source === "gpt") return state.classifications.gpt;
  return state.groundTruth;
}

function updateAccuracy() {
  const source = groundTruthSelect.value;
  const gtMap = getGroundTruthMap(source);
  if (!gtMap || Object.keys(gtMap).length === 0) {
    accuracyStats.textContent = "No ground truth data available.";
    return;
  }

  const geminiAcc = computeAccuracy(gtMap, state.classifications.gemini);
  const gptAcc = computeAccuracy(gtMap, state.classifications.gpt);
  const lines = [
    ["Ground truth source", source],
    ["Gemini accuracy", `${(geminiAcc.accuracy * 100).toFixed(1)}% (${geminiAcc.correct}/${geminiAcc.total})`],
    ["GPT5.2 accuracy", `${(gptAcc.accuracy * 100).toFixed(1)}% (${gptAcc.correct}/${gptAcc.total})`]
  ];
  accuracyStats.innerHTML = lines.map(([label, value]) => (
    `<div class="analysis-line"><span class="analysis-label">${label}</span><span>${escapeHtml(value)}</span></div>`
  )).join("");
}

function formatTitle(row) {
  const year = row.year || "n/a";
  const path = row.json_path || "(no json_path)";
  return `${year} | ${path}`;
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function collectMatches(text, patterns) {
  const ranges = [];
  patterns.forEach((pattern) => {
    if (!pattern) return;
    let regex = null;
    try {
      regex = new RegExp(pattern, "gi");
    } catch (err) {
      return;
    }
    let match;
    while ((match = regex.exec(text)) !== null) {
      if (!match[0]) {
        regex.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = match.index + match[0].length;
      ranges.push([start, end]);
    }
  });

  if (ranges.length === 0) return [];
  ranges.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  const merged = [ranges[0]];
  for (let i = 1; i < ranges.length; i += 1) {
    const [start, end] = ranges[i];
    const last = merged[merged.length - 1];
    if (start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

function highlightText(text, matchedPatterns) {
  if (!text) return "";
  if (!matchedPatterns) return escapeHtml(text);
  const patterns = matchedPatterns
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
  if (patterns.length === 0) return escapeHtml(text);

  const ranges = collectMatches(text, patterns);
  if (ranges.length === 0) return escapeHtml(text);

  let html = "";
  let cursor = 0;
  ranges.forEach(([start, end]) => {
    html += escapeHtml(text.slice(cursor, start));
    html += `<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    cursor = end;
  });
  html += escapeHtml(text.slice(cursor));
  return html;
}

function parseJsonPath(value) {
  const text = (value || "").trim();
  const combined = text.match(/(\d{4}-\d{2}-\d{2})_p(\d+)_sn(\d{8})/i);
  const lccnMatch = text.match(/sn\d{8}/i);
  const lccnFromParts = text
    .split(/[\\/_]/)
    .map((part) => part.trim())
    .find((part) => /^sn\d{8}$/i.test(part));
  const dateMatch = text.match(/(\d{4}-\d{2}-\d{2})/);
  const pageMatch = text.match(/(?:^|_)p(\d+)\b/i);
  return {
    lccn: combined ? `sn${combined[3]}`.toLowerCase()
      : (lccnMatch ? lccnMatch[0].toLowerCase() : (lccnFromParts ? lccnFromParts.toLowerCase() : "")),
    date: combined ? combined[1] : (dateMatch ? dateMatch[1] : ""),
    page: combined ? combined[2] : (pageMatch ? pageMatch[1] : "")
  };
}

function extractMetaFromRow(row) {
  const sources = [row.json_path, row.full_article_id, row.block_id].filter(Boolean);
  const parsed = { lccn: "", date: "", page: "" };
  sources.forEach((source) => {
    const next = parseJsonPath(source);
    if (!parsed.lccn && next.lccn) parsed.lccn = next.lccn;
    if (!parsed.date && next.date) parsed.date = next.date;
    if (!parsed.page && next.page) parsed.page = next.page;
  });
  return parsed;
}

function renderList() {
  articleSelect.innerHTML = "";
  state.filtered.forEach((row) => {
    const option = document.createElement("option");
    option.value = row._rowIndex;
    const prefix = row.manual_label ? "✓ " : "";
    const suffix = row.manual_label ? " [MANUAL]" : "";
    option.textContent = `${prefix}${formatTitle(row)}${suffix}`;
    if (state.selected && state.selected._rowIndex === row._rowIndex) {
      option.selected = true;
    }
    articleSelect.appendChild(option);
  });
}

function selectRow(row) {
  state.selected = row;
  const rawText = row.article || "";
  articleText.innerHTML = highlightText(rawText, row.matched_patterns);
  const meta = [
    row.year ? `Year: ${row.year}` : null,
    row.full_article_id ? `Article ID: ${row.full_article_id}` : null,
    row.block_id ? `Block ID: ${row.block_id}` : null
  ].filter(Boolean);
  articleMeta.textContent = meta.join(" | ") || "No metadata";
  updateNewspaperInfo(row);
  updateModelLabels(row);
  renderList();
}

function updateNewspaperInfo(row) {
  const parsed = extractMetaFromRow(row);
  const lccn = parsed.lccn;
  const info = lccn ? state.lccnMap[lccn] : null;

  if (!info) {
    if (!lccn) {
      const path = row.json_path ? escapeHtml(row.json_path) : "(empty json_path)";
      newspaperInfo.innerHTML = `<div class="meta-line"><span class="meta-label">Status</span><span class="meta-value">No LCCN detected in json_path: ${path}</span></div>`;
    } else {
      newspaperInfo.innerHTML = `<div class="meta-line"><span class="meta-label">Status</span><span class="meta-value">LCCN ${escapeHtml(lccn)} not found in Chronicling America data.</span></div>`;
    }
    return;
  }

  const firstYear = (info.first_issue || "").slice(0, 4);
  const lastYear = (info.last_issue || "").slice(0, 4);
  let years = "";
  if (firstYear && lastYear) {
    years = firstYear === lastYear ? firstYear : `${firstYear}–${lastYear}`;
  } else {
    years = firstYear || lastYear || "";
  }

  const pageLink = (parsed.date && parsed.page)
    ? `https://www.loc.gov/resource/${lccn}/${parsed.date}/ed-1/?sp=${parsed.page}`
    : "";

  const lines = [];
  if (lccn) {
    lines.push(`<div class="meta-line"><span class="meta-label">LCCN</span><span class="meta-value">${escapeHtml(lccn)}</span></div>`);
  }
  if (info.newspaper) {
    lines.push(`<div class="meta-line"><span class="meta-label">Title</span><span class="meta-value">${escapeHtml(info.newspaper)}</span></div>`);
  }
  if (years) {
    lines.push(`<div class="meta-line"><span class="meta-label">Dates of Publication</span><span class="meta-value">${escapeHtml(years)}</span></div>`);
  }
  if (parsed.date) {
    lines.push(`<div class="meta-line"><span class="meta-label">Issue date</span><span class="meta-value">${escapeHtml(parsed.date)}</span></div>`);
  }
  if (parsed.page) {
    lines.push(`<div class="meta-line"><span class="meta-label">Page</span><span class="meta-value">${escapeHtml(parsed.page)}</span></div>`);
  }
  if (info.city || info.state) {
    const cityState = [info.city, info.state].filter(Boolean).join(", ");
    lines.push(`<div class="meta-line"><span class="meta-label">City/State</span><span class="meta-value">${escapeHtml(cityState)}</span></div>`);
  }
  if (pageLink) {
    lines.push(`<div class="meta-line"><span class="meta-label">Issue page link</span><span class="meta-value"><a href="${pageLink}" target="_blank" rel="noreferrer">${escapeHtml(pageLink)}</a></span></div>`);
  } else if (info.browse_url) {
    lines.push(`<div class="meta-line"><span class="meta-label">Browse issues</span><span class="meta-value"><a href="${info.browse_url}" target="_blank" rel="noreferrer">${escapeHtml(info.browse_url)}</a></span></div>`);
  }

  newspaperInfo.innerHTML = lines.join("");
}

function applyFilter() {
  const term = searchInput.value.trim().toLowerCase();
  const year = yearFilter.value;
  if (!term) {
    state.filtered = [...state.rows];
  } else {
    state.filtered = state.rows.filter((row) => {
      return [row.json_path, row.year, row.full_article_id, row.block_id, row.headline]
        .filter(Boolean)
        .some((value) => value.toString().toLowerCase().includes(term));
    });
  }
  if (year && year !== "all") {
    state.filtered = state.filtered.filter((row) => (row.year || "") === year);
  }
  const hasSelected = state.selected && state.filtered.some((row) => row._rowIndex === state.selected._rowIndex);
  if (state.filtered.length === 0) {
    articleText.textContent = "No rows found.";
    articleMeta.textContent = "No metadata";
    newspaperInfo.textContent = "";
    renderList();
    return;
  }
  if (!hasSelected) {
    selectRow(state.filtered[0]);
    return;
  }
  renderList();
}

function updateYearOptions() {
  const years = Array.from(new Set(state.rows.map((row) => row.year).filter(Boolean)));
  years.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  yearFilter.innerHTML = "";
  const allOption = document.createElement("option");
  allOption.value = "all";
  allOption.textContent = "All years";
  yearFilter.appendChild(allOption);
  years.forEach((year) => {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    yearFilter.appendChild(option);
  });
}

async function loadLccnMap() {
  try {
    const res = await fetch("data/lccn_map.json");
    if (!res.ok) return;
    state.lccnMap = await res.json();
    if (state.selected) updateNewspaperInfo(state.selected);
  } catch (err) {
    state.lccnMap = {};
  }
}

async function loadClassifications() {
  const loadCsv = async (path) => {
    const res = await fetch(path);
    if (!res.ok) return [];
    const text = await res.text();
    return csvToObjects(text);
  };

  try {
    const [gptRows, geminiRows] = await Promise.all([
      loadCsv("data/output200.csv"),
      loadCsv("data/output200_g1.csv")
    ]);
    state.classifications.gpt = buildLabelMap(gptRows);
    state.classifications.gemini = buildLabelMap(geminiRows);
    attachClassificationToRows();
    if (state.selected) updateModelLabels(state.selected);
    updateAccuracy();
  } catch (err) {
    state.classifications.gpt = {};
    state.classifications.gemini = {};
  }
}

async function loadGroundTruth() {
  try {
    const res = await fetch("api/ground-truth");
    if (!res.ok) return;
    const data = await res.json();
    const rows = data.rows || [];
    const map = {};
    rows.forEach((row) => {
      if (!row.json_path) return;
      map[row.json_path] = normalizeLabel(row.manual_label);
    });
    state.groundTruth = map;
    attachClassificationToRows();
    if (state.selected) updateModelLabels(state.selected);
    updateAccuracy();
    renderList();
  } catch (err) {
    state.groundTruth = {};
  }
}

async function loadRows() {
  setStatus("Loading CSV...");
  let rows = null;

  try {
    const res = await fetch("api/rows");
    if (res.ok) {
      const data = await res.json();
      rows = data.rows || [];
    }
  } catch (err) {
    rows = null;
  }

  if (!rows) {
    try {
      const res = await fetch("data/sample200.csv");
      if (res.ok) {
        const csvText = await res.text();
        rows = csvToObjects(csvText);
        setStatus("Loaded from static CSV (backend unavailable)");
      }
    } catch (err) {
      rows = [];
    }
  }

  state.rows = rows || [];
  state.rowByIndex = new Map(state.rows.map((row) => [row._rowIndex, row]));
  attachClassificationToRows();
  state.filtered = [...state.rows];
  updateYearOptions();
  rowCount.textContent = `${state.rows.length} rows loaded`;
  if (state.rows.length > 0) {
    selectRow(state.rows[0]);
  } else {
    articleText.textContent = "No rows found.";
  }
  renderList();
  setStatus("");
  updateAccuracy();
}

async function postForOutput(endpoint) {
  if (!state.selected) return;
  setStatus("Calling OpenAI...");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text: state.selected.article || "",
      model: getSelectedModel(),
      json_path: state.selected.json_path || "",
      year: state.selected.year || "",
      full_article_id: state.selected.full_article_id || "",
      block_id: state.selected.block_id || ""
    })
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  if (!res.ok) {
    setStatus((data && data.error) || "Backend unavailable");
    return null;
  }
  setStatus("Done");
  return data && data.output ? data.output : null;
}

btnCleanAd.addEventListener("click", async () => {
  ocrOutput.textContent = "Running...";
  const output = await postForOutput("api/ocr-correct");
  if (output) ocrOutput.textContent = output;
});

btnRepro.addEventListener("click", async () => {
  reproLabel.textContent = "Running...";
  reproLabel.removeAttribute("data-label");
  reproExplanation.textContent = "Waiting for response...";
  reproExtract.textContent = "No extraction yet.";
  const output = await postForOutput("api/repro-classify");
  if (!output) {
    reproLabel.textContent = "Label: —";
    reproExplanation.textContent = "No output received.";
    return;
  }

  const lines = output.trim().split(/\r?\n/);
  const label = (lines.shift() || "").trim();
  while (lines.length && lines[0].trim() === "") {
    lines.shift();
  }
  const explanation = lines.join("\n").trim();

  if (label) {
    const upper = label.toUpperCase();
    reproLabel.textContent = upper;
    reproLabel.dataset.label = upper;
    if (upper === "ADS_REPRO") {
      reproExplanation.textContent = explanation || output.trim();
      const extractOutput = await postForOutput("api/repro-extract");
      if (extractOutput) {
        renderExtraction(extractOutput);
      } else {
        reproExtract.textContent = "Extraction failed.";
      }
      return;
    }
  } else {
    reproLabel.textContent = "Label: —";
    reproLabel.removeAttribute("data-label");
  }

  reproExplanation.textContent = explanation || output.trim();
  reproExtract.textContent = "Not ADS_REPRO.";
});

saveManual.addEventListener("click", async () => {
  if (!state.selected) return;
  const label = manualLabel.value;
  if (!label) {
    setManualStatus("Select a label first.");
    return;
  }
  setManualStatus("Saving...");
  const res = await fetch("api/ground-truth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      label,
      json_path: state.selected.json_path || "",
      year: state.selected.year || "",
      full_article_id: state.selected.full_article_id || "",
      block_id: state.selected.block_id || ""
    })
  });
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  if (!res.ok) {
    setManualStatus((data && data.error) || "Failed to save.");
    return;
  }
  await loadGroundTruth();
  setManualStatus("Saved.");
});

searchInput.addEventListener("input", applyFilter);
yearFilter.addEventListener("change", applyFilter);
groundTruthSelect.addEventListener("change", updateAccuracy);
articleSelect.addEventListener("change", (event) => {
  const idx = Number(event.target.value);
  const row = state.rowByIndex.get(idx);
  if (row) selectRow(row);
});

Promise.all([loadLccnMap(), loadClassifications(), loadGroundTruth(), loadRows()]).catch(() => {
  setStatus("Failed to load rows");
});
