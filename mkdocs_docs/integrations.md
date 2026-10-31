# Integrations

Minerva is a headless engine. It drives an interactive tool one turn at a time in an isolated git
workspace. When the tool needs an answer, Minerva parks the run on disk and exits. When the answer
arrives, possibly days later and from another process, it resumes the run from disk.

The tool is a parameter. [plugin-hive](https://firefly-events.github.io/plugin-hive/)'s
`kickoff` + `plan` is the batteries-included **default**: a `startRun` with no `tool` drives it,
exactly as Minerva always has. It is not a requirement. Minerva is **semi-agnostic**: the tool can
be anything that fits the shape on this page, and that shape still carries assumptions from
planning. It is not a general workflow engine. Section 2 lists those assumptions.

## 1. Default versus required

| | Default | Required |
| --- | --- | --- |
| The tool | plugin-hive `kickoff` + `plan` | A `tool` descriptor (section 2) |
| What runs a turn | `claude -p`, or whatever runtime Pantheon's route select names | An executable that accepts the turn arguments and prints a turn result (section 2) |
| Where answers come from | Whoever calls `submitAnswers`: a person, an agent, Pantheon's decision surface | A caller of `submitAnswers`. Minerva has no answering UI |
| Where the run lives | `~/.minerva/runs/<run_id>/` | Any local directory (`MINERVA_HOME`) |
| What a workspace is cut from | `~/repos/consus-seeds` (a greenfield idea), or `target_repo` | Any local git repo (`MINERVA_SEED_REPO`) |
| Pantheon, Consus, Auriga, Vulcan, Multica | Used when present | None of them. Section 3 runs with all of them absent |

## 2. The integration layer

An integration is two things: a **tool descriptor** that says how the tool is invoked and where it
leaves its output, and a **turn runner** that executes one turn. Minerva supplies the rest: the
workspace, the park, the resume and the ABI.

The definitions are the test suites, not this page. Where the page and a suite disagree, the
suite is right.

### The tool descriptor

`startRun`'s `tool` parameter. Omit it, or pass `"plugin-hive"`, for the default. Otherwise pass
an object. Minerva validates it strictly, freezes it onto the run record, and uses it for every
later turn of the run, so changing the default afterwards does not change a run in flight.

| Field | What it says |
| --- | --- |
| `id` | The tool's name. Recorded on the run as `tool_id` |
| `invoke` | The first turn's prompt. Every `{idea}` is replaced with the idea |
| `state_path` | Workspace-relative directory the tool keeps its state in. Minerva creates it |
| `completion_detector` | How Minerva sees that the run is finished. One kind exists: `epics-dir` |
| `question_source` | Where questions come from: `response` (the turn result) or `envelope-dir` (files on disk; plugin-hive with `MINERVA_DRIVER=forked`) |
| `base_branch` | Optional. Branch the workspace is cut from and the plan is pushed to |

Definition: `src/tool-descriptor.ts`, with `src/tool-descriptor.test.ts` as its suite. The field
reference with the plugin-hive values is in [ABI Reference](abi-reference.md) and `docs/abi.md`.

### The turn runner

Minerva runs a turn by spawning one executable in the workspace (its working directory). It
passes the Claude Code CLI's arguments:

```text
-p --model <model> --output-format json --permission-mode bypassPermissions
   (--session-id <id> | --resume <id>) [--json-schema <schema>] <prompt>
```

`--session-id` means a fresh turn; its prompt is the expanded `invoke`. `--resume` means a
continuation; its prompt carries the answer. The runner prints one JSON object on stdout:

```json
{"session_id": "<id>", "is_error": false, "result": "<classification JSON, as a string>"}
```

The classification is `{question, suggested_channel, confidence, reason}`. A non-empty `question`
parks the run on it. An empty one means there is nothing to ask.

By default the runner is `claude`, so `invoke` is a prompt and the tool is whatever skillset that
prompt reaches: another plugin's slash command, a different methodology, your own instructions.
The runner can also be any other program. Section 3 uses a POSIX shell script.

Definition: `ClaudeAdapter` in `src/driver.ts`. Two suites run real runners through
`bin/minerva.ts`: `tests/e2e/abi-smoke.test.ts` (a scripted planner) and
`tests/e2e/dns-cutover-example.test.ts` (section 3).

### The park and the resume

A run is parked when its status is `waiting_on_human`. The park is
`$MINERVA_HOME/runs/<run_id>/run.yaml` plus the workspace beside it. No process stays alive while
a run is parked, so any later process with the same `MINERVA_HOME` can resume it. The lifecycle
verbs an integration's caller uses are the ABI methods:

| Verb | Method |
| --- | --- |
| start | `startRun {idea, tool?}`. Runs the first turn and returns |
| read the park | `getRunStatus`, `getQuestions {channel}` |
| resume | `submitAnswers {channel, answers}`. The only call that moves a parked run |
| collect | `getOutput`, once the status is `complete` |
| give up | `abortRun`. Records cleanup, deletes nothing |

### What the descriptor does not abstract yet

Plainly, so nobody finds out by reading the source:

- **One park kind.** Minerva parks only on a question (`awaiting-answer` in Pantheon's terms). It
  has no time park and no signal park. A tool that has to wait for time passing says so in a
  question, as section 3 does, and the resume is a person or a scheduled caller answering it.
  Resuming without an answer is story p2-02 of epic `minerva-agnostic-async-lifecycle`, which is
  not done.
- **One output shape.** The only completion detector is `epics-dir`: a new `epic.yaml` with at
  least one story under the descriptor's `epics_dir`, in plugin-hive's nested
  (`<id>/epic.yaml` + `stories/`) or flat layout. `getOutput` returns that epic and its stories.
- **A custom runner works with the default driver only.** `MINERVA_DRIVER=subagent` needs
  `claude --bg`, and `forked` needs plugin-hive.
- **Choosing a runner that is not `claude`, `codex` or `opencode`** goes through the route-select
  override, `MINERVA_PANTHEON_ROUTE_SELECT_URL`. The variable's name is historical. A `data:` URL
  names the runner directly, with no network call (section 3). `MINERVA_FALLBACK_CLI` accepts
  only those three names.

### Pantheon's lifecycle contract

Pantheon defines the same lifecycle for every integration it hosts: the four park kinds, the
durable park record (`pantheon:park-record/v1`), the `park` and `resume` verbs, and the rules for
resuming exactly once. Its definition is a conformance suite:
`contracts/l1/interaction-lifecycle.contract.ts` in
[mdostal/pantheon-v2](https://github.com/mdostal/pantheon-v2), together with the contract
`contracts/l1/interaction-lifecycle.ts`. Its guide, `docs/integration-authoring.md`, works a linux
check that parks on `awaiting-time` through that contract.

**Minerva does not pass that suite yet.** Its run record is not a `pantheon:park-record/v1`, and
wiring Minerva into the suite is story p2-03, which is not done. Until it is, Minerva's own
contract is the descriptor and runner above. Pantheon's contract is what an integration hosted by
Pantheon implements.

## 3. Worked example: a check that cannot finish yet

Not plugin-hive and not an LLM. Before a domain is cut over, a plain shell tool checks with `dig`
that the domain's TXT record has propagated. If it has not, the run cannot finish, so it parks and
asks to be re-checked. Once it has, the tool writes a two-story cutover plan.

The files are `docs/examples/dns-cutover/tool.json` and
`docs/examples/dns-cutover/turn-runner.sh`. `tests/e2e/dns-cutover-example.test.ts` runs these
steps through `bin/minerva.ts` with a fake `dig`, and fails if the descriptor below stops matching
`tool.json`.

You need Node 20.19 or later, a checkout of this repo with `npm install` run, `dig`, and `jq`.
Run everything from the repo root.

### The descriptor

<!-- from: docs/examples/dns-cutover/tool.json -->
```json
{
  "id": "dns-cutover",
  "invoke": "dns-cutover {idea}",
  "state_path": ".dns-cutover",
  "completion_detector": { "kind": "epics-dir", "epics_dir": ".dns-cutover/plans", "worktree_roots": [] },
  "question_source": { "kind": "response" }
}
```

The idea is `<name> <expected TXT value>`. The runner reads it from the first turn's prompt,
saves it as `.dns-cutover/target`, and reads it back from disk on every later turn. The plan goes
in `.dns-cutover/plans/`, which is where the detector looks. Questions come back in the turn
result. Read `turn-runner.sh` alongside this; it is about 50 lines.

### Setup

A workspace is cut from a git repo, so make an empty one. Then point Minerva at the runner:

```bash
git init -q -b dev /tmp/dns-seed && git -C /tmp/dns-seed commit -q --allow-empty -m init

export MINERVA_HOME=/tmp/dns-minerva
export MINERVA_SEED_REPO=/tmp/dns-seed
export MINERVA_PANTHEON_ROUTE_SELECT_URL="data:application/json,{\"cli\":\"$PWD/docs/examples/dns-cutover/turn-runner.sh\",\"model\":\"none\"}"
minerva() { npx tsx bin/minerva.ts; }
```

Nothing else is configured: no Pantheon URL, no token, no model credential. Each call prints
`minerva: operator token unavailable (no core-api URL configured)` on stderr. That line is
expected without Pantheon, and the call still succeeds.

### Start: the check cannot finish

Use a name whose TXT record does not show the value yet:

```bash
jq -nc --slurpfile t docs/examples/dns-cutover/tool.json \
  '{method:"startRun",params:{idea:"_cutover.example.com v=cutover-2026",tool:$t[0],defaults:{mode:"off"}}}' | minerva
# {"result":{"run_id":"<run_id>"}}
RUN=<run_id>
```

`defaults: {mode: "off"}` keeps any plan defaults on your machine from answering the question for
you. The turn ran, the check failed, and the process exited. The run is parked:

```bash
echo "{\"method\":\"getRunStatus\",\"params\":{\"run_id\":\"$RUN\"}}" | minerva
# {"result":{"status":"waiting_on_human","metrics":{"turns":1,"escalations":1,...}}}

echo "{\"method\":\"getQuestions\",\"params\":{\"run_id\":\"$RUN\",\"channel\":\"human\"}}" | minerva
# {"result":{"questions":[{"id":"q-1","text":"TXT _cutover.example.com does not show
#   v=cutover-2026 from 1.1.1.1 yet. Reply recheck when you want it checked again.",...}]}}
```

The park is on disk: `$MINERVA_HOME/runs/$RUN/run.yaml`, and the tool's own state in
`$MINERVA_HOME/runs/$RUN/workspace/.dns-cutover/target`.

### Wait, then resume from disk

Ten minutes or two days later, from any shell with the same `MINERVA_HOME`, answer the question:

```bash
echo "{\"method\":\"submitAnswers\",\"params\":{\"run_id\":\"$RUN\",\"channel\":\"human\",\"answers\":[{\"question_id\":\"q-1\",\"answer\":\"recheck\"}]}}" | minerva
```

The runner is resumed (`--resume`), reads its target from disk and runs `dig` again. If the record
still is not visible, the run parks on a new question, `q-2`, and you answer that one later. Once
it is visible, the turn writes the plan and the run completes:

```bash
echo "{\"method\":\"getRunStatus\",\"params\":{\"run_id\":\"$RUN\"}}" | minerva
# {"result":{"status":"complete",...}}

echo "{\"method\":\"getOutput\",\"params\":{\"run_id\":\"$RUN\"}}" | minerva | jq '.result.epic | {epic_id, stories: [.stories[].id]}'
# {"epic_id": "cutover-_cutover.example.com", "stories": ["01-lower-ttl", "02-switch-records"]}
```

To try the finished path against real DNS, use a name and value that already resolve, for example
`google.com v=spf1`. Set `DNS_CUTOVER_RESOLVER` to change the resolver.

### What this does and does not show

It shows a non-plugin-hive tool, driven without any Pantheon service, parking because its work
cannot finish and resuming from disk in a later process. It does **not** show a time park. "Check
again later" is a question here, and something has to answer it: a person, or a cron job that
calls `submitAnswers`. A real `awaiting-time` park that wakes itself is in Pantheon's guide
(section 2), not in Minerva.

## 4. Contributing an integration

An integration does not go in this repo. It lives in its own.

1. **Its own repo** holds the descriptor (a JSON file like `tool.json`) and, if the runner is not
   an existing agent CLI, the runner.
2. **The gate is a test that drives it through `bin/minerva.ts`.** Copy
   `tests/e2e/dns-cutover-example.test.ts`: start with the descriptor, park, answer, complete,
   `getOutput`. Pin the Minerva commit it runs against. If the integration is also hosted by
   Pantheon, its test file also runs Pantheon's conformance suite,
   `runInteractionLifecycleContract`, from a pinned `mdostal/pantheon-v2` commit (section 2).
3. **To be selectable, a host passes the descriptor.** Any caller selects an integration by
   passing its descriptor object as `startRun`'s `tool`. There is no plugin loading, and nothing to
   install into Minerva. The only built-in id is `plugin-hive`. Adding another built-in id means a
   PR to this repo's `dev` that adds it to `BUILTIN_TOOLS` in `src/tool-descriptor.ts`, gated by
   `npm run ci`.
4. **Pantheon** selects integrations through its runner registry (PANT-706), which is not built
   yet. Its guide, `docs/integration-authoring.md` section 6, gives the route for now: the
   integration's own repo, plus a descriptor PR to `mdostal/pantheon-v2` `dev` gated by the
   conformance suite. List the integration's capabilities in that PR (park kinds, resume methods,
   whether it can push a signal, what backs its park record) so the descriptor can be added when
   the registry exists.

Changes to Minerva itself follow [Contributing](contributing.md).

## 5. What Minerva deliberately does not do

These are decisions, not gaps:

- **No UI.** Minerva never shows a question to a person. Something else asks and calls
  `submitAnswers`.
- **No daemon.** Every call is a fresh process. There is no server, port or background worker.
  `minerva mcp` is the same methods over stdio, for as long as its caller keeps it open.
- **No autonomous progress.** Nothing advances a run between calls, and a parked run waits with
  no timeout and no default answer (AD-5 in `docs/architecture.md`). Within a call, Minerva only
  answers questions that the caller's own plan defaults cover.
- **No deletion of its own workspaces.** Completing or aborting a run appends to a cleanup ledger
  and emits `cleanup_needed`. Deleting is another system's job (AD-4).
- **No dependency on Consus, Auriga, Vulcan or Multica.** They are callers and neighbours inside
  Pantheon. Section 3 runs with none of them. Filing stories to Multica is opt-in
  (`minerva-plan --file-to-multica`), and `~/repos/consus-seeds` is only the default seed path.
