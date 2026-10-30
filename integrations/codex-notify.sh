#!/usr/bin/env bash
# codex-notify.sh — bridge OpenAI Codex CLI notify events to keyboard-heart.
#
# Install: in ~/.codex/config.toml add (absolute path!):
#   notify = ["/absolute/path/to/keyboard-heart/integrations/codex-notify.sh"]
#
# Codex invokes this program with a JSON payload as the last argument.
KB_HOST="${KB_HOST:-127.0.0.1}"; KB_PORT="${KB_PORT:-8791}"
post() { curl -s -X POST "http://$KB_HOST:$KB_PORT/fx/$1" >/dev/null 2>&1 || true; }

payload="${*: -1}"   # last argument = event JSON
case "$payload" in
  *agent-turn-complete*)  post success ;;
  *approval-requested*|*elicit*) post needInput ;;
  *) post notify ;;
esac
