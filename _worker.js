export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // API routes will live here
    if (url.pathname.startsWith("/api/")) {
      return new Response("OK");
    }

    // Serve static assets (required in advanced mode)
    return env.ASSETS.fetch(request);
  },
};