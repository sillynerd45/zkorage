# zkorage prover worker image.
# Self-contained: the eight CANONICAL host binaries (each embeds its deterministic guest ELF) + r0vm +
# the poll loop. The host bins MUST be the canonical (Docker-built-ELF) ones — copy them from a box that
# built with ZKORAGE_GUEST_ELF/ZKORAGE_IDENTITY_ELF/ZKORAGE_COMPLIANCE_ELF/ZKORAGE_PAYROLL_ELF/
# ZKORAGE_ACCREDITED_ELF/ZKORAGE_DATAROOM_SEAL_ELF/ZKORAGE_MEMBERSHIP_ELF/ZKORAGE_DOCAUTH_ELF — or the
# worker emits a non-canonical image_id and its proofs are rejected on-chain (ImageMismatch). The Groth16
# wrap (stark_to_snark) runs the risc0 groth16 docker image as a SIBLING container via the mounted docker
# socket; /tmp is shared so the wrap's temp paths line up.
#
# Build context must contain: Dockerfile, worker.sh, host, host_identity, host_compliance, host_payroll,
# host_accredited, host_dataroom_seal, host_membership, host_docauth, r0vm.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq docker.io libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY host /prover/target/release/host
COPY host_identity /prover/target/release/host_identity
COPY host_compliance /prover/target/release/host_compliance
COPY host_payroll /prover/target/release/host_payroll
COPY host_accredited /prover/target/release/host_accredited
COPY host_dataroom_seal /prover/target/release/host_dataroom_seal
COPY host_membership /prover/target/release/host_membership
COPY host_docauth /prover/target/release/host_docauth
COPY r0vm /usr/local/bin/r0vm
COPY worker.sh /worker.sh
# Strip CR so a Windows (CRLF) checkout of worker.sh doesn't break the Linux shebang (`bash\r`).
RUN sed -i 's/\r$//' /worker.sh \
    && chmod +x /worker.sh /usr/local/bin/r0vm \
    /prover/target/release/host /prover/target/release/host_identity \
    /prover/target/release/host_compliance /prover/target/release/host_payroll \
    /prover/target/release/host_accredited /prover/target/release/host_dataroom_seal \
    /prover/target/release/host_membership /prover/target/release/host_docauth
ENV PROVER_DIR=/prover HOST_BIN=/prover/target/release/host \
    HOST_IDENTITY_BIN=/prover/target/release/host_identity \
    HOST_COMPLIANCE_BIN=/prover/target/release/host_compliance \
    HOST_PAYROLL_BIN=/prover/target/release/host_payroll \
    HOST_ACCREDITED_BIN=/prover/target/release/host_accredited \
    HOST_DATAROOM_SEAL_BIN=/prover/target/release/host_dataroom_seal \
    HOST_MEMBERSHIP_BIN=/prover/target/release/host_membership \
    HOST_DOCAUTH_BIN=/prover/target/release/host_docauth
ENTRYPOINT ["/worker.sh"]
