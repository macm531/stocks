#!/bin/zsh
# Local manual rescan (GitHub Actions does this automatically every weekday).
cd "$(dirname "$0")" && .venv/bin/python scan.py > scan.log 2>&1 && tail -1 scan.log
