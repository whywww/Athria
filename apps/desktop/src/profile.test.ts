import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { EditableProfileBoard, EquipmentSelector, PersonalInformationSection, Profile, ProfileBoard } from "./App";
import { LanguageProvider } from "./i18n";
import type { AthleteProfile, EquipmentCategory, PersonalInformation } from "./view-models";

const profile: AthleteProfile = { ownerId: "local-user", preferredName: "Hailey", gender: null, heightCm: null, birthDate: null, timezone: "UTC", goals: [], preference: "", maxSessionMinutes: 60, trainingRhythm: { kind: "flexible_week", targetDaysPerWeek: 4, minDaysPerWeek: 3, maxDaysPerWeek: 5 }, equipment: [], injuries: [], constraintNotes: [], explicitRecoveryDays: null, mesocycleDurationWeeks: 8, unitSystem: "metric", raceDays: [] };
const personal: PersonalInformation = { preferredName: "Hailey", gender: "female", heightCm: 170, birthDate: "1994-02-01", unitSystem: "metric", weightKg: 65, weightDate: "2026-09-17", snapshotHash: "snapshot" };

function renderProfileBoard(overrides: Partial<AthleteProfile> = {}, equipmentCategories: EquipmentCategory[] = []) {
  return renderToStaticMarkup(createElement(ProfileBoard, { profile: { ...profile, ...overrides }, equipmentCategories }));
}

describe("Profile board", () => {
  it("has one edit button for personal information and training profile", () => {
    const client = new QueryClient();
    client.setQueryData(["profile"], { ...profile, profileHash: "profile-hash" });
    client.setQueryData(["personal-information"], personal);
    client.setQueryData(["training-taxonomy"], { equipmentCategories: [] });
    const html = renderToStaticMarkup(createElement(QueryClientProvider, { client }, createElement(Profile)));
    expect(html.match(/>Edit<\/button>/g)).toHaveLength(1);
    expect(html.indexOf("Personal Information")).toBeLessThan(html.indexOf("Training Goals"));
  });
  it("places both duration fields in the shared profile grid", () => {
    const html = renderProfileBoard();
    expect(html).not.toContain("profile-column-stack");
    expect(html).toContain('class="profile-summary-item profile-max-session"');
    expect(html).toContain('class="profile-summary-item profile-mesocycle"');
    expect(html.indexOf("Max Session Length")).toBeLessThan(html.indexOf("Mesocycle Length"));
    expect(html).toContain("8 weeks");
  });
  it("renders the readonly summary as a three-column card", () => {
    const html = renderProfileBoard();
    expect(html).toContain("profile-top-summary profile-readonly-summary");
    expect(html).toContain("Preferences");
    expect(html).toContain("Training Rhythm");
  });
  it("places personal information above training goals in the profile card", () => {
    const personalSection = createElement(PersonalInformationSection, { value: personal, form: null, setForm: () => {}, unit: "metric", switchUnit: () => {}, weightText: "", setWeightText: () => {}, setWeightChanged: () => {}, feetText: "", setFeetText: () => {}, inchesText: "", setInchesText: () => {}, setHeightTouched: () => {} });
    const html = renderToStaticMarkup(createElement(ProfileBoard, { profile, equipmentCategories: [], personalSection }));
    expect(html.indexOf("Personal Information")).toBeLessThan(html.indexOf("Training Goals"));
    expect(html).toContain("2026-09-17");
    expect(html).toContain("65 kg");
    expect(html.indexOf("Training Goals")).toBeLessThan(html.indexOf("profile-preferences-summary"));
    expect(html.indexOf("profile-preferences-summary")).toBeLessThan(html.indexOf("profile-race-summary"));
    expect(html).not.toContain("What do you want to focus on?");
    const goals = html.match(/<section class="profile-goals-panel">([\s\S]*?)<\/section>/)?.[1] ?? "";
    expect(goals).not.toContain("profile-feature-icon");
    expect(goals).toContain("profile-editor-title");
  });
  it("places preferences before race editing and uses the matching compact title", () => {
    const personalSection = createElement(PersonalInformationSection, { value: personal, form: personal, setForm: () => {}, unit: "metric", switchUnit: () => {}, weightText: "65", setWeightText: () => {}, setWeightChanged: () => {}, feetText: "", setFeetText: () => {}, inchesText: "", setInchesText: () => {}, setHeightTouched: () => {} });
    const html = renderToStaticMarkup(createElement(EditableProfileBoard, { profile, form: profile, setForm: () => {}, personalSection, customGoal: "", setCustomGoal: () => {}, availableGoals: [], setAvailableGoals: () => {}, toggleList: () => {}, toggleTrainingDay: () => {}, raceDraft: { date: "", sport: "10K", custom: "" }, setRaceDraft: () => {}, raceDraftValid: false, addRaceDay: () => {}, removeRaceDay: () => {} }));
    expect(html.indexOf("Training Goals")).toBeLessThan(html.indexOf("profile-preferences-editor"));
    expect(html.indexOf("profile-preferences-editor")).toBeLessThan(html.indexOf("profile-race-editor"));
    expect(html).not.toContain("What do you want to focus on?");
    expect(html).toContain("profile-editor-title");
    expect(html).toContain('<span class="fixed-date-placeholder" aria-hidden="true">yyyy/mm/dd</span>');
  });
  it("renders all preset training goals with their English labels and selection state", () => {
    const goals = ["general_fitness", "build_strength", "build_muscle", "improve_endurance", "fat_loss", "improve_competition_results", "body_recomposition", "improve_posture"];
    const form = { ...profile, goals: ["general_fitness", "body_recomposition"] };
    const html = renderToStaticMarkup(createElement(EditableProfileBoard, { profile, form, setForm: () => {}, customGoal: "", setCustomGoal: () => {}, availableGoals: goals, setAvailableGoals: () => {}, toggleList: () => {}, toggleTrainingDay: () => {}, raceDraft: { date: "", sport: "", custom: "" }, setRaceDraft: () => {}, raceDraftValid: false, addRaceDay: () => {}, removeRaceDay: () => {} }));
    for (const label of ["Physical &amp; mental wellness", "Build strength", "Build muscle", "Improve endurance", "Fat loss", "Improve competition results", "Body recomposition", "Improve posture"]) expect(html).toContain(label);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(6);
  });
  it("renders the expanded training goals in Chinese without changing their identifiers", () => {
    const goals = ["general_fitness", "improve_competition_results", "body_recomposition", "improve_posture"];
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    const html = renderToStaticMarkup(createElement(LanguageProvider, null,
      createElement(EditableProfileBoard, { profile, form: { ...profile, goals }, setForm: () => {}, customGoal: "", setCustomGoal: () => {}, availableGoals: goals, setAvailableGoals: () => {}, toggleList: () => {}, toggleTrainingDay: () => {}, raceDraft: { date: "", sport: "", custom: "" }, setRaceDraft: () => {}, raceDraftValid: false, addRaceDay: () => {}, removeRaceDay: () => {} })));
    for (const label of ["身心健康", "提高比赛成绩", "塑形", "改善体态"]) expect(html).toContain(label);
    expect(goals).toEqual(["general_fitness", "improve_competition_results", "body_recomposition", "improve_posture"]);
    vi.unstubAllGlobals();
  });
  it("starts the race picker with a translated selection prompt", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    const html = renderToStaticMarkup(createElement(LanguageProvider, null,
      createElement(EditableProfileBoard, { profile, form: profile, setForm: () => {}, customGoal: "", setCustomGoal: () => {}, availableGoals: [], setAvailableGoals: () => {}, toggleList: () => {}, toggleTrainingDay: () => {}, raceDraft: { date: "", sport: "", custom: "" }, setRaceDraft: () => {}, raceDraftValid: false, addRaceDay: () => {}, removeRaceDay: () => {} })));
    expect(html).toContain('<option value="" selected="">请选择</option>');
    vi.unstubAllGlobals();
  });
  it("keeps the race date format fixed when the interface is Chinese", () => {
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    const personalSection = createElement(PersonalInformationSection, { value: personal, form: { ...personal, birthDate: null }, setForm: () => {}, unit: "metric", switchUnit: () => {}, weightText: "65", setWeightText: () => {}, setWeightChanged: () => {}, feetText: "", setFeetText: () => {}, inchesText: "", setInchesText: () => {}, setHeightTouched: () => {} });
    const intervalProfile: AthleteProfile = { ...profile, maxSessionMinutes: 45, trainingRhythm: { kind: "interval", intervalDays: 3 } };
    const html = renderToStaticMarkup(createElement(LanguageProvider, null,
      createElement(EditableProfileBoard, { profile: intervalProfile, form: intervalProfile, setForm: () => {}, personalSection, customGoal: "", setCustomGoal: () => {}, availableGoals: [], setAvailableGoals: () => {}, toggleList: () => {}, toggleTrainingDay: () => {}, raceDraft: { date: "", sport: "10K", custom: "" }, setRaceDraft: () => {}, raceDraftValid: false, addRaceDay: () => {}, removeRaceDay: () => {} })));
    expect(html.match(/>yyyy\/mm\/dd<\/span>/g)).toHaveLength(2);
    expect(html).toContain("每隔");
    expect(html).toContain("天");
    expect(html).toContain("45 分钟");
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
    renderToStaticMarkup(createElement(LanguageProvider, null, createElement(EditableProfileBoard, { profile, form: profile, setForm: () => {}, customGoal: "", setCustomGoal: () => {}, availableGoals: [], setAvailableGoals: () => {}, toggleList: () => {}, toggleTrainingDay: () => {}, raceDraft: { date: "", sport: "10K", custom: "" }, setRaceDraft: () => {}, raceDraftValid: false, addRaceDay: () => {}, removeRaceDay: () => {} })));
    vi.unstubAllGlobals();
  });
  it("shows the shared editor's personal fields and unit controls", () => {
    const html = renderToStaticMarkup(createElement(PersonalInformationSection, { value: personal, form: personal, setForm: () => {}, unit: "imperial", switchUnit: () => {}, weightText: "143.3", setWeightText: () => {}, setWeightChanged: () => {}, feetText: "5", setFeetText: () => {}, inchesText: "7", setInchesText: () => {}, setHeightTouched: () => {} }));
    expect(html).toContain('aria-label="Measurement units"');
    expect(html).toContain('aria-label="Height feet"');
    expect(html).toContain('aria-label="Height inches"');
    expect(html).toContain('value="143.3"');
    expect(html).toContain('type="date"');
  });
  it("uses the singular week label for a one-week mesocycle", () => {
    expect(renderProfileBoard({ mesocycleDurationWeeks: 1 })).toContain("1 week<");
  });
  it("shows the three nearest upcoming races in date order with countdowns on the same row", () => {
    const html = renderProfileBoard({ raceDays: [{ date: "2999-05-01", sport: "Trail Run" }, { date: "2020-01-01", sport: "10K" }, { date: "2999-04-02", sport: "Half Marathon" }, { date: "2999-03-21", sport: "Marathon" }, { date: "2999-06-12", sport: "Cycling" }] });
    expect(html).toContain("Race Days");
    const rows = html.match(/<div class="race-summary-row">[\s\S]*?<\/div>/g) ?? [];
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain("Mar 21, 2999 · Marathon");
    expect(rows[0]).toContain("race-countdown");
    expect(rows[1]).toContain("Apr 2, 2999 · Half Marathon");
    expect(rows[1]).toContain("race-countdown");
    expect(rows[2]).toContain("May 1, 2999 · Trail Run");
    expect(rows[2]).toContain("race-countdown");
    expect(html).not.toContain("Jun 12, 2999 · Cycling");
    expect(html).toContain("+1 more scheduled");
  });
  it("shows an empty race state when no race is upcoming", () => {
    expect(renderProfileBoard({ raceDays: [{ date: "2020-01-01", sport: "10K" }] })).toContain("No upcoming races");
  });

  it("translates available equipment labels without changing equipment identifiers", () => {
    const categories: EquipmentCategory[] = [{ id: "cardio_endurance", label: "Cardio & Endurance", groups: [{ id: "indoor_cardio", label: "Indoor Cardio Machines", items: [{ id: "treadmill", label: "Treadmill" }] }] }];
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    const html = renderToStaticMarkup(createElement(LanguageProvider, null,
      createElement(EquipmentSelector, { categories, selected: ["treadmill"], onToggleItem: () => {}, onToggleGroup: () => {} })));
    expect(html).toContain("有氧与耐力训练");
    expect(html).toContain("室内有氧器械");
    expect(html).toContain("跑步机");
    expect(categories[0]?.groups[0]?.items[0]?.id).toBe("treadmill");
    vi.unstubAllGlobals();
    vi.stubGlobal("localStorage", { getItem: () => "en", setItem: () => {} });
    renderToStaticMarkup(createElement(LanguageProvider, null, createElement(EquipmentSelector, { categories: [], selected: [] })));
    vi.unstubAllGlobals();
  });

  it("groups only selected equipment in taxonomy order in readonly mode", () => {
    const categories: EquipmentCategory[] = [
      { id: "strength", label: "Strength & Resistance", groups: [
        { id: "free", label: "Free Weights", items: [{ id: "dumbbell", label: "Dumbbells" }, { id: "barbell", label: "Barbell" }] },
        { id: "machines", label: "Machines & Cable", items: [{ id: "cable", label: "Cable Machine" }] },
      ] },
      { id: "cardio", label: "Cardio & Endurance", groups: [{ id: "indoor", label: "Indoor Cardio Machines", items: [{ id: "treadmill", label: "Treadmill" }] }] },
    ];
    const html = renderToStaticMarkup(createElement(EquipmentSelector, { categories, selected: ["treadmill", "barbell", "dumbbell"] }));
    expect(html).toContain("equipment-categories");
    expect(html.indexOf("Strength &amp; Resistance")).toBeLessThan(html.indexOf("Cardio &amp; Endurance"));
    expect(html.indexOf("Dumbbells")).toBeLessThan(html.indexOf("Barbell"));
    expect(html).toContain("Free Weights");
    expect(html).toContain("Indoor Cardio Machines");
    expect(html).not.toContain("Machines &amp; Cable");
    expect(html).not.toContain("Cable Machine");
    expect(html).not.toContain("type=\"checkbox\"");
    expect(html).not.toContain("<button");
  });

  it("keeps the readonly empty state when nothing is selected", () => {
    const categories: EquipmentCategory[] = [{ id: "cardio", label: "Cardio & Endurance", groups: [{ id: "indoor", label: "Indoor Cardio Machines", items: [{ id: "treadmill", label: "Treadmill" }] }] }];
    const html = renderToStaticMarkup(createElement(EquipmentSelector, { categories, selected: [] }));
    expect(html).toContain("None");
    expect(html).not.toContain("equipment-categories");
    expect(html).not.toContain("Treadmill");
  });

  it("translates readonly category, group, and item labels", () => {
    const categories: EquipmentCategory[] = [{ id: "cardio", label: "Cardio & Endurance", groups: [{ id: "indoor", label: "Indoor Cardio Machines", items: [{ id: "treadmill", label: "Treadmill" }] }] }];
    vi.stubGlobal("localStorage", { getItem: () => "zh-CN", setItem: () => {} });
    const html = renderToStaticMarkup(createElement(LanguageProvider, null, createElement(EquipmentSelector, { categories, selected: ["treadmill"] })));
    expect(html).toContain("有氧与耐力训练");
    expect(html).toContain("室内有氧器械");
    expect(html).toContain("跑步机");
    vi.unstubAllGlobals();
  });
});
