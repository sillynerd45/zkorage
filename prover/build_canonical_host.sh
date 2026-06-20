#!/bin/bash
# Build the CANONICAL host (cuda) embedding all 8 Docker-built guest .bin (risc0 5.0.0-rc.1).
# build.rs canonical mode (all ZKORAGE_*_ELF set) -> embed_prebuilt (no embed_methods deadlock).
set -e
export PATH=/usr/local/cuda-12.9/bin:$HOME/.cargo/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export CARGO_HOME=$HOME/.cargo RUSTUP_HOME=$HOME/.rustup PROTOC=$HOME/.local/protoc/bin/protoc
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
cargo build --release -p host --features cuda 2>&1 | grep -iE "embedded prebuilt|image_id|error|warning: unused|Finished|Compiling host"
echo "CANON_HOST_EXIT=${PIPESTATUS[0]}"
ls -la target/release/host target/release/host_docauth target/release/host_solvency 2>/dev/null
