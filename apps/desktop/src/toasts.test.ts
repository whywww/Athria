import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "./i18n";
import { dismissToast, notify, ToastProvider } from "./toasts";

function render() { return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(ToastProvider, null, "page"))); }
afterEach(() => { vi.advanceTimersByTime(3000); vi.useRealTimers(); vi.unstubAllGlobals(); render(); });
describe("global notifications", () => {
  it("keeps the newest three messages and expires each after three seconds", () => {
    vi.useFakeTimers();
    notify("first", "success");
    vi.advanceTimersByTime(1000);
    notify("second", "warning"); notify("third", "info"); notify("fourth", "error");
    const html = render();
    expect(html).not.toContain("first");
    expect(html).toContain("toast-warning"); expect(html).toContain("toast-info"); expect(html).toContain("toast-error");
    expect(html).toContain('role="alert"'); expect(html).toContain('role="status"');
    vi.advanceTimersByTime(2999); expect(render()).toContain("second");
    vi.advanceTimersByTime(1); expect(render()).not.toContain("second");
  });
  it("dismisses one notification without removing others", () => {
    vi.useFakeTimers();
    const id = notify("dismiss me", "success")!;
    notify("keep me", "info");
    dismissToast(id);
    expect(render()).not.toContain("dismiss me"); expect(render()).toContain("keep me");
  });
  it("translates messages and close controls", () => {
    vi.useFakeTimers(); vi.stubGlobal("localStorage", { getItem: () => "zh-CN" });
    notify("Connection updated. Your credentials were saved securely on this device.", "success");
    const html = render();
    expect(html).toContain("关闭通知"); expect(html).not.toContain("Connection updated.");
  });
});
