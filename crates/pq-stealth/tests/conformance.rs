use pqsa_channel::{SchemeId4, SchemeId5};
use pqsa_conformance::{Outcome, load, run_channel_vector, run_vector};
use pqsa_per_payment::{SchemeId2, SchemeId3};

#[test]
fn pinned_upstream_vectors_execute_the_golden_48_cases() {
    let directory =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/pqsa-vectors");
    let vectors = load(&directory).expect("fixture checksums match their pinned manifest");
    let mut executed = 0;
    let mut skipped = 0;
    for vector in &vectors {
        for outcome in [
            run_vector::<SchemeId2>(vector),
            run_vector::<SchemeId3>(vector),
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
        executed, 48,
        "golden executed count changed ({skipped} cases were not applicable)"
    );
}
