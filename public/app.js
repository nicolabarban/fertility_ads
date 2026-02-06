const rowList = document.getElementById("rowList");
const rowCount = document.getElementById("rowCount");
const searchInput = document.getElementById("searchInput");
const articleText = document.getElementById("articleText");
const articleMeta = document.getElementById("articleMeta");
const ocrOutput = document.getElementById("ocrOutput");
const reproOutput = document.getElementById("reproOutput");
const statusEl = document.getElementById("status");
const btnCleanAd = document.getElementById("btnCleanAd");
const btnRepro = document.getElementById("btnRepro");

const state = {
  rows: [],
  filtered: [],
  selected: null
};

function setStatus(message) {
  statusEl.textContent = message;
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

function renderList() {
  rowList.innerHTML = "";
  state.filtered.forEach((row) => {
    const button = document.createElement("button");
    button.className = "row-item";
    button.textContent = formatTitle(row);
    if (state.selected && state.selected._rowIndex === row._rowIndex) {
      button.classList.add("active");
    }
    button.addEventListener("click", () => selectRow(row));
    rowList.appendChild(button);
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
  renderList();
}

function applyFilter() {
  const term = searchInput.value.trim().toLowerCase();
  if (!term) {
    state.filtered = [...state.rows];
  } else {
    state.filtered = state.rows.filter((row) => {
      return [row.json_path, row.year, row.full_article_id, row.block_id, row.headline]
        .filter(Boolean)
        .some((value) => value.toString().toLowerCase().includes(term));
    });
  }
  renderList();
}

async function loadRows() {
  setStatus("Loading CSV...");
  let rows = null;

  try {
    const res = await fetch("/api/rows");
    if (res.ok) {
      const data = await res.json();
      rows = data.rows || [];
    }
  } catch (err) {
    rows = null;
  }

  if (!rows) {
    try {
      const res = await fetch("/data/sample200.csv");
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
  state.filtered = [...state.rows];
  rowCount.textContent = `${state.rows.length} rows loaded`;
  if (state.rows.length > 0) {
    selectRow(state.rows[0]);
  } else {
    articleText.textContent = "No rows found.";
  }
  renderList();
  setStatus("");
}

async function postForOutput(endpoint) {
  if (!state.selected) return;
  setStatus("Calling OpenAI...");
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: state.selected.article || "" })
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
  const output = await postForOutput("/api/ocr-correct");
  if (output) ocrOutput.textContent = output;
});

btnRepro.addEventListener("click", async () => {
  reproOutput.textContent = "Running...";
  const output = await postForOutput("/api/repro-classify");
  if (output) reproOutput.textContent = output;
});

searchInput.addEventListener("input", applyFilter);

loadRows().catch(() => {
  setStatus("Failed to load rows");
});
