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

  // consider station online if last update < 30 seconds ago
  if (lastTs !== null && now - lastTs < 30) {
    dot.className = "w-3 h-3 rounded-full bg-green-500";
    label.textContent = "Weather‑Station Online";
    label.className = "text-sm font-medium text-green-400";
  } else {
    dot.className = "w-3 h-3 rounded-full bg-red-500";
    label.textContent = "Weather‑Station Offline";
    label.className = "text-sm font-medium text-red-400";
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
