const $ = (id) => document.getElementById(id);

const apiBaseInput = $("apiBase");
const pingBtn = $("pingBtn");
const apiStatus = $("apiStatus");
const lastRoute = $("lastRoute");

const txForm = $("txForm");
const predictBtn = $("predictBtn");
const historyBtn = $("historyBtn");
const resetBtn = $("resetBtn");

const resultBox = $("resultBox");

const csvFile = $("csvFile");
const uploadBtn = $("uploadBtn");
const csvSummary = $("csvSummary");

const chart = $("chart");
const ctx = chart.getContext("2d");
const historyNote = $("historyNote");

function apiBase() {
  return (apiBaseInput.value || "").replace(/\/+$/, "");
}

function setStatus(ok, msg) {
  apiStatus.textContent = `API: ${msg}`;
  apiStatus.style.borderColor = ok ? "rgba(16,185,129,.35)" : "rgba(244,63,94,.35)";
  apiStatus.style.color = ok ? "rgba(167,243,208,.95)" : "rgba(254,202,202,.95)";
  apiStatus.style.background = ok ? "rgba(16,185,129,.10)" : "rgba(244,63,94,.10)";
}

async function request(path, opts = {}) {
  lastRoute.textContent = `last: ${path}`;
  const url = apiBase() + path;
  const res = await fetch(url, opts);
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`${res.status} ${res.statusText}\n${t}`);
  }
  return res.json();
}

async function ping() {
  try {
    const res = await fetch(apiBase() + "/health", { method: "GET" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setStatus(true, "reachable");
  } catch (e) {
    setStatus(false, "not reachable");
    // show the real reason in the result box so you don't guess
    resultBox.innerHTML = `<div class="empty"><b>Ping failed</b><br/>
      Try setting API Base URL to <span class="mono">http://127.0.0.1:8000</span><br/>
      <pre>${escapeHtml(String(e?.message || e))}</pre></div>`;
  }
}

pingBtn.addEventListener("click", ping);
window.addEventListener("load", () => {
  $("timestamp").value = "";
  ping();
  drawChart([]); // blank
});

// ----------- UI Renderers -----------
function riskDotClass(level) {
  if (level === "High") return "high";
  if (level === "Medium") return "med";
  return "low";
}

function renderPrediction(data) {
  const dot = riskDotClass(data.risk_level);

  resultBox.innerHTML = `
    <div class="kv">
      <div class="k">transaction_id</div><div class="v mono">${escapeHtml(data.transaction_id)}</div>
      <div class="k">risk_score</div><div class="v"><b>${data.risk_score}</b> / 100</div>
      <div class="k">risk_level</div>
      <div class="v">
        <span class="badge"><span class="dot ${dot}"></span>${escapeHtml(data.risk_level)} Risk</span>
      </div>
      <div class="k">reasons</div>
      <div class="v">
        <ul style="margin:6px 0 0; padding-left:18px; color:rgba(255,255,255,.78);">
          ${(data.reasons || []).map(r => `<li>${escapeHtml(r)}</li>`).join("")}
        </ul>
      </div>
      <div class="k">llm_summary</div>
      <div class="v" style="white-space:pre-wrap; color:rgba(255,255,255,.78);">${escapeHtml(data.llm_summary || "")}</div>
    </div>

    <pre><span class="mono">// Raw JSON from backend</span>\n${escapeHtml(JSON.stringify(data, null, 2))}</pre>
  `;
}

function renderCsvSummary(res) {
  const rows = res.results || [];
  const total = rows.length;
  const high = rows.filter(r => r.risk_level === "High").length;
  const med = rows.filter(r => r.risk_level === "Medium").length;
  const low = rows.filter(r => r.risk_level === "Low").length;

  csvSummary.innerHTML = `
    <div class="kv">
      <div class="k">total</div><div class="v"><b>${total}</b></div>
      <div class="k">high</div><div class="v">${high}</div>
      <div class="k">medium</div><div class="v">${med}</div>
      <div class="k">low</div><div class="v">${low}</div>
    </div>
    <pre><span class="mono">// Raw JSON from backend</span>\n${escapeHtml(JSON.stringify(res, null, 2))}</pre>
  `;
}

// ----------- Actions -----------
txForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  predictBtn.disabled = true;
  resultBox.innerHTML = `<div class="empty">Scoring… calling <span class="mono">POST /predict</span></div>`;

  try {
    const fd = new FormData(txForm);
    const payload = Object.fromEntries(fd.entries());

    // number casts
    payload.amount = Number(payload.amount);
    payload.oldbalanceOrg = Number(payload.oldbalanceOrg);
    payload.newbalanceOrig = Number(payload.newbalanceOrig);
    payload.oldbalanceDest = Number(payload.oldbalanceDest);
    payload.newbalanceDest = Number(payload.newbalanceDest);

    // timestamp default
    if (!payload.timestamp) payload.timestamp = new Date().toISOString();

    const data = await request("/predict", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    setStatus(true, "reachable");
    renderPrediction(data);
  } catch (err) {
    setStatus(false, "error");
    resultBox.innerHTML = `<div class="empty"><b>Error:</b><br/><pre>${escapeHtml(String(err.message || err))}</pre></div>`;
  } finally {
    predictBtn.disabled = false;
  }
});

historyBtn.addEventListener("click", async () => {
  historyBtn.disabled = true;
  historyNote.textContent = "Loading… calling GET /risk_history/{user_id}";
  try {
    const userId = new FormData(txForm).get("user_id");
    const data = await request(`/risk_history/${encodeURIComponent(userId)}`);
    const hist = data.risk_history || [];
    drawChart(hist);
    historyNote.textContent = hist.length ? `Loaded ${hist.length} points for user_id=${userId}` : "No history yet for this user.";
    setStatus(true, "reachable");
  } catch (err) {
    setStatus(false, "error");
    historyNote.textContent = "Failed to load history (see Response Viewer).";
    resultBox.innerHTML = `<div class="empty"><b>Error:</b><br/><pre>${escapeHtml(String(err.message || err))}</pre></div>`;
  } finally {
    historyBtn.disabled = false;
  }
});

resetBtn.addEventListener("click", async () => {
  resetBtn.disabled = true;
  try {
    const data = await request("/reset", { method: "POST" });
    setStatus(true, "reachable");
    resultBox.innerHTML = `<div class="empty">${escapeHtml(data.status || "Reset done.")}</div>`;
    csvSummary.innerHTML = `<div class="empty">No CSV uploaded yet.</div>`;
    drawChart([]);
    historyNote.textContent = "Reset done. Run predictions then load history.";
  } catch (err) {
    setStatus(false, "error");
    resultBox.innerHTML = `<div class="empty"><b>Error:</b><br/><pre>${escapeHtml(String(err.message || err))}</pre></div>`;
  } finally {
    resetBtn.disabled = false;
  }
});

uploadBtn.addEventListener("click", async () => {
  const file = csvFile.files && csvFile.files[0];
  if (!file) {
    csvSummary.innerHTML = `<div class="empty">Pick a CSV file first.</div>`;
    return;
  }

  uploadBtn.disabled = true;
  csvSummary.innerHTML = `<div class="empty">Uploading… calling <span class="mono">POST /upload_csv</span></div>`;

  try {
    const fd = new FormData();
    fd.append("file", file);

    const data = await request("/upload_csv", {
      method: "POST",
      body: fd,
    });

    setStatus(true, "reachable");
    renderCsvSummary(data);
  } catch (err) {
    setStatus(false, "error");
    csvSummary.innerHTML = `<div class="empty"><b>Error:</b><br/><pre>${escapeHtml(String(err.message || err))}</pre></div>`;
  } finally {
    uploadBtn.disabled = false;
  }
});

// ----------- Chart (no libs) -----------
function drawChart(points) {
  // points: [{timestamp, risk_score}]
  const W = chart.width;
  const H = chart.height;

  ctx.clearRect(0, 0, W, H);

  // padding
  const pad = { l: 46, r: 14, t: 18, b: 28 };
  const x0 = pad.l, y0 = pad.t, x1 = W - pad.r, y1 = H - pad.b;

  // background grid
  ctx.globalAlpha = 1;
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.lineWidth = 1;

  for (let i = 0; i <= 5; i++) {
    const y = y0 + (i * (y1 - y0)) / 5;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x1, y);
    ctx.stroke();

    const v = 100 - i * 20;
    ctx.fillStyle = "rgba(255,255,255,.45)";
    ctx.font = "12px ui-monospace";
    ctx.fillText(String(v), 10, y + 4);
  }

  // axes
  ctx.strokeStyle = "rgba(255,255,255,.12)";
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x0, y1);
  ctx.lineTo(x1, y1);
  ctx.stroke();

  if (!points || points.length === 0) {
    ctx.fillStyle = "rgba(255,255,255,.45)";
    ctx.font = "14px system-ui";
    ctx.fillText("No history points yet.", x0 + 16, y0 + 30);
    return;
  }

  // normalize x over index (simple)
  const n = points.length;
  const xs = points.map((_, i) => x0 + (i * (x1 - x0)) / Math.max(1, n - 1));
  const ys = points.map((p) => {
    const v = Math.max(0, Math.min(100, Number(p.risk_score)));
    return y0 + ((100 - v) * (y1 - y0)) / 100;
  });

  // line
  ctx.strokeStyle = "rgba(255,255,255,.65)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(xs[0], ys[0]);
  for (let i = 1; i < n; i++) ctx.lineTo(xs[i], ys[i]);
  ctx.stroke();

  // points colored by risk band
  for (let i = 0; i < n; i++) {
    const v = Number(points[i].risk_score);
    const level = v >= 80 ? "high" : v >= 40 ? "med" : "low";
    ctx.fillStyle =
      level === "high" ? "rgba(244,63,94,.95)" :
      level === "med"  ? "rgba(245,158,11,.95)" :
                         "rgba(16,185,129,.95)";
    ctx.beginPath();
    ctx.arc(xs[i], ys[i], 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ----------- Utils -----------
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}