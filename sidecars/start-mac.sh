#!/usr/bin/env bash
# Start the MAC sidecar's FastAPI service (the only thing Forge's CAD mode
# needs running). Mirrors MAC's README: `python -m multi_agent_cad.web`,
# which binds 0.0.0.0:8000 by default (override with MAC_WEB_HOST/MAC_WEB_PORT).
#
#   FORGE_CAD_* env vars in packages/server/.env must point at the same port.
set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/multi-agent-cad"
cd "$SIDECAR_DIR"

if [ -x ".venv/bin/python" ]; then
  PY="$PWD/.venv/bin/python"          # documented pip fallback path
elif [ "${CONDA_PREFIX:-}" != "" ] && [ -x "$CONDA_PREFIX/bin/python" ]; then
  PY="$CONDA_PREFIX/bin/python"       # conda env, already activated
else
  PY="${PYTHON_BIN:-python3}"         # whatever is on PATH
fi

# MAC reads DASHSCOPE_API_KEY for any OpenAI-compatible provider (the name is
# historical). Forge passes its own provider key per request too, so this is
# only needed when you drive the MAC UI or CLI directly.
#
# MAC's server binds 0.0.0.0 by default and *executes the Python the pipeline
# generates*. Forge only ever talks to it over loopback, so default to that and
# keep the box off the LAN. Override with MAC_WEB_HOST if you know why you want
# the opposite.
export MAC_WEB_HOST="${MAC_WEB_HOST:-127.0.0.1}"
export MAC_WEB_PORT="${MAC_WEB_PORT:-8000}"

echo "MAC sidecar on http://$MAC_WEB_HOST:$MAC_WEB_PORT (Forge: FORGE_CAD_MAC_URL)"
exec "$PY" -m multi_agent_cad.web
