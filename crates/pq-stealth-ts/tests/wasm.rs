#![cfg(target_arch = "wasm32")]

use pq_stealth_scheme3::{Scanner, create_announcement, derive_identity};
use serde::Deserialize;
use wasm_bindgen_test::wasm_bindgen_test;

#[derive(Deserialize)]
struct Identity {
    keygen_index: String,
    meta_address: Vec<u8>,
}

#[derive(Deserialize)]
struct Announcement {
    stealth_address: Vec<u8>,
    ephemeral_pubkey: Vec<u8>,
    metadata: Vec<u8>,
}

#[derive(Deserialize)]
struct Match {
    stealth_address: Vec<u8>,
    shared_secret: Vec<u8>,
}

/// Derive, announce, and scan through the WASM exports.
#[wasm_bindgen_test]
fn scheme_3_crosses_the_wasm_boundary() {
    let recipient_master = [7_u8; 32];
    let identity: Identity = serde_wasm_bindgen::from_value(
        derive_identity(&recipient_master).expect("identity derives in WASM"),
    )
    .unwrap();
    let announcement: Announcement = serde_wasm_bindgen::from_value(
        create_announcement(&identity.meta_address, &[9_u8; 32], "0")
            .expect("announcement derives in WASM"),
    )
    .unwrap();
    let scanner = Scanner::new(
        &recipient_master,
        &identity.keygen_index,
        &identity.meta_address,
    )
    .unwrap();
    let matched: Option<Match> = serde_wasm_bindgen::from_value(
        scanner
            .scan(
                &announcement.stealth_address,
                &announcement.ephemeral_pubkey,
                &announcement.metadata,
            )
            .unwrap(),
    )
    .unwrap();
    let matched = matched.expect("recipient finds its payment");
    println!("meta-address bytes {}", identity.meta_address.len());
    println!(
        "ephemeral pubkey bytes {}",
        announcement.ephemeral_pubkey.len()
    );
    println!("metadata bytes {}", announcement.metadata.len());
    println!("shared secret bytes {}", matched.shared_secret.len());
    assert_eq!(matched.stealth_address, announcement.stealth_address);
    assert_eq!(matched.shared_secret.len(), 32);
}
