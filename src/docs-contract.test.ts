// docs-contract.test.ts -- PANT-907.
//
// mkdocs_docs/abi-reference.md is the contract agents read before driving Minerva. It drifted from
// the code once (a submitAnswers example that failed validation, methods listed that
// `capabilities` never returned), so this pins the two against each other: every method
// registered in dispatch.ts has a `## \`method\`` section in the reference and vice versa, and the
// documented submitAnswers example passes the handler's own answer validation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registeredMethods } from "./dispatch.ts";
import { isAnswerArray } from "./kickoff-engine.ts";

const ABI_REFERENCE = join(dirname(fileURLToPath(import.meta.url)), "..", "mkdocs_docs", "abi-reference.md");
const doc = readFileSync(ABI_REFERENCE, "utf8");

// Method sections are level-2 headings of the form "## `methodName`".
function documentedMethods(): string[] {
  return [...doc.matchAll(/^## `([A-Za-z]+)`\s*$/gm)].map((m) => m[1]!);
}

// The body of one method's section: from its heading up to the next level-2 heading.
function methodSection(method: string): string {
  const start = doc.indexOf(`## \`${method}\``);
  assert.notEqual(start, -1, `abi-reference.md has no section for ${method}`);
  const next = doc.indexOf("\n## ", start + 1);
  return next === -1 ? doc.slice(start) : doc.slice(start, next);
}

// The JSON request inside a section's `echo '<json>' | npx tsx bin/minerva.ts` example.
function exampleRequest(method: string): { method: string; params: Record<string, unknown> } {
  const match = methodSection(method).match(/echo '([\s\S]*?)'\s*(?:\\\s*)?\|\s*npx tsx bin\/minerva\.ts/);
  assert.ok(match, `abi-reference.md's ${method} section has no \`echo '...' | npx tsx bin/minerva.ts\` example`);
  return JSON.parse(match[1]!);
}

test("every dispatch.ts method is documented in abi-reference.md", () => {
  const documented = new Set(documentedMethods());
  const missing = registeredMethods().filter((m) => !documented.has(m));
  assert.deepEqual(missing, [], `methods registered in dispatch.ts but not documented: ${missing.join(", ")}`);
});

test("every method documented in abi-reference.md is registered in dispatch.ts", () => {
  const registered = new Set(registeredMethods());
  const extra = documentedMethods().filter((m) => !registered.has(m));
  assert.deepEqual(extra, [], `methods documented but not registered in dispatch.ts: ${extra.join(", ")}`);
});

test("the documented submitAnswers example passes isAnswerArray", () => {
  const req = exampleRequest("submitAnswers");
  assert.equal(req.method, "submitAnswers");
  assert.ok(
    isAnswerArray(req.params.answers),
    `documented answers ${JSON.stringify(req.params.answers)} fail isAnswerArray`,
  );
  assert.ok((req.params.answers as unknown[]).length > 0, "documented answers array is empty");
});
