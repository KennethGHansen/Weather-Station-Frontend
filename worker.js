export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ✅ API endpoint your UI is calling
    if (url.pathname === "/api/weather") {
      return new Response(
        JSON.stringify({
          temperature: 12.3,
          humidity: 67,
          pressure: 1014,
          timestamp: new Date().toISOString()
        }),
        {
          headers: { "Content-Type": "application/json" }
        }
      );
    }

    // Health check (optional)
    if (url.pathname === "/api/test") {
      return new Response(JSON.stringify({ status: "worker-alive" }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    // ✅ Serve static UI
    return env.ASSETS.fetch(request);
  }
};