//! Ethereum ABI codecs, transaction builders, and opaque one-time-key signing.

use alloy::{
    consensus::{SignableTransaction, TxEip1559, TxEnvelope},
    eips::eip2718::Encodable2718,
    network::TxSignerSync,
    primitives::{Address, B256, Bytes, Log, TxKind, U256, keccak256},
    signers::local::PrivateKeySigner,
    sol,
    sol_types::{SolCall, SolEvent},
};
use serde::{Deserialize, Serialize};
use thiserror::Error;

sol! {
    interface IERC5564Announcer {
        event Announcement(
            uint256 indexed schemeId,
            address indexed stealthAddress,
            address indexed caller,
            bytes ephemeralPubKey,
            bytes metadata
        );

        function announce(
            uint256 schemeId,
            address stealthAddress,
            bytes ephemeralPubKey,
            bytes metadata
        ) external;
    }

    interface IERC6538Registry {
        function registerKeys(uint256 schemeId, bytes stealthMetaAddress) external;
        function stealthMetaAddressOf(address registrant, uint256 schemeId)
            external view returns (bytes);
    }

    interface IERC20 {
        event Transfer(address indexed from, address indexed to, uint256 value);
        function transfer(address to, uint256 value) external returns (bool);
        function balanceOf(address account) external view returns (uint256);
    }

    interface IERC721 {
        event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
        function safeTransferFrom(address from, address to, uint256 tokenId) external;
        function ownerOf(uint256 tokenId) external view returns (address);
    }
}

/// Canonical ERC-5564 singleton announcer deployment.
pub const ERC5564_ANNOUNCER: [u8; 20] = hex_literal("55649e01b5df198d18d95b5cc5051630cfd45564");

/// Canonical ERC-6538 singleton registry deployment.
pub const ERC6538_REGISTRY: [u8; 20] = hex_literal("6538e6bf4b0ebd30a8ea093027ac2422ce5d6538");

const fn hex_literal(value: &str) -> [u8; 20] {
    let bytes = value.as_bytes();
    let mut output = [0_u8; 20];
    let mut index = 0;
    while index < 20 {
        output[index] = (hex_nibble(bytes[index * 2]) << 4) | hex_nibble(bytes[index * 2 + 1]);
        index += 1;
    }
    output
}

const fn hex_nibble(value: u8) -> u8 {
    match value {
        b'0'..=b'9' => value - b'0',
        b'a'..=b'f' => value - b'a' + 10,
        b'A'..=b'F' => value - b'A' + 10,
        _ => panic!("invalid hex literal"),
    }
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("malformed Ethereum ABI data")]
    MalformedAbi,
    #[error("scheme id does not fit the supported u64 dispatch")]
    UnsupportedSchemeId,
    #[error("ERC-721 amount must be exactly one")]
    InvalidErc721Amount,
    #[error("invalid one-time signing key")]
    InvalidSigningKey,
    #[error("transaction signing failed")]
    Signing,
}

/// A strictly decoded ERC-5564 announcement payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DecodedAnnouncement {
    pub scheme_id: u64,
    pub stealth_address: [u8; 20],
    pub caller: [u8; 20],
    pub ephemeral_pubkey: Vec<u8>,
    pub metadata: Vec<u8>,
}

/// Decode the complete event and validate its signature, topic count, padding, and ABI body.
pub fn decode_announcement_log(
    emitter: [u8; 20],
    topics: &[[u8; 32]],
    data: &[u8],
) -> Result<DecodedAnnouncement, Error> {
    if topics.len() != 4 {
        return Err(Error::MalformedAbi);
    }
    let log = Log::new(
        Address::from(emitter),
        topics.iter().copied().map(B256::from).collect(),
        Bytes::copy_from_slice(data),
    )
    .ok_or(Error::MalformedAbi)?;
    let decoded = IERC5564Announcer::Announcement::decode_log_validate(&log)
        .map_err(|_| Error::MalformedAbi)?;
    if decoded.schemeId > U256::from(u64::MAX) {
        return Err(Error::UnsupportedSchemeId);
    }
    Ok(DecodedAnnouncement {
        scheme_id: decoded.schemeId.to::<u64>(),
        stealth_address: decoded.stealthAddress.into_array(),
        caller: decoded.caller.into_array(),
        ephemeral_pubkey: decoded.ephemeralPubKey.to_vec(),
        metadata: decoded.metadata.to_vec(),
    })
}

#[must_use]
pub fn announcement_topic() -> [u8; 32] {
    IERC5564Announcer::Announcement::SIGNATURE_HASH.into()
}

#[must_use]
pub fn transfer_topic() -> [u8; 32] {
    IERC20::Transfer::SIGNATURE_HASH.into()
}

#[must_use]
pub fn encode_announce_call(announcement: &pq_stealth::WireAnnouncement) -> Vec<u8> {
    IERC5564Announcer::announceCall {
        schemeId: U256::from(announcement.scheme_id),
        stealthAddress: Address::from(announcement.stealth_address),
        ephemeralPubKey: announcement.ephemeral_pubkey.clone().into(),
        metadata: announcement.metadata.clone().into(),
    }
    .abi_encode()
}

#[must_use]
pub fn encode_register_call(scheme_id: u64, meta_address: &[u8]) -> Vec<u8> {
    IERC6538Registry::registerKeysCall {
        schemeId: U256::from(scheme_id),
        stealthMetaAddress: meta_address.to_vec().into(),
    }
    .abi_encode()
}

#[must_use]
pub fn encode_registry_lookup(registrant: [u8; 20], scheme_id: u64) -> Vec<u8> {
    IERC6538Registry::stealthMetaAddressOfCall {
        registrant: Address::from(registrant),
        schemeId: U256::from(scheme_id),
    }
    .abi_encode()
}

pub fn decode_registry_lookup(value: &[u8]) -> Result<Vec<u8>, Error> {
    IERC6538Registry::stealthMetaAddressOfCall::abi_decode_returns(value)
        .map(|bytes| bytes.to_vec())
        .map_err(|_| Error::MalformedAbi)
}

/// Current Kohaku assets supported by phase 1.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum Asset {
    Native,
    Erc20 {
        contract: [u8; 20],
    },
    Erc721 {
        contract: [u8; 20],
        token_id: [u8; 32],
    },
}

/// Minimal semantic transaction intent. Fee/nonce fields are filled immediately before signing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TransactionIntent {
    pub to: [u8; 20],
    pub value: [u8; 32],
    pub data: Vec<u8>,
}

/// Minimal receipt log input used by pure funding/spending verification.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReceiptLog {
    pub address: [u8; 20],
    pub topics: Vec<[u8; 32]>,
    pub data: Vec<u8>,
}

fn amount(value: [u8; 32]) -> U256 {
    U256::from_be_bytes(value)
}

/// Build native/ERC-20/ERC-721 funding without touching upstream protocol payloads.
pub fn build_funding(
    asset: &Asset,
    payer: [u8; 20],
    recipient: [u8; 20],
    value: [u8; 32],
) -> Result<TransactionIntent, Error> {
    build_asset_transfer(asset, payer, recipient, value)
}

/// Build a spend from the stealth EOA to its destination.
pub fn build_spend(
    asset: &Asset,
    stealth: [u8; 20],
    recipient: [u8; 20],
    value: [u8; 32],
) -> Result<TransactionIntent, Error> {
    build_asset_transfer(asset, stealth, recipient, value)
}

fn build_asset_transfer(
    asset: &Asset,
    from: [u8; 20],
    to: [u8; 20],
    value: [u8; 32],
) -> Result<TransactionIntent, Error> {
    match asset {
        Asset::Native => Ok(TransactionIntent {
            to,
            value,
            data: Vec::new(),
        }),
        Asset::Erc20 { contract } => Ok(TransactionIntent {
            to: *contract,
            value: [0; 32],
            data: IERC20::transferCall {
                to: Address::from(to),
                value: amount(value),
            }
            .abi_encode(),
        }),
        Asset::Erc721 { contract, token_id } => {
            if amount(value) != U256::from(1) {
                return Err(Error::InvalidErc721Amount);
            }
            Ok(TransactionIntent {
                to: *contract,
                value: [0; 32],
                data: IERC721::safeTransferFromCall {
                    from: Address::from(from),
                    to: Address::from(to),
                    tokenId: amount(*token_id),
                }
                .abi_encode(),
            })
        }
    }
}

/// Verify the observable effect of a native/ERC-20/ERC-721 funding or spend intent.
///
/// Native value movement has no log and is established by a successful receipt for the exact
/// submitted transaction hash. Token intents additionally require a strict matching `Transfer`.
pub fn verify_asset_transfer_receipt(
    from: [u8; 20],
    intent: &TransactionIntent,
    logs: &[ReceiptLog],
) -> Result<bool, Error> {
    if intent.data.is_empty() {
        return Ok(true);
    }
    if intent.data.starts_with(&IERC20::transferCall::SELECTOR) {
        let call =
            IERC20::transferCall::abi_decode(&intent.data).map_err(|_| Error::MalformedAbi)?;
        for receipt_log in logs.iter().filter(|log| log.address == intent.to) {
            let Some(log) = alloy_log(receipt_log) else {
                return Err(Error::MalformedAbi);
            };
            if let Ok(event) = IERC20::Transfer::decode_log_validate(&log) {
                if event.from == Address::from(from)
                    && event.to == call.to
                    && event.value == call.value
                {
                    return Ok(true);
                }
            }
        }
        return Ok(false);
    }
    if intent
        .data
        .starts_with(&IERC721::safeTransferFromCall::SELECTOR)
    {
        let call = IERC721::safeTransferFromCall::abi_decode(&intent.data)
            .map_err(|_| Error::MalformedAbi)?;
        for receipt_log in logs.iter().filter(|log| log.address == intent.to) {
            let Some(log) = alloy_log(receipt_log) else {
                return Err(Error::MalformedAbi);
            };
            if let Ok(event) = IERC721::Transfer::decode_log_validate(&log) {
                if event.from == call.from && event.to == call.to && event.tokenId == call.tokenId {
                    return Ok(true);
                }
            }
        }
        return Ok(false);
    }
    Err(Error::MalformedAbi)
}

fn alloy_log(log: &ReceiptLog) -> Option<Log> {
    Log::new(
        Address::from(log.address),
        log.topics.iter().copied().map(B256::from).collect(),
        Bytes::copy_from_slice(&log.data),
    )
}

#[must_use]
pub fn encode_erc20_balance_of(owner: [u8; 20]) -> Vec<u8> {
    IERC20::balanceOfCall {
        account: Address::from(owner),
    }
    .abi_encode()
}

pub fn decode_erc20_balance(value: &[u8]) -> Result<[u8; 32], Error> {
    IERC20::balanceOfCall::abi_decode_returns(value)
        .map(|balance| balance.to_be_bytes())
        .map_err(|_| Error::MalformedAbi)
}

#[must_use]
pub fn encode_erc721_owner_of(token_id: [u8; 32]) -> Vec<u8> {
    IERC721::ownerOfCall {
        tokenId: amount(token_id),
    }
    .abi_encode()
}

pub fn decode_erc721_owner(value: &[u8]) -> Result<[u8; 20], Error> {
    IERC721::ownerOfCall::abi_decode_returns(value)
        .map(Address::into_array)
        .map_err(|_| Error::MalformedAbi)
}

/// Fully specified unsigned EIP-1559 request used for an opaque spend signature.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Eip1559Request {
    pub chain_id: u64,
    pub nonce: u64,
    pub gas_limit: u64,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub intent: TransactionIntent,
}

/// Raw signed bytes and their immutable transaction identity.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SignedTransaction {
    pub raw: Vec<u8>,
    pub hash: [u8; 32],
    pub signer: [u8; 20],
}

/// Sign inside Rust and return only the raw transaction, hash, and public signer address.
pub fn sign_eip1559(
    one_time_key: [u8; 32],
    request: &Eip1559Request,
) -> Result<SignedTransaction, Error> {
    let signer = PrivateKeySigner::from_bytes(&B256::from(one_time_key))
        .map_err(|_| Error::InvalidSigningKey)?;
    let mut transaction = TxEip1559 {
        chain_id: request.chain_id,
        nonce: request.nonce,
        gas_limit: request.gas_limit,
        max_fee_per_gas: request.max_fee_per_gas,
        max_priority_fee_per_gas: request.max_priority_fee_per_gas,
        to: TxKind::Call(Address::from(request.intent.to)),
        value: amount(request.intent.value),
        access_list: Default::default(),
        input: request.intent.data.clone().into(),
    };
    let signature = signer
        .sign_transaction_sync(&mut transaction)
        .map_err(|_| Error::Signing)?;
    let envelope = TxEnvelope::Eip1559(transaction.into_signed(signature));
    let mut raw = Vec::with_capacity(envelope.encode_2718_len());
    envelope.encode_2718(&mut raw);
    Ok(SignedTransaction {
        hash: keccak256(&raw).into(),
        raw,
        signer: signer.address().into_array(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(value: u64) -> [u8; 32] {
        U256::from(value).to_be_bytes()
    }

    #[test]
    fn erc721_requires_exactly_one() {
        let asset = Asset::Erc721 {
            contract: [1; 20],
            token_id: word(42),
        };
        assert!(matches!(
            build_funding(&asset, [2; 20], [3; 20], word(2)),
            Err(Error::InvalidErc721Amount)
        ));
    }

    #[test]
    fn announcement_call_preserves_upstream_payload_bytes() {
        let announcement = pq_stealth::WireAnnouncement {
            scheme: pq_stealth::SchemeKind::MlkemPerPayment,
            scheme_id: 2,
            stealth_address: [7; 20],
            ephemeral_pubkey: vec![1, 2, 3],
            metadata: vec![4, 5],
        };
        let encoded = encode_announce_call(&announcement);
        let decoded = IERC5564Announcer::announceCall::abi_decode(&encoded).unwrap();
        assert_eq!(decoded.ephemeralPubKey.as_ref(), [1, 2, 3]);
        assert_eq!(decoded.metadata.as_ref(), [4, 5]);
    }

    #[test]
    fn one_time_signing_returns_matching_public_signer() {
        let signed = sign_eip1559(
            [1; 32],
            &Eip1559Request {
                chain_id: 1,
                nonce: 0,
                gas_limit: 21_000,
                max_fee_per_gas: 2,
                max_priority_fee_per_gas: 1,
                intent: TransactionIntent {
                    to: [2; 20],
                    value: word(1),
                    data: Vec::new(),
                },
            },
        )
        .unwrap();
        assert_eq!(signed.raw[0], 2);
        assert_eq!(signed.hash, <[u8; 32]>::from(keccak256(&signed.raw)));
    }

    #[test]
    fn token_receipt_must_match_the_exact_semantic_intent() {
        let from = Address::from([2; 20]);
        let to = Address::from([3; 20]);
        let contract = [4; 20];
        let intent = build_funding(
            &Asset::Erc20 { contract },
            from.into_array(),
            to.into_array(),
            word(7),
        )
        .unwrap();
        let event = IERC20::Transfer {
            from,
            to,
            value: U256::from(7),
        }
        .encode_log_data();
        let receipt = ReceiptLog {
            address: contract,
            topics: event.topics().iter().copied().map(Into::into).collect(),
            data: event.data.to_vec(),
        };
        assert!(
            verify_asset_transfer_receipt(from.into_array(), &intent, &[receipt.clone()]).unwrap()
        );

        let wrong = IERC20::Transfer {
            from,
            to,
            value: U256::from(8),
        }
        .encode_log_data();
        let wrong_receipt = ReceiptLog {
            topics: wrong.topics().iter().copied().map(Into::into).collect(),
            data: wrong.data.to_vec(),
            ..receipt
        };
        assert!(
            !verify_asset_transfer_receipt(from.into_array(), &intent, &[wrong_receipt]).unwrap()
        );
    }
}
