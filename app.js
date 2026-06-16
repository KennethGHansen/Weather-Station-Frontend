// ===============================
// Hidden DEV toggle for history data source (SIM vs REAL)
// Default is REAL; SIM is for local/dev inspection only
// ===============================
(function setupHiddenDataModeToggle() {
  const KEY = "weather_data_mode"; // "sim" | "real"
  const DEFAULT_MODE = "real";

// Initialize once; REAL is the production default
if (!localStorage.getItem(KEY)) {
  localStorage.setItem(KEY, DEFAULT_MODE);
}

// Ctrl + Alt + D toggles mode
window.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.altKey && e.code === "KeyD") {
      const current = localStorage.getItem(KEY) || DEFAULT_MODE;
      const next = current === "sim" ? "real" : "sim";
      localStorage.setItem(KEY, next);

      alert(`DEV data mode: ${next.toUpperCase()}`);

      // Force refresh so graphs refetch
      location.reload();
    }
});

window.__getWeatherDataMode = () =>
    localStorage.getItem(KEY) || DEFAULT_MODE;
})();

// ------------------------------------------------------------
// ISO week number helper
// ------------------------------------------------------------
function getISOWeek(date) {
  const target = new Date(date.getTime());
  target.setHours(0, 0, 0, 0);

  // move to Thursday (ISO rule)
  target.setDate(target.getDate() + 3 - (target.getDay() + 6) % 7);

  const firstThursday = new Date(target.getFullYear(), 0, 4);
  firstThursday.setDate(firstThursday.getDate() + 3 - (firstThursday.getDay() + 6) % 7);

  const weekNumber = 1 + Math.round(
    (target - firstThursday) / (7 * 24 * 60 * 60 * 1000)
  );

  return { year: target.getFullYear(), week: weekNumber };
}

/* ============================================================================
 * Load history snapshot (idempotent; used by controlled polling)
 * ============================================================================
 */
async function loadHistoryOnce() {
  try {
    // ============================================================
    // DATA MODE (hidden toggle)
    // ============================================================
    // - "sim"  => simulated history (safe, no DO/SQLite)
    // - "real" => real history (server may still refuse if disabled)
    //
    // IMPORTANT:
    // This is NOT security. It is only a *client preference*.
    // The server remains authoritative and may return empty samples for "real".
    // ============================================================
    const mode =
      (typeof window.__getWeatherDataMode === "function")
        ? window.__getWeatherDataMode()   // returns "sim" or "real"
        : "sim";                          // safe default

    // ============================================================
    // HISTORY REQUEST (mode is appended as a query param)
    // ============================================================
    // This ensures the history endpoint can switch between:
    //   /api/history?range=24h&amp;mode=sim
    //   /api/history?range=24h&amp;mode=real
    // ============================================================
	const res = await fetch(
	  `/api/history?range=${historyRange}&mode=${encodeURIComponent(mode)}&t=${Date.now()}`,
	  { cache: "no-store" }
	);
	
    if (!res.ok) {
      console.warn("History fetch failed:", res.status);
      renderAllHistoryCharts([]);
      return;
    }

    const data = await res.json();

    // Defensive: ensure array
    const samples = (Array.isArray(data.samples) ? data.samples : [])
      .slice()
      .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

    // Cache locally (future steps will reuse this)
    historyBuf = samples;
    historyLastTs = samples.length > 0 ? samples[samples.length - 1].ts : null;

    // Render ONCE
    renderAllHistoryCharts(historyBuf);

  } catch (err) {
    console.error("History fetch error:", err);
    renderAllHistoryCharts([]);
  }
}

/* ============================================================================
 * HISTORY LIVE UPDATE (EXACTLY ONE TIMER)
 * ========================================================================== */
let historyPollTimer = null;

// ============================================================================
// HISTORY POLLING POLICY (single source of truth)
// - Adjust intervals here without hunting through code.
// - Values are milliseconds.
// ============================================================================
const HISTORY_POLL_MS_BY_RANGE = {
  "6h":  15000,
  "24h": 15000,
  "7d":  60000,
  "30d": 0,       // 0 => no polling after the initial load (fetch-on-enter only)
  "1y":  0   // 1y = fetch-on-enter only (no polling)
};

function startHistoryPolling() {
  // HARD reset (never rely on "if (timer)")
  stopHistoryPolling();

  // Immediate fetch
  loadHistoryOnce();

  // Single, controlled interval (range-dependent)
    const pollMs = HISTORY_POLL_MS_BY_RANGE[historyRange] ?? 15000;

  // If 0, we do fetch-on-enter only (no background polling)
  if (pollMs > 0) {
    historyPollTimer = setInterval(() => {
      loadHistoryOnce();
    }, pollMs);
  }
}

function stopHistoryPolling() {
  if (historyPollTimer !== null) {
    clearInterval(historyPollTimer);
    historyPollTimer = null;
  }
}

/* ============================================================================
 * HISTORY BUFFER (sliding window)
 * ============================================================================
 *
 * - historyBuf holds the current window
 * - historyLastTs tracks the most recent timestamp in the buffer
 * - historyState holds the running "last values" so the series is smooth
 * ============================================================================
 */
let historyBuf = [];            // array of REAL samples used by charts
let historyLastTs = null;       // newest REAL ts in historyBuf (null until loaded)

/* ============================================================================
 * HISTORY VIEW STATE (frontend only)
 * ============================================================================
 *
 * Purpose:
 * - Track which time window is currently selected
 * - Later used to fetch real history data
 *   (e.g. /api/history?range=24h)
 * ============================================================================
 */
let historyRange = "24h";   // default selection

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// Small helper function that should solve the min/max value confusion (text or string)
function toNumber(v) {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const clockEl = document.getElementById("clock");
// If you truly want a fixed GMT+1 (no DST), use "Etc/GMT-1".
// If you want Denmark local time with DST, use "Europe/Copenhagen".
const clockFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Copenhagen",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function tickClock() {
  if (clockEl) clockEl.textContent = clockFmt.format(new Date());
}

tickClock();
setInterval(tickClock, 1000);

/* ============================================================================
 * FIXED X-AXIS LABEL STRATEGY (exactly 6 labels)
 * ============================================================================
 */
/* Format timestamp depending on range */
function formatXAxisLabel(ts, range) {
  const d = new Date(ts * 1000);

  // 1y: month-only labels
  if (range === "1y") {
    return d.toLocaleDateString([], { month: "short" });
  }

  // 6h + 24h: time labels
  if (range === "6h" || range === "24h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // 7d + 30d: date labels
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

/* Build labels array + tick callback */
function buildXAxis(historyData, range) {
  const len = historyData.length;
  if (len === 0) {
    return { labels: [], tickCallback: () => "" };
  }

  /* ------------------------------------------------------------
   * 1y: show labels at month change (weekly-safe)
   * ------------------------------------------------------------ */
  if (range === "1y") {
    const labels = historyData.map((p, i, arr) => {
      const d = new Date(p.ts * 1000);

      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Copenhagen",
        year: "numeric",
        month: "2-digit"
      }).formatToParts(d);

      const month = parts.find(part => part.type === "month").value;
      const year  = parts.find(part => part.type === "year").value;

      if (i === 0) {
        return new Intl.DateTimeFormat("en-GB", {
          timeZone: "Europe/Copenhagen",
          month: "short"
        }).format(d);
      }

      const prev = new Date(arr[i - 1].ts * 1000);

      const prevParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Europe/Copenhagen",
        year: "numeric",
        month: "2-digit"
      }).formatToParts(prev);

      const prevMonth = prevParts.find(part => part.type === "month").value;
      const prevYear  = prevParts.find(part => part.type === "year").value;

      const monthChanged = (month !== prevMonth) || (year !== prevYear);

      return monthChanged
        ? new Intl.DateTimeFormat("en-GB", {
            timeZone: "Europe/Copenhagen",
            month: "short"
          }).format(d)
        : "";
    });

    return {
      labels,
      tickCallback(value) {
        return this.getLabelForValue(value) || "";
      }
    };
  }

  /* ------------------------------------------------------------
   * Existing behavior for 6h / 24h / 7d / 30d
   * ------------------------------------------------------------ */
  const indices = [];
  for (let i = 0; i < 6; i++) {
    indices.push(Math.round(i * (len - 1) / 5));
  }
  const indexSet = new Set(indices);

  return {
    labels: historyData.map((p, i) =>
      indexSet.has(i) ? formatXAxisLabel(p.ts, range) : ""
    ),
    tickCallback(value) {
      return this.getLabelForValue(value) || "";
    }
  };
}

/* ============================================================================
 * LEFT‑ALIGNED DATE STAMP PLUGIN
 * ============================================================================
 *
 * PURPOSE:
 * - Draws a small date label directly onto the chart canvas
 * - Positioned between:
 *     • Y‑axis labels (left)
 *     • First X‑axis tick label (right)
 *
 * WHY THIS EXISTS:
 * - X‑axis labels are sparse, intentionally
 * - Users still need to know WHICH DAY the chart starts on
 * - Axis titles cannot do this without consuming layout space
 *
 * IMPORTANT:
 * - This does NOT affect chart layout
 * - This does NOT affect data
 * - This is pure visual context only
 * - Safe to remove without breaking charts (pure decoration)
 *
 * WHEN IT APPEARS:
 * - Only for 6h, 24h and 1 year views
 * - Hidden for 7d, 30d (dates already visible there)
 *
 * HOW IT WORKS:
 * - Hooks into Chart.js `afterDatasetsDraw`
 * - Measures first X‑tick text width
 * - Calculates safe position to the LEFT of it
 * - Draws text using the same font as the axis ticks
 * ============================================================================
 */
const leftDateStampPlugin = {
  id: "leftDateStamp",

  afterDatasetsDraw(chart, args, pluginOptions) {
    const { ctx } = chart;
    const { range, firstTs, singleLine } = pluginOptions || {};
    
    // Active for 6h, 24h and 1y (year stamp)
    if (range !== "6h" && range !== "24h" && range !== "1y") return;

    if (!firstTs) return;

    const xScale = chart.scales?.x;
    if (!xScale || !xScale.ticks?.length) return;

    // Convert first timestamp into date parts
    const d = new Date(firstTs * 1000);

    // ------------------------------------------------------------
    // Use Copenhagen timezone for stamp
    // ------------------------------------------------------------
    if (range === "1y") {

      const yearText = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Copenhagen",
        year: "numeric"
      }).format(d);

      ctx.save();
      ctx.fillStyle = "#9ca3af";
      ctx.textAlign = "center";
      ctx.textBaseline = "alphabetic";

      const xScale = chart.scales?.x;
      if (!xScale || !xScale.ticks?.length) return;

      const tickFont = Chart.helpers.toFont(xScale.options.ticks.font);
      ctx.font = tickFont.string;

      const tickX = xScale.getPixelForTick(0);

      const firstLabel = xScale.getLabelForValue(0) || "";
      const labelWidth = firstLabel ? ctx.measureText(firstLabel).width : 0;

      const yearWidth = ctx.measureText(yearText).width;

      const GAP_PX = 8;
      const x =
        tickX -
        (labelWidth / 2) -
        GAP_PX -
        (yearWidth / 2);

      const y = xScale.bottom - 6;

      ctx.fillText(yearText, x, y);
      ctx.restore();

      return;
    }

    // Existing behavior (6h / 24h)
    const dayText   = d.toLocaleDateString([], { day: "2-digit" });
    const monthText = d.toLocaleDateString([], { month: "short" });
    const oneLineText = `${dayText} ${monthText}`;


    // Use the same font as X‑axis labels for visual consistency
    const tickFont = Chart.helpers.toFont(xScale.options.ticks.font);

    ctx.save();
    ctx.font = tickFont.string;
    ctx.fillStyle = "#9ca3af";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";

    // Pixel position of the FIRST X‑axis tick
    const tickX = xScale.getPixelForTick(0);

    // Measure first time label width so we avoid overlap
    const firstTimeLabel = xScale.getLabelForValue(0) || "";
    const timeLabelWidth = firstTimeLabel
      ? ctx.measureText(firstTimeLabel).width
      : 0;

    // Measure date width
    const dateWidth = singleLine
      ? ctx.measureText(oneLineText).width
      : Math.max(
          ctx.measureText(dayText).width,
          ctx.measureText(monthText).width
        );

    // Horizontal layout:
    // [ DATE ][ gap ][ TIME ]
    const GAP_PX = 8;
    const x =
      tickX -
      (timeLabelWidth / 2) -
      GAP_PX -
      (dateWidth / 2);

    // Vertical baseline aligned with tick labels
    const lh = tickFont.lineHeight;
    const baseY = xScale.bottom - 6;

    if (singleLine) {
      // Pressure chart: single‑line date
      ctx.fillText(oneLineText, x, baseY);
    } else {
      // Temperature / Humidity: stacked day + month
      ctx.fillText(dayText,   x, baseY - lh);
      ctx.fillText(monthText, x, baseY);
    }

    ctx.restore();
  }
};

/* ============================================================================
 * GLOBAL REGISTRATION OF leftDateStampPlugin
 * ============================================================================
 *
 * CRITICAL:
 * - JavaScript `const` declarations are NOT hoisted
 * - The plugin MUST be defined BEFORE it is registered
 *
 * This line makes the plugin available to all charts.
 * ============================================================================
 */
Chart.register(leftDateStampPlugin);

/* ============================================================================
 * Update weather function
 * ============================================================================
 */
async function updateWeather() {
  const res = await fetch("/api/weather", { cache: "no-store" });
  const data = await res.json();

  const w = data?.weather;
  if (!w) return;

  // ---- Station online/offline indicator ----
  const now = Math.floor(Date.now() / 1000);
  const lastTs = toNumber(data.ts ?? w.ts);

  const dot = document.getElementById("station-dot");
  const label = document.getElementById("station-status");
  const cards = document.getElementById("cards");

  // consider station online if last update < 30 seconds ago
  if (lastTs !== null && now - lastTs < 30) {
    // ONLINE
    dot.className = "w-3 h-3 rounded-full bg-green-500";
    label.textContent = "Weather‑Station Online";
    label.className = "text-sm font-medium text-green-400";

    if (cards) {
      cards.style.opacity = "1";
      cards.style.filter = "";
      cards.style.pointerEvents = "";
    }
  } else {
    // OFFLINE
    dot.className = "w-3 h-3 rounded-full bg-red-500";
    label.textContent = "Weather‑Station Offline";
    label.className = "text-sm font-medium text-red-400";

    if (cards) {
      cards.style.opacity = "0.4";          // always works
      cards.style.filter = "grayscale(1)";  // mobile Safari-safe
      cards.style.pointerEvents = "none";   // optional
    }
  }

  // Temperature (works even if minmax/derived missing)
  if (typeof w.temp === "number") {
    setText("temp", w.temp.toFixed(1) + " °C");
  } else if (typeof w.raw?.temperature_c === "number") {
    setText("temp", w.raw.temperature_c.toFixed(1) + " °C");
  }

  // Humidity
  if (typeof w.hum === "number") {
    setText("humidity", w.hum.toFixed(1) + " %");
  }

  // Sea-level pressure (Pa → hPa)
  if (typeof w.derived?.sea_level_pressure_pa === "number") {
    setText("pressure", (w.derived.sea_level_pressure_pa / 100).toFixed(0) + " hPa");
  } else if (typeof w.pressure === "number") {
    // fallback if you prefer station pressure
    setText("pressure", (w.pressure / 100).toFixed(1) + " hPa");
  } else if (typeof w.raw?.pressure_pa === "number") {
    setText("pressure", (w.raw.pressure_pa / 100).toFixed(1) + " hPa");
  }

  // Min / Max values (minmax may be missing on some samples)
  const mm = w.minmax ?? w.derived?.minmax ?? null;

  // Temperature min/max
  const tmin = toNumber(mm?.temp_min_c);
  if (tmin !== null) setText("temp-min", tmin.toFixed(1) + " °C");

  const tmax = toNumber(mm?.temp_max_c);
  if (tmax !== null) setText("temp-max", tmax.toFixed(1) + " °C");

  // Humidity min/max (rh_min_pct / rh_max_pct)
  const rhMin = toNumber(mm?.rh_min_pct);
  if (rhMin !== null) setText("hum-min", rhMin.toFixed(1) + " %");

  const rhMax = toNumber(mm?.rh_max_pct);
  if (rhMax !== null) setText("hum-max", rhMax.toFixed(1) + " %");

  // Pressure min/max (press_min_pa / press_max_pa) -> show in hPa, no decimals
  const pMin = toNumber(mm?.press_min_pa);
  if (pMin !== null) setText("press-min", (pMin).toFixed(0) + " hPa");

  const pMax = toNumber(mm?.press_max_pa);
  if (pMax !== null) setText("press-max", (pMax).toFixed(0) + " hPa");

  /* ----------------------------------------------------
   * Outdoor (Shelly BLU H&T)
   * ---------------------------------------------------- */
  const sh = w.shelly ?? null;

  if (sh?.ready === true) {
    // Current outdoor values
    if (typeof sh.temperature_c === "number") {
      setText("out-temp", sh.temperature_c.toFixed(1) + " °C");
    }
    if (typeof sh.humidity_pct === "number") {
      setText("out-humidity", sh.humidity_pct.toFixed(1) + " %");
    }

    // Battery (only shown when Shelly reports low level)
    const battRow = document.getElementById("shelly-batt-row");
    const battVal = document.getElementById("shelly-batt");

    if (battRow && battVal) {
      if (typeof sh?.battery_pct === "number" && sh.battery_pct <= 25) {  // Low batt set at 25 %
        battVal.textContent = sh.battery_pct.toFixed(0) + " %";
        battRow.classList.remove("hidden");   // show
      } else {
        battRow.classList.add("hidden");      // hide
      }
    }

    // Outdoor min/max
    const omm = sh.minmax ?? null;

    if (omm?.ready === true) {
      const otMin = toNumber(omm.temp_min_c);
      if (otMin !== null) setText("out-temp-min", otMin.toFixed(1) + " °C");

      const otMax = toNumber(omm.temp_max_c);
      if (otMax !== null) setText("out-temp-max", otMax.toFixed(1) + " °C");

      const orhMin = toNumber(omm.rh_min_pct);
      if (orhMin !== null) setText("out-hum-min", orhMin.toFixed(1) + " %");

      const orhMax = toNumber(omm.rh_max_pct);
      if (orhMax !== null) setText("out-hum-max", orhMax.toFixed(1) + " %");
    }
  }

  // Forecast / Trend / Alert
  if (typeof w.derived?.barometer_forecast === "string") {
    setText("forecast", w.derived.barometer_forecast.trim());
  }

  if (typeof w.derived?.barometer_trend === "string") {
    const trendText = w.derived.barometer_trend.trim();
    const trendEl = document.getElementById("trend");

    // Default: no arrow, neutral color
    let displayText = trendText;
    let color = "text-slate-300";

    if (/rising|up/i.test(trendText)) {
      displayText = `↑ ${trendText}`;
      color = "text-green-400";
    } else if (/falling|down/i.test(trendText)) {
      displayText = `↓ ${trendText}`;
      color = "text-amber-400";
    } else if (/steady/i.test(trendText)) {
      displayText = `→ ${trendText}`;
      color = "text-slate-300";
    }
    trendEl.textContent = displayText;
    trendEl.className = `text-lg font-medium ${color}`;
  }

  if (typeof w.derived?.barometer_storm === "string") {
    const alertText = w.derived.barometer_storm.trim();
    const alertEl = document.getElementById("alert");

    setText("alert", alertText);

    // Semantic coloring
    if (/no storm/i.test(alertText)) {
      alertEl.className = "text-lg text-green-400";
    } else if (/watch|warning|possible/i.test(alertText)) {
      alertEl.className = "text-lg text-amber-400";
    } else {
      alertEl.className = "text-lg text-red-400";
    }
  }

  // Air Quality text
  if (typeof w.derived?.air_quality_text === "string") {
    const aqText = w.derived.air_quality_text.trim();
    const aqEl = document.getElementById("air-quality");

    // Default: show text as-is, neutral color
    let color = "text-slate-300";
    let displayText = aqText;

    if (/normal|good/i.test(aqText)) {
      color = "text-green-400";
    } else if (/moderate|fair/i.test(aqText)) {
      color = "text-amber-400";
    } else if (/poor|bad|unhealthy/i.test(aqText)) {
      color = "text-red-400";
    }

    aqEl.textContent = displayText;
    aqEl.className = `text-lg font-medium ${color}`;
  }
}

updateWeather();
setInterval(updateWeather, 3000);

/* ============================================================================
 * Page Navigation (Overview <-> History)
 * ============================================================================
 *
 * Purpose:
 * - We currently have two "pages" implemented as <section> blocks:
 *     1) #overview-page  (your existing live dashboard)
 *     2) #history-page   (placeholder for graphs)
 *
 * - We are NOT navigating to a new URL.
 * - We are simply toggling visibility by adding/removing the Tailwind "hidden" class.
 *
 * Why "hidden":
 * - Tailwind uses "hidden" to set display: none; so the section is removed
 *   from layout completely.
 *
 * - Using classList.add/remove is widely supported and standard.
 * ============================================================================
 */

/* Get references to the DOM elements we need */
const btnHistory   = document.getElementById("btn-history");     // button user clicks
const overviewPage = document.getElementById("overview-page");   // live dashboard section
const historyPage  = document.getElementById("history-page");    // history placeholder section

/* ============================================================================
 * 1 YEAR DAILY AGGREGATION (frontend)
 * ============================================================================
 * 
 * INPUT:
 * - hourly samples from backend (range = "1y")
 *
 * OUTPUT:
 * - one sample per day
 * - each day contains min/max values
 *
 * RULES:
 * - ignore null values
 * - group by LOCAL DAY (Europe/Copenhagen via browser)
 * - no backend dependency
 * - pure transformation layer
 * ============================================================================
 */
/* ============================================================================
 * 1 YEAR WEEKLY AGGREGATION (frontend)
 * ============================================================================
 * 
 * INPUT:
 * - hourly samples from backend (range = "1y")
 *
 * OUTPUT:
 * - one sample per week
 * - each week contains min/max values
 *
 * RULES:
 * - ignore null values
 * - group by Europe/Copenhagen calendar week
 * - exclude the CURRENT (incomplete) week
 * - no backend dependency
 * - pure transformation layer
 *
 * NOTE:
 * - Function NAME is intentionally kept as aggregateDailyMinMax()
 *   so we do NOT touch already-working callers elsewhere.
 * ============================================================================
 */
function aggregateDailyMinMax(historyData) {
  const weeks = new Map();

  // ------------------------------------------------------------
  // Determine CURRENT Copenhagen week
  // We will EXCLUDE all samples from the current (incomplete) week
  // ------------------------------------------------------------
  const now = new Date();

  const nowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(now);

  const nowYear  = Number(nowParts.find(p => p.type === "year").value);
  const nowMonth = Number(nowParts.find(p => p.type === "month").value);
  const nowDay   = Number(nowParts.find(p => p.type === "day").value);

  // Build a Copenhagen-local date at local noon to avoid DST edge issues
  const nowLocalForWeek = new Date(nowYear, nowMonth - 1, nowDay, 12, 0, 0, 0);
  const nowIsoWeek = getISOWeek(nowLocalForWeek);

  const currentWeekKey =
    String(nowIsoWeek.year) + "-W" + String(nowIsoWeek.week).padStart(2, "0");

  for (const p of historyData) {
    const ts = p?.ts;
    if (typeof ts !== "number") continue;

    // ------------------------------------------------------------
    // Force timezone = Europe/Copenhagen (station location)
    // ------------------------------------------------------------
    const d = new Date(ts * 1000);

    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Copenhagen",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(d);

    const y = Number(parts.find(p => p.type === "year").value);
    const m = Number(parts.find(p => p.type === "month").value);
    const dayOfMonth = Number(parts.find(p => p.type === "day").value);

    // ------------------------------------------------------------
    // Build a Copenhagen-local date at local noon
    // - Reuses the already-correct Copenhagen date parts
    // - Avoids using raw browser timezone date for grouping
    // ------------------------------------------------------------
    const localForWeek = new Date(y, m - 1, dayOfMonth, 12, 0, 0, 0);
    const isoWeek = getISOWeek(localForWeek);

    const key =
      String(isoWeek.year) + "-W" + String(isoWeek.week).padStart(2, "0");

    // ------------------------------------------------------------
    // EXCLUDE current (incomplete) week
    // ------------------------------------------------------------
    if (key === currentWeekKey) continue;

    if (!weeks.has(key)) {
      weeks.set(key, {
        ts: ts, // first occurrence (will be overwritten later)

        temp_in_min: null,
        temp_in_max: null,
        temp_out_min: null,
        temp_out_max: null,

        hum_in_min: null,
        hum_in_max: null,
        hum_out_min: null,
        hum_out_max: null,

        press_min: null,
        press_max: null,
      });
    }

    const week = weeks.get(key);

    // Always update ts so it ends up as LAST sample of the week
    week.ts = ts;

    // ------------------ TEMPERATURE ------------------
    const tin = p?.weather?.temp;
    if (typeof tin === "number") {
      if (week.temp_in_min === null || tin < week.temp_in_min) week.temp_in_min = tin;
      if (week.temp_in_max === null || tin > week.temp_in_max) week.temp_in_max = tin;
    }

    const tout = p?.weather?.shelly?.temperature_c;
    if (typeof tout === "number") {
      if (week.temp_out_min === null || tout < week.temp_out_min) week.temp_out_min = tout;
      if (week.temp_out_max === null || tout > week.temp_out_max) week.temp_out_max = tout;
    }

    // ------------------ HUMIDITY ------------------
    const hin = p?.weather?.hum;
    if (typeof hin === "number") {
      if (week.hum_in_min === null || hin < week.hum_in_min) week.hum_in_min = hin;
      if (week.hum_in_max === null || hin > week.hum_in_max) week.hum_in_max = hin;
    }

    const hout = p?.weather?.shelly?.humidity_pct;
    if (typeof hout === "number") {
      if (week.hum_out_min === null || hout < week.hum_out_min) week.hum_out_min = hout;
      if (week.hum_out_max === null || hout > week.hum_out_max) week.hum_out_max = hout;
    }

    // ------------------ PRESSURE ------------------
    const pval = p?.weather?.pressure;
    if (typeof pval === "number") {
      if (week.press_min === null || pval < week.press_min) week.press_min = pval;
      if (week.press_max === null || pval > week.press_max) week.press_max = pval;
    }
  }

  // Convert map → sorted array (by ts)
  return Array.from(weeks.values())
    .sort((a, b) => a.ts - b.ts);
}

/* Render all charts in sync */
function renderAllHistoryCharts(data) {
  /* ------------------------------------------------------------------
   * Select data source:
   * - 1y  → aggregated daily min/max
   * - else → raw data
   * ------------------------------------------------------------------ */
  const chartData =
    (historyRange === "1y")
      ? aggregateDailyMinMax(data)
      : data;

  renderTemperatureChart(chartData);
  renderHumidityChart(chartData);
  renderPressureChart(chartData);
}

// Guard against partial DOM load (static hosting / cache edge cases)
if (btnHistory && overviewPage && historyPage) {

  /* Attach click handler once.
   * This runs every time the user taps/clicks the button.
   */
  btnHistory.addEventListener("click", () => {

    /* Determine current state:
     * If historyPage currently has "hidden", then history is not visible.
     * If it does NOT have "hidden", history is visible.
     */
    const historyIsVisible = !historyPage.classList.contains("hidden");

    if (historyIsVisible) {
      /* ------------------------------------------------------------
       * Switch to OVERVIEW
       * ------------------------------------------------------------
       * - hide history
       * - show overview
       * - change button label back to "History"
       */
      historyPage.classList.add("hidden");
      overviewPage.classList.remove("hidden");
      btnHistory.textContent = "History";
      stopHistoryPolling();

    } else {
      /* ------------------------------------------------------------
       * Switch to HISTORY
       * ------------------------------------------------------------
       * - hide overview
       * - show history
       * - change button label to "Overview" (acts like a back button)
       */
      overviewPage.classList.add("hidden");
      historyPage.classList.remove("hidden");

      btnHistory.textContent = "Overview";
      startHistoryPolling();

      // IMPORTANT:
      // Enforce that the time range UI reflects the TRUE state
      // (historyRange is already set to "24h" by default)
      // This prevents mismatch like:
      //   - 24h data loaded
      //   - 6h button highlighted
      syncHistoryRangeButtons();

      // Start controlled polling (includes initial fetch)
    }
  });
}

/* ============================================================================
 * History Page – Time Range Selector (UI ONLY)
 * ============================================================================
 *
 * Purpose:
 * - Visually mark which time window is selected (6h / 24h / 7d)
 * - No graph updates
 * - No API calls
 * - No state persistence
 *
 * Behavior:
 * - Exactly one button is "active" at a time
 * - Active button is highlighted
 * - Others revert to normal styling
 *
 * This uses classList.add/remove which is the standard way to
 * toggle UI state in vanilla JavaScript.
 * ============================================================================
 */

const timeButtons = document.querySelectorAll(".time-btn");

syncHistoryRangeButtons();  // ensure the highlight matches the default state on load

/* Attach one click handler to each button */
timeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {

    /* Clear active styling from all buttons */
    timeButtons.forEach((b) => {
      b.classList.remove("bg-slate-600", "font-semibold");
      b.classList.add("bg-slate-700");
    });

    /* Mark clicked button as active */
    btn.classList.remove("bg-slate-700");
    btn.classList.add("bg-slate-600", "font-semibold");

    /* ------------------------------------------------------------
     * Update current history range state
     * ------------------------------------------------------------
     * We store the value as text ("6h", "24h", "7d").
     * This mirrors how a backend API will be queried later.
     */

    historyRange = btn.textContent.trim();

    // Then redraw charts + apply the polling policy for the selected range
    if (!historyPage.classList.contains("hidden")) {
      // Restart polling so the new range's interval takes effect.
      // startHistoryPolling() already performs the immediate fetch.
      startHistoryPolling();
    }
  });
});

/* ============================================================================
 * Sync History Range Buttons to historyRange (SOURCE OF TRUTH)
 * ============================================================================
 *
 * PURPOSE:
 * - Enforce a strict rule:
 *     historyRange controls the UI, never the other way around
 *
 * WHEN THIS MUST BE CALLED:
 * - Whenever History becomes visible
 * - Whenever historyRange is changed programmatically
 *
 * WHAT THIS DOES:
 * - Iterates over all time range buttons (6h / 24h / 7d)
 * - Highlights the ONE button whose label matches historyRange
 * - De-highlights all others
 *
 * WHAT THIS FUNCTION DOES *NOT* DO:
 * - Does NOT fetch data
 * - Does NOT change historyRange
 * - Does NOT start timers
 * - Does NOT render charts
 *
 * This is PURE UI state synchronization.
 * ============================================================================
 */
function syncHistoryRangeButtons() {
  timeButtons.forEach(btn => {
    // Extract the textual label from the button ("6h", "24h", "7d")
    const btnRange = btn.textContent.trim();

    // Determine if THIS button represents the active range
    const isActive = btnRange === historyRange;

    // Apply active styling ONLY if this button matches historyRange
    btn.classList.toggle("bg-slate-600", isActive);
    btn.classList.toggle("font-semibold", isActive);

    // Ensure all inactive buttons revert to normal styling
    btn.classList.toggle("bg-slate-700", !isActive);
  });
}

/* ============================================================================
 * TEMPERATURE HISTORY CHART (Chart.js)
 * ============================================================================
 *
 * PURPOSE:
 * - Renders Temperature history using REAL data only
 * - Supports EMPTY history (station just started, outage, etc.)
 * - Updates ONLY when new data is passed in
 *
 * IMPORTANT:
 * - This function does NOT advance time
 * - This function does NOT generate samples
 * - It merely renders what it is given
 * ============================================================================
 */

let tempChart = null;

function renderTemperatureChart(historyData) {
  const canvas = document.getElementById("temp-chart-canvas");
  if (!canvas) return;

  const dataArr = Array.isArray(historyData) ? historyData : [];

  const xAxis = buildXAxis(dataArr, historyRange);
  const labels = xAxis.labels;
  const firstTs = dataArr.length > 0 ? dataArr[0].ts : null;

  /* ------------------------------------------------------------
   * DATA SELECTION
   * - 1y  → aggregated min/max fields
   * - else → raw fields
   * ------------------------------------------------------------ */
  let indoorTemps, outdoorTemps;
  let indoorMin, indoorMax, outdoorMin, outdoorMax;

  if (historyRange === "1y") {

    indoorMin = dataArr.map(p => p.temp_in_min ?? null);
    indoorMax = dataArr.map(p => p.temp_in_max ?? null);

    outdoorMin = dataArr.map(p => p.temp_out_min ?? null);
    outdoorMax = dataArr.map(p => p.temp_out_max ?? null);

  } else {

    indoorTemps = dataArr.map(p =>
      (typeof p?.weather?.temp === "number") ? p.weather.temp : null
    );

    // ---------------------------------------------------------------------------
    // OUTDOOR TEMPERATURE SERIES (history)
    // ---------------------------------------------------------------------------
    // WHY THIS EXISTS:
    // - Your backend (SIM + REAL) includes outdoor measurements under:
    //     weather.shelly.temperature_c
    // - Previously we hard-coded outdoorTemps to null, so the chart was blank.
    //
    // DESIGN RULES:
    // 1) Use ONLY real numeric values.
    // 2) If the value is missing, return null (so Chart.js shows a gap).
    // 3) Do not convert units here (value is already °C).
    // ---------------------------------------------------------------------------
    outdoorTemps = dataArr.map(p =>
      (typeof p?.weather?.shelly?.temperature_c === "number")
        ? p.weather.shelly.temperature_c
        : null
    );
  }

  /* ------------------------------------------------------------------
   * Build datasets once so BOTH create path and update path use
   * exactly the same dataset structure.
   * ------------------------------------------------------------------ */
  const datasets = (historyRange === "1y") ? [

    {
      label: "Indoor Min",
      data: indoorMin,
      borderColor: "#38bdf8",
      tension: 0,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      borderWidth: 1
    },
    {
      label: "Indoor Max",
      data: indoorMax,
      borderColor: "#0ea5e9",
      tension: 0,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      borderWidth: 1
    },
    {
      label: "Outdoor Min",
      data: outdoorMin,
      borderColor: "#a78bfa",
      tension: 0,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      borderWidth: 1
    },
    {
      label: "Outdoor Max",
      data: outdoorMax,
      borderColor: "#7c3aed",
      tension: 0,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      borderWidth: 1
    }

  ] : [

    {
      label: "Indoor",
      data: indoorTemps,
      borderColor: "#38bdf8",
      backgroundColor: "rgba(56,189,248,0.12)",
      tension: 0,
      spanGaps: false,
      showLine: true,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      pointHoverRadius: 6,
      borderWidth: 1
    },
    {
      label: "Outdoor",
      data: outdoorTemps,
      borderColor: "#a78bfa",
      backgroundColor: "rgba(167,139,250,0.12)",
      tension: 0,
      spanGaps: false,
      showLine: true,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      pointHoverRadius: 6,
      borderWidth: 1
    }

  ];

  if (!tempChart) {
    tempChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,

        plugins: {
          legend: { labels: { color: "#e5e7eb" } },
          leftDateStamp: {
            range: historyRange,
            firstTs
          }
        },
        scales: {
          x: {
            ticks: {
              color: "#9ca3af",
              autoSkip: false,
              maxRotation: 0,
              callback: xAxis.tickCallback
            },

            // Only draw vertical grid lines where x-axis labels exist
            grid: {
              lineWidth: 1,
              color: (context) => {
                const label = context?.tick?.label;
                return label
                  ? "rgba(148,163,184,0.16)"  // subtle but readable
                  : "rgba(0,0,0,0)";          // hide non-labeled grid lines
              },
              drawBorder: false
            }
          },
          y: {
            min: 0,
            max: 40,
            ticks: { color: "#9ca3af" },
            title: { display: true, text: "°C", color: "#9ca3af" },

            // Only draw visible grid lines at tick values (the labeled y-values)
            grid: {
              lineWidth: 1,

              // Scriptable color: tick gridlines get a slightly stronger slate tone
              // (still not bright/white). Everything else is transparent.
              color: (context) => {
                // context.tick.value is the numeric y tick value for this grid line
                const v = context?.tick?.value;
                if (typeof v === "number") {
                  return "rgba(148,163,184,0.22)"; // visible, subtle (slate-ish)
                }
                return "rgba(0,0,0,0)"; // fallback: hide non-tick lines
              },
              drawBorder: false
            }
          }
        }
      }
    });
    return;
  }

  /* ------------------------------------------------------------------
   * UPDATE EXISTING CHART INSTANCE
   * - Needed because 1y uses 4 datasets, others use 2
   * ------------------------------------------------------------------ */
  tempChart.data.labels = labels;

  if (historyRange === "1y") {
    tempChart.data.datasets = [
      {
        label: "Indoor Min",
        data: indoorMin,
        borderColor: "#38bdf8",
        tension: 0,
        pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
        borderWidth: 1
      },
      {
        label: "Indoor Max",
        data: indoorMax,
        borderColor: "#0ea5e9",
        tension: 0,
        pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
        borderWidth: 1
      },
      {
        label: "Outdoor Min",
        data: outdoorMin,
        borderColor: "#a78bfa",
        tension: 0,
        pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
        borderWidth: 1
      },
      {
        label: "Outdoor Max",
        data: outdoorMax,
        borderColor: "#7c3aed",
        tension: 0,
        pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
        borderWidth: 1
      }
    ];
  } else {
    tempChart.data.datasets = [
      {
        label: "Indoor",
        data: indoorTemps,
        borderColor: "#38bdf8",
        backgroundColor: "rgba(56,189,248,0.12)",
        tension: 0,
        spanGaps: false,
        showLine: true,
        pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
        pointHoverRadius: 6,
        borderWidth: 1
      },
      {
        label: "Outdoor",
        data: outdoorTemps,
        borderColor: "#a78bfa",
        backgroundColor: "rgba(167,139,250,0.12)",
        tension: 0,
        spanGaps: false,
        showLine: true,
        pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
        pointHoverRadius: 6,
        borderWidth: 1
      }
    ];
  }

  tempChart.options.plugins.leftDateStamp = { range: historyRange, firstTs };
  tempChart.options.scales.x.ticks.callback = xAxis.tickCallback;

  tempChart.update("none");
}

/* ============================================================================
 * HUMIDITY HISTORY CHART (Chart.js)
 * ============================================================================
 *
 * PURPOSE:
 * - Renders Humidity history using REAL samples only
 * - Handles empty datasets cleanly
 * - No artificial continuity or time movement
 * ============================================================================
 */

let humidityChart = null;

function renderHumidityChart(historyData) {
  const canvas = document.getElementById("humidity-chart-canvas");
  if (!canvas) return;

  const dataArr = Array.isArray(historyData) ? historyData : [];

  const xAxis = buildXAxis(dataArr, historyRange);
  const labels = xAxis.labels;
  const firstTs = dataArr.length > 0 ? dataArr[0].ts : null;

  /* ------------------------------------------------------------
   * DATA SELECTION
   * - 1y  → aggregated min/max fields
   * - else → raw fields
   * ------------------------------------------------------------ */
  let indoorHum, outdoorHum;
  let indoorHumMin, indoorHumMax, outdoorHumMin, outdoorHumMax;

  if (historyRange === "1y") {

    indoorHumMin = dataArr.map(p => p.hum_in_min ?? null);
    indoorHumMax = dataArr.map(p => p.hum_in_max ?? null);

    outdoorHumMin = dataArr.map(p => p.hum_out_min ?? null);
    outdoorHumMax = dataArr.map(p => p.hum_out_max ?? null);

  } else {

    indoorHum = dataArr.map(p =>
      (typeof p?.weather?.hum === "number") ? p.weather.hum : null
    );

    // ---------------------------------------------------------------------------
    // OUTDOOR HUMIDITY SERIES (history)
    // ---------------------------------------------------------------------------
    outdoorHum = dataArr.map(p =>
      (typeof p?.weather?.shelly?.humidity_pct === "number")
        ? p.weather.shelly.humidity_pct
        : null
    );
  }

  /* ------------------------------------------------------------------
   * Build datasets once so BOTH create path and update path use
   * exactly the same dataset structure.
   * ------------------------------------------------------------------ */
  const datasets = (historyRange === "1y") ? [

    {
      label: "Indoor Min",
      data: indoorHumMin,
      borderColor: "#34d399",
      tension: 0,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      borderWidth: 1
    },
    {
      label: "Indoor Max",
      data: indoorHumMax,
      borderColor: "#059669",
      tension: 0,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      borderWidth: 1
    },
    {
      label: "Outdoor Min",
      data: outdoorHumMin,
      borderColor: "#fbbf24",
      tension: 0,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      borderWidth: 1
    },
    {
      label: "Outdoor Max",
      data: outdoorHumMax,
      borderColor: "#d97706",
      tension: 0,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      borderWidth: 1
    }

  ] : [

    {
      label: "Indoor",
      data: indoorHum,
      borderColor: "#34d399",
      backgroundColor: "rgba(52,211,153,0.12)",
      tension: 0,
      spanGaps: false,
      showLine: true,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      pointHoverRadius: 6,
      borderWidth: 1
    },
    {
      label: "Outdoor",
      data: outdoorHum,
      borderColor: "#fbbf24",
      backgroundColor: "rgba(251,191,36,0.12)",
      tension: 0,
      spanGaps: false,
      showLine: true,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      pointHoverRadius: 6,
      borderWidth: 1
    }

  ];

  if (!humidityChart) {
    humidityChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,

        plugins: {
          legend: { labels: { color: "#e5e7eb" } },
          leftDateStamp: {
            range: historyRange,
            firstTs,
            singleLine: false
          }
        },
        scales: {
          x: {
            ticks: {
              color: "#9ca3af",
              autoSkip: false,
              maxRotation: 0,
              callback: xAxis.tickCallback
            },
            grid: {
              lineWidth: 1,
              color: (context) => {
                const label = context?.tick?.label;
                return label
                  ? "rgba(148,163,184,0.16)"
                  : "rgba(0,0,0,0)";
              },
              drawBorder: false
            }
          },
          y: {
            min: 0,
            max: 100,
            ticks: { color: "#9ca3af" },
            title: { display: true, text: "%RH", color: "#9ca3af" },

            grid: {
              lineWidth: 1,
              color: (context) => {
                const v = context?.tick?.value;
                if (typeof v === "number") {
                  return "rgba(148,163,184,0.22)";
                }
                return "rgba(0,0,0,0)";
              },
              drawBorder: false
            }
          }
        }
      }
    });
    return;
  }

  /* ------------------------------------------------------------------
   * UPDATE EXISTING CHART INSTANCE
   * - Needed because 1y uses 4 datasets, others use 2
   * ------------------------------------------------------------------ */
  humidityChart.data.labels = labels;
  humidityChart.data.datasets = datasets;

  humidityChart.options.plugins.leftDateStamp = { range: historyRange, firstTs, singleLine: false };
  humidityChart.options.scales.x.ticks.callback = xAxis.tickCallback;

  humidityChart.update("none");
}

/* ============================================================================
 * PRESSURE HISTORY CHART (Chart.js)
 * ============================================================================
 *
 * PURPOSE:
 * - Displays Sea‑level Pressure history
 * - Uses REAL timestamps only
 * - No time synthesis, no assumptions
 * ============================================================================
 */

let pressureChart = null;

function renderPressureChart(historyData) {
  const canvas = document.getElementById("pressure-chart-canvas");
  if (!canvas) return;

  const dataArr = Array.isArray(historyData) ? historyData : [];

  const xAxis = buildXAxis(dataArr, historyRange);
  const labels = xAxis.labels;
  const firstTs = dataArr.length > 0 ? dataArr[0].ts : null;

  /* ------------------------------------------------------------
   * DATA SELECTION
   * - 1y  → aggregated min/max fields
   * - else → raw pressure field
   * ------------------------------------------------------------ */
  let pressure;
  let pressureMin, pressureMax;

  if (historyRange === "1y") {

    // Aggregated values are still stored in Pa, so convert to hPa here
    pressureMin = dataArr.map(p =>
      (typeof p?.press_min === "number") ? (p.press_min / 100) : null
    );

    pressureMax = dataArr.map(p =>
      (typeof p?.press_max === "number") ? (p.press_max / 100) : null
    );

  } else {

    pressure = dataArr.map(p =>
      (typeof p?.weather?.pressure === "number")
        ? (p.weather.pressure / 100)   // Pa → hPa
        : null
    );
  }

  /* ------------------------------------------------------------------
   * Build datasets once so BOTH create path and update path use
   * exactly the same dataset structure.
   * ------------------------------------------------------------------ */
  const datasets = (historyRange === "1y") ? [

    {
      label: "Min",
      data: pressureMin,
      borderColor: "#60a5fa",
      tension: 0,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      borderWidth: 1
    },
    {
      label: "Max",
      data: pressureMax,
      borderColor: "#1d4ed8",
      tension: 0,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      borderWidth: 1
    }

  ] : [

    {
      label: "Sea‑level Pressure",
      data: pressure,
      borderColor: "#60a5fa",
      backgroundColor: "rgba(96,165,250,0.12)",
      tension: 0,
      spanGaps: false,
      showLine: true,
      pointRadius: (ctx) => (ctx.raw == null ? 0 : 0),
      pointHoverRadius: 6,
      borderWidth: 1
    }

  ];

  if (!pressureChart) {
    pressureChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,

        plugins: {
          legend: { labels: { color: "#e5e7eb" } },
          leftDateStamp: {
            range: historyRange,
            firstTs,
            singleLine: true
          }
        },
        scales: {
          x: {
            ticks: {
              color: "#9ca3af",
              autoSkip: false,
              maxRotation: 0,
              callback: xAxis.tickCallback
            },
            grid: {
              lineWidth: 1,
              color: (context) => {
                const label = context?.tick?.label;
                return label
                  ? "rgba(148,163,184,0.16)"
                  : "rgba(0,0,0,0)";
              },
              drawBorder: false
            }
          },
          y: {
            min: 950,
            max: 1050,
            ticks: { color: "#9ca3af" },
            title: { display: true, text: "hPa", color: "#9ca3af" },

            grid: {
              lineWidth: 1,
              color: (context) => {
                const v = context?.tick?.value;
                if (typeof v === "number") {
                  return "rgba(148,163,184,0.22)";
                }
                return "rgba(0,0,0,0)";
              },
              drawBorder: false
            }
          }
        }
      }
    });
    return;
  }

  /* ------------------------------------------------------------------
   * UPDATE EXISTING CHART INSTANCE
   * - Needed because 1y uses 2 datasets, others use 1
   * ------------------------------------------------------------------ */
  pressureChart.data.labels = labels;
  pressureChart.data.datasets = datasets;

  pressureChart.options.plugins.leftDateStamp = { range: historyRange, firstTs, singleLine: true };
  pressureChart.options.scales.x.ticks.callback = xAxis.tickCallback;

  pressureChart.update("none");
}