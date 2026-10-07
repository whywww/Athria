import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LanguageProvider } from "./i18n";
import { dismissToast, notify, ToastProvider } from "./toasts";

function render() { return renderToStaticMarkup(createElement(LanguageProvider, null, createElement(ToastProvider, null, "page"))); }
afterEach(() => { vi.advanceTimersByTime(3000); vi.useRealTimers(); vi.unstubAllGlobals(); render(); });
describe("global notifications", () => {
  it.each([
    ["en", "success", 0, 0, 2, "Sync Successful: activities 0 added, 0 updated; wellness 2 synced."],
    ["zh-CN", "success", 0, 0, 2, "同步成功：训练活动新增 0 条、更新 0 条；健康数据同步 2 条。"],
    ["en", "success", 3, 1, 4, "Sync Successful: activities 3 added, 1 updated; wellness 4 synced."],
    ["zh-CN", "success", 3, 1, 4, "同步成功：训练活动新增 3 条、更新 1 条；健康数据同步 4 条。"],
    ["zh-CN", "success", 0, 0, 0, "同步成功：训练活动新增 0 条、更新 0 条；健康数据同步 0 条。"],
    ["en", "partial", 0, 0, 2, "Sync partial: activities 0 added, 0 updated; wellness 2 synced."],
    ["zh-CN", "partial", 0, 0, 2, "同步部分完成：训练活动新增 0 条、更新 0 条；健康数据同步 2 条。"],
    ["zh-CN", "failed", 0, 0, 0, "同步失败：训练活动新增 0 条、更新 0 条；健康数据同步 0 条。"],
  ])("shows Intervals counts in %s for %s (%i/%i/%i)", (language, status, added, updated, wellness, expected) => {
    vi.useFakeTimers(); vi.stubGlobal("localStorage", { getItem: () => language });
    const kind = status === "partial" || status === "failed" ? "warning" : "success";
    notify(`Sync ${status}: activities ${added} added, ${updated} updated; wellness ${wellness} synced.`, kind);
    const html = render();
    expect(html).toContain(expected);
    expect(html).toContain(`toast-${kind}`);
  });
  it("preserves other sources' sync notifications", () => {
    vi.useFakeTimers(); vi.stubGlobal("localStorage", { getItem: () => "zh-CN" });
    notify("Sync complete: 1 added, 2 updated.", "success");
    expect(render()).toContain("同步完成：新增 1 条，更新 2 条。");
  });
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
