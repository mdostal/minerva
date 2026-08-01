#!/bin/bash
# model-tier-and-statelessness.sh — spike harness for
# .pHive/epics/forked-driver-integration/stories/spike-stateless-model-tier.yaml
#
# Answers two empirical sub-questions against a LOCAL plugin-hive-fork checkout (never the
# marketplace install, never waiting on PR #341 to merge upstream):
#
#   (a) Can a fresh (non---resume) claude -p/--bg invocation correctly continue a headless run
#       from on-disk state alone, or does it need session continuity?
#   (b) What model tier reliably follows the headless-routing instruction, for both kickoff
#       (simple, linear) and design (topic+round-scoped, more complex)?
#
# Not a node:test file -- this is empirical spike work per the story's own instruction. Prints
# PASS/FAIL-style lines for each assertion so results are greppable, and leaves the raw scratch
# workspaces on disk (reported at the end) for manual inspection if a result is surprising.

set -uo pipefail

FORK=/Users/dostal/Documents/work/dostal/code/plugin-hive-fork
SCRATCH_ROOT=$(mktemp -d /tmp/minerva-spike-XXXXXX)
RESULTS_FILE="$SCRATCH_ROOT/results.txt"
: > "$RESULTS_FILE"

record() {
  echo "$1" | tee -a "$RESULTS_FILE"
}

new_scratch() {
  local name="$1"
  local dir="$SCRATCH_ROOT/$name"
  mkdir -p "$dir"
  (cd "$dir" && git init -q . && git commit -q --allow-empty -m init)
  echo "$dir"
}

envelope_count() {
  local dir="$1"
  find "$dir/.pHive/questions" -maxdepth 1 -name "*.yaml" 2>/dev/null | wc -l | tr -d ' '
}

# ---------------------------------------------------------------------------
record "=== Test B: model-tier x kickoff (haiku vs sonnet) ==="
# ---------------------------------------------------------------------------
for MODEL in claude-haiku-4-5-20251001 claude-sonnet-4-5; do
  DIR=$(new_scratch "kickoff-$MODEL")
  OUT=$(cd "$DIR" && env -u CLAUDE_CODE_OAUTH_TOKEN HIVE_HEADLESS=1 claude -p --model "$MODEL" \
    --permission-mode bypassPermissions --plugin-dir "$FORK" --output-format json \
    "/plugin-hive:kickoff a tiny spike test project" 2>&1)
  IS_ERROR=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).is_error)}catch(e){console.log('PARSE_ERROR')}})" 2>/dev/null)
  COUNT=$(envelope_count "$DIR")
  if [ "$COUNT" -gt 0 ]; then
    record "PASS: $MODEL wrote $COUNT envelope(s) for kickoff -- headless-routing compliant (is_error=$IS_ERROR)"
  else
    record "FAIL: $MODEL wrote 0 envelopes for kickoff -- did not follow headless-routing instruction (is_error=$IS_ERROR)"
  fi
done

# ---------------------------------------------------------------------------
record ""
record "=== Test C: model-tier x design (more complex, topic+round-scoped) ==="
# ---------------------------------------------------------------------------
for MODEL in claude-sonnet-4-5 claude-opus-4-5; do
  DIR=$(new_scratch "design-$MODEL")
  # design requires an existing project-profile / kickoff-complete state in real usage; for this
  # spike we only need to observe whether ANY headless-routed envelope gets written under
  # .pHive/questions/ with a topic+round-scoped phase id when /design is invoked headlessly,
  # not a full realistic design session.
  OUT=$(cd "$DIR" && env -u CLAUDE_CODE_OAUTH_TOKEN HIVE_HEADLESS=1 claude -p --model "$MODEL" \
    --permission-mode bypassPermissions --plugin-dir "$FORK" --output-format json \
    "/plugin-hive:design a tiny settings screen for spike-test-topic" 2>&1)
  IS_ERROR=$(echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).is_error)}catch(e){console.log('PARSE_ERROR')}})" 2>/dev/null)
  COUNT=$(envelope_count "$DIR")
  if [ "$COUNT" -gt 0 ]; then
    TOPIC_SCOPED=$(grep -l "touchpoint" "$DIR"/.pHive/questions/*.yaml 2>/dev/null | wc -l | tr -d ' ')
    record "PASS: $MODEL wrote $COUNT envelope(s) for design, $TOPIC_SCOPED topic-scoped (is_error=$IS_ERROR)"
  else
    record "FAIL: $MODEL wrote 0 envelopes for design -- did not follow headless-routing instruction, or design didn't reach a touchpoint this turn (is_error=$IS_ERROR); result snippet:"
    echo "$OUT" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log((JSON.parse(d).result||'').slice(0,400))}catch(e){console.log(d.slice(0,400))}})" 2>/dev/null | tee -a "$RESULTS_FILE"
  fi
done

# ---------------------------------------------------------------------------
record ""
record "=== Test A: stateless-turn feasibility (fresh, non-resumed invocation continues from on-disk state) ==="
# ---------------------------------------------------------------------------
DIR=$(new_scratch "stateless-kickoff")
OUT1=$(cd "$DIR" && env -u CLAUDE_CODE_OAUTH_TOKEN HIVE_HEADLESS=1 claude -p --model claude-sonnet-4-5 \
  --permission-mode bypassPermissions --plugin-dir "$FORK" --output-format json \
  "/plugin-hive:kickoff a tiny spike test project" 2>&1)
SID1=$(echo "$OUT1" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).session_id||'')}catch(e){console.log('')}})" 2>/dev/null)
COUNT1=$(envelope_count "$DIR")
if [ "$COUNT1" -eq 0 ]; then
  record "FAIL: stateless-turn test setup -- initial kickoff wrote 0 envelopes, cannot proceed with this sub-test"
else
  # Answer the first envelope directly on disk.
  FIRST_ENVELOPE=$(find "$DIR/.pHive/questions" -maxdepth 1 -name "*.yaml" | sort | head -1)
  python3 -c "
import yaml
p = '$FIRST_ENVELOPE'
d = yaml.safe_load(open(p))
for q in d['questions']:
    if q.get('required'):
        q['answer'] = q['options'][0] if q.get('options') else 'no'
d['status'] = 'answered'
yaml.safe_dump(d, open(p, 'w'), sort_keys=False)
"
  # Genuinely fresh invocation: NO --resume, no session_id passed at all -- deliberately a brand
  # new claude -p call, testing whether on-disk state (workspace + answered envelope) alone is
  # sufficient continuity, exactly as ForkedHiveDriver would need it to be if stateless.
  OUT2=$(cd "$DIR" && env -u CLAUDE_CODE_OAUTH_TOKEN HIVE_HEADLESS=1 claude -p --model claude-sonnet-4-5 \
    --permission-mode bypassPermissions --plugin-dir "$FORK" --output-format json \
    "/plugin-hive:kickoff a tiny spike test project" 2>&1)
  SID2=$(echo "$OUT2" | node -e "let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{try{console.log(JSON.parse(d).session_id||'')}catch(e){console.log('')}})" 2>/dev/null)
  ENVELOPE_STILL_PRESENT=$([ -f "$FIRST_ENVELOPE" ] && echo yes || echo no)
  COUNT2=$(envelope_count "$DIR")
  record "context: fresh session_id=$SID2 (original was $SID1 -- expected to differ; a fresh -p call always gets a new session_id regardless of statelessness)"
  record "context: first envelope still present after fresh invocation: $ENVELOPE_STILL_PRESENT (expected: no, if the fresh call correctly consumed it)"
  record "context: envelope count after fresh invocation: $COUNT2 (expected: >0 if kickoff progressed to a new phase)"
  if [ "$ENVELOPE_STILL_PRESENT" = "no" ] && [ "$COUNT2" -gt 0 ]; then
    record "PASS: a genuinely fresh (non---resume) claude -p invocation correctly consumed the answered envelope and progressed to a new phase, using on-disk state alone -- stateless turns are FEASIBLE"
  else
    record "FAIL: a fresh invocation did not correctly progress from on-disk state alone -- statelessness is NOT feasible without session continuity; ForkedHiveDriver likely needs --resume like SpawnDriver/SubagentDriver"
  fi
fi

echo ""
echo "Full results: $RESULTS_FILE"
echo "Scratch workspaces (left on disk for inspection): $SCRATCH_ROOT"
