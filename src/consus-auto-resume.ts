// Consus auto-resume — the missing wire between a poll pass and an actual resume.
//
// pollConsusAnswers (consus-poller.ts) is deliberately read-only: it never calls submitAnswers or
// mutates run state itself (docs/architecture.md "No Autonomous Progress"). resumeFromConsusAnswer
// (consus-resume.ts) is the primitive that injects one answer into one parked run and drives it
// forward. Nothing before this module fed the former's output into the latter -- an external
// caller had to do that wiring by hand. pollAndResumeConsusAnswers below is that wiring, exposed
// as one more fresh-process-per-call method (AD-1 still holds: one pass in, one pass out, no
// loop, no daemon) so "poll, then resume whatever came back answered" is a single call.

import { pollConsusAnswers, type PolledAnswer, type PollError } from "./consus-poller.ts";
import { resumeFromConsusAnswer, type ResumeResult } from "./consus-resume.ts";

export interface ResumeAttemptError {
  run_id: string;
  question_id: string;
  error: string;
}

export interface PollAndResumeResult extends Record<string, unknown> {
  polled: number;
  resumed: ResumeResult[];
  poll_errors: PollError[];
  resume_errors: ResumeAttemptError[];
}

export interface PollAndResumeDeps {
  pollConsusAnswers: typeof pollConsusAnswers;
  resumeFromConsusAnswer: typeof resumeFromConsusAnswer;
}

const realDeps: PollAndResumeDeps = { pollConsusAnswers, resumeFromConsusAnswer };

// One poll pass, then one resume attempt per question Consus reported answered -- in that order,
// sequentially (never in parallel: multiple answers can land against the same run's on-disk state
// in one pass, and resumeFromConsusAnswer/submitAnswers is not safe to race against itself).
// A poll-side error (Consus unreachable, unparseable answer, ...) never reaches resume; it passes
// through unchanged as poll_errors. A resume-side failure (thrown by submitAnswers, e.g. the run
// vanished between poll and resume) is caught per-question so one bad mapping can't stop the rest
// from resuming, and surfaces in resume_errors instead of failing the whole call.
export async function pollAndResumeConsusAnswers(
  rawParams: Record<string, unknown> = {},
  deps: PollAndResumeDeps = realDeps,
): Promise<PollAndResumeResult> {
  const pollResult = (await deps.pollConsusAnswers(rawParams)) as {
    polled: number;
    answered: PolledAnswer[];
    errors: PollError[];
  };

  const fileToMultica = rawParams.file_to_multica === true;
  const parentIssueId = typeof rawParams.parent_issue_id === "string" ? rawParams.parent_issue_id : undefined;
  const project = typeof rawParams.project === "string" ? rawParams.project : undefined;
  const targetRepo = typeof rawParams.target_repo === "string" ? rawParams.target_repo : undefined;

  const resumed: ResumeResult[] = [];
  const resumeErrors: ResumeAttemptError[] = [];

  for (const polledAnswer of pollResult.answered) {
    try {
      const result = await deps.resumeFromConsusAnswer({
        run_id: polledAnswer.run_id,
        question_id: polledAnswer.question_id,
        channel: polledAnswer.channel,
        answer: polledAnswer.answer,
        file_to_multica: fileToMultica,
        parent_issue_id: parentIssueId,
        project,
        target_repo: targetRepo,
      });
      resumed.push(result);
    } catch (e) {
      resumeErrors.push({
        run_id: polledAnswer.run_id,
        question_id: polledAnswer.question_id,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    polled: pollResult.polled,
    resumed,
    poll_errors: pollResult.errors,
    resume_errors: resumeErrors,
  };
}
