//! Copied vectors must match the pinned git revision, plus V3-08 wire layout and V3-09 keygen.

use pqsa_core::StealthScheme;
use pqsa_per_payment::SchemeId3;
use serde_json::Value;
use sha2::{Digest, Sha256};

const MANIFEST: &[u8] = include_bytes!("fixtures/scheme3/manifest.json");
const SECTION_1: &[u8] = include_bytes!("fixtures/scheme3/section-1.json");
const SECTION_2_9: &[u8] = include_bytes!("fixtures/scheme3/section-2_9.json");

#[test]
fn fixtures_match_the_pinned_upstream_manifest() {
    let manifest: Value = serde_json::from_slice(MANIFEST).unwrap();
    for (name, bytes) in [
        ("section-1.json", SECTION_1),
        ("section-2_9.json", SECTION_2_9),
    ] {
        let expected = manifest["files"][name]["sha256"].as_str().unwrap();
        let actual = hex::encode(Sha256::digest(bytes));
        println!("{name} sha256 {actual}");
        assert_eq!(actual, expected, "{name}");
    }
}

#[test]
fn v3_09_keygen_matches_the_pinned_meta_address() {
    let section: Value = serde_json::from_slice(SECTION_2_9).unwrap();
    let vector = &section["vectors"]["V3-09"];
    let seed = hex::decode(vector["given"]["keygen_seed"].as_str().unwrap()).unwrap();
    let expected = hex::decode(vector["expect"]["meta_address"].as_str().unwrap()).unwrap();
    let (meta, _, _) = SchemeId3::keygen(&seed).unwrap();
    let actual = SchemeId3::meta_to_bytes(&meta);
    println!("V3-09 meta-address bytes {}", actual.len());
    assert_eq!(actual, expected);
}

#[test]
fn v3_08_announcement_matches_the_pinned_wire_format() {
    let section: Value = serde_json::from_slice(SECTION_2_9).unwrap();
    let vector = &section["vectors"]["V3-08"];
    let ephemeral_public_key = decode(&vector["expect"]["ephemeralPubKey"]);
    let metadata = decode(&vector["expect"]["metadata"]);
    let mut expected_metadata = decode(&vector["given"]["view_tag"]);
    expected_metadata.extend(decode(&vector["given"]["ct"]));
    let stealth_address = [0x11; 20];

    println!(
        "V3-08 ephemeral pubkey bytes {}",
        ephemeral_public_key.len()
    );
    println!("V3-08 metadata bytes {}", metadata.len());

    assert_eq!(ephemeral_public_key, decode(&vector["given"]["epk"]));
    assert_eq!(metadata, expected_metadata);

    let announcement =
        SchemeId3::announcement_from_bytes(&stealth_address, &ephemeral_public_key, &metadata)
            .unwrap();
    let (encoded_address, encoded_key, encoded_metadata) =
        SchemeId3::announcement_to_bytes(&announcement);

    assert_eq!(encoded_address, stealth_address);
    assert_eq!(encoded_key, ephemeral_public_key);
    assert_eq!(encoded_metadata, metadata);
}

#[test]
fn v3_09_identity_can_announce_scan_and_spend() {
    let section: Value = serde_json::from_slice(SECTION_2_9).unwrap();
    let vector = &section["vectors"]["V3-09"];
    let seed = decode(&vector["given"]["keygen_seed"]);
    let (meta, master, tracking) = SchemeId3::keygen(&seed).unwrap();
    let announce_seed = vec![0x44; SchemeId3::ANNOUNCE_SEED_BYTES];
    let announcement = SchemeId3::announce(&meta, &announce_seed).unwrap();
    let (stealth_address, ephemeral_public_key, metadata) =
        SchemeId3::announcement_to_bytes(&announcement);
    let decoded =
        SchemeId3::announcement_from_bytes(&stealth_address, &ephemeral_public_key, &metadata)
            .unwrap();
    let scanner = SchemeId3::bind(&tracking, &meta).unwrap();
    let matched = SchemeId3::scan(&scanner, &decoded).unwrap();

    println!("V3-09 stealth address 0x{}", hex::encode(stealth_address));
    println!(
        "V3-09 ephemeral pubkey bytes {}",
        ephemeral_public_key.len()
    );
    println!("V3-09 metadata bytes {}", metadata.len());

    assert_eq!(matched.stealth_address, stealth_address);
    SchemeId3::spend_key(&master, &matched).unwrap();
}

fn decode(value: &Value) -> Vec<u8> {
    hex::decode(value.as_str().unwrap()).unwrap()
}
