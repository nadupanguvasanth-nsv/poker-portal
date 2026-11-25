#!/bin/sh
# Every test, in order. Pass a number to run the lot more than once.
runs=${1:-1}
i=1
while [ $i -le $runs ]; do
  echo "=== PASS $i ==="
  fail=0
  for f in test-formats.js test-portal.js test-guard.js test-restart.js test-stall.js test-fresh.js test-baddata.js test-oldfile.js bombtest.js decktest.js tiertest.js starttest.js pausetest.js buyintest.js staytest.js pushtest.js orbittest.js paytest.js; do
    if ! timeout 300 node "$f" >/tmp/sbt.out 2>&1; then
      echo "FAIL $f"; grep -E "AssertionError|Error:|PROBLEMS" /tmp/sbt.out | head -4; fail=1
    fi
  done
  for s in 1 2 3 4 5 6 7 8; do
    out=$(timeout 300 node test-game.js $s 15 2>&1 | grep -E "^SEED|CHIPS")
    case "$out" in *clean*) ;; *) echo "FAIL game seed $s"; printf '%s\n' "$out"; fail=1;; esac
  done
  # Each of these says what it found and leaves 0 if it found nothing wrong. Go by that, not by
  # the words: matching the wording meant a new test, or a reworded message, read as a failure
  # while a real failure with familiar wording would have read as a pass.
  for f in uitest.js replaytest.js runittest.js layouttest.js fxtest.js seattest.js showtest.js discotest.js badgetest.js tourneytest.js timertest.js cardsizetest.js livetest.js historytest.js skytest.js rulestest.js bettest.js chiptest.js felttest.js saytest.js accounttest.js bookstest.js; do
    if ! timeout 600 node "$f" >/tmp/sbt.out 2>&1; then
      echo "FAIL $f"; tail -8 /tmp/sbt.out; fail=1
    fi
  done
  if [ $fail -eq 0 ]; then echo "pass $i: everything green"; else bad=1; fi
  i=$((i+1))
done
# Leave non-zero if any pass found anything, so a run can be trusted without reading it.
exit ${bad:-0}
