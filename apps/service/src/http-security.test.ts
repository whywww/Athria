import { describe, expect, it } from "vitest";
import { applyCors, corsPreflightResponse, isAllowedOrigin } from "./http-security";

describe("loopback CORS security", () => {
  it.each(["http://tauri.localhost", "tauri://localhost", "http://localhost:1420", "http://127.0.0.1:1420"])("allows the trusted desktop origin %s", (origin) => expect(isAllowedOrigin(origin)).toBe(true));
  it.each(["https://evil.example", "null", "not a URL"])("rejects the untrusted origin %s", (origin) => expect(isAllowedOrigin(origin)).toBe(false));
  it("answers browser preflight before bearer authentication", () => {
    const response = corsPreflightResponse("http://tauri.localhost");
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(response.headers.get("access-control-allow-methods")).toContain("PATCH");
  });
  it("adds the same origin to the actual API response", () => {
    const response = applyCors(Response.json({ status: "ok" }), "http://tauri.localhost");
    expect(response.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
  });
});
