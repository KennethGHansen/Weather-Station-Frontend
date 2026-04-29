/* ============================================================================
 * STEP 1 — Load history snapshot (one-shot, no polling)
 * ============================================================================
 */
async function loadHistoryOnce() {
	console.log("loadHistoryOnce CALLED"); // TEMP DEBUG
  try {
    const res = await fetch(`/api/history?range=${historyRange}`, {
      cache: "no-store"
    });

    if (!res.ok) {
      console.warn("History fetch failed:", res.status);
      renderAllHistoryCharts([]);
      return;
    }

    const data = await res.json();

    // Defensive: ensure array
    const samples = Array.isArray(data.samples) ? data.samples : [];

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
 * HISTORY WINDOW CONFIG (authoritative UI contract)
 * ============================================================================
 *
 * Defines:
 * - Nominal sample spacing per history range
 * - Fixed window size expected by the charts
 *
 * NOTE:
 * - Samples are REAL and event-driven
 * - stepSec is NOT used to generate time
 * - Backend and frontend must agree on these values
 * ============================================================================
 */
const HISTORY_CFG = {
  "6h":  { stepSec: 5 * 60,    maxSamples: 72  },
  "24h": { stepSec: 10 * 60,   maxSamples: 144 },
  "7d":  { stepSec: 60 * 60,   maxSamples: 168 }
};

/* ============================================================================
 * HISTORY BUFFER (sliding window)
 * ============================================================================
 *
 * - historyBuf holds the current window
 * - historyLastTs tracks the most recent timestamp in the buffer
 * - historyState holds the running "last values" so the series is smooth
 * ============================================================================
 */
let historyBuf = [];		// array of REAL samples used by charts
let historyLastTs = null;		// newest REAL ts in historyBuf (null until loaded)

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

/* ============================================================================
 * HISTORY UPDATE LIFECYCLE (stub for Step 1)
 * ============================================================================
 *
 * Purpose:
 * - Centralized control over history polling / fetching
 * - EMPTY for now (Step 0)
 * - Will be filled when real history API is wired
 * ============================================================================
 */
function startHistoryUpdates() {
  // Step 1 will implement:
  // - initial history fetch
  // - polling for new samples
}

function stopHistoryUpdates() {
  // Step 1 will implement:
  // - stopping timers / aborting fetches
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

const X_LABEL_COUNT = 6;

/* Format timestamp depending on range */
function formatXAxisLabel(ts, range) {
  const d = new Date(ts * 1000);

  // 6h + 24h: ALWAYS time labels (including the first tick)
  if (range === "6h" || range === "24h") {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }

  // 7d: date-only labels
  return d.toLocaleDateString([], { day: "2-digit", month: "short" });
}

/* Build labels array + tick callback */
function buildXAxis(historyData, range) {
  const len = historyData.length;

  // pick exactly 6 evenly spaced indices
  const indices = [];
  for (let i = 0; i < 6; i++) {
    indices.push(Math.round(i * (len - 1) / 5));
  }
  
  const indexSet = new Set(indices);

  return {
		labels: historyData.map((p, i) =>
		  indexSet.has(i) ? formatXAxisLabel(p.ts, range) : ""
	),

    tickCallback: function (val) {
      // show only the pre‑formatted label
      return this.getLabelForValue(val) || "";
    }
  };
}

/* ============================================================================
 * LEFT-ALIGNED DATE STAMP PLUGIN
 * ============================================================================
 *
 * - Used for 6h and 24h views only
 * - Renders a date label inside the chart area
 * - Does NOT consume axis space
 * - Mobile-safe
 * ============================================================================
 */
const leftDateStampPlugin = {
  id: "leftDateStamp",

afterDatasetsDraw(chart, args, pluginOptions) {
  /* ------------------------------------------------------------------------
   * LEFT DATE STAMP (6h / 24h only)
   *
   * Supports TWO layouts:
   * - Two-line (day / month): temperature, humidity
   * - Single-line (day month): pressure
   *
   * Layout is controlled by plugin option:
   *   singleLine: true | false
   * ------------------------------------------------------------------------ */

  const { ctx } = chart;
  const { range, firstTs, singleLine } = pluginOptions || {};

  if (range !== "6h" && range !== "24h") return;
  if (!firstTs) return;

  const xScale = chart.scales?.x;
  if (!xScale || !xScale.ticks || xScale.ticks.length === 0) return;

  // Build date parts
  const d = new Date(firstTs * 1000);
  const dayText   = d.toLocaleDateString([], { day: "2-digit" });
  const monthText = d.toLocaleDateString([], { month: "short" });
  const oneLineText = `${dayText} ${monthText}`;

  // Match x‑axis tick font
  const tickFont = Chart.helpers.toFont(xScale.options.ticks.font);

  ctx.save();
  ctx.font = tickFont.string;
  ctx.fillStyle = "#9ca3af";

  // Anchor to FIRST tick
  const tickX = xScale.getPixelForTick(0);

  // Measure first time label width (so we avoid overlap)
  const firstTimeLabel =
    typeof xScale.getLabelForValue === "function"
      ? xScale.getLabelForValue(0)
      : "";

  const timeLabelWidth = firstTimeLabel
    ? ctx.measureText(firstTimeLabel).width
    : 0;

  // Measure date width (depends on mode)
  const dateWidth = singleLine
    ? ctx.measureText(oneLineText).width
    : Math.max(
        ctx.measureText(dayText).width,
        ctx.measureText(monthText).width
      );

  // Horizontal placement:
  // [ DATE ][ GAP ][ TIME ]
  const GAP_PX = 8;
  const x =
    tickX
    - (timeLabelWidth / 2)
    - GAP_PX
    - (dateWidth / 2);

  // Vertical placement — your calibrated value
  const lh = tickFont.lineHeight;
  const Y_NUDGE_PX = -5.5;
  const baseY = xScale.bottom + Y_NUDGE_PX;

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";

  if (singleLine) {
    // Pressure: single-line date
    ctx.fillText(oneLineText, x, baseY);
  } else {
    // Temp / Hum: two-line date
    ctx.fillText(dayText,   x, baseY - lh);
    ctx.fillText(monthText, x, baseY);
  }

  ctx.restore();
}
};

// register plugin ONCE (before any new Chart(...))
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
  const cards = document.getElementById("cards")
  
  
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
	
    //Battery (Only show text when battery is low
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

/* Render all charts in sync */
function renderAllHistoryCharts(data) {
  renderTemperatureChart(data);
  renderHumidityChart(data);
  renderPressureChart(data);
}

/* Defensive check:
 * If any element is missing, do nothing (prevents runtime errors).
 */
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
	  stopHistoryUpdates();

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
	  
      loadHistoryOnce();          // ✅Step 1 real history read
	  startHistoryUpdates(); 	 
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

	// Then redraw charts
	if (!historyPage.classList.contains("hidden")) {
		loadHistoryOnce();
	}
  });
});

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

  const indoorTemps = dataArr.map(p =>
	  (typeof p?.weather?.temp === "number") ? p.weather.temp : null
	);

  const outdoorTemps = dataArr.map(_ => null); // no outdoor temp yet

  const firstTs = dataArr.length > 0 ? dataArr[0].ts : null;

  if (!tempChart) {
    tempChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Indoor",
            data: indoorTemps,
            borderColor: "#38bdf8",
            backgroundColor: "rgba(56,189,248,0.12)",
            tension: 0,
            spanGaps: true,
            showLine: true,
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2
          },
          {
            label: "Outdoor",
            data: outdoorTemps,
            borderColor: "#a78bfa",
            backgroundColor: "rgba(167,139,250,0.12)",
            tension: 0,
            spanGaps: true,
            showLine: true,
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: "#e5e7eb" } },
          leftDateStamp: { range: historyRange, firstTs }
        },
        scales: {
          x: {
            ticks: {
              color: "#9ca3af",
              autoSkip: false,
              maxRotation: 0,
              callback: xAxis.tickCallback
            }
          },
          y: {
            min: 0,
            max: 40,
            ticks: { color: "#9ca3af" },
            title: { display: true, text: "°C", color: "#9ca3af" }
          }
        }
      }
    });
    return;
  }

  tempChart.data.labels = labels;
  tempChart.data.datasets[0].data = indoorTemps;
  tempChart.data.datasets[1].data = outdoorTemps;

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

  const indoorHum = dataArr.map(p =>
	  (typeof p?.weather?.hum === "number") ? p.weather.hum : null
	);

  const outdoorHum = dataArr.map(_ => null); // no outdoor humidity yet


  const firstTs = dataArr.length > 0 ? dataArr[0].ts : null;

  if (!humidityChart) {
    humidityChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Indoor",
            data: indoorHum,
            borderColor: "#34d399",
            backgroundColor: "rgba(52,211,153,0.12)",
            tension: 0,
            spanGaps: true,
            showLine: true,
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2
          },
          {
            label: "Outdoor",
            data: outdoorHum,
            borderColor: "#fbbf24",
            backgroundColor: "rgba(251,191,36,0.12)",
            tension: 0,
            spanGaps: true,
            showLine: true,
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: "#e5e7eb" } },
          leftDateStamp: { range: historyRange, firstTs, singleLine: false }
        },
        scales: {
          x: {
            ticks: {
              color: "#9ca3af",
              autoSkip: false,
              maxRotation: 0,
              callback: xAxis.tickCallback
            }
          },
          y: {
            min: 0,
            max: 100,
            ticks: { color: "#9ca3af" },
            title: { display: true, text: "%", color: "#9ca3af" }
          }
        }
      }
    });
    return;
  }

  humidityChart.data.labels = labels;
  humidityChart.data.datasets[0].data = indoorHum;
  humidityChart.data.datasets[1].data = outdoorHum;

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

  const pressure = dataArr.map(p =>
	  (typeof p?.weather?.pressure === "number")
		? p.weather.pressure / 100   // Pa → hPa
		: null
	);

  const firstTs = dataArr.length > 0 ? dataArr[0].ts : null;

  if (!pressureChart) {
    pressureChart = new Chart(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [
          {
            label: "Sea‑level Pressure",
            data: pressure,
            borderColor: "#60a5fa",
            backgroundColor: "rgba(96,165,250,0.12)",
            tension: 0,
            spanGaps: true,
            showLine: true,
            pointRadius: 4,
            pointHoverRadius: 6,
            borderWidth: 2
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { labels: { color: "#e5e7eb" } },
          leftDateStamp: { range: historyRange, firstTs, singleLine: true }
        },
        scales: {
          x: {
            ticks: {
              color: "#9ca3af",
              autoSkip: false,
              maxRotation: 0,
              callback: xAxis.tickCallback
            }
          },
          y: {
            min: 950,
            max: 1050,
            ticks: { color: "#9ca3af" },
            title: { display: true, text: "hPa", color: "#9ca3af" }
          }
        }
      }
    });
    return;
  }

  pressureChart.data.labels = labels;
  pressureChart.data.datasets[0].data = pressure;

  pressureChart.options.plugins.leftDateStamp = { range: historyRange, firstTs, singleLine: true };
  pressureChart.options.scales.x.ticks.callback = xAxis.tickCallback;

  pressureChart.update("none");
}