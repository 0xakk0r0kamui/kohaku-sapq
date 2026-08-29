#![cfg(target_arch = "wasm32")]

use pqsa_channel::{SchemeId4, SchemeId5};
use pqsa_conformance::{Outcome, Vector, run_channel_vector, run_vector};
use pqsa_per_payment::SchemeId2;
use serde_json::Value;
use sha2::{Digest, Sha256};
use wasm_bindgen_test::wasm_bindgen_test;

const MANIFEST: &[u8] =
    include_bytes!("../../pq-stealth/tests/fixtures/pqsa-vectors/manifest.json");
const FILES: &[(&str, &[u8])] = &[
    (
        "section-1.json",
        include_bytes!("../../pq-stealth/tests/fixtures/pqsa-vectors/section-1.json"),
    ),
    (
        "section-2.json",
        include_bytes!("../../pq-stealth/tests/fixtures/pqsa-vectors/section-2.json"),
    ),
    (
        "section-2_9.json",
        include_bytes!("../../pq-stealth/tests/fixtures/pqsa-vectors/section-2_9.json"),
    ),
    (
        "section-3.json",
        include_bytes!("../../pq-stealth/tests/fixtures/pqsa-vectors/section-3.json"),
    ),
    (
        "section-3_12.json",
        include_bytes!("../../pq-stealth/tests/fixtures/pqsa-vectors/section-3_12.json"),
    ),
    (
        "section-5.json",
        include_bytes!("../../pq-stealth/tests/fixtures/pqsa-vectors/section-5.json"),
    ),
];

/// The same pinned vector rows execute inside `wasm32-unknown-unknown`, not merely in native
/// Rust. This integration target is dev-only, so `pqsa-conformance` never enters the shipped WASM.
#[wasm_bindgen_test]
fn pinned_upstream_vectors_execute_schemes_2_4_5_in_wasm() {
    let vectors = embedded_vectors().expect("embedded manifest and vectors are consistent");
    let mut executed = 0;
    for vector in &vectors {
        for outcome in [
            run_vector::<SchemeId2>(vector),
            run_channel_vector::<SchemeId4>(vector),
            run_channel_vector::<SchemeId5>(vector),
        ] {
            match outcome {
                Outcome::Pass => executed += 1,
                Outcome::NotApplicable => {}
                Outcome::Fail {
                    field,
                    expected,
                    got,
                } => panic!(
                    "{}: field `{field}`\n expected {expected}\n got {got}",
                    vector.id
                ),
            }
        }
    }
    assert_eq!(executed, 40, "WASM golden executed count changed");
}

fn embedded_vectors() -> Result<Vec<Vector>, String> {
    let manifest: Value = serde_json::from_slice(MANIFEST).map_err(|error| error.to_string())?;
    let manifest_files = manifest
        .get("files")
        .and_then(Value::as_object)
        .ok_or("manifest has no files object")?;
    let mut output = Vec::new();
    for &(name, raw) in FILES {
        let expected = manifest_files
            .get(name)
            .and_then(|entry| entry.get("sha256"))
            .and_then(Value::as_str)
            .ok_or_else(|| format!("{name}: missing manifest checksum"))?;
        let actual = hex::encode(Sha256::digest(raw));
        if actual != expected {
            return Err(format!("{name}: checksum mismatch"));
        }
        let body: Value = serde_json::from_slice(raw).map_err(|error| error.to_string())?;
        let rows = body
            .get("vectors")
            .and_then(Value::as_object)
            .ok_or_else(|| format!("{name}: no vectors object"))?;
        for (id, row) in rows {
            if let Some(marker) = row.get("not_generatable") {
                if marker
                    .as_str()
                    .is_none_or(|reason| reason.trim().is_empty())
                    || row.get("expect").is_some()
                {
                    return Err(format!("{id}: malformed not_generatable row"));
                }
                continue;
            }
            output.push(Vector {
                id: id.clone(),
                scheme_id: scheme_id(id),
                input: flatten(row.get("given")),
                expect: flatten(row.get("expect")),
                numbers: flatten_numbers(row.get("given")),
                expect_numbers: flatten_numbers(row.get("expect")),
                wrong: flatten(row.get("wrong")),
            });
        }
    }
    output.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(output)
}

fn scheme_id(id: &str) -> u64 {
    match id.split('-').next().unwrap_or("") {
        "V1" | "V2" | "V6" => 2,
        "V3" => 3,
        "V4" => 4,
        "V5" => 5,
        _ => 0,
    }
}

fn flatten(value: Option<&Value>) -> Vec<(String, String)> {
    let mut output = Vec::new();
    let Some(object) = value.and_then(Value::as_object) else {
        return output;
    };
    for (key, value) in object {
        match value {
            Value::String(string) => output.push((key.clone(), string.clone())),
            Value::Array(items) => {
                for (index, item) in items.iter().enumerate() {
                    if let Some(string) = item.as_str() {
                        output.push((format!("{key}.{index}"), string.to_owned()));
                    }
                }
            }
            Value::Object(inner) => {
                for (subkey, item) in inner {
                    if let Some(string) = item.as_str() {
                        output.push((format!("{key}.{subkey}"), string.to_owned()));
                    }
                }
            }
            _ => {}
        }
    }
    output
}

fn flatten_numbers(value: Option<&Value>) -> Vec<(String, Vec<u64>)> {
    let mut output = Vec::new();
    let Some(object) = value.and_then(Value::as_object) else {
        return output;
    };
    for (key, value) in object {
        match value {
            Value::Array(items) => {
                let numbers: Vec<u64> = items.iter().filter_map(Value::as_u64).collect();
                if !numbers.is_empty() {
                    output.push((key.clone(), numbers));
                }
            }
            Value::Number(number) => {
                if let Some(number) = number.as_u64() {
                    output.push((key.clone(), vec![number]));
                }
            }
            Value::Object(inner) => {
                for (subkey, item) in inner {
                    if let Some(number) = item.as_u64() {
                        output.push((format!("{key}.{subkey}"), vec![number]));
                    }
                }
            }
            _ => {}
        }
    }
    output
}
