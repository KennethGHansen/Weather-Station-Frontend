/* =============================================================================
 * weather-station / worker.js
 * =============================================================================
 *
 * TWO Durable Objects:
 *
 * 1) WeatherDO (LATEST ONLY)
 *    - KV-style storage via ctx.storage.get/put
 *    - Stores ONLY the most recent record under key "latest"
 *    - This DO stays simple and never grows
 *
 * 2) WeatherHistoryDO (HISTORY ONLY, SQLite-backed)
 *    - Stores one row per sample in a SQLite table (no giant JSON blobs)
 *    - Provides /history?range=6h|24h|7d
 *    - Returns a FULL fixed bucket timeline (B) with NULL buckets for gaps
 *    - Right edge anchored to latest real sample bucket (freeze on outage)
 *
 * Worker routes:
 * - POST /api/weather    -> writes latest to WeatherDO AND stores sample in WeatherHistoryDO
 * - GET  /api/weather    -> reads latest from WeatherDO
 * - GET  /api/history    -> reads bucketed+gapfilled history from WeatherHistoryDO
 *
 * =============================================================================
 */

/* -----------------------------------------------------------------------------
 * Small JSON response helper
 * --------------------------------------------------------------------------- */
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

/* -----------------------------------------------------------------------------
 * HISTORY VIEW CONFIG (must match frontend intent)
 *
 * - stepSec: bucket width (your agreed resolution)
 * - maxSamples: how many buckets the chart expects
 * - windowSec: semantic window (used for retention-style checks if needed)
 * --------------------------------------------------------------------------- */
const HISTORY_CFG = {
  "6h":  { stepSec: 5 * 60,    maxSamples: 72,  windowSec: 6 * 3600   }, // 5 min buckets
  "24h": { stepSec: 10 * 60,   maxSamples: 144, windowSec: 24 * 3600  }, // 10 min buckets
  "7d":  { stepSec: 60 * 60,   maxSamples: 168, windowSec: 7 * 86400  }  // 1 hour buckets
};

/* =============================================================================
 * Durable Object #1: WeatherDO  (LATEST ONLY)
 * =============================================================================
 *
 * IMPORTANT:
 * - This DO does NOT store history.
 * - It only stores "latest".
 * - Keep it boring and reliable.
 * =============================================================================
 */
export class WeatherDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    // In-memory cache for "latest"
    this.latest = null;

    // Load persisted latest once on cold start
    this.ctx.blockConcurrencyWhile(async () => {
      this.latest = await this.ctx.storage.get("latest");
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // -------------------------------------------------------------------------
    // Internal: POST /update
    // - Store the latest record
    // -------------------------------------------------------------------------
    if (url.pathname === "/update" && request.method === "POST") {
      let record;
      try {
        record = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      this.latest = record;
      await this.ctx.storage.put("latest", record);

      return json({ ok: true });
    }

    // -------------------------------------------------------------------------
    // Internal: GET /latest
    // - Return latest record
    // -------------------------------------------------------------------------
    if (url.pathname === "/latest" && request.method === "GET") {
      if (!this.latest) {
        this.latest = await this.ctx.storage.get("latest");
      }
      if (!this.latest) return json({ error: "no data yet" }, 404);
      return json(this.latest);
    }

    return json({ error: "not found" }, 404);
  }
}

/* =============================================================================
 * Durable Object #2: WeatherHistoryDO (HISTORY ONLY, SQLite-backed)
 * =============================================================================
 *
 * Stores:
 * - samples(ts INTEGER PRIMARY KEY, boot_id INTEGER, weather_json TEXT)
 *
 * Provides:
 * - POST /record       (append one real sample)
 * - GET  /history?...  (bucketed + gap-filled timeline)
 *
 * CRITICAL:
 * - No giant JSON arrays stored as one value (avoids SQLITE_TOOBIG).
 * =============================================================================
 */
export class WeatherHistoryDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;

    // SQLite handle (ONLY works if this DO class was created via new_sqlite_classes)
    this.sql = this.ctx.storage.sql;

    this.ctx.blockConcurrencyWhile(async () => {
      // Create the table once (idempotent)
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS samples (
          ts INTEGER PRIMARY KEY,        -- unix seconds (server timestamp)
          boot_id INTEGER,               -- optional boot marker
          weather_json TEXT NOT NULL     -- JSON payload as text
        );
      `);

      // Helpful index for time scans (optional, but cheap)
      // (Primary key already helps, but this makes intent explicit.)
      this.sql.exec(`CREATE INDEX IF NOT EXISTS idx_samples_ts ON samples(ts);`);
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // -------------------------------------------------------------------------
    // Internal: POST /record
    // - Store exactly one real sample row
    // - Retention trim to keep DB bounded
    // -------------------------------------------------------------------------
    if (url.pathname === "/record" && request.method === "POST") {
      const record = await request.json();

      // Insert or replace (ts is PRIMARY KEY -> idempotent if same ts appears)
      this.sql.exec(
        "INSERT OR REPLACE INTO samples (ts, boot_id, weather_json) VALUES (?, ?, ?)",
        record.ts,
        record.boot_id ?? null,
        JSON.stringify(record.weather)
      );

      // Retention: keep last 10 days (raw storage bound)
      const RETENTION_SEC = 10 * 24 * 60 * 60;
      const cutoff = record.ts - RETENTION_SEC;
      this.sql.exec("DELETE FROM samples WHERE ts < ?", cutoff);

      return json({ ok: true });
    }

    // -------------------------------------------------------------------------
    // Internal: GET /history?range=6h|24h|7d
    //
    // REQUIRED BEHAVIOR (your “B”):
    // - Always return EXACTLY cfg.maxSamples buckets
    // - Buckets are evenly spaced by cfg.stepSec
    // - Right edge anchored to latest REAL sample bucket (freeze on outage)
    // - Missing buckets have null values (honest gaps)
    // -------------------------------------------------------------------------
    if (url.pathname === "/history" && request.method === "GET") {
      const range = url.searchParams.get("range");
      const cfg = HISTORY_CFG[range];
      if (!cfg) return json({ error: "invalid range" }, 400);

      const BUCKET_SEC = cfg.stepSec;

      // 1) Find newest real sample timestamp in DB
      const latestRow = this.sql.exec("SELECT MAX(ts) AS latest_ts FROM samples").one();
      const latestTs = latestRow?.latest_ts;

      // No data yet -> empty
      if (typeof latestTs !== "number" || !Number.isFinite(latestTs)) {
        return json({ samples: [] });
      }

      // 2) Align newest sample to bucket boundary (bucket start time)
      const endBucket = Math.floor(latestTs / BUCKET_SEC) * BUCKET_SEC;

      // 3) Start bucket such that we always return N buckets
      const startBucket = endBucket - (cfg.maxSamples - 1) * BUCKET_SEC;

      // Include full last bucket range
      const endInclusive = endBucket + (BUCKET_SEC - 1);

      // 4) Build the complete bucket timeline (always N)
      const buckets = [];
      for (let i = 0; i < cfg.maxSamples; i++) {
        buckets.push(startBucket + i * BUCKET_SEC);
      }

      // 5) Aggregate real samples into buckets (only buckets that have data appear here)
      //
      // IMPORTANT:
      // - We extract the SAME fields your frontend graphs use:
      //     $.temp, $.hum, $.pressure
      // - Averages are stable and simple
      const aggRows = this.sql.exec(
        `
        SELECT
          (ts / ?) * ? AS bucket_ts,
          AVG(json_extract(weather_json, '$.temp'))     AS temp,
          AVG(json_extract(weather_json, '$.hum'))      AS hum,
          AVG(json_extract(weather_json, '$.pressure')) AS pressure
        FROM samples
        WHERE ts >= ? AND ts <= ?
        GROUP BY bucket_ts
        `,
        BUCKET_SEC, BUCKET_SEC,
        startBucket, endInclusive
      ).toArray();

      // 6) Build lookup map: bucket_ts -> {temp,hum,pressure}
      const byBucket = new Map();
      for (const r of aggRows) {
        byBucket.set(r.bucket_ts, {
          temp:     (r.temp     == null ? null : Number(r.temp)),
          hum:      (r.hum      == null ? null : Number(r.hum)),
          pressure: (r.pressure == null ? null : Number(r.pressure))
        });
      }

      // 7) Emit ALL buckets; missing => nulls
      const samples = buckets.map(ts => {
        const v = byBucket.get(ts) ?? { temp: null, hum: null, pressure: null };
        return {
          ts,
          boot_id: null,       // aggregated across possibly many samples
          weather: v
        };
      });

      return json({ samples });
    }

    return json({ error: "not found" }, 404);
  }
}

/* =============================================================================
 * Worker Entrypoint
 * =============================================================================
 */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // -------------------------------------------------------------------------
    // Stubs:
    // - liveStub  -> WeatherDO (latest)
    // - histStub  -> WeatherHistoryDO (history)
    //
    // NOTE: DO fetch URLs must be well-formed, but do not need to be resolvable. [1](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
    // -------------------------------------------------------------------------
    const liveId  = env.WEATHER_DO.idFromName("default");
    const liveStub = env.WEATHER_DO.get(liveId);

    const histId  = env.WEATHER_HISTORY_DO.idFromName("default");
    const histStub = env.WEATHER_HISTORY_DO.get(histId);

    // -------------------------------------------------------------------------
    // POST /api/weather  (station -> cloud)
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/weather" && request.method === "POST") {
      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      // AUTHORITATIVE server timestamp (prevents device clock drift issues)
      const ts = Math.floor(Date.now() / 1000);

      // Record passed to both DOs
      const record = {
        ts,
        device_id: payload.device_id ?? null,
        boot_id: payload.boot_id ?? null,
        weather: payload
      };

      // 1) Write latest
      const liveRes = await liveStub.fetch(new Request("https://do/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record)
      }));
      if (!liveRes.ok) return liveRes;

      // 2) Write history row
      const histRes = await histStub.fetch(new Request("https://hist/record", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record)
      }));
      if (!histRes.ok) return histRes;

      return json({ ok: true });
    }

    // -------------------------------------------------------------------------
    // GET /api/weather  (UI -> latest)
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/weather" && request.method === "GET") {
      return await liveStub.fetch(new Request("https://do/latest", { method: "GET" }));
    }

    // -------------------------------------------------------------------------
    // GET /api/history?range=6h|24h|7d  (UI -> history)
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/history" && request.method === "GET") {
      const range = url.searchParams.get("range");
      if (!["6h", "24h", "7d"].includes(range)) {
        return json({ error: "invalid range" }, 400);
      }

      const res = await histStub.fetch(
        new Request(`https://hist/history?range=${encodeURIComponent(range)}`, { method: "GET" })
      );

      const data = await res.json();
      return json({ range, samples: data.samples ?? [] });
    }

    // -------------------------------------------------------------------------
    // Health check
    // -------------------------------------------------------------------------
    if (url.pathname === "/api/test") {
      return json({ status: "worker-alive" });
    }

    // -------------------------------------------------------------------------
    // Static assets
    // -------------------------------------------------------------------------
    return env.ASSETS.fetch(request);
  }
};