#!/bin/sh
# Full local verification: guard tests, every Node test, profile validation, build and drift check.
# Run from the repository root. Exit 0 only when everything passes.
set -u
status=0
python3 -I -m unittest discover -s core/guard -p 'test_*.py' || status=1
node --test core/checks/*.test.mjs core/profiles/*/checks/*.test.mjs build.test.mjs workflows.test.mjs || status=1
node core/checks/check-profiles.mjs core/profiles || status=1
node build.mjs all && node build.mjs all --check || status=1
node scripts/render-assets.mjs --check || status=1
if command -v mendcode >/dev/null 2>&1; then
  for package in dist/*/; do mendcode package check "$package" || status=1; done
else
  echo "verify.sh: mendcode not found; skipped the package check" >&2
fi
exit $status
