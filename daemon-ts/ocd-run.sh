#!/bin/bash
# L4 supervisor for the opencode unit daemon: restart loop, never gives up. Bash builtins only (started without Git's usr/bin on PATH).
# exit 0 = another ocd holds the port (stay idle); exit 4 = the old keeper still runs (stay idle); a run > 120 s resets the quick-crash counter; 5 quick crashes -> wait 60 s between tries.
cd "${BASH_SOURCE%/*}" 2>/dev/null
n=0
while true; do
  t0=$SECONDS
  INITCOOL=${INITCOOL:-0} MAXRUN=${MAXRUN:-4} bun run ocd/ocd.ts >>keeper-run.out 2>>ocd.err
  code=$?; dt=$((SECONDS - t0))
  if [ $code -eq 0 ] || [ $code -eq 4 ]; then n=0; read -t 30 <> <(:) 2>/dev/null; continue; fi
  if [ $dt -gt 120 ]; then n=0; else n=$((n+1)); fi
  echo "OCD EXITED (code $code after ${dt}s), quick-crash count $n" >>keeper-run.out
  if [ $n -ge 5 ]; then read -t 60 <> <(:) 2>/dev/null; else read -t 1 <> <(:) 2>/dev/null; fi
done
