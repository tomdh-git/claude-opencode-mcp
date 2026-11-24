#!/bin/bash
# Supervisor for the Kotlin opencode unit daemon: restart loop, never gives up (same contract as daemon-ts/ocd-run.sh).
# exit 0 = another ocd holds the port (stay idle); a run > 120 s resets the quick-crash counter; 5 quick crashes -> wait 60 s between tries.
# Build first:  ./gradlew installDist     (needs JDK 17+; JAVA_HOME below)
cd "${BASH_SOURCE%/*}" 2>/dev/null
export JAVA_HOME="${JAVA_HOME:-C:/Program Files/Eclipse Adoptium/jdk-17.0.21.10002-hotspot}"
OUT="${OCD_DIR:-C:/Users/Atomi/opencode-mcp-bridge}"
n=0
while true; do
  t0=$SECONDS
  MAXRUN=${MAXRUN:-4} build/install/ocd/bin/ocd.bat >>"$OUT/keeper-run.out" 2>>"$OUT/ocd.err"
  code=$?; dt=$((SECONDS - t0))
  if [ $code -eq 0 ]; then n=0; read -t 30 <> <(:) 2>/dev/null; continue; fi
  if [ $dt -gt 120 ]; then n=0; else n=$((n+1)); fi
  echo "OCD-KT EXITED (code $code after ${dt}s), quick-crash count $n" >>"$OUT/keeper-run.out"
  if [ $n -ge 5 ]; then read -t 60 <> <(:) 2>/dev/null; else read -t 1 <> <(:) 2>/dev/null; fi
done
