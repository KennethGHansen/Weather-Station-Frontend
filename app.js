// TEMPORARY: replace with the current trycloudflare URL
const API_BASE = "https://softball-features-acquired-vital.trycloudflare.com";

async function load() {
  const r = await fetch(`${API_BASE}/weather`);
  if (!r.ok) {
    document.getElementById("weather").textContent = "API error";
    return;
  }
  const data = await r.json();
  document.getElementById("weather").textContent =
    JSON.stringify(data, null, 2);
}

load();
setInterval(load, 5000);
