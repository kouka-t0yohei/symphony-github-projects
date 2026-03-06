import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WorkflowParseError,
  WorkflowValidationError,
  loadWorkflowFile,
  parseWorkflowMarkdown,
} from "./loader.js";

test("parses front matter and trims prompt body", () => {
  const doc = parseWorkflowMarkdown(`---\nname: demo\ncount: 3\n---\n\n  hello prompt\n\n`);

  assert.deepEqual(doc.config, { name: "demo", count: 3 });
  assert.equal(doc.prompt_template, "hello prompt");
});

test("returns empty config when front matter is absent", () => {
  const doc = parseWorkflowMarkdown("\n\njust prompt\n\n");

  assert.deepEqual(doc.config, {});
  assert.equal(doc.prompt_template, "just prompt");
});

test("throws WorkflowParseError when front matter is malformed", () => {
  assert.throws(
    () => parseWorkflowMarkdown("---\nname: demo\nbody without closer"),
    WorkflowParseError,
  );
});

test("throws WorkflowValidationError when front matter is not an object", () => {
  assert.throws(
    () => parseWorkflowMarkdown("---\n- item\n---\ntext"),
    WorkflowValidationError,
  );
});

test("loadWorkflowFile reads explicit path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "workflow-loader-"));
  const filePath = join(dir, "WORKFLOW.md");
  await writeFile(filePath, "---\nname: from-file\n---\n\nbody\n", "utf8");

  const doc = await loadWorkflowFile(filePath);
  assert.deepEqual(doc.config, { name: "from-file" });
  assert.equal(doc.prompt_template, "body");
});
