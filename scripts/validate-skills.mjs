import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(projectRoot, "packages/skills");
const skills = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join("packages/skills", entry.name))
  .filter((skill) => {
    const files = new Set(readdirSync(join(projectRoot, skill)));
    return files.has("SKILL.md") && files.has("manifest.json");
  })
  .sort();
const allowedProperties = new Set(["name", "description", "license", "allowed-tools", "metadata"]);
const toolReferencePattern = /`((?:get|list|calculate|estimate|evaluate|validate|check|create|update|delete|save|record|set|allow|remove)_[a-z0-9_]+)`/g;

function readMarkdownTree(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return readMarkdownTree(path);
      return entry.isFile() && entry.name.endsWith(".md") ? [readFileSync(path, "utf8")] : [];
    })
    .join("\n");
}

function fail(skill, message) {
  throw new Error(`${skill}: ${message}`);
}

export function validateToolNames(tools) {
  const names = tools.map((tool) => tool?.name);
  const invalid = names.filter((name) => typeof name !== "string" || !name);
  if (invalid.length) throw new Error("MCP contract contains a tool without a valid name");
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) throw new Error(`MCP contract contains duplicate tools: ${[...new Set(duplicates)].join(", ")}`);
  for (const tool of tools) {
    if (tool.handlerKey !== tool.name) throw new Error(`MCP tool ${tool.name} must use its canonical name as handlerKey`);
    const output = tool.outputSchema;
    if (output?.type !== "object" || !output.properties?.result || !output.required?.includes("result")) {
      throw new Error(`MCP tool ${tool.name} must define an object outputSchema with required result`);
    }
    if (Object.keys(output.properties.result).length === 0) {
      throw new Error(`MCP tool ${tool.name} has an untyped result schema`);
    }
  }
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

export function validateWriteToolOwnership(skillManifests, contract) {
  const writeTools = new Set(contract.tools
    .filter((tool) => tool.annotations?.readOnlyHint === false)
    .map((tool) => tool.name));
  const owners = new Map();

  for (const [skill, manifest] of skillManifests) {
    for (const tool of manifest.allowedTools) {
      if (!writeTools.has(tool)) continue;
      const previous = owners.get(tool);
      if (previous) fail(skill, `write tool ${tool} is already owned by ${previous}`);
      owners.set(tool, skill);
    }
  }

  const unowned = [...writeTools].filter((tool) => !owners.has(tool));
  if (unowned.length) throw new Error(`write tools must have exactly one Skill owner: ${unowned.join(", ")}`);
  return owners;
}

const contract = JSON.parse(readFileSync(join(projectRoot, "crates/athria-mcp/contract.json"), "utf8"));
if (!Array.isArray(contract.tools)) throw new Error("crates/athria-mcp/contract.json: tools must be an array");
const contractTools = validateToolNames(contract.tools);
const skillManifests = [];

for (const skill of skills) {
  const content = readFileSync(join(projectRoot, skill, "SKILL.md"), "utf8");
  const allMarkdown = readMarkdownTree(join(projectRoot, skill));
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
  if (name !== basename(skill)) fail(skill, `frontmatter name must match folder name ${basename(skill)}`);
  if (manifest.name !== name) fail(skill, "manifest name must match frontmatter name");

  const description = frontmatter.description;
  if (typeof description !== "string" || !description) fail(skill, "frontmatter requires a non-empty string description");
  if (description.startsWith("[TODO:") || description.includes("<") || description.includes(">")) fail(skill, "description contains a placeholder or angle bracket");
  if (description.length > 1024) fail(skill, "description must not exceed 1024 characters");

  validateSkillTools(skill, manifest, allMarkdown, contractTools);
  skillManifests.push([skill, manifest]);

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

validateWriteToolOwnership(skillManifests, contract);
console.log("Skill write-tool ownership: valid");
