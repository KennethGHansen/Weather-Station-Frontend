function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ---------------------------------
    // POST /api/weather (ESP → cloud)
    // ---------------------------------
    if (url.pathname === "/api/weather" && request.method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      let ts = payload.ts;
      if (!ts || ts < 1_000_000_000) {
        ts = Math.floor(Date.now() / 1000);
      }

      const record = {
        ts,
        device_id: payload.device_id ?? null,
        boot_id: payload.boot_id ?? null,
        weather: payload,
      };

      // Persist to KV (single source of truth)
      await env.WEATHER_KV.put("latest", JSON.stringify(record));

      return json({ ok: true });
    }

    // ---------------------------------
    // GET /api/weather (UI → latest)
    // ---------------------------------
    if (url.pathname === "/api/weather" && request.method === "GET") {
      const latest = await env.WEATHER_KV.get("latest", { type: "json" });

      if (!latest) {
        return json({ error: "no data yet" }, 404);
      }

      return json(latest);
    }

    // ---------------------------------
    // Health check
    // ---------------------------------
    if (url.pathname === "/api/test") {
      return json({ status: "worker-alive" });
    }

    // ---------------------------------
    // Static assets
    // ---------------------------------
    return env.ASSETS.fetch(request);
  },
};