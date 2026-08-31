//! WASM exports used by the TypeScript plugin.

mod wallet;

use serde::{Deserialize, Serialize};
use wallet::{AnnouncementPayload, Eip1559Request, Match};
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}

fn from_js<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(value).map_err(js_error)
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(js_error)
}

fn parse_u64(value: &str, field: &str) -> Result<u64, JsValue> {
    value
        .parse()
        .map_err(|_| js_error(format!("{field} must be an unsigned 64-bit integer")))
}

#[derive(Serialize)]
struct JsIdentity {
    keygen_index: String,
    meta_address: Vec<u8>,
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen(js_name = schemeId)]
#[must_use]
pub fn scheme_id() -> u32 {
    3
}

/// Derive the scheme 3 identity.
///
/// # Errors
///
/// Wrong-length master or keygen failure.
#[wasm_bindgen(js_name = deriveIdentity)]
pub fn derive_identity(keygen_master: &[u8]) -> Result<JsValue, JsValue> {
    let identity = wallet::derive_identity(keygen_master).map_err(js_error)?;
    to_js(&JsIdentity {
        keygen_index: identity.keygen_index.to_string(),
        meta_address: identity.meta_address,
    })
}

/// Build an ERC-5564 payload at `sender_index`.
///
/// Returns `undefined` when this sender index's seed is rejected.
///
/// # Errors
///
/// Invalid keys, meta-address, or sender index.
#[wasm_bindgen(js_name = createAnnouncement)]
pub fn create_announcement(
    meta_address: &[u8],
    sender_master: &[u8],
    sender_index: &str,
) -> Result<JsValue, JsValue> {
    match wallet::create_announcement(
        meta_address,
        sender_master,
        parse_u64(sender_index, "sender index")?,
    ) {
        Ok(payload) => to_js(&payload),
        Err(wallet::Error::SeedRejected) => Ok(JsValue::UNDEFINED),
        Err(error) => Err(js_error(error)),
    }
}

/// True if the bytes are a scheme 3 meta-address.
#[wasm_bindgen(js_name = isValidMetaAddress)]
#[must_use]
pub fn is_valid_meta_address(meta_address: &[u8]) -> bool {
    wallet::is_valid_meta_address(meta_address)
}

#[wasm_bindgen(js_name = Scanner)]
pub struct Scanner {
    inner: wallet::Scanner,
}

#[wasm_bindgen(js_class = Scanner)]
impl Scanner {
    /// Bind recipient keys to the registered meta-address.
    ///
    /// # Errors
    ///
    /// Keys, index, and meta-address do not agree.
    #[wasm_bindgen(constructor)]
    pub fn new(
        keygen_master: &[u8],
        keygen_index: &str,
        meta_address: &[u8],
    ) -> Result<Scanner, JsValue> {
        Ok(Self {
            inner: wallet::Scanner::new(
                keygen_master,
                parse_u64(keygen_index, "keygen index")?,
                meta_address,
            )
            .map_err(js_error)?,
        })
    }

    /// Scan one announcement.
    ///
    /// # Errors
    ///
    /// Stealth address is not 20 bytes.
    pub fn scan(
        &self,
        stealth_address: &[u8],
        ephemeral_pubkey: &[u8],
        metadata: &[u8],
    ) -> Result<JsValue, JsValue> {
        let payload = AnnouncementPayload {
            stealth_address: stealth_address
                .try_into()
                .map_err(|_| js_error("stealth address must be 20 bytes"))?,
            ephemeral_pubkey: ephemeral_pubkey.to_vec(),
            metadata: metadata.to_vec(),
        };
        to_js(&self.inner.scan(&payload))
    }
}

#[derive(Deserialize)]
struct JsTransactionRequest {
    chain_id: String,
    nonce: String,
    gas_limit: String,
    max_fee_per_gas: String,
    max_priority_fee_per_gas: String,
    to: Vec<u8>,
    value: Vec<u8>,
    data: Vec<u8>,
}

impl TryFrom<JsTransactionRequest> for Eip1559Request {
    type Error = JsValue;

    fn try_from(value: JsTransactionRequest) -> Result<Self, Self::Error> {
        Ok(Self {
            chain_id: parse_u64(&value.chain_id, "chain id")?,
            nonce: parse_u64(&value.nonce, "nonce")?,
            gas_limit: parse_u64(&value.gas_limit, "gas limit")?,
            max_fee_per_gas: value
                .max_fee_per_gas
                .parse()
                .map_err(|_| js_error("max fee per gas must be an unsigned 128-bit integer"))?,
            max_priority_fee_per_gas: value.max_priority_fee_per_gas.parse().map_err(|_| {
                js_error("max priority fee per gas must be an unsigned 128-bit integer")
            })?,
            to: value
                .to
                .as_slice()
                .try_into()
                .map_err(|_| js_error("transaction recipient must be 20 bytes"))?,
            value: value
                .value
                .as_slice()
                .try_into()
                .map_err(|_| js_error("transaction value must be 32 bytes"))?,
            data: value.data,
        })
    }
}

/// Sign an EIP-1559 spend.
///
/// # Errors
///
/// Malformed input, identity mismatch, or signing failure.
#[wasm_bindgen(js_name = signSpend)]
pub fn sign_spend(
    keygen_master: &[u8],
    keygen_index: &str,
    matched: JsValue,
    request: JsValue,
) -> Result<JsValue, JsValue> {
    let matched: Match = from_js(matched)?;
    let request: JsTransactionRequest = from_js(request)?;
    to_js(
        &wallet::sign_spend(
            keygen_master,
            parse_u64(keygen_index, "keygen index")?,
            &matched,
            &request.try_into()?,
        )
        .map_err(js_error)?,
    )
}
