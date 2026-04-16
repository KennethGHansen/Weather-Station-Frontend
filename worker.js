function json(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Avoid any accidental caching of API responses
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

/**
 * Durable Object: stores the latest weather record with strong consistency.
 * - Uses in-memory cache for fast reads
 * - Persists to DO storage so it survives restarts/eviction
 *
 * DO storage is private per-object and strongly consistent. [1](https://developers.cloudflare.com/durable-objects/)[3](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
 */
export class WeatherDO {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.latest = null;

    // Ensure we load stored state before handling requests.
    // blockConcurrencyWhile blocks other events until init completes. [6](https://developers.cloudflare.com/durable-objects/api/state/)
    this.ctx.blockConcurrencyWhile(async () => {
      this.latest = await this.ctx.storage.get("latest");
    });
  }

  async fetch(request) {
    const url = new URL(request.url);

    // Internal endpoint: write latest
    if (url.pathname === "/update" && request.method === "POST") {
      let record;
      try {
        record = await request.json();
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      this.latest = record;

      // DO Storage API supports KV-style get/put and is transactional/strongly consistent. [5](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)[3](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
      await this.ctx.storage.put("latest", record);

      return json({ ok: true });
    }

    // Internal endpoint: read latest
    if (url.pathname === "/latest" && request.method === "GET") {
      // If memory is empty (cold start), read from storage
      if (!this.latest) {
        this.latest = await this.ctx.storage.get("latest");
      }

      if (!this.latest) {
        return json({ error: "no data yet" }, 404);
      }

      return json(this.latest);
    }

    return json({ error: "not found" }, 404);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Choose a single named DO instance for your station.
    // idFromName() + get() is the standard way to address a specific object. [2](https://developers.cloudflare.com/durable-objects/api/namespace/)
    const doId = env.WEATHER_DO.idFromName("default");
    const stub = env.WEATHER_DO.get(doId);

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

      // Persist to Durable Object instead of KV (strong consistency, high write rate).
      // DOs have a soft limit of ~1,000 req/s per object. [7](https://developers.cloudflare.com/durable-objects/platform/limits/)
      const internalReq = new Request("https://do/update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record),
      });

      return await stub.fetch(internalReq);
    }

    // ---------------------------------
    // GET /api/weather (UI → latest)
    // ---------------------------------
    if (url.pathname === "/api/weather" && request.method === "GET") {
      const internalReq = new Request("https://do/latest", { method: "GET" });
      return await stub.fetch(internalReq);
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