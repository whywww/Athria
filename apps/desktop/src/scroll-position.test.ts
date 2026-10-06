import { afterEach, expect, it, vi } from "vitest";
import { captureMainScroll } from "./scroll-position";

afterEach(() => vi.unstubAllGlobals());
it("restores the captured main position and clamps when content shrinks", () => {
  const main = { scrollTop: 750, scrollHeight: 1500, clientHeight: 500, isConnected: true };
  vi.stubGlobal("document", { querySelector: () => main });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => callback());
  const restore = captureMainScroll(); main.scrollTop = 0; restore(); expect(main.scrollTop).toBe(750);
  main.scrollHeight = 1000; restore(); expect(main.scrollTop).toBe(500);
  main.isConnected = false; main.scrollTop = 0; restore(); expect(main.scrollTop).toBe(0);
});
