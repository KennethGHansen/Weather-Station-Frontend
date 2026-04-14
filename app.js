// IMPORTANT: In production (your Worker), use same-origin so CORS is not involved.
const API_BASE = ""; // same origin

async function load() {
  try {
    const r = await fetch(`${API_BASE}/api/weather?nocache=${Date.now()}`, {
      cache: "no-store",
    });

    if (!r.ok) {
      document.getElementById("weather").textContent = `API error: HTTP ${r.status}`;
      return;
    }

    const data = await r.json();
    document.getElementById("weather").textContent = JSON.stringify(data, null, 2);
  } catch (e) {
    document.getElementById("weather").textContent = `Fetch failed: ${e.message}`;
  }
}

load();
setInterval(load, 5000);

