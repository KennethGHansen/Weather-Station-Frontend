function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

/* ============================================================================
 * HISTORY WINDOW CONFIG (must match frontend)
 * ============================================================================
 */
const HISTORY_CFG = {
  "6h":  { windowSec: 6 * 3600,   maxSamples: 72  },
  "24h": { windowSec: 24 * 3600,  maxSamples: 144 },
  "7d":  { windowSec: 7 * 86400,  maxSamples: 168 }
};

/* ============================================================================
 * Durable Object: WeatherDO
 * ============================================================================
 * Stores:
 * - "latest"  (single record)
 * - "history" (array of raw samples)
 * ============================================================================
 */
export class WeatherDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    this.latest = null;
    this.history = [];

    this.ctx.blockConcurrencyWhile(async () => {
      this.latest = await this.ctx.storage.get("latest");
      this.history = (await this.ctx.storage.get("history")) ?? [];
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ------------------------------------------------------------
    // Internal: GET /history?range=6h|24h|7d
    // Applies windowing + maxSamples (NO aggregation)
    // ------------------------------------------------------------
    if (url.pathname === "/history" && request.method === "GET") {
      const range = url.searchParams.get("range");
      const cfg = HISTORY_CFG[range];
      if (!cfg) return json({ error: "invalid range" }, 400);

      const now = Math.floor(Date.now() / 1000);
      const cutoff = now - cfg.windowSec;

      // Filter to time window
      let samples = this.history.filter(s => s && typeof s.ts === "number" && s.ts >= cutoff);

      // Ensure ascending ts
      samples.sort((a, b) => a.ts - b.ts);

      // Cap to maxSamples (keep newest N)
      if (samples.length > cfg.maxSamples) {
        samples = samples.slice(samples.length - cfg.maxSamples);
      }

      return json({ samples });
    }

    // ------------------------------------------------------------
    // Internal: POST /update
    // Writes latest + appends raw history + trims retention
    // ------------------------------------------------------------
    if (url.pathname === "/update" && request.method === "POST") {
      let record;
      try {
        record = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      // Update latest
      this.latest = record;
      await this.ctx.storage.put("latest", record);

      // Append raw history sample
      this.history.push({
        ts: record.ts,
        boot_id: record.boot_id ?? null,
        weather: record.weather
      });

      // Trim retention (keep 10 days)
      const RETENTION_SEC = 10 * 24 * 60 * 60;
      const cutoffTs = record.ts - RETENTION_SEC;
      this.history = this.history.filter(s => s && typeof s.ts === "number" && s.ts >= cutoffTs);

      // Persist history
      await this.ctx.storage.put("history", this.history);

      return json({ ok: true });
    }

    // ------------------------------------------------------------
    // Internal: GET /latest
    // ------------------------------------------------------------
    if (url.pathname === "/latest" && request.method === "GET") {
      if (!this.latest) this.latest = await this.ctx.storage.get("latest");
      if (!this.latest) return json({ error: "no data yet" }, 404);
      return json(this.latest);
    }

    return json({ error: "not found" }, 404);
  }
}

/* ============================================================================
 * Worker entrypoint
 * ============================================================================
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const doId = env.WEATHER_DO.idFromName("default");
    const stub = env.WEATHER_DO.get(doId);

    // -----------------------------
    // POST /api/weather (ESP → cloud)
    // -----------------------------
    if (url.pathname === "/api/weather" && request.method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      const ts = Math.floor(Date.now() / 1000);

      const record = {
        ts,
        device_id: payload.device_id ?? null,
        boot_id: payload.boot_id ?? null,
        weather: payload,
      };

      return await stub.fetch(new Request("https://do/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      }));
    }

    // -----------------------------
    // GET /api/weather (UI → latest)
    // -----------------------------
    if (url.pathname === "/api/weather" && request.method === "GET") {
      return await stub.fetch(new Request("https://do/latest", { method: "GET" }));
    }

    // -----------------------------
    // GET /api/history?range=...
    // Worker forwards to DO /history?range=...
    // -----------------------------
    if (url.pathname === "/api/history" && request.method === "GET") {
      const range = url.searchParams.get("range");
      if (!["6h", "24h", "7d"].includes(range)) {
        return json({ error: "invalid range" }, 400);
      }

      const res = await stub.fetch(new Request(`https://do/history?range=${encodeURIComponent(range)}`, {
        method: "GET",
      }));

      // Pass-through samples
      const data = await res.json();
      return json({ range, samples: data.samples ?? [] });
    }

    // -----------------------------
    // Health check
    // -----------------------------
    if (url.pathname === "/api/test") {
      return json({ status: "worker-alive" });
    }

    // -----------------------------
    // Static assets
    // -----------------------------
    return env.ASSETS.fetch(request);
  },
};
