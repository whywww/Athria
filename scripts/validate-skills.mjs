import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skills = [
  "packages/skills/athria-training-planner",
  "packages/skills/athria-xunji-records",
];
const allowedProperties = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
const toolReferencePattern = /`((?:get|list|calculate|estimate|evaluate|validate|check|create|update|delete|save|record|set|allow|remove)_[a-z0-9_]+)`/g;

function fail(skill, message) {
  throw new Error(`${skill}: ${message}`);
}

export function validateToolNames(tools) {
  const names = tools.map((tool) => tool?.name);
  const invalid = names.filter((name) => typeof name !== "string" || !name);
  if (invalid.length) throw new Error("MCP contract contains a tool without a valid name");
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`MCP contract contains duplicate tools: ${[...new Set(duplicates)].join(", ")}`);
  return new Set(names);
}

export function validateSkillTools(skill, manifest, content, contractTools) {
  if (!Array.isArray(manifest.allowedTools)) fail(skill, "manifest allowedTools must be an array");
  const duplicateAllowed = manifest.allowedTools.filter((name, index) => manifest.allowedTools.indexOf(name) !== index);
  if (duplicateAllowed.length) fail(skill, `manifest contains duplicate allowedTools: ${[...new Set(duplicateAllowed)].join(", ")}`);
  const missing = manifest.allowedTools.filter((name) => !contractTools.has(name));
  if (missing.length) fail(skill, `manifest references unknown MCP tools: ${missing.join(", ")}`);

  const referenced = [...content.matchAll(toolReferencePattern)].map((match) => match[1]);
  const unknownReferences = referenced.filter((name) => !contractTools.has(name));
  if (unknownReferences.length) fail(skill, `SKILL.md references unknown MCP tools: ${[...new Set(unknownReferences)].join(", ")}`);
  const allowed = new Set(manifest.allowedTools);
  const unauthorized = referenced.filter((name) => !allowed.has(name));
  if (unauthorized.length) fail(skill, `SKILL.md references tools missing from manifest allowedTools: ${[...new Set(unauthorized)].join(", ")}`);
}

const contract = JSON.parse(readFileSync(join(projectRoot, "crates/athria-mcp/contract.json"), "utf8"));
const adjustmentTool = JSON.parse(readFileSync(join(projectRoot, "crates/athria-mcp/adjustment-tool.json"), "utf8"));
if (!Array.isArray(contract.tools)) throw new Error("crates/athria-mcp/contract.json: tools must be an array");
const contractTools = validateToolNames([...contract.tools, adjustmentTool]);

for (const skill of skills) {
  const content = readFileSync(join(projectRoot, skill, "SKILL.md"), "utf8");
  const manifest = JSON.parse(readFileSync(join(projectRoot, skill, "manifest.json"), "utf8"));
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) fail(skill, "SKILL.md must start with valid YAML frontmatter");

  const parsed = YAML.parse(match[1]);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) fail(skill, "frontmatter must be a YAML dictionary");
  const frontmatter = parsed;
  const unexpected = Object.keys(frontmatter).filter((key) => !allowedProperties.has(key));
  if (unexpected.length) fail(skill, `unexpected frontmatter properties: ${unexpected.join(", ")}`);

  const name = frontmatter.name;
  if (typeof name !== "string" || !name) fail(skill, "frontmatter requires a non-empty string name");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) fail(skill, "name must use lowercase hyphen-case");
  if (name.length > 64) fail(skill, "name must not exceed 64 characters");

  const description = frontmatter.description;
  if (typeof description !== "string" || !description) fail(skill, "frontmatter requires a non-empty string description");
  if (description.startsWith("[TODO:") || description.includes("<") || description.includes(">")) fail(skill, "description contains a placeholder or angle bracket");
  if (description.length > 1024) fail(skill, "description must not exceed 1024 characters");

  validateSkillTools(skill, manifest, content, contractTools);

  let fence;
  let fenceLength = 0;
  for (const line of content.slice(match[0].length).split(/\r?\n/)) {
    const marker = line.match(/^[ \t]*(?:(?:[-+*]|\d+[.)])[ \t]+)?(`{3,}|~{3,})(.*)$/);
    if (marker) {
      const current = marker[1];
      if (!fence) { fence = current[0]; fenceLength = current.length; }
      else if (current[0] === fence && current.length >= fenceLength && !marker[2].trim()) { fence = undefined; fenceLength = 0; }
    } else if (!fence && /^[ ]{0,3}\[TODO:[^\n]*\][ \t]*$/.test(line)) {
      fail(skill, "instructions contain an unfinished TODO placeholder");
    }
  }
  console.log(`${skill}: valid`);
}
