import { test } from "node:test";
import assert from "node:assert/strict";
import { pollAndResumeConsusAnswers } from "./consus-auto-resume.ts";
import type { ResumeResult } from "./consus-resume.ts";

test("pollAndResumeConsusAnswers feeds every polled answer into resumeFromConsusAnswer and resumes it", async () => {
  const resumeCalls: any[] = [];

  const result = await pollAndResumeConsusAnswers(
    { run_id: "run-1" },
    {
      async pollConsusAnswers(params) {
        assert.deepEqual(params, { run_id: "run-1" });
        return {
          polled: 1,
          answered: [
            {
              run_id: "run-1",
              question_id: "q-1",
              consus_question_id: "consus-q-1",
              channel: "human",
              answer: "Use mdostal/minerva.",
            },
          ],
          errors: [],
        };
      },
      async resumeFromConsusAnswer(params): Promise<ResumeResult> {
        resumeCalls.push(params);
        return {
          run_id: "run-1",
          status: "in_progress",
          resumed: true,
          filed_stories: [],
          file_errors: [],
        };
      },
    },
  );

  assert.deepEqual(resumeCalls, [
    {
      run_id: "run-1",
      question_id: "q-1",
      channel: "human",
      answer: "Use mdostal/minerva.",
      file_to_multica: false,
      parent_issue_id: undefined,
      project: undefined,
      target_repo: undefined,
    },
  ]);
  assert.equal(result.polled, 1);
  assert.deepEqual(result.resumed, [
    { run_id: "run-1", status: "in_progress", resumed: true, filed_stories: [], file_errors: [] },
  ]);
  assert.deepEqual(result.poll_errors, []);
  assert.deepEqual(result.resume_errors, []);
});

test("pollAndResumeConsusAnswers resumes every answered mapping across multiple runs, in order", async () => {
  const resumeCalls: string[] = [];

  const result = await pollAndResumeConsusAnswers(
    {},
    {
      async pollConsusAnswers() {
        return {
          polled: 2,
          answered: [
            { run_id: "run-a", question_id: "q-1", consus_question_id: "c-1", channel: "human", answer: "A" },
            { run_id: "run-b", question_id: "q-1", consus_question_id: "c-2", channel: "agent", answer: "B" },
          ],
          errors: [],
        };
      },
      async resumeFromConsusAnswer(params: any): Promise<ResumeResult> {
        resumeCalls.push(params.run_id);
        return { run_id: params.run_id, status: "complete", resumed: true, filed_stories: [], file_errors: [] };
      },
    },
  );

  assert.deepEqual(resumeCalls, ["run-a", "run-b"]);
  assert.equal(result.resumed.length, 2);
});

test("pollAndResumeConsusAnswers forwards file_to_multica/parent_issue_id/project/target_repo to every resume call", async () => {
  const resumeCalls: any[] = [];

  await pollAndResumeConsusAnswers(
    { file_to_multica: true, parent_issue_id: "PAN-100", project: "project-1", target_repo: "mdostal/minerva" },
    {
      async pollConsusAnswers() {
        return {
          polled: 1,
          answered: [{ run_id: "run-1", question_id: "q-1", consus_question_id: "c-1", channel: "human", answer: "ok" }],
          errors: [],
        };
      },
      async resumeFromConsusAnswer(params): Promise<ResumeResult> {
        resumeCalls.push(params);
        return { run_id: "run-1", status: "complete", resumed: true, filed_stories: [], file_errors: [] };
      },
    },
  );

  assert.equal(resumeCalls[0].file_to_multica, true);
  assert.equal(resumeCalls[0].parent_issue_id, "PAN-100");
  assert.equal(resumeCalls[0].project, "project-1");
  assert.equal(resumeCalls[0].target_repo, "mdostal/minerva");
});

test("pollAndResumeConsusAnswers passes poll_errors through untouched and never attempts to resume them", async () => {
  const result = await pollAndResumeConsusAnswers(
    {},
    {
      async pollConsusAnswers() {
        return {
          polled: 1,
          answered: [],
          errors: [{ run_id: "run-1", question_id: "q-1", consus_question_id: "c-1", error: "HTTP 500" }],
        };
      },
      async resumeFromConsusAnswer(): Promise<ResumeResult> {
        throw new Error("should not be called for a poll error");
      },
    },
  );

  assert.equal(result.polled, 1);
  assert.deepEqual(result.resumed, []);
  assert.deepEqual(result.poll_errors, [{ run_id: "run-1", question_id: "q-1", consus_question_id: "c-1", error: "HTTP 500" }]);
  assert.deepEqual(result.resume_errors, []);
});

test("pollAndResumeConsusAnswers records a resume-side failure without stopping the rest of the batch", async () => {
  const resumeCalls: string[] = [];

  const result = await pollAndResumeConsusAnswers(
    {},
    {
      async pollConsusAnswers() {
        return {
          polled: 2,
          answered: [
            { run_id: "run-a", question_id: "q-1", consus_question_id: "c-1", channel: "human", answer: "A" },
            { run_id: "run-b", question_id: "q-1", consus_question_id: "c-2", channel: "human", answer: "B" },
          ],
          errors: [],
        };
      },
      async resumeFromConsusAnswer(params: any): Promise<ResumeResult> {
        resumeCalls.push(params.run_id);
        if (params.run_id === "run-a") throw new Error("run vanished");
        return { run_id: params.run_id, status: "complete", resumed: true, filed_stories: [], file_errors: [] };
      },
    },
  );

  assert.deepEqual(resumeCalls, ["run-a", "run-b"]);
  assert.equal(result.resumed.length, 1);
  assert.equal(result.resumed[0]?.run_id, "run-b");
  assert.deepEqual(result.resume_errors, [{ run_id: "run-a", question_id: "q-1", error: "run vanished" }]);
});

test("pollAndResumeConsusAnswers is a no-op resume pass when nothing was answered", async () => {
  const result = await pollAndResumeConsusAnswers(
    {},
    {
      async pollConsusAnswers() {
        return { polled: 3, answered: [], errors: [] };
      },
      async resumeFromConsusAnswer(): Promise<ResumeResult> {
        throw new Error("should not be called");
      },
    },
  );

  assert.equal(result.polled, 3);
  assert.deepEqual(result.resumed, []);
  assert.deepEqual(result.poll_errors, []);
  assert.deepEqual(result.resume_errors, []);
});
