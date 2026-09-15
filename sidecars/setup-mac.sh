#!/usr/bin/env bash
# One-time setup for the MAC (Multi-Agent CAD) sidecar that Forge's CAD mode
# talks to. Nothing here is invented: every step below is copied from the
# installation section of MAC's own README
# (https://github.com/Pan-Chera/Multi-Agent-CAD), including the documented
# pip fallback for machines without conda.
#
# Forge does NOT auto-install this. Treat the sidecar like Ollama: an optional
# local service you start yourself, which Forge then connects to.
#
# Usage:
#   bash sidecars/setup-mac.sh            # clone (if needed) + install deps
#   bash sidecars/start-mac.sh            # start the HTTP service on :8000
#
# Requires: git, and either conda/mamba/micromamba (recommended) or Python 3.11
# (the documented pure-pip fallback).
set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/multi-agent-cad"
REPO_URL="https://github.com/Pan-Chera/Multi-Agent-CAD"

# ---------------------------------------------------------------------------
# 1. Clone the upstream repo into sidecars/multi-agent-cad (never packages/)
# ---------------------------------------------------------------------------
if [ ! -d "$SIDECAR_DIR/.git" ]; then
  echo "==> cloning $REPO_URL"
  git clone "$REPO_URL" "$SIDECAR_DIR"
else
  echo "==> sidecar already present at $SIDECAR_DIR"
fi
cd "$SIDECAR_DIR"

# ---------------------------------------------------------------------------
# 2. Install dependencies, exactly as MAC's README prescribes.
#
# Recommended path (conda) — MAC ships an environment.yml; aider-chat is left
# out of it because every aider-chat release on PyPI hard-pins numpy==1.26.4
# while build123d needs numpy>=2, so it is installed afterwards with --no-deps:
#
#   conda env create -f environment.yml
#   conda activate multi_agent_cad
#   pip install --no-deps "aider-chat==0.82.3"
#
# Documented fallback (no conda) — venv + install aider first, then
# force-upgrade numpy over aider's over-cautious pin:
#
#   python3.11 -m venv .venv && source .venv/bin/activate
#   pip install --upgrade pip
#   pip install "aider-chat==0.82.3"
#   pip install --no-deps --force-reinstall "numpy>=2,<2.3"
#   pip install "build123d>=0.8" "langgraph>=0.2,<0.3" ... (see README)
#   pip install --no-deps -e .
# ---------------------------------------------------------------------------
if command -v conda >/dev/null 2>&1; then
  echo "==> conda detected: MAC's recommended path (conda env create -f environment.yml)"
  conda env create -f environment.yml || echo "   (env may already exist — continuing)"
  echo
  echo "==> finish with:"
  echo "    conda activate multi_agent_cad"
  echo "    pip install --no-deps 'aider-chat==0.82.3'"
  echo "    pip install -e '.[web]'"
  PIP="pip"
else
  echo "==> conda not found: MAC's documented pip fallback (.venv, Python 3.11)"
  PYTHON_BIN="${PYTHON_BIN:-}"
  if [ -z "$PYTHON_BIN" ]; then
    for candidate in python3.11 python3 python; do
      if command -v "$candidate" >/dev/null 2>&1 \
        && "$candidate" -c 'import sys; sys.exit(0 if sys.version_info[:2] == (3, 11) else 1)' 2>/dev/null; then
        PYTHON_BIN="$candidate"; break
      fi
    done
  fi
  if [ -z "$PYTHON_BIN" ]; then
    echo "!! MAC requires Python 3.11 for the pure-pip path (MAC 3.11 pin); install it or use conda." >&2
    exit 1
  fi
  "$PYTHON_BIN" -m venv .venv
  # shellcheck disable=SC1091
  source .venv/bin/activate
  PIP="$PWD/.venv/bin/pip"
  "$PIP" install --upgrade pip
  "$PIP" install "aider-chat==0.82.3"
  "$PIP" install --no-deps --force-reinstall "numpy>=2,<2.3"
  "$PIP" install \
    "build123d>=0.8" "langgraph>=0.2,<0.3" "langgraph-checkpoint>=2.0,<3.0" \
    "pydantic>=2.5" "openai>=1.20.0" "anthropic>=0.30" \
    "trimesh>=4.0" "rtree>=1.1" "scipy>=1.10" "scikit-learn>=1.3" \
    "fastapi>=0.110" "uvicorn[standard]>=0.27" "ipython>=8.15" "pytest>=7.4"
  "$PIP" install --no-deps -e .
fi

# ---------------------------------------------------------------------------
# 3. Web extras (FastAPI + uvicorn) so `python -m multi_agent_cad.web` works.
# ---------------------------------------------------------------------------
"$PIP" install -e ".[web]"

echo
echo "==> sidecar ready."
echo "    LLM endpoint + key are configured in multi_agent_cad/config.py (DS_BASE_URL)"
echo "    or overridden per request by Forge. Start the service with:"
echo
echo "        bash sidecars/start-mac.sh"
