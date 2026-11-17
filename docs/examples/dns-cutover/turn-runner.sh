#!/bin/sh
# turn-runner.sh -- the worked example in docs/integrations.md. A plain POSIX shell program that
# stands where Minerva normally spawns `claude -p`: it is handed one turn's arguments, does the
# tool's work in the run workspace (its cwd), and prints one JSON TurnResult on stdout.
#
# The tool: before cutting a domain over, check that its TXT record has propagated. If it has not,
# the run cannot finish yet, so it asks to be re-checked later and parks. Once it has, it writes
# the cutover plan where the descriptor's completion_detector looks for it.
set -eu

DIG="${DIG:-dig}"
RESOLVER="${DNS_CUTOVER_RESOLVER:-1.1.1.1}"
STATE=.dns-cutover

session=""
resumed=no
prompt=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --session-id) session="$2"; shift 2 ;;
    --resume) session="$2"; resumed=yes; shift 2 ;;
    --model|--output-format|--permission-mode|--json-schema) shift 2 ;;
    *) prompt="$1"; shift ;;
  esac
done

# Fresh turn: the prompt is the descriptor's invoke with {idea} filled in ("dns-cutover NAME VALUE").
# Save the target in the tool's state dir; a resumed turn reads it back from disk.
if [ "$resumed" = no ]; then
  set -- $prompt
  printf '%s\n%s\n' "$2" "$3" > "$STATE/target"
fi
name=$(sed -n 1p "$STATE/target")
want=$(sed -n 2p "$STATE/target")

# question is the one string the caller sees; an empty question means "nothing to ask".
emit() {
  printf '{"session_id":"%s","is_error":false,"stop_reason":"end_turn","result":"{\\"question\\":\\"%s\\",\\"suggested_channel\\":\\"human\\",\\"confidence\\":1,\\"reason\\":\\"%s\\"}"}\n' \
    "$session" "$1" "$2"
}

if ! "$DIG" +short TXT "$name" "@$RESOLVER" | grep -qF "$want"; then
  emit "TXT $name does not show $want from $RESOLVER yet. Reply recheck when you want it checked again." \
    "check cannot finish yet"
  exit 0
fi

plan="$STATE/plans/cutover-$name"
mkdir -p "$plan/stories"
printf 'id: cutover-%s\ntitle: Cut %s over\nstatus: approved\n' "$name" "$name" > "$plan/epic.yaml"
printf 'id: lower-ttl\ntitle: Lower the TTL on %s to 300s\n' "$name" > "$plan/stories/01-lower-ttl.yaml"
printf 'id: switch-records\ntitle: Point %s at the new host\n' "$name" > "$plan/stories/02-switch-records.yaml"
emit "" "TXT record visible; cutover plan written"
