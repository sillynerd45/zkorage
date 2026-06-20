#!/bin/bash
# Build the CANONICAL host WITHOUT cuda (for the VM CPU fallback), embedding the same 8 Docker .bin ->
# same image_ids. Separate CARGO_TARGET_DIR so the CUDA bins (worker) are preserved.
set -e
export PATH=$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export CARGO_HOME=$HOME/.cargo RUSTUP_HOME=$HOME/.rustup PROTOC=$HOME/.local/protoc/bin/protoc
export CARGO_TARGET_DIR=$HOME/zkorage-r5/target-cpu
M=$HOME/zkorage-r5/prover/methods
D=target/riscv32im-risc0-zkvm-elf/docker
export ZKORAGE_GUEST_ELF=$M/guest/$D/claim_predicate.bin
export ZKORAGE_IDENTITY_ELF=$M/guest-identity/$D/identity_predicate.bin
export ZKORAGE_COMPLIANCE_ELF=$M/guest-compliance/$D/compliance_predicate.bin
export ZKORAGE_PAYROLL_ELF=$M/guest-payroll/$D/payroll_predicate.bin
export ZKORAGE_ACCREDITED_ELF=$M/guest-accredited/$D/accredited_predicate.bin
export ZKORAGE_DATAROOM_SEAL_ELF=$M/guest-dataroom-seal/$D/dataroom_seal_predicate.bin
export ZKORAGE_MEMBERSHIP_ELF=$M/guest-membership/$D/membership_predicate.bin
export ZKORAGE_DOCAUTH_ELF=$M/guest-docauth/$D/docauth_predicate.bin
export ZKORAGE_SOLVENCY_ELF=$M/guest-solvency/$D/solvency_predicate.bin
cd $HOME/zkorage-r5/prover
echo "=== build non-cuda canonical host ==="
cargo build --release -p host 2>&1 | tail -3
echo "=== CPU prove smoke (host demo, in-process CPU groth16) ==="
cd $CARGO_TARGET_DIR/release
ZKORAGE_OUT=/tmp/cpu_bundle.json ./host >/tmp/cpu_host.log 2>&1 && echo "CPU PROVE OK" || { echo "CPU PROVE FAIL"; tail -5 /tmp/cpu_host.log; }
grep -oE 'image_id"?: ?"?[0-9a-f]{64}' /tmp/cpu_bundle.json 2>/dev/null | head -1
