use pqsa_channel::{SchemeId4, SchemeId5};
use pqsa_conformance::{Outcome, load, run_channel_vector, run_vector};
use pqsa_per_payment::SchemeId2;
use pqsa_s3_core::StealthScheme;
use pqsa_s3_per_payment::SchemeId3;
use serde_json::Value;

#[test]
fn pinned_upstream_vectors_execute_schemes_2_4_5() {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pqsa-vectors");
    let vectors = load(&directory).expect("fixture checksums match their pinned manifest");
    let mut executed = 0;
    let mut skipped = 0;
    for vector in &vectors {
        for outcome in [
            run_vector::<SchemeId2>(vector),
            run_channel_vector::<SchemeId4>(vector),
            run_channel_vector::<SchemeId5>(vector),
        ] {
            match outcome {
                Outcome::Pass => executed += 1,
                Outcome::NotApplicable => skipped += 1,
                Outcome::Fail {
                    field,
                    expected,
                    got,
                } => panic!(
                    "{}: field `{field}`\n  expected {expected}\n  got      {got}",
                    vector.id
                ),
            }
        }
    }
    assert_eq!(
        executed, 40,
        "golden executed count changed ({skipped} cases were not applicable)"
    );
}

#[test]
fn scheme3_public_v3_09_keygen_matches_its_fixture() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/pqsa-s3-vectors/section-2_9.json");
    let doc: Value = serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
    let row = &doc["vectors"]["V3-09"];
    let seed = hex::decode(row["given"]["keygen_seed"].as_str().unwrap()).unwrap();
    let expected = hex::decode(row["expect"]["meta_address"].as_str().unwrap()).unwrap();
    let (meta, _, _) = SchemeId3::keygen(&seed).expect("V3-09 seed is well-formed");
    assert_eq!(SchemeId3::meta_to_bytes(&meta), expected);
    assert_eq!(expected.len(), 1_250);
}
