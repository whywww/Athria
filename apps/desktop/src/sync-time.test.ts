import { describe, expect, it, vi } from "vitest";
import { currentLanguage } from "./i18n";
import { formatDateTime, formatSyncDateTimeParts } from "./view-models";

vi.mock("./i18n", async (importOriginal) => ({
  ...await importOriginal<typeof import("./i18n")>(),
  currentLanguage: vi.fn(() => "en"),
}));

describe("sync timestamp wrapping", () => {
  for (const language of ["en", "zh-CN"] as const) {
    it(`keeps the complete date and time in ${language}, including timezone conversion`, () => {
      vi.mocked(currentLanguage).mockReturnValue(language);
      const timestamp = "2026-10-07T03:45:00Z";
      for (const timezone of ["Asia/Hong_Kong", "America/New_York"]) {
        const parts = formatSyncDateTimeParts(timestamp, timezone);
        expect(parts.date).toContain("2026");
        expect(parts.time).toMatch(/\d+:45/);
        // Intl uses narrow spaces in formatToParts on some runtimes.
        const normalize = (text: string) => text.replace(/\s/g, " ");
        expect(normalize(parts.date + parts.separator + parts.time)).toBe(normalize(formatDateTime(timestamp, timezone)));
        expect(parts.date).not.toContain("…");
        expect(parts.time).not.toContain("…");
      }
    });
  }
});
