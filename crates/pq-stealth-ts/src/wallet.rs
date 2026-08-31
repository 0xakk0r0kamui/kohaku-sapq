//! Scheme 3 identity, announcement, scan, and spend signing.

use alloy::{
    consensus::{SignableTransaction, TxEip1559, TxEnvelope},
    eips::{eip2718::Encodable2718, eip2930::AccessList},
    network::TxSignerSync,
    primitives::{Address, Bytes, TxKind, U256, keccak256},
    signers::local::PrivateKeySigner,
};
use pqsa_core::{Bytes32, Error as SchemeError, SenderState, StealthScheme, keygen_seed};
use pqsa_per_payment::{
    Announcement, Master, Match as SchemeMatch, MetaAddress, Scanner as BoundScanner, SchemeId3,
};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use zeroize::Zeroize;

const KEYGEN_ATTEMPTS: u64 = 1_024;

#[derive(Debug, Error)]
pub enum Error {
    #[error("expected {expected} bytes, received {actual}")]
    InvalidLength { expected: usize, actual: usize },
    #[error("invalid scheme 3 meta-address")]
    InvalidMetaAddress,
    #[error("key generation retry limit reached")]
    KeygenExhausted,
    #[error("invalid sender index")]
    InvalidSenderIndex,
    #[error("announcement seed rejected")]
    SeedRejected,
    #[error("scheme 3 operation failed: {0}")]
    Scheme(String),
    #[error("transaction signing failed")]
    Signing,
}

impl From<SchemeError> for Error {
    fn from(error: SchemeError) -> Self {
        match error {
            SchemeError::SeedRejected => Self::SeedRejected,
            other => Self::Scheme(format!("{other:?}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Identity {
    pub keygen_index: u64,
    pub meta_address: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnnouncementPayload {
    pub stealth_address: [u8; 20],
    pub ephemeral_pubkey: Vec<u8>,
    pub metadata: Vec<u8>,
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Match {
    pub stealth_address: [u8; 20],
    pub shared_secret: Bytes32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Eip1559Request {
    pub chain_id: u64,
    pub nonce: u64,
    pub gas_limit: u64,
    pub max_fee_per_gas: u128,
    pub max_priority_fee_per_gas: u128,
    pub to: [u8; 20],
    pub value: [u8; 32],
    pub data: Vec<u8>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SignedTransaction {
    pub raw: Vec<u8>,
    pub hash: [u8; 32],
    pub signer: [u8; 20],
}

/// Derive a meta-address from a 32-byte master, retrying the keygen seed on a bad scalar.
pub fn derive_identity(master: &[u8]) -> Result<Identity, Error> {
    for keygen_index in 0..KEYGEN_ATTEMPTS {
        let seed = derive_keygen_seed(master, keygen_index)?;
        match SchemeId3::keygen(&seed) {
            Ok((meta, _, _)) => {
                return Ok(Identity {
                    keygen_index,
                    meta_address: SchemeId3::meta_to_bytes(&meta),
                });
            }
            Err(SchemeError::NoValidScalar | SchemeError::SpendingKeyDelegated) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(Error::KeygenExhausted)
}

/// Announce to `meta_address` at `sender_index`.
pub fn create_announcement(
    meta_address: &[u8],
    sender_master: &[u8],
    sender_index: u64,
) -> Result<AnnouncementPayload, Error> {
    let meta = SchemeId3::meta_from_bytes(meta_address).ok_or(Error::InvalidMetaAddress)?;
    let master = fixed_bytes::<32>(sender_master)?;
    let mut sender = SenderState::resume(master, sender_index);
    let seed = sender
        .draw_seed::<SchemeId3>()
        .map_err(|error| match error {
            SchemeError::CounterExhausted => Error::InvalidSenderIndex,
            other => other.into(),
        })?;
    let announcement = SchemeId3::announce(&meta, &seed)?;
    Ok(wire_payload(&announcement))
}

#[must_use]
pub fn is_valid_meta_address(meta_address: &[u8]) -> bool {
    SchemeId3::meta_from_bytes(meta_address).is_some()
}

pub struct Scanner {
    inner: BoundScanner,
}

impl Scanner {
    /// Bind tracking keys to `meta_address`.
    pub fn new(
        keygen_master: &[u8],
        keygen_index: u64,
        meta_address: &[u8],
    ) -> Result<Self, Error> {
        let (derived_meta, _, tracking) = keys(keygen_master, keygen_index)?;
        let meta = SchemeId3::meta_from_bytes(meta_address).ok_or(Error::InvalidMetaAddress)?;
        if SchemeId3::meta_to_bytes(&derived_meta) != meta_address {
            return Err(Error::InvalidMetaAddress);
        }
        Ok(Self {
            inner: SchemeId3::bind(&tracking, &meta)?,
        })
    }

    /// Return a match when this announcement is ours.
    pub fn scan(&self, payload: &AnnouncementPayload) -> Option<Match> {
        let announcement = SchemeId3::announcement_from_bytes(
            &payload.stealth_address,
            &payload.ephemeral_pubkey,
            &payload.metadata,
        )?;
        SchemeId3::scan(&self.inner, &announcement).map(|matched| Match {
            stealth_address: matched.stealth_address,
            shared_secret: matched.shared_secret,
        })
    }
}

/// Derive the one-time key for `matched` and sign `request`.
pub fn sign_spend(
    keygen_master: &[u8],
    keygen_index: u64,
    matched: &Match,
    request: &Eip1559Request,
) -> Result<SignedTransaction, Error> {
    let (_, master, _) = keys(keygen_master, keygen_index)?;
    let scheme_match = SchemeMatch {
        stealth_address: matched.stealth_address,
        shared_secret: matched.shared_secret,
    };
    let one_time_key = SchemeId3::spend_key(&master, &scheme_match)?;
    sign_transaction(one_time_key, request)
}

fn keys(
    keygen_master: &[u8],
    keygen_index: u64,
) -> Result<(MetaAddress, Master, pqsa_per_payment::Tracking), Error> {
    Ok(SchemeId3::keygen(&derive_keygen_seed(
        keygen_master,
        keygen_index,
    )?)?)
}

fn derive_keygen_seed(master: &[u8], index: u64) -> Result<Vec<u8>, Error> {
    Ok(keygen_seed(
        master,
        SchemeId3::SCHEME_ID,
        SchemeId3::NAME.as_bytes(),
        index,
        SchemeId3::KEYGEN_SEED_BYTES,
    )?)
}

fn wire_payload(announcement: &Announcement) -> AnnouncementPayload {
    let (stealth_address, ephemeral_pubkey, metadata) =
        SchemeId3::announcement_to_bytes(announcement);
    AnnouncementPayload {
        stealth_address,
        ephemeral_pubkey,
        metadata,
    }
}

/// Sign an EIP-1559 transaction and zeroize `one_time_key`.
fn sign_transaction(
    mut one_time_key: Bytes32,
    request: &Eip1559Request,
) -> Result<SignedTransaction, Error> {
    let signer = PrivateKeySigner::from_slice(&one_time_key);
    one_time_key.zeroize();
    let signer = signer.map_err(|_| Error::Signing)?;
    let mut transaction = TxEip1559 {
        chain_id: request.chain_id,
        nonce: request.nonce,
        gas_limit: request.gas_limit,
        max_fee_per_gas: request.max_fee_per_gas,
        max_priority_fee_per_gas: request.max_priority_fee_per_gas,
        to: TxKind::Call(Address::from(request.to)),
        value: U256::from_be_bytes(request.value),
        access_list: AccessList::default(),
        input: Bytes::copy_from_slice(&request.data),
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

fn fixed_bytes<const N: usize>(value: &[u8]) -> Result<[u8; N], Error> {
    value.try_into().map_err(|_| Error::InvalidLength {
        expected: N,
        actual: value.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payment_round_trip_uses_scheme_3_wire_shape() {
        // Wire sizes: meta-address 1250, ephemeral key 33, metadata 1089.
        let recipient_master = [7_u8; 32];
        let sender_master = [9_u8; 32];
        let identity = derive_identity(&recipient_master).unwrap();
        let payload = create_announcement(&identity.meta_address, &sender_master, 0).unwrap();

        println!("meta-address bytes {}", identity.meta_address.len());
        println!("ephemeral pubkey bytes {}", payload.ephemeral_pubkey.len());
        println!("metadata bytes {}", payload.metadata.len());
        println!("stealth address 0x{}", hex::encode(payload.stealth_address));

        assert_eq!(identity.meta_address.len(), 1_250);
        assert_eq!(payload.ephemeral_pubkey.len(), 33);
        assert_eq!(payload.metadata.len(), 1_089);

        let scanner = Scanner::new(
            &recipient_master,
            identity.keygen_index,
            &identity.meta_address,
        )
        .unwrap();
        let matched = scanner.scan(&payload).expect("recipient finds its payment");
        assert_eq!(matched.stealth_address, payload.stealth_address);
    }

    #[test]
    fn signed_spend_is_controlled_by_the_derived_stealth_address() {
        // Signer address equals the announced stealth address.
        let recipient_master = [3_u8; 32];
        let identity = derive_identity(&recipient_master).unwrap();
        let payload = create_announcement(&identity.meta_address, &[4_u8; 32], 0).unwrap();
        let matched = Scanner::new(
            &recipient_master,
            identity.keygen_index,
            &identity.meta_address,
        )
        .unwrap()
        .scan(&payload)
        .unwrap();
        let signed = sign_spend(
            &recipient_master,
            identity.keygen_index,
            &matched,
            &Eip1559Request {
                chain_id: 1,
                nonce: 0,
                gas_limit: 21_000,
                max_fee_per_gas: 2,
                max_priority_fee_per_gas: 1,
                to: [5_u8; 20],
                value: U256::from(1).to_be_bytes(),
                data: Vec::new(),
            },
        )
        .unwrap();

        println!("signer 0x{}", hex::encode(signed.signer));
        println!("stealth address 0x{}", hex::encode(payload.stealth_address));

        assert_eq!(signed.signer, payload.stealth_address);
        assert_eq!(signed.raw.first(), Some(&2));
    }
}
