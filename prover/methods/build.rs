use std::{env, fs, path::Path};

// Guest embedding for the host. NINE guests live here:
//   * claim_predicate      (PoR / generic; also W8 revenue) -> CLAIM_PREDICATE_ELF / CLAIM_PREDICATE_ID
//   * identity_predicate    (KYC identity, W5)      -> IDENTITY_PREDICATE_ELF / IDENTITY_PREDICATE_ID
//   * compliance_predicate  (KYC ∧ not-sanctioned)  -> COMPLIANCE_PREDICATE_ELF / COMPLIANCE_PREDICATE_ID
//   * payroll_predicate     (proof-of-income, W7)   -> PAYROLL_PREDICATE_ELF / PAYROLL_PREDICATE_ID
//   * accredited_predicate  (accredited investor,W8)-> ACCREDITED_PREDICATE_ELF / ACCREDITED_PREDICATE_ID
//   * dataroom_seal_predicate (DR1 faithful seal)   -> DATAROOM_SEAL_PREDICATE_ELF / _ID
//   * membership_predicate  (DR2 anon eligibility)  -> MEMBERSHIP_PREDICATE_ELF / MEMBERSHIP_PREDICATE_ID
//   * docauth_predicate     (DR4 doc-authenticity)  -> DOCAUTH_PREDICATE_ELF / DOCAUTH_PREDICATE_ID
//   * solvency_predicate    (BP3 solvency-bonded)   -> SOLVENCY_PREDICATE_ELF / SOLVENCY_PREDICATE_ID
//
// Two modes:
//   * Default (no env)     -> risc0_build::embed_methods() (fast native build; per-machine image_ids).
//                             Builds ALL guests and generates ALL constant pairs.
//   * Canonical (env set)  -> embed PREBUILT, deterministic guest ELFs (from `cargo risczero build`)
//                             + their computed image_ids. This is the CANONICAL path: every prover
//                             box embeds the same .bin, so they emit byte-identical image_ids —
//                             required because the on-chain contracts pin `expected_image_id`.
//                             ALL NINE env vars must be set together (the single host crate compiles
//                             all bins, so all constant pairs must exist).
//
// Regenerate the canonical ELFs (Docker / reproducible):
//   (cd methods/guest            && cargo risczero build)  # -> .../docker/claim_predicate.bin
//   (cd methods/guest-identity   && cargo risczero build)  # -> .../docker/identity_predicate.bin
//   (cd methods/guest-compliance && cargo risczero build)  # -> .../docker/compliance_predicate.bin
//   (cd methods/guest-payroll    && cargo risczero build)  # -> .../docker/payroll_predicate.bin
//   (cd methods/guest-accredited && cargo risczero build)  # -> .../docker/accredited_predicate.bin
//   (cd methods/guest-dataroom-seal && cargo risczero build)# -> .../docker/dataroom_seal_predicate.bin
//   (cd methods/guest-membership && cargo risczero build)  # -> .../docker/membership_predicate.bin
//   (cd methods/guest-docauth    && cargo risczero build)  # -> .../docker/docauth_predicate.bin
//   (cd methods/guest-solvency   && cargo risczero build)  # -> .../docker/solvency_predicate.bin
// then build the host with ALL NINE:
//   ZKORAGE_GUEST_ELF=<…> ZKORAGE_IDENTITY_ELF=<…> ZKORAGE_COMPLIANCE_ELF=<…> ZKORAGE_PAYROLL_ELF=<…> \
//     ZKORAGE_ACCREDITED_ELF=<…> ZKORAGE_DATAROOM_SEAL_ELF=<…> ZKORAGE_MEMBERSHIP_ELF=<…> \
//     ZKORAGE_DOCAUTH_ELF=<…> ZKORAGE_SOLVENCY_ELF=<…> cargo build --release -p host
fn main() {
    let por = env::var("ZKORAGE_GUEST_ELF").ok();
    let identity = env::var("ZKORAGE_IDENTITY_ELF").ok();
    let compliance = env::var("ZKORAGE_COMPLIANCE_ELF").ok();
    let payroll = env::var("ZKORAGE_PAYROLL_ELF").ok();
    let accredited = env::var("ZKORAGE_ACCREDITED_ELF").ok();
    let dataroom_seal = env::var("ZKORAGE_DATAROOM_SEAL_ELF").ok();
    let membership = env::var("ZKORAGE_MEMBERSHIP_ELF").ok();
    let docauth = env::var("ZKORAGE_DOCAUTH_ELF").ok();
    let solvency = env::var("ZKORAGE_SOLVENCY_ELF").ok();

    if por.is_some()
        || identity.is_some()
        || compliance.is_some()
        || payroll.is_some()
        || accredited.is_some()
        || dataroom_seal.is_some()
        || membership.is_some()
        || docauth.is_some()
        || solvency.is_some()
    {
        // Canonical path — require ALL so every bin in the host crate gets correct image_ids.
        let por = por.expect("ZKORAGE_GUEST_ELF must be set alongside the other guest ELFs");
        let identity =
            identity.expect("ZKORAGE_IDENTITY_ELF must be set alongside the other guest ELFs");
        let compliance =
            compliance.expect("ZKORAGE_COMPLIANCE_ELF must be set alongside the other guest ELFs");
        let payroll =
            payroll.expect("ZKORAGE_PAYROLL_ELF must be set alongside the other guest ELFs");
        let accredited =
            accredited.expect("ZKORAGE_ACCREDITED_ELF must be set alongside the other guest ELFs");
        let dataroom_seal = dataroom_seal
            .expect("ZKORAGE_DATAROOM_SEAL_ELF must be set alongside the other guest ELFs");
        let membership =
            membership.expect("ZKORAGE_MEMBERSHIP_ELF must be set alongside the other guest ELFs");
        let docauth =
            docauth.expect("ZKORAGE_DOCAUTH_ELF must be set alongside the other guest ELFs");
        let solvency =
            solvency.expect("ZKORAGE_SOLVENCY_ELF must be set alongside the other guest ELFs");
        let out_dir = env::var("OUT_DIR").unwrap();

        let por_rs = embed_prebuilt(&out_dir, "claim_predicate", "CLAIM_PREDICATE", &por);
        let id_rs = embed_prebuilt(&out_dir, "identity_predicate", "IDENTITY_PREDICATE", &identity);
        let comp_rs =
            embed_prebuilt(&out_dir, "compliance_predicate", "COMPLIANCE_PREDICATE", &compliance);
        let pay_rs = embed_prebuilt(&out_dir, "payroll_predicate", "PAYROLL_PREDICATE", &payroll);
        let acc_rs =
            embed_prebuilt(&out_dir, "accredited_predicate", "ACCREDITED_PREDICATE", &accredited);
        let ds_rs = embed_prebuilt(
            &out_dir,
            "dataroom_seal_predicate",
            "DATAROOM_SEAL_PREDICATE",
            &dataroom_seal,
        );
        let mem_rs = embed_prebuilt(
            &out_dir,
            "membership_predicate",
            "MEMBERSHIP_PREDICATE",
            &membership,
        );
        let da_rs = embed_prebuilt(&out_dir, "docauth_predicate", "DOCAUTH_PREDICATE", &docauth);
        let sol_rs = embed_prebuilt(&out_dir, "solvency_predicate", "SOLVENCY_PREDICATE", &solvency);

        fs::write(
            Path::new(&out_dir).join("methods.rs"),
            format!("{por_rs}{id_rs}{comp_rs}{pay_rs}{acc_rs}{ds_rs}{mem_rs}{da_rs}{sol_rs}"),
        )
        .unwrap();
        println!("cargo:rerun-if-env-changed=ZKORAGE_GUEST_ELF");
        println!("cargo:rerun-if-env-changed=ZKORAGE_IDENTITY_ELF");
        println!("cargo:rerun-if-env-changed=ZKORAGE_COMPLIANCE_ELF");
        println!("cargo:rerun-if-env-changed=ZKORAGE_PAYROLL_ELF");
        println!("cargo:rerun-if-env-changed=ZKORAGE_ACCREDITED_ELF");
        println!("cargo:rerun-if-env-changed=ZKORAGE_DATAROOM_SEAL_ELF");
        println!("cargo:rerun-if-env-changed=ZKORAGE_MEMBERSHIP_ELF");
        println!("cargo:rerun-if-env-changed=ZKORAGE_DOCAUTH_ELF");
        println!("cargo:rerun-if-env-changed=ZKORAGE_SOLVENCY_ELF");
        println!("cargo:rerun-if-changed={por}");
        println!("cargo:rerun-if-changed={identity}");
        println!("cargo:rerun-if-changed={compliance}");
        println!("cargo:rerun-if-changed={payroll}");
        println!("cargo:rerun-if-changed={accredited}");
        println!("cargo:rerun-if-changed={dataroom_seal}");
        println!("cargo:rerun-if-changed={membership}");
        println!("cargo:rerun-if-changed={docauth}");
        println!("cargo:rerun-if-changed={solvency}");
    } else {
        risc0_build::embed_methods();
    }
}

/// Embed one prebuilt ELF + its image_id under `<CONST>_ELF` / `<CONST>_ID`, returning the Rust source.
fn embed_prebuilt(out_dir: &str, bin_name: &str, const_prefix: &str, elf_path: &str) -> String {
    let elf = fs::read(elf_path).unwrap_or_else(|e| panic!("read {elf_path}: {e}"));
    let id = risc0_binfmt::compute_image_id(&elf).expect("compute_image_id");
    let words = id.as_words();
    assert_eq!(words.len(), 8, "image id must be 8 u32 words");

    let elf_dest = Path::new(out_dir).join(format!("{bin_name}.bin"));
    fs::write(&elf_dest, &elf).unwrap();

    eprintln!("[methods] embedded prebuilt {bin_name}, image_id = {}", hex_words(words));
    format!(
        "pub const {const_prefix}_ELF: &[u8] = include_bytes!({:?});\n\
         pub const {const_prefix}_ID: [u32; 8] = {:?};\n",
        elf_dest, words
    )
}

fn hex_words(words: &[u32]) -> String {
    // image_id digest hex = each 32-bit word in little-endian byte order, concatenated.
    let mut s = String::with_capacity(64);
    for w in words {
        for b in w.to_le_bytes() {
            s.push_str(&format!("{:02x}", b));
        }
    }
    s
}
