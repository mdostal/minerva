import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  __setMulticaRunnerForTest,
  extractAnsweredConsusDecision,
  fileAllStoriesToMultica,
  resumeAnsweredConsusDecision,
  resumeFromConsusAnswer,
} from "./consus-resume.ts";
import type { CompletedEpic } from "./output-emitter.ts";

const epic = {
  epic_id: "routing",
  epic_yaml: "name: routing\n",
  stories: [
    { id: "story-1", content: "id: story-1\ntitle: Build answered decision resume\n" },
    { id: "story-2", content: "id: story-2\ntitle: File completed stories\n" },
  ],
} as CompletedEpic;

test("resumeFromConsusAnswer resumes a waiting run and files stories after completion", async () => {
  const submitted: any[] = [];
  let status = "waiting_on_human";
  const filedCalls: any[] = [];

  const result = await resumeFromConsusAnswer(
    {
      run_id: "run-1",
      question_id: "q-1",
      channel: "human",
      answer: "Ship it as planned.",
      file_to_multica: true,
      parent_issue_id: "PAN-100",
      project: "project-1",
      target_repo: "mdostal/minerva",
    },
    {
      async submitAnswers(params) {
        submitted.push(params);
        status = "complete";
        return { result: {} };
      },
      getRunStatus() {
        return { status };
      },
      getOutput() {
        return { epic };
      },
      fileAllStoriesToMultica(parentIssueId, epics, opts) {
        filedCalls.push({ parentIssueId, epics, opts });
        return {
          filed: [{ story_id: "story-1", issue_id: "child-1", epic_id: "routing" }],
          errors: [],
        };
      },
    },
  );

  assert.deepEqual(submitted, [
    {
      run_id: "run-1",
      channel: "human",
      answers: [{ question_id: "q-1", answer: "Ship it as planned." }],
    },
  ]);
  assert.equal(result.status, "complete");
  assert.equal(result.resumed, true);
  assert.deepEqual(result.filed_stories, [{ story_id: "story-1", issue_id: "child-1", epic_id: "routing" }]);
  assert.equal(filedCalls[0].parentIssueId, "PAN-100");
  assert.deepEqual(filedCalls[0].opts, { project: "project-1", targetRepo: "mdostal/minerva" });
});

test("resumeFromConsusAnswer skips runs that are not awaiting a human answer", async () => {
  let submitCalled = false;
  const result = await resumeFromConsusAnswer(
    { run_id: "run-2", question_id: "q-1", channel: "human", answer: "yes" },
    {
      async submitAnswers() {
        submitCalled = true;
        return { result: {} };
      },
      getRunStatus() {
        return { status: "complete" };
      },
      getOutput() {
        return { epic };
      },
      fileAllStoriesToMultica() {
        throw new Error("should not file");
      },
    },
  );

  assert.equal(submitCalled, false);
  assert.equal(result.resumed, false);
  assert.equal(result.reason, "run is complete, not waiting_on_human or awaiting-consus");
});

test("resumeFromConsusAnswer resumes a run awaiting Consus", async () => {
  const submitted: any[] = [];
  let status = "awaiting-consus";

  const result = await resumeFromConsusAnswer(
    { run_id: "run-3", question_id: "q-1", channel: "agent", answer: "Use mdostal/minerva." },
    {
      async submitAnswers(params) {
        submitted.push(params);
        status = "waiting_on_human";
        return { result: {} };
      },
      getRunStatus() {
        return { status };
      },
      getOutput() {
        return { epic };
      },
      fileAllStoriesToMultica() {
        throw new Error("should not file");
      },
    },
  );

  assert.deepEqual(submitted, [
    {
      run_id: "run-3",
      channel: "agent",
      answers: [{ question_id: "q-1", answer: "Use mdostal/minerva." }],
    },
  ]);
  assert.equal(result.status, "waiting_on_human");
  assert.equal(result.resumed, true);
});

test("fileAllStoriesToMultica creates todo child issues without assigning them and stamps target_repo", () => {
  const calls: string[][] = [];
  const descriptions: string[] = [];
  const previous = __setMulticaRunnerForTest((args) => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "create") {
      const descFile = args[args.indexOf("--description-file") + 1]!;
      descriptions.push(readFileSync(descFile, "utf8"));
      assert.equal(args.includes("--assignee"), false);
      assert.equal(args.includes("--assignee-id"), false);
      return { id: `child-${descriptions.length}` };
    }
    return {};
  });

  try {
    const result = fileAllStoriesToMultica("PAN-100", [epic], {
      project: "project-1",
      targetRepo: "mdostal/minerva",
    });

    assert.deepEqual(result.filed, [
      { story_id: "story-1", issue_id: "child-1", epic_id: "routing" },
      { story_id: "story-2", issue_id: "child-2", epic_id: "routing" },
    ]);
    assert.deepEqual(result.errors, []);
    const firstDescription = descriptions[0];
    const firstCall = calls[0];
    const metadataCall = calls[1];
    assert.ok(firstDescription);
    assert.ok(firstCall);
    assert.ok(metadataCall);
    assert.match(firstDescription, /target_repo: mdostal\/minerva/);
    assert.deepEqual(firstCall.slice(0, 4), ["issue", "create", "--parent", "PAN-100"]);
    assert.ok(firstCall.includes("--status"));
    assert.equal(firstCall[firstCall.indexOf("--status") + 1], "todo");
    assert.equal(firstCall[firstCall.indexOf("--project") + 1], "project-1");
    assert.deepEqual(metadataCall.slice(0, 4), ["issue", "metadata", "set", "child-1"]);
  } finally {
    __setMulticaRunnerForTest(previous);
  }
});

test("extractAnsweredConsusDecision reads the latest human thread answer for an awaiting run item", () => {
  const extracted = extractAnsweredConsusDecision({
    id: "decision-1",
    type: "survey",
    decision_payload: {
      kind: "minerva_run_question",
      run_id: "run-1",
      question_id: "q-1",
      channel: "human",
      ticket_id: "PAN-100",
      target_repo: "mdostal/minerva",
    },
    threads: {
      "q-1": [
        { role: "agent", text: "Can I proceed?" },
        { role: "human", text: "Yes, file the decomposed stories." },
      ],
    },
  });

  assert.deepEqual(extracted, {
    run_id: "run-1",
    question_id: "q-1",
    channel: "human",
    answer: "Yes, file the decomposed stories.",
    parent_issue_id: "PAN-100",
    project: undefined,
    target_repo: "mdostal/minerva",
  });
});

test("resumeAnsweredConsusDecision composes extraction with resume+filing", async () => {
  let status = "waiting_on_human";
  const result = await resumeAnsweredConsusDecision(
    {
      file_to_multica: true,
      item: {
        decision_payload: {
          kind: "minerva_run_question",
          run_id: "run-1",
          question_id: "q-1",
          channel: "human",
          parent_issue_id: "PAN-100",
        },
        answers: { "q-1": { value: "approved" } },
      },
    },
    {
      async submitAnswers(params) {
        assert.deepEqual(params.answers, [{ question_id: "q-1", answer: "approved" }]);
        status = "complete";
        return { result: {} };
      },
      getRunStatus() {
        return { status };
      },
      getOutput() {
        return { epic };
      },
      fileAllStoriesToMultica(parentIssueId) {
        assert.equal(parentIssueId, "PAN-100");
        return { filed: [{ story_id: "story-1", issue_id: "child-1", epic_id: "routing" }], errors: [] };
      },
    },
  );

  assert.equal(result.resumed, true);
  assert.equal(result.status, "complete");
  assert.equal(result.filed_stories.length, 1);
});
