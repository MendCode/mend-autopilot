#!/bin/sh
# Local verification. Run from the repository root; exit 0 only when everything that ran passes.
#
#   scripts/verify.sh              full when code changed since HEAD, quick when only docs did
#   scripts/verify.sh --full       always the full suite
#   scripts/verify.sh --quick      only the build, drift, images and package checks
#   scripts/verify.sh --since REV  decide from the changes since REV instead of HEAD
#   scripts/verify.sh --dry-run    print the mode it would run and stop
#
# Quick skips the guard tests, the Node test suites and the profile validation. It is chosen
# automatically only when every changed path is documentation or a README image (see DOCS_ONLY).
set -u
mode=auto
since=HEAD
dry=0
while [ $# -gt 0 ]; do
  case "$1" in
    --full) mode=full ;;
    --quick) mode=quick ;;
    --dry-run) dry=1 ;;
    --since) shift; since=${1:?verify.sh: --since needs a revision} ;;
    *) echo "verify.sh: unknown argument $1" >&2; exit 64 ;;
  esac
  shift
done

# Paths that no test reads: changing only these cannot break a test.
DOCS_ONLY='^(README\.md|LICENSE|NOTICE|\.gitignore|docs/.*|adapters/[^/]+/MAPPING\.md|scripts/render-assets\.mjs)$'

if [ "$mode" = auto ]; then
  changed=$( { git diff --name-only "$since" --; git ls-files --others --exclude-standard; } | sort -u)
  if [ -n "$changed" ] && ! printf '%s\n' "$changed" | grep -Ev "$DOCS_ONLY" | grep -q .; then
    mode=quick
  else
    mode=full
  fi
  echo "verify.sh: $mode (changes since $since)"
fi
[ "$dry" = 1 ] && { echo "verify.sh: would run $mode"; exit 0; }

status=0
if [ "$mode" = full ]; then
  python3 -I -m unittest discover -s core/guard -p 'test_*.py' || status=1
  node --test core/checks/*.test.mjs core/profiles/*/checks/*.test.mjs build.test.mjs workflows.test.mjs || status=1
  node core/checks/check-profiles.mjs core/profiles || status=1
fi
node build.mjs all && node build.mjs all --check || status=1
node scripts/render-assets.mjs --check || status=1
if command -v mendcode >/dev/null 2>&1; then
  for package in dist/*/; do mendcode package check "$package" || status=1; done
else
  echo "verify.sh: mendcode not found; skipped the package check" >&2
fi
exit $status
