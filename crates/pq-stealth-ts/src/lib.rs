//! Thin WASM facade over `pq-stealth` and `pq-stealth-ethereum`.

use pq_stealth::{IdentityRecord, MatchMaterial, SchemeKind, WireAnnouncement, dispatch};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

fn js_error(error: impl std::fmt::Display) -> JsValue {
    js_sys::Error::new(&error.to_string()).into()
}

fn kind(value: &str) -> Result<SchemeKind, JsValue> {
    match value {
        "mlkem-per-payment" => Ok(SchemeKind::MlkemPerPayment),
        "hybrid-per-payment" => Ok(SchemeKind::HybridPerPayment),
        "mlkem-channel" => Ok(SchemeKind::MlkemChannel),
        "hybrid-channel" => Ok(SchemeKind::HybridChannel),
        _ => Err(js_error("unknown PQ stealth scheme")),
    }
}

fn from_js<T: serde::de::DeserializeOwned>(value: JsValue) -> Result<T, JsValue> {
    serde_wasm_bindgen::from_value(value).map_err(js_error)
}

fn to_js<T: Serialize>(value: &T) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(value).map_err(js_error)
}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

#[wasm_bindgen]
pub fn storage_schema_version() -> u32 {
    pq_stealth::SCHEMA_VERSION
}

#[wasm_bindgen]
pub fn validate_storage_schema(found: u32) -> Result<(), JsValue> {
    if found == pq_stealth::SCHEMA_VERSION {
        Ok(())
    } else {
        Err(js_error(pq_stealth::Error::MigrationRequired { found }))
    }
}

#[wasm_bindgen]
pub fn scheme_info(scheme: &str) -> Result<JsValue, JsValue> {
    let info = dispatch::scheme_info(kind(scheme)?);
    #[derive(Serialize)]
    struct JsInfo<'a> {
        scheme_id: u64,
        name: &'a str,
        keygen_seed_bytes: usize,
        announce_seed_bytes: usize,
    }
    to_js(&JsInfo {
        scheme_id: info.id,
        name: info.name,
        keygen_seed_bytes: info.keygen_seed_bytes,
        announce_seed_bytes: info.announce_seed_bytes,
    })
}

#[wasm_bindgen]
pub fn create_identity(scheme: &str, keygen_master: &[u8]) -> Result<JsValue, JsValue> {
    to_js(&dispatch::create_identity(kind(scheme)?, keygen_master).map_err(js_error)?)
}

#[wasm_bindgen]
pub fn validate_meta_address(scheme: &str, meta_address: &[u8]) -> Result<bool, JsValue> {
    Ok(dispatch::validate_meta(kind(scheme)?, meta_address))
}

#[wasm_bindgen]
pub fn export_tracking_capability(
    identity: JsValue,
    keygen_master: &[u8],
) -> Result<JsValue, JsValue> {
    let identity: IdentityRecord = from_js(identity)?;
    to_js(&dispatch::tracking_capability(&identity, keygen_master).map_err(js_error)?)
}

/// Opaque announce seed. JS can observe only its reserved and next-unused indexes.
#[wasm_bindgen]
pub struct SenderReservation {
    inner: Option<dispatch::SenderReservation>,
}

#[wasm_bindgen]
impl SenderReservation {
    #[wasm_bindgen(js_name = reserve)]
    pub fn reserve(
        scheme: &str,
        sender_master: &[u8],
        next_index: &str,
    ) -> Result<SenderReservation, JsValue> {
        let next_index = next_index
            .parse()
            .map_err(|_| js_error("sender index is not a u64"))?;
        Ok(Self {
            inner: Some(
                dispatch::reserve_sender(kind(scheme)?, sender_master, next_index)
                    .map_err(js_error)?,
            ),
        })
    }

    #[wasm_bindgen(getter)]
    pub fn index(&self) -> Result<String, JsValue> {
        self.inner
            .as_ref()
            .map(|reservation| reservation.index().to_string())
            .ok_or_else(|| js_error("reservation has already been consumed"))
    }

    #[wasm_bindgen(getter, js_name = nextIndex)]
    pub fn next_index(&self) -> Result<String, JsValue> {
        self.inner
            .as_ref()
            .map(|reservation| reservation.next_index().to_string())
            .ok_or_else(|| js_error("reservation has already been consumed"))
    }

    /// Complete only after the host has persisted `nextIndex`.
    pub fn complete(&mut self, meta_address: &[u8]) -> Result<JsValue, JsValue> {
        let reservation = self
            .inner
            .take()
            .ok_or_else(|| js_error("reservation has already been consumed"))?;
        let output = dispatch::complete_reservation(reservation, meta_address).map_err(js_error)?;
        #[derive(Serialize)]
        struct JsOutput {
            announcement: WireAnnouncement,
            sender_channel: Option<Vec<u8>>,
        }
        to_js(&JsOutput {
            announcement: output.announcement,
            sender_channel: output.sender_channel,
        })
    }
}

#[wasm_bindgen]
pub fn pay_channel(scheme: &str, sender_blob: &[u8]) -> Result<JsValue, JsValue> {
    let output = dispatch::pay_channel(kind(scheme)?, sender_blob).map_err(js_error)?;
    #[derive(Serialize)]
    struct JsOutput {
        announcement: WireAnnouncement,
        sender_channel: Option<Vec<u8>>,
    }
    to_js(&JsOutput {
        announcement: output.announcement,
        sender_channel: output.sender_channel,
    })
}

#[wasm_bindgen]
pub fn scan_payment(
    scheme: &str,
    keygen_master: &[u8],
    accepted_j: &str,
    meta_address: &[u8],
    wire: JsValue,
) -> Result<JsValue, JsValue> {
    let accepted_j = accepted_j
        .parse()
        .map_err(|_| js_error("accepted keygen index is not a u64"))?;
    let wire = from_js(wire)?;
    to_js(
        &dispatch::scan_payment(
            kind(scheme)?,
            keygen_master,
            accepted_j,
            meta_address,
            &wire,
        )
        .map_err(js_error)?,
    )
}

#[wasm_bindgen]
pub fn scan_channel(
    scheme: &str,
    keygen_master: &[u8],
    accepted_j: &str,
    meta_address: &[u8],
    wire: JsValue,
    channel_blobs: JsValue,
    lookahead: u32,
) -> Result<JsValue, JsValue> {
    let accepted_j = accepted_j
        .parse()
        .map_err(|_| js_error("accepted keygen index is not a u64"))?;
    let wire = from_js(wire)?;
    let channel_blobs: Vec<Vec<u8>> = from_js(channel_blobs)?;
    to_js(
        &dispatch::scan_channel(
            kind(scheme)?,
            keygen_master,
            accepted_j,
            meta_address,
            &wire,
            &channel_blobs,
            lookahead as usize,
        )
        .map_err(js_error)?,
    )
}

#[wasm_bindgen]
pub fn export_channel_watch(scheme: &str, scanner_blob: &[u8]) -> Result<JsValue, JsValue> {
    to_js(&dispatch::channel_watch(kind(scheme)?, scanner_blob).map_err(js_error)?)
}

#[wasm_bindgen]
pub fn encode_announce_call(wire: JsValue) -> Result<Vec<u8>, JsValue> {
    let wire = from_js(wire)?;
    Ok(pq_stealth_ethereum::encode_announce_call(&wire))
}

#[wasm_bindgen]
pub fn encode_register_call(scheme_id: u64, meta_address: &[u8]) -> Vec<u8> {
    pq_stealth_ethereum::encode_register_call(scheme_id, meta_address)
}

#[wasm_bindgen]
pub fn encode_registry_lookup(registrant: &[u8], scheme_id: u64) -> Result<Vec<u8>, JsValue> {
    Ok(pq_stealth_ethereum::encode_registry_lookup(
        registrant
            .try_into()
            .map_err(|_| js_error("registrant is not 20 bytes"))?,
        scheme_id,
    ))
}

#[wasm_bindgen]
pub fn decode_registry_lookup(value: &[u8]) -> Result<Vec<u8>, JsValue> {
    pq_stealth_ethereum::decode_registry_lookup(value).map_err(js_error)
}

#[wasm_bindgen]
pub fn announcement_topic() -> Vec<u8> {
    pq_stealth_ethereum::announcement_topic().to_vec()
}

#[wasm_bindgen]
pub fn transfer_topic() -> Vec<u8> {
    pq_stealth_ethereum::transfer_topic().to_vec()
}

#[wasm_bindgen]
pub fn decode_announcement_log(
    emitter: &[u8],
    topics: JsValue,
    data: &[u8],
) -> Result<JsValue, JsValue> {
    let emitter = emitter
        .try_into()
        .map_err(|_| js_error("log emitter is not 20 bytes"))?;
    let topics: Vec<Vec<u8>> = from_js(topics)?;
    let topics: Vec<[u8; 32]> = topics
        .into_iter()
        .map(|topic| {
            topic
                .try_into()
                .map_err(|_| js_error("log topic is not 32 bytes"))
        })
        .collect::<Result<_, _>>()?;
    let decoded =
        pq_stealth_ethereum::decode_announcement_log(emitter, &topics, data).map_err(js_error)?;
    #[derive(Serialize)]
    struct JsAnnouncement {
        scheme_id: u64,
        stealth_address: [u8; 20],
        caller: [u8; 20],
        ephemeral_pubkey: Vec<u8>,
        metadata: Vec<u8>,
    }
    to_js(&JsAnnouncement {
        scheme_id: decoded.scheme_id,
        stealth_address: decoded.stealth_address,
        caller: decoded.caller,
        ephemeral_pubkey: decoded.ephemeral_pubkey,
        metadata: decoded.metadata,
    })
}

#[wasm_bindgen]
pub fn build_asset_transfer(
    asset: JsValue,
    from: &[u8],
    to: &[u8],
    value: &[u8],
    spend: bool,
) -> Result<JsValue, JsValue> {
    let asset = from_js(asset)?;
    let from = from
        .try_into()
        .map_err(|_| js_error("sender is not 20 bytes"))?;
    let to = to
        .try_into()
        .map_err(|_| js_error("recipient is not 20 bytes"))?;
    let value = value
        .try_into()
        .map_err(|_| js_error("amount is not 32 bytes"))?;
    let intent = if spend {
        pq_stealth_ethereum::build_spend(&asset, from, to, value)
    } else {
        pq_stealth_ethereum::build_funding(&asset, from, to, value)
    }
    .map_err(js_error)?;
    to_js(&intent)
}

#[wasm_bindgen]
pub fn encode_erc20_balance_of(owner: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(pq_stealth_ethereum::encode_erc20_balance_of(
        owner
            .try_into()
            .map_err(|_| js_error("owner is not 20 bytes"))?,
    ))
}

#[wasm_bindgen]
pub fn decode_erc20_balance(value: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(pq_stealth_ethereum::decode_erc20_balance(value)
        .map_err(js_error)?
        .to_vec())
}

#[wasm_bindgen]
pub fn encode_erc721_owner_of(token_id: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(pq_stealth_ethereum::encode_erc721_owner_of(
        token_id
            .try_into()
            .map_err(|_| js_error("token id is not 32 bytes"))?,
    ))
}

#[wasm_bindgen]
pub fn decode_erc721_owner(value: &[u8]) -> Result<Vec<u8>, JsValue> {
    Ok(pq_stealth_ethereum::decode_erc721_owner(value)
        .map_err(js_error)?
        .to_vec())
}

#[wasm_bindgen]
pub fn verify_asset_transfer_receipt(
    from: &[u8],
    intent: JsValue,
    logs: JsValue,
) -> Result<bool, JsValue> {
    let from: [u8; 20] = from
        .try_into()
        .map_err(|_| js_error("sender address is not 20 bytes"))?;
    let intent: pq_stealth_ethereum::TransactionIntent = from_js(intent)?;
    let logs: Vec<pq_stealth_ethereum::ReceiptLog> = from_js(logs)?;
    pq_stealth_ethereum::verify_asset_transfer_receipt(from, &intent, &logs).map_err(js_error)
}

#[wasm_bindgen]
pub fn reconcile_operation_stage(kind: &str, observation: JsValue) -> Result<JsValue, JsValue> {
    let kind = match kind {
        "registration" => pq_stealth::OperationKind::Registration,
        "payment" => pq_stealth::OperationKind::Payment,
        "spend" => pq_stealth::OperationKind::Spend,
        _ => return Err(js_error("unknown operation kind")),
    };
    let observation: pq_stealth::LifecycleObservation = from_js(observation)?;
    to_js(&pq_stealth::reconcile_stage(kind, observation))
}

#[derive(Deserialize)]
struct JsEip1559Request {
    chain_id: String,
    nonce: String,
    gas_limit: String,
    max_fee_per_gas: String,
    max_priority_fee_per_gas: String,
    intent: pq_stealth_ethereum::TransactionIntent,
}

impl TryFrom<JsEip1559Request> for pq_stealth_ethereum::Eip1559Request {
    type Error = JsValue;

    fn try_from(value: JsEip1559Request) -> Result<Self, Self::Error> {
        Ok(Self {
            chain_id: value.chain_id.parse().map_err(js_error)?,
            nonce: value.nonce.parse().map_err(js_error)?,
            gas_limit: value.gas_limit.parse().map_err(js_error)?,
            max_fee_per_gas: value.max_fee_per_gas.parse().map_err(js_error)?,
            max_priority_fee_per_gas: value.max_priority_fee_per_gas.parse().map_err(js_error)?,
            intent: value.intent,
        })
    }
}

/// Derive the spend key and sign in one call; the scalar never crosses the WASM boundary.
#[wasm_bindgen]
pub fn sign_prepared_spend(
    keygen_master: &[u8],
    accepted_j: &str,
    material: JsValue,
    request: JsValue,
) -> Result<JsValue, JsValue> {
    let accepted_j = accepted_j
        .parse()
        .map_err(|_| js_error("accepted keygen index is not a u64"))?;
    let material: MatchMaterial = from_js(material)?;
    let request: JsEip1559Request = from_js(request)?;
    let key =
        dispatch::spend_key_for_match(keygen_master, accepted_j, &material).map_err(js_error)?;
    let signed = pq_stealth_ethereum::sign_eip1559(key, &request.try_into()?).map_err(js_error)?;
    to_js(&signed)
}
