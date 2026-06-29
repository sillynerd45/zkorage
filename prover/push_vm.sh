#!/bin/bash
# Push the 8 v5 NON-cuda canonical host bins to the VM CPU fallback (so it emits v5 image_ids).
set -e
KEY="${KEY:-$HOME/.ssh/id_vm}"
VM="${VM:-user@vm-host}"
DEST="${DEST:-/home/user/zkorage/prover/target/release}"
SRC=$HOME/zkorage-r5/target-cpu/release
echo "=== 8 cpu bins ==="; ls -la "$SRC"/host "$SRC"/host_identity "$SRC"/host_compliance "$SRC"/host_payroll "$SRC"/host_accredited "$SRC"/host_dataroom_seal "$SRC"/host_membership "$SRC"/host_docauth | awk '{print $5, $NF}'
echo "=== backup VM 3.0.5 bins ==="
ssh -i "$KEY" -o StrictHostKeyChecking=no "$VM" "mkdir -p $DEST/../release.v3.bak && cp -n $DEST/host* $DEST/../release.v3.bak/ 2>/dev/null; echo backed-up"
echo "=== scp v5 cpu bins -> VM ==="
scp -i "$KEY" -o StrictHostKeyChecking=no \
  "$SRC"/host "$SRC"/host_identity "$SRC"/host_compliance "$SRC"/host_payroll \
  "$SRC"/host_accredited "$SRC"/host_dataroom_seal "$SRC"/host_membership "$SRC"/host_docauth \
  "$VM:$DEST/"
echo "=== verify on VM (chmod + presence) ==="
ssh -i "$KEY" -o StrictHostKeyChecking=no "$VM" "chmod +x $DEST/host*; ls -la $DEST/host $DEST/host_docauth | awk '{print \$5, \$NF}'"
echo "PUSH_DONE"
