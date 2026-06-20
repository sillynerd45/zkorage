# zkorage prover worker image — v5 GPU (risc0 5.0.0-rc.1, Blackwell sm_120).
# Self-contained: the NINE CANONICAL CUDA host binaries (each embeds its deterministic guest ELF) + the
# poll loop. Unlike the 3.0.5 CPU worker, the CUDA host bins do the FULL pipeline (STARK + Groth16
# shrink-wrap) IN-PROCESS ON GPU — so there is NO sibling groth16 docker container, NO docker socket, and
# NO r0vm. The bins only dynamically need libcuda.so.1 (the WSL2 driver lib), which `--gpus all` +
# nvidia-container-toolkit injects from /usr/lib/wsl/lib; risc0 statically links the CUDA runtime.
#
# The host bins MUST be the v5 canonical (Docker-ELF) ones or the worker emits a non-canonical image_id
# and proofs are rejected on-chain (ImageMismatch). v5 image_ids: claim 973c9831 / identity a5198a5a /
# compliance 54d5921c / payroll 2c9cc61b / accredited 26d74373 / dataroom_seal 8f24842d /
# membership 9550a12e / docauth e4f4a356 / solvency d0a2f137.
#
# Build context must contain: this Dockerfile (as Dockerfile), worker.sh, and the 9 CUDA host bins.
# RUN with GPU:  docker run -d --restart unless-stopped --gpus all \
#                  -v $HOME/.risc0:/root/.risc0:ro --dns 1.1.1.1 \
#                  -e VM_URL=https://prover.wazowsky.id -e WORKER_TOKEN=... \
#                  --name zkorage-worker-gpu zkorage-worker-gpu
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl jq libssl3 \
    && rm -rf /var/lib/apt/lists/*
COPY host /prover/target/release/host
COPY host_identity /prover/target/release/host_identity
COPY host_compliance /prover/target/release/host_compliance
COPY host_payroll /prover/target/release/host_payroll
COPY host_accredited /prover/target/release/host_accredited
COPY host_dataroom_seal /prover/target/release/host_dataroom_seal
COPY host_membership /prover/target/release/host_membership
COPY host_docauth /prover/target/release/host_docauth
COPY host_solvency /prover/target/release/host_solvency
COPY worker.sh /worker.sh
RUN sed -i 's/\r$//' /worker.sh \
    && chmod +x /worker.sh \
    /prover/target/release/host /prover/target/release/host_identity \
    /prover/target/release/host_compliance /prover/target/release/host_payroll \
    /prover/target/release/host_accredited /prover/target/release/host_dataroom_seal \
    /prover/target/release/host_membership /prover/target/release/host_docauth \
    /prover/target/release/host_solvency
ENV PROVER_DIR=/prover HOST_BIN=/prover/target/release/host \
    HOST_IDENTITY_BIN=/prover/target/release/host_identity \
    HOST_COMPLIANCE_BIN=/prover/target/release/host_compliance \
    HOST_PAYROLL_BIN=/prover/target/release/host_payroll \
    HOST_ACCREDITED_BIN=/prover/target/release/host_accredited \
    HOST_DATAROOM_SEAL_BIN=/prover/target/release/host_dataroom_seal \
    HOST_MEMBERSHIP_BIN=/prover/target/release/host_membership \
    HOST_DOCAUTH_BIN=/prover/target/release/host_docauth \
    HOST_SOLVENCY_BIN=/prover/target/release/host_solvency
ENTRYPOINT ["/worker.sh"]
