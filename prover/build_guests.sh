#!/bin/bash
# Docker-build the 7 remaining canonical guests at risc0 5.0.0-rc.1, one at a time, recording image_ids.
export PATH=$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export CARGO_HOME=$HOME/.cargo RUSTUP_HOME=$HOME/.rustup
ROOT=~/zkorage-r5/prover/methods
SUM=~/zkorage-r5/guest_image_ids.txt
: > "$SUM"
for g in guest-identity guest-compliance guest-payroll guest-accredited guest-dataroom-seal guest-membership guest-docauth guest-solvency; do
  echo "===== building $g $(date +%T) ====="
  cd "$ROOT/$g" || { echo "$g: NO DIR" >> "$SUM"; continue; }
  if cargo risczero build > "/tmp/build_$g.log" 2>&1; then
    ID=$(grep -oE "ImageID: [0-9a-f]{64}" "/tmp/build_$g.log" | tail -1 | awk '{print $2}')
    echo "$g $ID" | tee -a "$SUM"
  else
    echo "$g BUILD_FAILED" | tee -a "$SUM"
    tail -8 "/tmp/build_$g.log"
  fi
done
echo "===== ALL DONE $(date +%T) ====="
echo "=== SUMMARY ==="
cat "$SUM"
