#!/bin/bash
# Run on the VM: prove a demo claim with the v5 host, print image_id + selector from the bundle.
cd ~/Project/Stellar/zkorage/prover/target/release
ZKORAGE_OUT=/tmp/vmb.json ./host >/tmp/vmhost.log 2>&1
echo "EXIT=$?"
if [ -f /tmp/vmb.json ]; then
  echo "image_id: $(grep -oE '[0-9a-f]{64}' /tmp/vmb.json | head -1)"
  echo "selector: $(grep -oE '"seal": "[0-9a-f]{8}' /tmp/vmb.json | grep -oE '[0-9a-f]{8}$')"
else
  echo "NO BUNDLE; host log tail:"; tail -4 /tmp/vmhost.log
fi
