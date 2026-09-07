const allowedHostnames = new Set(["127.0.0.1", "localhost", "tauri.localhost"]);

export function isAllowedOrigin(origin: string): boolean {
  if (origin === "tauri://localhost") return true;
  try { return allowedHostnames.has(new URL(origin).hostname); }
  catch { return false; }
}

function corsHeaders(origin: string): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    "Vary": "Origin",
  });
}

export function corsPreflightResponse(origin: string): Response {
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export function applyCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  corsHeaders(origin).forEach((value, name) => headers.set(name, value));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
