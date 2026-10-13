import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { syncFailureMessage, notifyTrainingSync } from "./training-sync";
import { LanguageProvider } from "./i18n";
import { ToastProvider } from "./toasts";

function render() { return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(ToastProvider, null, "page"))); }
afterEach(() => { vi.advanceTimersByTime(3000); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("connection failure notifications", () => {
  it("shows dates, unknown dates and endpoint ranges in one existing error toast", () => {
    vi.useFakeTimers(); vi.stubGlobal("localStorage", { getItem: () => "en" }); render();
    notifyTrainingSync("intervals", {
      sync: { status: "failed", rangeStart: "2026-08-01", rangeEnd: "2026-08-16" },
      failedDates: [{ date: "2026-08-15", failures: [{ activityId: "ride-1", reason: "No valid start time" }] }],
      undatedFailures: [{ activityId: "ride-2", reason: "No valid start time" }],
      errors: { wellness: "HTTP 500" },
      errorRanges: { wellness: { rangeStart: "2026-07-31", rangeEnd: "2026-08-17" } },
    });
    const html = render();
    for (const text of ["2026-08-15", "ride-1", "Unknown date", "ride-2", "2026-07-31", "2026-08-17", "wellness", "HTTP 500", "No data or sync time was updated."]) expect(html).toContain(text);
    expect(html.match(/toast-error/g)).toHaveLength(1);
    expect(html).toContain('role="alert"');
    vi.advanceTimersByTime(3000); expect(render()).not.toContain("toast-error");
  });

  it("includes every SynFit failure date even when reasons are identical", () => {
    vi.useFakeTimers(); vi.stubGlobal("localStorage", { getItem: () => "en" }); render();
    notifyTrainingSync("xunji", { sync: { status: "failed", data: { errors: [
      { datestr: "2026-09-29", message: "HTTP 429" }, { datestr: "2026-09-30", message: "HTTP 429" },
    ] } } });
    const html = render();
    expect(html).toContain("2026-09-29"); expect(html).toContain("2026-09-30");
    expect(html.match(/toast-error/g)).toHaveLength(1);
  });

  it("localizes failure messages and uses unknown date for exceptions", () => {
    vi.useFakeTimers(); vi.stubGlobal("localStorage", { getItem: () => "zh-CN" }); render();
    const message = syncFailureMessage("xunji", undefined, new Error("Offline"));
    expect(message).toContain("同步失败"); expect(message).toContain("日期未知");
    expect(message).toContain("同步时间未更新");
    notifyTrainingSync("xunji", undefined, new Error("Offline"));
    expect(render()).toContain(message);
  });

  it("keeps successful sync notifications", () => {
    vi.useFakeTimers(); vi.stubGlobal("localStorage", { getItem: () => "en" }); render();
    notifyTrainingSync("intervals", { sync: { status: "success" }, added: 1 });
    expect(render()).toContain("toast-success");
    expect(render()).not.toContain("toast-error");
  });
});
