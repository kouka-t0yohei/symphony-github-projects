import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type WorkflowConfig = Record<string, unknown>;

export interface WorkflowDocument {
  config: WorkflowConfig;
  prompt_template: string;
}

export class WorkflowLoadError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkflowLoadError";
  }
}

export class WorkflowParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowParseError";
  }
}

export class WorkflowValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowValidationError";
  }
}

export async function loadWorkflowFile(path?: string): Promise<WorkflowDocument> {
  const workflowPath = path ? resolve(path) : resolve(process.cwd(), "WORKFLOW.md");

  let raw: string;
  try {
    raw = await readFile(workflowPath, "utf8");
  } catch (error) {
    throw new WorkflowLoadError(`Failed to read WORKFLOW.md: ${workflowPath}`, { cause: error });
  }

  return parseWorkflowMarkdown(raw);
}

export function parseWorkflowMarkdown(input: string): WorkflowDocument {
  const normalized = input.replace(/\r\n/g, "\n");

  if (!normalized.startsWith("---\n")) {
    return {
      config: {},
      prompt_template: normalized.trim(),
    };
  }

  const closingIndex = normalized.indexOf("\n---\n", 4);
  if (closingIndex < 0) {
    throw new WorkflowParseError("Malformed front matter: missing closing delimiter");
  }

  const frontMatterText = normalized.slice(4, closingIndex).trim();
  const markdownBody = normalized.slice(closingIndex + 5);
  const config = parseYamlObject(frontMatterText);

  return {
    config,
    prompt_template: markdownBody.trim(),
  };
}

function parseYamlObject(text: string): WorkflowConfig {
  if (text.length === 0) {
    return {};
  }

  const result: WorkflowConfig = {};

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (trimmed.startsWith("-") || trimmed.startsWith("[") || trimmed.startsWith("{")) {
      throw new WorkflowValidationError("Front matter must be a YAML object");
    }

    const match = trimmed.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!match) {
      throw new WorkflowParseError(`Malformed front matter line: ${line}`);
    }

    const [, key, rawValue] = match;
    result[key] = parseScalar(rawValue);
  }

  return result;
}

function parseScalar(value: string): unknown {
  const v = value.trim();

  if (v === "") return "";
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);

  return v;
}
