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

function fail(skill, message) {
  throw new Error(`${skill}: ${message}`);
}

for (const skill of skills) {
  const content = readFileSync(join(projectRoot, skill, "SKILL.md"), "utf8");
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
