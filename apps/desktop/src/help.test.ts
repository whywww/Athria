import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Help } from "./App";
import { LanguageProvider } from "./i18n";

function renderHelp(): string {
  return renderToStaticMarkup(createElement(Help));
}

describe("Help", () => {
  it("answers the setup and connection questions", () => {
    const html = renderHelp();
    expect(html).toContain("How do I create a new plan?");
    expect(html).toContain("How do I import my training data?");
    expect(html).toContain("Why do you recommend Intervals.icu?");
    expect(html).toContain("Athria does not yet have a mobile app, so it cannot read health data directly from your phone. You can use Intervals Companion to sync workouts and health metrics from Apple Health to Intervals.icu, which also brings together data from endurance training platforms such as Strava.");
    expect(html).toContain("How do I back up my data and sync it with my own cloud?");
  });

  it("renders the FAQ as collapsed accordions", () => {
    const html = renderHelp();
    expect((html.match(/class="faq-item"/g) ?? []).length).toBe(4);
    expect(html).toContain("Your connected AI assistant creates your training plan.");
    expect(html).toContain("send “Start Athria” to your assistant");
    expect(html).toContain("If you use other training apps, you can import your training data from them.");
    expect(html).toContain("In Connections, select the training app you use and follow the instructions to set up the connection.");
    expect(html).toContain("On the first open each day, Athria automatically syncs connections with daily automatic sync enabled since the last sync after unlocking the database.");
  });

  it("no longer carries the MCP connection section", () => {
    const html = renderHelp();
    expect(html).not.toContain("Connect Athria to Your AI Agent");
    expect(html).not.toContain("mcp-card");
  });

  it("explains AI and training terms in the glossary", () => {
    const html = renderHelp();
    expect(html).toContain("Model Context Protocol");
    expect(html).toContain("e.g., Claude, ChatGPT");
    expect(html).toContain("Mesocycle");
    expect(html).toContain("Rates how hard a set felt");
    expect(html).toContain("Zone (heart rate zone)");
  });

  it("explains health metrics with RMSSD and SDNN inside the HRV card", () => {
    const html = renderHelp();
    expect(html).toContain("Health &amp; Recovery");
    const hrvCard = html.match(/<section><strong>HRV \(heart rate variability\)<\/strong>[\s\S]*?<\/section>/)?.[0];
    expect(hrvCard).toContain("Compare with your own usual level.");
    expect(hrvCard).toContain("<span><strong>RMSSD</strong> focuses on changes between consecutive heartbeats, while <strong>SDNN</strong> reflects overall changes in heartbeat intervals over a period of time.</span>");
    expect(html).toContain("Resting heart rate");
    expect(html).toContain("Heartbeats per minute while resting quietly, which can help you track fitness and recovery.");
    expect(html).toContain("SpO2 (oxygen saturation)");
    expect(html).toContain("An estimate of how well your blood is supplied with oxygen, shown as a percentage. Device fit and measurement conditions can affect readings.");
  });

  it("translates the setup answers, template explanation and health metrics", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(Help)));
    expect(html).toContain("向助手发送“开始 Athria”");
    expect(html).toContain("为什么建议使用 Intervals.icu？");
    expect(html).toContain("目前 Athria 尚未提供手机客户端，无法直接读取手机健康数据。你可以通过 Intervals Companion 将 Apple 健康中的运动记录和健康指标同步到 Intervals.icu，并在其中统一整合 Strava 等耐力训练平台的数据。");
    expect(html).toContain("如果你有常用的训练 App，可以导入其中的训练数据。");
    expect(html).toContain("在“连接”中选择你常用的训练 App，按照引导完成连接设置。");
    expect(html).toContain("每日首次打开并解锁数据库后，Athria 会自动对已启用每日自动同步的连接执行“自上次同步后”同步。");
    expect(html).toContain("围绕一个训练目标制定的数周计划，用于安排训练节奏、阶段进阶和动态调整。");
    expect(html).toContain("一类训练的可复用抽象结构，用于定义训练应包含什么，而不固定具体动作、组数或负荷。");
    expect(html).toContain("健康与恢复");
    const hrvCard = html.match(/<section><strong>HRV（心率变异性）<\/strong>[\s\S]*?<\/section>/)?.[0];
    expect(hrvCard).toContain("每次心跳之间的间隔变化，可辅助观察身体恢复状态。适合与自己的日常水平比较。");
    expect(hrvCard).toContain("<span><strong>RMSSD</strong> 侧重相邻心跳间的变化，<strong>SDNN</strong> 反映一段时间内心跳间隔的整体变化。</span>");
    expect(html).toContain("Zone（心率区间）");
    expect(html).toContain("静息心率");
    expect(html).toContain("安静休息时每分钟的心跳次数，可辅助观察体能和恢复状态。");
    expect(html).toContain("SpO2（血氧饱和度）");
    expect(html).toContain("血液中氧气充足程度的估计值，以百分比显示。佩戴和测量条件可能影响读数。");
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
    renderToStaticMarkup(createElement(LanguageProvider, null, createElement(Help)));
    vi.unstubAllGlobals();
  });
});
