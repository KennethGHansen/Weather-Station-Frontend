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

async function updateWeather() {
  const res = await fetch("/api/weather", { cache: "no-store" });
  const data = await res.json();

  const w = data?.weather;
  if (!w) return;

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


  // Forecast / Trend / Alert
  if (typeof w.derived?.barometer_forecast === "string") {
    setText("forecast", w.derived.barometer_forecast.trim());
  }
  if (typeof w.derived?.barometer_trend === "string") {
    setText("trend", w.derived.barometer_trend.trim());
  }
  if (typeof w.derived?.barometer_storm === "string") {
    setText("alert", w.derived.barometer_storm.trim());
  }

  // Air Quality text
  if (typeof w.derived?.air_quality_text === "string") {
    setText("air-quality", w.derived.air_quality_text.trim());
  }
}

updateWeather();
setInterval(updateWeather, 3000);
