/* =============================================================================
 * weather-station / worker.js (ESM module)
 * =============================================================================
 * Two Durable Objects:
 * 1) WeatherDO: stores latest live reading + decides deterministic history sampling times
 * 2) WeatherHistoryDO: stores deterministic snapshot points (SQLite)
 *    - 6h: every 5 min, 24h: every 10 min, 7d: every 1 hour
 *    - no aggregation; missing timestamps are null-filled on read
 *
 * FEATURE FLAG:
 * - env.HISTORY_ENABLED controls whether history is written/read.
 * =============================================================================
 */

/* ----------------------------------------------------------------------------- */
/* JSON helper                                                                    */
/* ----------------------------------------------------------------------------- */
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

/* ----------------------------------------------------------------------------- */
/* HISTORY CONFIG                                                                 */
/* ----------------------------------------------------------------------------- */
const HISTORY_CFG = {
  "6h":  { stepSec: 5 * 60,    maxSamples: 72},
  "24h": { stepSec: 10 * 60,   maxSamples: 144},
  "7d":  { stepSec: 60 * 60,   maxSamples: 168},
  "30d": { stepSec: 60 * 60,   maxSamples: 24 * 31}, // hourly, 1 month
  "1y":  { stepSec: 60 * 60,   maxSamples: 24 * 366}, // hourly, rolling year
};

  // Normalize the incoming device payload to the stable history schema.
  // lastOutdoor provides latched Shelly values when a boundary sample lands between updates.
function normalizeForHistory(payload, lastOutdoor = null) {

  const temp =
    (typeof payload?.temp === "number") ? payload.temp :
    (typeof payload?.raw?.temperature_c === "number") ? payload.raw.temperature_c :
    null;

  const hum =
    (typeof payload?.hum === "number") ? payload.hum :
    (typeof payload?.raw?.humidity_pct === "number") ? payload.raw.humidity_pct :
    null;

	// Pressure MUST always be SEA-LEVEL compensated.
	// Raw station pressure must never be used for history or charts.
	//
	// Rule:
	// - Accept only derived.sea_level_pressure_pa.
	// - If it is missing, store null (not raw pressure).
	const pressurePa =
	  (typeof payload?.derived?.sea_level_pressure_pa === "number") ? payload.derived.sea_level_pressure_pa
	: null;

	const outTemp =
	  (typeof payload?.shelly?.temperature_c === "number") ? payload.shelly.temperature_c :
	  (typeof lastOutdoor?.temperature_c === "number") ? lastOutdoor.temperature_c :
	  null;

	const outHum =
	  (typeof payload?.shelly?.humidity_pct === "number") ? payload.shelly.humidity_pct :
	  (typeof lastOutdoor?.humidity_pct === "number") ? lastOutdoor.humidity_pct :
	  null;

  return {
    temp,
    hum,
    pressure: pressurePa,
    shelly: {
      temperature_c: outTemp,
      humidity_pct: outHum
    }
  };
}

/* SIMULATED HISTORY (DEV MODE)
 * Used when /api/history is requested without mode=real (or with mode=sim).
 * Intended for UI testing without relying on device/DO availability.
 */
function hash32(x) {
  x |= 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

function rand01(seed) {
  return hash32(seed) / 4294967296;
}

function randSigned(seed) {
  return rand01(seed) * 2 - 1;
}

function clamp(x, lo, hi) {
  return Math.min(hi, Math.max(lo, x));
}

function simulateBucket(bucketTs, prev) {
  const BASE_SEED = 1337;
  const dayPhase = (bucketTs % 86400) / 86400 * Math.PI * 2;

  const nTemp = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x01));
  const nHum  = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x02));
  const nPres = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x03));
  const nOutT = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x04));
  const nOutH = randSigned(hash32(BASE_SEED ^ bucketTs ^ 0x05));

  const baseTemp = prev ? prev.temp : 22.0;
  const tempStep = nTemp * 0.08;
  const tempCycle = Math.sin(dayPhase) * 0.6;

  let temp = baseTemp + tempStep;
  temp = temp + (tempCycle - (prev ? prev.tempCycle : 0));
  temp = clamp(temp, 16, 30);

  const baseHum = prev ? prev.hum : 45.0;
  const humStep = nHum * 0.5;
  const humTempCoupling = (22 - temp) * 1.2;

  let hum = baseHum + humStep + humTempCoupling * 0.05;
  hum = clamp(hum, 20, 80);

  const basePres = prev ? prev.pressure : 101300.0;
  const presStep = nPres * 8;

  let pressure = basePres + presStep;
  pressure = clamp(pressure, 98000, 105000);

  let outTemp = (temp - 1.5) + nOutT * 0.4;
  outTemp = clamp(outTemp, -10, 35);

  let outHum = (hum + 5) + nOutH * 2.0;
  outHum = clamp(outHum, 10, 100);

  return {
    temp,
    hum,
    pressure,
    tempCycle,
    shelly: {
      temperature_c: outTemp,
      humidity_pct: outHum
    }
  };
}

const SIM_HISTORY_CACHE = new Map();

async function getSimulatedHistory(range) {
  const cfg = HISTORY_CFG[range];
  if (!cfg) return json({ error: "invalid range" }, 400);

  const step = cfg.stepSec;
  const now = Math.floor(Date.now() / 1000);
  const endBucket = Math.floor(now / step) * step;

  const cacheKey = `${range}:${endBucket}`;

  const cached = SIM_HISTORY_CACHE.get(cacheKey);
  if (cached) {
    return json(cached.payload);
  }

  const startBucket = endBucket - (cfg.maxSamples - 1) * step;

  const samples = [];
  let prev = null;

  for (let i = 0; i < cfg.maxSamples; i++) {
    const ts = startBucket + i * step;

    const v = simulateBucket(ts, prev);

    samples.push({
      ts,
      boot_id: null,
      weather: {
        temp: v.temp,
        hum: v.hum,
        pressure: v.pressure,
        shelly: {
          temperature_c: v.shelly.temperature_c,
          humidity_pct: v.shelly.humidity_pct
        }
      }
    });

    prev = v;
  }

  const payload = { range, samples };
  SIM_HISTORY_CACHE.set(cacheKey, { endBucket, payload });

  for (const key of SIM_HISTORY_CACHE.keys()) {
    if (key.startsWith(`${range}:`) && key !== cacheKey) {
      SIM_HISTORY_CACHE.delete(key);
    }
  }

  return json(payload);
}

/* =============================================================================
 * Durable Object #1: WeatherDO (LATEST ONLY, KV)
 * ============================================================================= */
export class WeatherDO {
  constructor(ctx) {
    this.ctx = ctx;
    this.latest = null;

    // -----------------------------------------------------------------------
    // Latest snapshot write throttling (IMPORTANT)
    //
    // Why: In SQLite-backed Durable Objects, the KV-style storage API
    // (ctx.storage.get/put/delete/list) is implemented by writing to a hidden
    // SQLite table called __cf_kv. Those writes count toward rows_written. [1](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
    //
    // We want the "latest weather" to be fresh for every request, but we do NOT
    // need every 3-second update to be durable. So:
    //   - Always update this.latest in memory
    //   - Only checkpoint to durable storage every N seconds (default 60s)
    // -----------------------------------------------------------------------
    this.latestDirty = false;              // true when in-memory latest changed since last checkpoint
    this.lastLatestPersistMs = 0;          // last time we persisted "latest" (ms since epoch)
    this.latestPersistIntervalMs = 60_000; // checkpoint interval (60s). Adjust if desired.
	
	// Latched last-known outdoor readings (Shelly)
	// These are used when sampling history so we don't miss outdoor data at boundaries.
	this.lastOutdoor = { temperature_c: null, humidity_pct: null };

	// Deterministic sampling state per range (aligned to step boundaries)
	this.lastSampleTsByRange = { "6h": 0, "24h": 0, "7d": 0, "30d": 0, "1y": 0 };

    this.ctx.blockConcurrencyWhile(async () => {
      this.latest = await this.ctx.storage.get("latest");
      // If we loaded a persisted latest value, consider it already checkpointed.
      // (We will still overwrite it later, but only on the checkpoint interval.)
      if (this.latest) {
        this.latestDirty = false;
        this.lastLatestPersistMs = Date.now();
      }
    // Load latched outdoor readings from storage (if any)
    this.lastOutdoor =(await this.ctx.storage.get("lastOutdoor")) ?? { temperature_c: null, humidity_pct: null };
	  
    //Load per-range sampler state from storage
    this.lastSampleTsByRange = (await this.ctx.storage.get("lastSampleTsByRange")) ?? { "6h": 0, "24h": 0, "7d": 0, "30d": 0, "1y": 0 };
    });
  }

  // -----------------------------------------------------------------------
  // Persist "latest" to durable storage at a controlled rate.
  //
  // IMPORTANT:
  // In SQLite-backed DOs, ctx.storage.put() writes to hidden SQLite table __cf_kv,
  // and those writes count toward rows_written.
  //
  // - force=true: always write (used when we have never persisted yet)
  // - otherwise: write only when dirty AND interval elapsed
  // -----------------------------------------------------------------------
  async maybePersistLatest(force = false) {
    if (!this.latest) return;

    // First-ever persist should not be delayed indefinitely.
    if (this.lastLatestPersistMs === 0) force = true;

    // If nothing changed, don't write unless forced.
    if (!this.latestDirty && !force) return;

    const now = Date.now();

    // Throttle unless forced.
    if (!force && (now - this.lastLatestPersistMs) < this.latestPersistIntervalMs) {
      return;
    }
    
    // Persist latest + lastOutdoor together on the checkpoint interval.
    // In SQLite-backed DOs, KV API writes are stored in __cf_kv. [1](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
    await this.ctx.storage.put("latest", this.latest);
    await this.ctx.storage.put("lastOutdoor", this.lastOutdoor);

    this.lastLatestPersistMs = now;
    this.latestDirty = false;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ---------------------------------------------------------------------
    // POST /purge  (ADMIN)
    // Clears all durable + in-memory state in WeatherDO:
    // - latest (durable)
    // - lastOutdoor (durable)
    // - lastSampleTsByRange (durable)
    // - plus in-memory mirrors
    // ---------------------------------------------------------------------
    if (url.pathname === "/purge" && request.method === "POST") {
      // Durable storage keys
      await this.ctx.storage.delete("latest");
      await this.ctx.storage.delete("lastOutdoor");
      await this.ctx.storage.delete("lastSampleTsByRange");

      // In-memory state
      this.latest = null;
      this.latestDirty = false;
      this.lastLatestPersistMs = 0;

      this.lastOutdoor = { temperature_c: null, humidity_pct: null };
      this.lastSampleTsByRange = { "6h": 0, "24h": 0, "7d": 0, "30d": 0, "1y": 0 };

      return json({ ok: true, purged: "WeatherDO" });
    }

    // POST /update -> store latest
    if (url.pathname === "/update" && request.method === "POST") {
      let record;
      try {
        record = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      // Always keep latest in memory (freshness)
      this.latest = record;
      this.latestDirty = true;
	  
      // Latch last-known outdoor readings whenever present in the incoming record
      // We latch from record.weather.shelly (the live payload) if it contains numbers.
      const sh = record?.weather?.shelly;
	  const shellyReady = (sh?.ready === true);

      // Only mark changed if the new value differs from what we already latched.
	  if (shellyReady &&
		typeof sh?.temperature_c === "number" &&
		sh.temperature_c !== this.lastOutdoor.temperature_c) {
	  this.lastOutdoor.temperature_c = sh.temperature_c;
	  }
	  if (shellyReady &&
		typeof sh?.humidity_pct === "number" &&
		sh.humidity_pct !== this.lastOutdoor.humidity_pct) {
	    this.lastOutdoor.humidity_pct = sh.humidity_pct;
	  }

    // Do NOT persist lastOutdoor immediately.
      // We checkpoint lastOutdoor together with "latest" inside maybePersistLatest()
      // to avoid frequent rows_written. [1](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
      // If outdoorChanged is true, the updated values are already stored in memory
      // checkpoint them together (throttled) to reduce rows_written. [1](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
      await this.maybePersistLatest(false);

      // Deterministic sampling decisions (aligned to exact boundaries)
      // - Returns 0..3 due samples (6h/24h/7d) to the Worker.
      // - Each range writes exactly once per aligned timestamp.
      const nowTs = record?.ts;
      const dueSamples = []; 

      if (typeof nowTs === "number") {
        for (const range of Object.keys(HISTORY_CFG)) {
        const step = HISTORY_CFG[range].stepSec;               
        const sampleTs = Math.floor(nowTs / step) * step;      // aligned timestamp
        const lastTs = this.lastSampleTsByRange?.[range] ?? 0; 

        if (sampleTs > lastTs) {
          dueSamples.push({ range, ts: sampleTs });            
          this.lastSampleTsByRange[range] = sampleTs;          
        }
        }

        // Persist only when changed
        if (dueSamples.length > 0) {
        await this.ctx.storage.put("lastSampleTsByRange", this.lastSampleTsByRange);
        }
      }
	// Include latched outdoor values so Worker can build complete history snapshots
	return json({ ok: true, dueSamples, lastOutdoor: this.lastOutdoor });
    }

  // GET /latest -> return latest
  if (url.pathname === "/latest" && request.method === "GET") {
    if (!this.latest) this.latest = await this.ctx.storage.get("latest");
    if (!this.latest) return json({ error: "no data yet" }, 404);
    return json(this.latest);
  }
  return json({ error: "not found" }, 404);
  }
}

/* =============================================================================
 * Durable Object #2: WeatherHistoryDO (HISTORY, SQLite)
 * ============================================================================= */
export class WeatherHistoryDO {
  constructor(ctx){
    this.ctx = ctx;
    this.sql = this.ctx.storage.sql;

    this.ctx.blockConcurrencyWhile(async () => {
      // One table per range so each has its own ts primary key timeline
      // boot_id is stored for debugging device restarts; not used in charting.
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS samples_6h (
          ts INTEGER PRIMARY KEY,
          boot_id INTEGER,
          weather_json TEXT NOT NULL
        );
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS samples_24h (
          ts INTEGER PRIMARY KEY,
          boot_id INTEGER,
          weather_json TEXT NOT NULL
        );
      `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS samples_7d (
          ts INTEGER PRIMARY KEY,
          boot_id INTEGER,
          weather_json TEXT NOT NULL
        );
      `);

      this.sql.exec(`
      CREATE TABLE IF NOT EXISTS samples_30d (
        ts INTEGER PRIMARY KEY,
        boot_id INTEGER,
        weather_json TEXT NOT NULL
      );
    `);
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS samples_1y (
          ts INTEGER PRIMARY KEY,
          boot_id INTEGER,
          weather_json TEXT NOT NULL
        );
      `);
    });
  }
  
  async fetch(request) {
    const url = new URL(request.url);

    // ---------------------------------------------------------------------
    // POST /purge  (ADMIN)
    // Deletes all rows from all history tables so graphs start fresh.
    // ---------------------------------------------------------------------
    if (url.pathname === "/purge" && request.method === "POST") {
      this.sql.exec(`DELETE FROM samples_6h;`);
      this.sql.exec(`DELETE FROM samples_24h;`);
      this.sql.exec(`DELETE FROM samples_7d;`);
      this.sql.exec(`DELETE FROM samples_30d;`);
      this.sql.exec(`DELETE FROM samples_1y;`);

      return json({ ok: true, purged: "WeatherHistoryDO" });
    }

	// POST /record_batch -> insert deterministic samples (0..3) in one request.
	// This avoids any bucket/AVG logic: we store the snapshot at the exact aligned ts.
	if (url.pathname === "/record_batch" && request.method === "POST") {
	  const body = await request.json();

	  const samples = Array.isArray(body?.samples) ? body.samples : [];
	  const bootId = body?.boot_id ?? null;
	  const weather = body?.weather ?? null;

	  // Require normalized weather object
	  if (!weather || typeof weather !== "object") {
		return json({ error: "missing weather" }, 400);
	  }

	  const RETENTION_SEC_BY_RANGE = {
      "6h":  2  * 24 * 60 * 60,   // keep 2 days
      "24h": 3  * 24 * 60 * 60,   // keep 3 days
      "7d":  10 * 24 * 60 * 60,   // keep 10 days
      "30d": 40 * 24 * 60 * 60,   // keep ~40 days
      "1y":  380 * 24 * 60 * 60,  // keep ~1 year
    };

	  for (const s of samples) {
		const range = s?.range;
		const ts = s?.ts;

		if (!["6h", "24h", "7d", "30d", "1y"].includes(range)) continue;
		if (typeof ts !== "number" || !Number.isFinite(ts)) continue;

    const table =
      (range === "6h")  ? "samples_6h"  :
      (range === "24h") ? "samples_24h" :
      (range === "7d")  ? "samples_7d"  :
      (range === "30d") ? "samples_30d" :
      "samples_1y";

		this.sql.exec(
		  `INSERT OR REPLACE INTO ${table} (ts, boot_id, weather_json) VALUES (?, ?, ?)`,
		  ts,
		  bootId,
		  JSON.stringify(weather)
		);

		const retentionSec = RETENTION_SEC_BY_RANGE[range] ?? 0;
    const cutoff = retentionSec > 0 ? ts - retentionSec : ts;
		this.sql.exec(`DELETE FROM ${table} WHERE ts < ?`, cutoff);
	  }

	  return json({ ok: true });
	}

	// GET /history?range=...
	if (url.pathname === "/history" && request.method === "GET") {
	  const range = url.searchParams.get("range");
	  const cfg = HISTORY_CFG[range];
	  if (!cfg) return json({ error: "invalid range" }, 400);

	  const step = cfg.stepSec;

	  // Pick correct table
    const table =
      (range === "6h")  ? "samples_6h"  :
      (range === "24h") ? "samples_24h" :
      (range === "7d")  ? "samples_7d"  :
      (range === "30d") ? "samples_30d" :
      "samples_1y";

	  // Deterministic aligned window
	  const now = Math.floor(Date.now() / 1000);
	  const endTs = Math.floor(now / step) * step;
	  const startTs = endTs - (cfg.maxSamples - 1) * step;

	  // Read stored samples
	  const rows = this.sql.exec(
		`SELECT ts, boot_id, weather_json FROM ${table} WHERE ts >= ? AND ts <= ? ORDER BY ts ASC`,
		startTs,
		endTs
	  ).toArray();

	  const byTs = new Map();
	  for (const r of rows) {
		let weather;
		try { weather = JSON.parse(r.weather_json); } catch { weather = null; }
		byTs.set(r.ts, { boot_id: r.boot_id ?? null, weather });
	  }

	  // Return exactly N timestamps; missing ones are null-filled
	  const samples = [];
	  for (let i = 0; i < cfg.maxSamples; i++) {
		const ts = startTs + i * step;
		const found = byTs.get(ts);

		samples.push({
		  ts,
		  boot_id: found?.boot_id ?? null,
		  weather: found?.weather ?? {
			temp: null,
			hum: null,
			pressure: null,
			shelly: { temperature_c: null, humidity_pct: null }
		  }
		});
	  }
	  return json({ range, samples });
	}
    return json({ error: "not found" }, 404);
  }
}

/* =============================================================================
 * Worker Entrypoint
 * ============================================================================= */
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // stubs (well-formed URLs are enough for DO internal routing)
    const liveId = env.WEATHER_DO.idFromName("default");
    const liveStub = env.WEATHER_DO.get(liveId);

    const histStub =
      env.HISTORY_ENABLED === "true"
        ? env.WEATHER_HISTORY_DO.get(env.WEATHER_HISTORY_DO.idFromName("default"))
        : null;

    // ---------------------------------------------------------------------
    // POST /api/purge  (ADMIN)
    // Purges WeatherDO + WeatherHistoryDO in one call.
    //
    // Security:
    // - Requires secret PURGE_TOKEN (recommended by Cloudflare) [1](https://developers.cloudflare.com/workers/configuration/secrets/)
    // - Client must send header: X-Purge-Token: <token>
    // ---------------------------------------------------------------------
    if (url.pathname === "/api/purge" && request.method === "POST") {
      const token = request.headers.get("X-Purge-Token");

      if (!env.PURGE_TOKEN || token !== env.PURGE_TOKEN) {
        return json({ error: "unauthorized" }, 401);
      }

      // Purge WeatherDO
      const r1 = await liveStub.fetch(new Request("https://do/purge", { method: "POST" }));
      if (!r1.ok) return json({ error: "WeatherDO purge failed", status: r1.status }, 500);

      // Purge HistoryDO (only if enabled/bound)
      if (histStub) {
        const r2 = await histStub.fetch(new Request("https://hist/purge", { method: "POST" }));
        if (!r2.ok) return json({ error: "WeatherHistoryDO purge failed", status: r2.status }, 500);
      }

      return json({ ok: true, purged: true });
    } 
        
    // POST /api/weather
    if (url.pathname === "/api/weather" && request.method === "POST") {
      const ts = Math.floor(Date.now() / 1000);

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      const record = {
        ts,
        device_id: payload.device_id ?? null,
        boot_id: payload.boot_id ?? null,
        weather: payload,
      };

	// always update latest
	const liveRes = await liveStub.fetch(new Request("https://do/update", {
	  method: "POST",
	  headers: { "Content-Type": "application/json" },
	  body: JSON.stringify(record),
	}));
	if (!liveRes.ok) return liveRes;

	// Read deterministic sampling decisions from WeatherDO
	let dueSamples = [];
	let lastOutdoor = null; 
	try {
	  const liveJson = await liveRes.json();
	  dueSamples = Array.isArray(liveJson?.dueSamples) ? liveJson.dueSamples : [];
	  lastOutdoor = liveJson?.lastOutdoor ?? null; // latched outdoor fallback
	} catch {
	  dueSamples = [];
	  lastOutdoor = null;
	}


	// Only write history if enabled AND any range is due
	if (env.HISTORY_ENABLED === "true" && dueSamples.length > 0) {
	  // Use latched outdoor values if payload.shelly is missing at the boundary
	  const normalized = normalizeForHistory(payload, lastOutdoor);

	  // Batch write to History DO in background (single DO request)
	  ctx.waitUntil(
		histStub.fetch(new Request("https://hist/record_batch", {
		  method: "POST",
		  headers: { "Content-Type": "application/json" },
		  body: JSON.stringify({
			samples: dueSamples,            // [{range, ts}, ...]
			boot_id: record.boot_id ?? null, // preserve boot_id if available
			weather: normalized              // normalized snapshot
		  }),
		}))
	  );
	}

	return json({ ok: true });
}

    // GET /api/weather
    if (url.pathname === "/api/weather" && request.method === "GET") {
      return await liveStub.fetch(new Request("https://do/latest", { method: "GET" }));
      //return json({ weather: null, degraded: true });
    }

    // GET /api/history?range=...
    if (url.pathname === "/api/history" && request.method === "GET") {
      const range = url.searchParams.get("range");

      // Validate input early
      if (!["6h", "24h", "7d", "30d", "1y"].includes(range)) {
        return json({ error: "invalid range" }, 400);
      }

      // MODE SWITCH (single source of truth for dev)
      // - SIMULATED: return generated history, do NOT touch Durable Objects
      // - REAL: return real history if enabled
      const requestedMode =
        url.searchParams.get("mode") === "real" ? "REAL" : "SIMULATED";

      // DEV: simulated history (UI testing) when mode is not "real"
      if (requestedMode === "SIMULATED") {
        return await getSimulatedHistory(range);
      }

      // REAL is still server‑gated
      if (env.HISTORY_ENABLED !== "true") {
        return json({ range, samples: [] }, 200);
      }

      // REAL path: call History DO
      const res = await histStub.fetch(
        new Request(`https://hist/history?range=${encodeURIComponent(range)}`, { method: "GET" })
      );

      if (!res.ok) {
        return json({ error: "history DO fetch failed", status: res.status }, res.status);
      }
      const data = await res.json();
      return json({ range, samples: data.samples ?? [] });
    }

    // health check
    if (url.pathname === "/api/test") {
      return json({ status: "worker-alive" });
    }

    // static assets
    return env.ASSETS.fetch(request);
  },
};