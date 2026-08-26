//! The only semantic-name to concrete-PQSA-type dispatch in the integration.

use pqsa_channel::{
    ChannelScheme, Master as ChannelMaster, Match as ChannelMatch, ScannerChannel, ScannerChannels,
    SchemeId4, SchemeId5, Tracking as ChannelTracking,
};
use pqsa_core::{Bytes32, SenderState, StealthScheme, keygen_seed};
use pqsa_per_payment::{
    Master as PaymentMaster, Match as PaymentMatch, MetaAddress as PaymentMeta, SchemeId2,
    SchemeId3, Tracking as PaymentTracking,
};

use crate::{
    ChannelScanOutput, Error, IdentityRecord, MatchMaterial, ScanMatch, SchemeKind,
    TrackingCapability, WireAnnouncement,
};

const KEYGEN_TRIES: u32 = 1_024;

/// Canonical upstream information for a semantic scheme name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SchemeInfo {
    pub id: u64,
    pub name: &'static str,
    pub keygen_seed_bytes: usize,
    pub announce_seed_bytes: usize,
}

/// Return constants from the concrete upstream implementation, never duplicated literals.
#[must_use]
pub fn scheme_info(kind: SchemeKind) -> SchemeInfo {
    match kind {
        SchemeKind::MlkemPerPayment => info_payment::<SchemeId2>(),
        SchemeKind::HybridPerPayment => info_payment::<SchemeId3>(),
        SchemeKind::MlkemChannel => info_channel::<SchemeId4>(),
        SchemeKind::HybridChannel => info_channel::<SchemeId5>(),
    }
}

/// Validate an ERC-6538 value with the concrete upstream parser selected by scheme id.
pub fn validate_meta(kind: SchemeKind, bytes: &[u8]) -> bool {
    match kind {
        SchemeKind::MlkemPerPayment => SchemeId2::meta_from_bytes(bytes).is_some(),
        SchemeKind::HybridPerPayment => SchemeId3::meta_from_bytes(bytes).is_some(),
        SchemeKind::MlkemChannel => SchemeId4::meta_from_bytes(bytes).is_some(),
        SchemeKind::HybridChannel => SchemeId5::meta_from_bytes(bytes).is_some(),
    }
}

fn info_payment<S: StealthScheme>() -> SchemeInfo {
    SchemeInfo {
        id: S::SCHEME_ID,
        name: S::NAME,
        keygen_seed_bytes: S::KEYGEN_SEED_BYTES,
        announce_seed_bytes: S::ANNOUNCE_SEED_BYTES,
    }
}

fn info_channel<C: ChannelScheme>() -> SchemeInfo {
    SchemeInfo {
        id: C::SCHEME_ID,
        name: C::NAME,
        keygen_seed_bytes: C::KEYGEN_SEED_BYTES,
        announce_seed_bytes: C::ANNOUNCE_SEED_BYTES,
    }
}

/// Deterministically derive identity, retrying keygen indices and recording the accepted `j`.
pub fn create_identity(kind: SchemeKind, keygen_master: &[u8]) -> Result<IdentityRecord, Error> {
    match kind {
        SchemeKind::MlkemPerPayment => create_payment_identity::<SchemeId2>(kind, keygen_master),
        SchemeKind::HybridPerPayment => create_payment_identity::<SchemeId3>(kind, keygen_master),
        SchemeKind::MlkemChannel => create_channel_identity::<SchemeId4>(kind, keygen_master),
        SchemeKind::HybridChannel => create_channel_identity::<SchemeId5>(kind, keygen_master),
    }
}

fn create_payment_identity<S>(kind: SchemeKind, master: &[u8]) -> Result<IdentityRecord, Error>
where
    S: StealthScheme<Meta = PaymentMeta, Master = PaymentMaster, Tracking = PaymentTracking>,
{
    for j in 0..u64::from(KEYGEN_TRIES) {
        let seed = keygen_seed(
            master,
            S::SCHEME_ID,
            S::NAME.as_bytes(),
            j,
            S::KEYGEN_SEED_BYTES,
        )?;
        match S::keygen(&seed) {
            Ok((meta, _, _)) => {
                return Ok(IdentityRecord {
                    scheme: kind,
                    scheme_id: S::SCHEME_ID,
                    scheme_name: S::NAME.to_owned(),
                    accepted_j: j,
                    meta_address: S::meta_to_bytes(&meta),
                });
            }
            Err(pqsa_core::Error::NoValidScalar | pqsa_core::Error::SpendingKeyDelegated) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(Error::Protocol("keygen retry bound exhausted".into()))
}

fn create_channel_identity<C: ChannelScheme>(
    kind: SchemeKind,
    master: &[u8],
) -> Result<IdentityRecord, Error> {
    for j in 0..u64::from(KEYGEN_TRIES) {
        let seed = keygen_seed(
            master,
            C::SCHEME_ID,
            C::NAME.as_bytes(),
            j,
            C::KEYGEN_SEED_BYTES,
        )?;
        match C::keygen(&seed) {
            Ok((meta, _, _)) => {
                return Ok(IdentityRecord {
                    scheme: kind,
                    scheme_id: C::SCHEME_ID,
                    scheme_name: C::NAME.to_owned(),
                    accepted_j: j,
                    meta_address: C::meta_to_bytes(&meta),
                });
            }
            Err(pqsa_core::Error::NoValidScalar | pqsa_core::Error::SpendingKeyDelegated) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Err(Error::Protocol("keygen retry bound exhausted".into()))
}

/// Re-derive the explicitly tagged tracking capability for backup/delegation.
pub fn tracking_capability(
    identity: &IdentityRecord,
    keygen_master: &[u8],
) -> Result<TrackingCapability, Error> {
    match identity.scheme {
        SchemeKind::MlkemPerPayment => {
            let (_, _, tracking) = payment_keys::<SchemeId2>(keygen_master, identity.accepted_j)?;
            Ok(TrackingCapability::PerPaymentTracking {
                scheme: identity.scheme,
                bytes: tracking_bytes_payment(&tracking),
            })
        }
        SchemeKind::HybridPerPayment => {
            let (_, _, tracking) = payment_keys::<SchemeId3>(keygen_master, identity.accepted_j)?;
            Ok(TrackingCapability::PerPaymentTracking {
                scheme: identity.scheme,
                bytes: tracking_bytes_payment(&tracking),
            })
        }
        SchemeKind::MlkemChannel => {
            let (_, _, tracking) = channel_keys::<SchemeId4>(keygen_master, identity.accepted_j)?;
            Ok(TrackingCapability::ChannelTracking {
                scheme: identity.scheme,
                bytes: tracking_bytes_channel(&tracking),
            })
        }
        SchemeKind::HybridChannel => {
            let (_, _, tracking) = channel_keys::<SchemeId5>(keygen_master, identity.accepted_j)?;
            Ok(TrackingCapability::ChannelTracking {
                scheme: identity.scheme,
                bytes: tracking_bytes_channel(&tracking),
            })
        }
    }
}

fn tracking_bytes_payment(tracking: &PaymentTracking) -> Vec<u8> {
    tracking
        .viewing_ec_seed
        .iter()
        .flat_map(|seed| seed.as_slice())
        .chain(tracking.kem_seed.iter())
        .copied()
        .collect()
}

fn tracking_bytes_channel(tracking: &ChannelTracking) -> Vec<u8> {
    tracking
        .viewing_ec_seed
        .iter()
        .flat_map(|seed| seed.as_slice())
        .chain(tracking.kem_seed.iter())
        .copied()
        .collect()
}

/// A drawn seed kept opaque by the WASM facade until TS persists `next_index`.
pub struct SenderReservation {
    kind: SchemeKind,
    index: u64,
    next_index: u64,
    seed: Vec<u8>,
}

impl SenderReservation {
    #[must_use]
    pub const fn kind(&self) -> SchemeKind {
        self.kind
    }

    #[must_use]
    pub const fn index(&self) -> u64 {
        self.index
    }

    #[must_use]
    pub const fn next_index(&self) -> u64 {
        self.next_index
    }
}

/// Draw exactly one upstream sender seed. Callers must persist `next_index` before completion.
pub fn reserve_sender(
    kind: SchemeKind,
    sender_master: &[u8],
    next_index: u64,
) -> Result<SenderReservation, Error> {
    let master: Bytes32 = sender_master
        .try_into()
        .map_err(|_| Error::MissingOperationalState)?;
    let mut sender = SenderState::resume(master, next_index);
    let seed = match kind {
        SchemeKind::MlkemPerPayment => sender.draw_seed::<SchemeId2>(),
        SchemeKind::HybridPerPayment => sender.draw_seed::<SchemeId3>(),
        SchemeKind::MlkemChannel => pqsa_channel::draw_announce_seed::<SchemeId4>(&mut sender),
        SchemeKind::HybridChannel => pqsa_channel::draw_announce_seed::<SchemeId5>(&mut sender),
    }?;
    Ok(SenderReservation {
        kind,
        index: next_index,
        next_index: sender.counter(),
        seed,
    })
}

/// Result of consuming a reservation for either an announcement or first contact.
pub struct ReservationOutput {
    pub announcement: WireAnnouncement,
    pub sender_channel: Option<Vec<u8>>,
}

/// Consume already-reserved entropy using only upstream announce/open and serializers.
pub fn complete_reservation(
    reservation: SenderReservation,
    meta_bytes: &[u8],
) -> Result<ReservationOutput, Error> {
    match reservation.kind {
        SchemeKind::MlkemPerPayment => {
            complete_payment::<SchemeId2>(reservation.kind, &reservation.seed, meta_bytes)
        }
        SchemeKind::HybridPerPayment => {
            complete_payment::<SchemeId3>(reservation.kind, &reservation.seed, meta_bytes)
        }
        SchemeKind::MlkemChannel => {
            complete_channel::<SchemeId4>(reservation.kind, &reservation.seed, meta_bytes)
        }
        SchemeKind::HybridChannel => {
            complete_channel::<SchemeId5>(reservation.kind, &reservation.seed, meta_bytes)
        }
    }
}

fn complete_payment<S>(
    kind: SchemeKind,
    seed: &[u8],
    meta_bytes: &[u8],
) -> Result<ReservationOutput, Error>
where
    S: StealthScheme<Meta = PaymentMeta>,
{
    let meta = S::meta_from_bytes(meta_bytes).ok_or(Error::MalformedMetaAddress)?;
    let announcement = S::announce(&meta, seed)?;
    let (stealth_address, ephemeral_pubkey, metadata) = S::announcement_to_bytes(&announcement);
    Ok(ReservationOutput {
        announcement: WireAnnouncement {
            scheme: kind,
            scheme_id: S::SCHEME_ID,
            stealth_address,
            ephemeral_pubkey,
            metadata,
        },
        sender_channel: None,
    })
}

fn complete_channel<C: ChannelScheme>(
    kind: SchemeKind,
    seed: &[u8],
    meta_bytes: &[u8],
) -> Result<ReservationOutput, Error> {
    let meta = C::meta_from_bytes(meta_bytes).ok_or(Error::MalformedMetaAddress)?;
    let (first_contact, channel) = C::open(&meta, seed)?;
    let (stealth_address, ephemeral_pubkey, metadata) = C::first_contact_to_bytes(&first_contact);
    Ok(ReservationOutput {
        announcement: WireAnnouncement {
            scheme: kind,
            scheme_id: C::SCHEME_ID,
            stealth_address,
            ephemeral_pubkey,
            metadata,
        },
        sender_channel: Some(channel.to_bytes()),
    })
}

/// Advance a sender channel before exposing its memo. Restore always goes through upstream.
pub fn pay_channel(kind: SchemeKind, sender_blob: &[u8]) -> Result<ReservationOutput, Error> {
    if !kind.is_channel() {
        return Err(Error::MalformedMetaAddress);
    }
    let mut channel =
        pqsa_channel::SenderChannel::from_bytes(sender_blob).map_err(|_| Error::RoleMismatch)?;
    let memo = channel.pay()?;
    let (stealth_address, ephemeral_pubkey, metadata) = pqsa_channel::memo_to_bytes(&memo);
    Ok(ReservationOutput {
        announcement: WireAnnouncement {
            scheme: kind,
            scheme_id: scheme_info(kind).id,
            stealth_address,
            ephemeral_pubkey,
            metadata,
        },
        sender_channel: Some(channel.to_bytes()),
    })
}

/// Scan one per-payment row. Scheme dispatch occurs before any payload parser is selected.
pub fn scan_payment(
    kind: SchemeKind,
    keygen_master: &[u8],
    accepted_j: u64,
    meta_bytes: &[u8],
    wire: &WireAnnouncement,
) -> Result<Option<ScanMatch>, Error> {
    if wire.scheme != kind || wire.scheme_id != scheme_info(kind).id {
        return Ok(None);
    }
    match kind {
        SchemeKind::MlkemPerPayment => {
            scan_payment_as::<SchemeId2>(kind, keygen_master, accepted_j, meta_bytes, wire)
        }
        SchemeKind::HybridPerPayment => {
            scan_payment_as::<SchemeId3>(kind, keygen_master, accepted_j, meta_bytes, wire)
        }
        SchemeKind::MlkemChannel | SchemeKind::HybridChannel => Ok(None),
    }
}

fn scan_payment_as<S>(
    kind: SchemeKind,
    keygen_master: &[u8],
    accepted_j: u64,
    meta_bytes: &[u8],
    wire: &WireAnnouncement,
) -> Result<Option<ScanMatch>, Error>
where
    S: StealthScheme<
            Meta = PaymentMeta,
            Master = PaymentMaster,
            Tracking = PaymentTracking,
            Match = PaymentMatch,
        >,
{
    let (_, _, tracking) = payment_keys::<S>(keygen_master, accepted_j)?;
    let meta = S::meta_from_bytes(meta_bytes).ok_or(Error::MalformedMetaAddress)?;
    let scanner = S::bind(&tracking, &meta)?;
    let Some(announcement) = S::announcement_from_bytes(
        &wire.stealth_address,
        &wire.ephemeral_pubkey,
        &wire.metadata,
    ) else {
        return Ok(None);
    };
    let Some(matched) = S::scan(&scanner, &announcement) else {
        return Ok(None);
    };
    let derived = S::match_address(&matched);
    Ok(Some(ScanMatch {
        material: MatchMaterial {
            scheme: kind,
            stealth_address: derived,
            shared_secret: matched.shared_secret,
            channel_counter: None,
            channel_key: None,
        },
        announced_matches_derived: derived == wire.stealth_address,
    }))
}

/// Scan one first-contact or memo and return a complete, role-checked channel book.
pub fn scan_channel(
    kind: SchemeKind,
    keygen_master: &[u8],
    accepted_j: u64,
    meta_bytes: &[u8],
    wire: &WireAnnouncement,
    channel_blobs: &[Vec<u8>],
    lookahead: usize,
) -> Result<ChannelScanOutput, Error> {
    if wire.scheme != kind || wire.scheme_id != scheme_info(kind).id {
        return Ok(ChannelScanOutput {
            matched: None,
            channel_blobs: channel_blobs.to_vec(),
        });
    }
    match kind {
        SchemeKind::MlkemChannel => scan_channel_as::<SchemeId4>(
            kind,
            keygen_master,
            accepted_j,
            meta_bytes,
            wire,
            channel_blobs,
            lookahead,
        ),
        SchemeKind::HybridChannel => scan_channel_as::<SchemeId5>(
            kind,
            keygen_master,
            accepted_j,
            meta_bytes,
            wire,
            channel_blobs,
            lookahead,
        ),
        SchemeKind::MlkemPerPayment | SchemeKind::HybridPerPayment => {
            Err(Error::MalformedMetaAddress)
        }
    }
}

fn scan_channel_as<C: ChannelScheme>(
    kind: SchemeKind,
    keygen_master: &[u8],
    accepted_j: u64,
    meta_bytes: &[u8],
    wire: &WireAnnouncement,
    channel_blobs: &[Vec<u8>],
    lookahead: usize,
) -> Result<ChannelScanOutput, Error> {
    if !(pqsa_channel::SCAN_LOOKAHEAD_MIN..=pqsa_channel::SCAN_LOOKAHEAD_MAX).contains(&lookahead) {
        return Err(Error::MalformedMetaAddress);
    }
    let (_, _, tracking) = channel_keys::<C>(keygen_master, accepted_j)?;
    let meta = C::meta_from_bytes(meta_bytes).ok_or(Error::MalformedMetaAddress)?;
    let scanner = C::bind(&tracking, &meta)?;
    let mut book = ScannerChannels::default();
    for blob in channel_blobs {
        let channel = ScannerChannel::from_bytes(blob).map_err(|_| Error::RoleMismatch)?;
        let _ = book.restore(channel);
    }

    let mut matched = None;
    if let Some(first_contact) = C::first_contact_from_bytes(
        &wire.stealth_address,
        &wire.ephemeral_pubkey,
        &wire.metadata,
    ) {
        if let Some((channel, found)) = C::admit(&scanner, &first_contact) {
            let channel = channel_with_lookahead(channel, lookahead)?;
            if book.restore(channel) {
                matched = Some(channel_scan_match(kind, found, &wire.stealth_address));
            }
        }
    } else if let Some(memo) = pqsa_channel::memo_from_bytes(
        &wire.stealth_address,
        &wire.ephemeral_pubkey,
        &wire.metadata,
    ) {
        matched = book
            .match_memo(&memo)
            .map(|found| channel_scan_match(kind, found, &wire.stealth_address));
    }

    Ok(ChannelScanOutput {
        matched,
        channel_blobs: book.iter().map(ScannerChannel::to_bytes).collect(),
    })
}

fn channel_with_lookahead(
    channel: ScannerChannel,
    lookahead: usize,
) -> Result<ScannerChannel, Error> {
    if lookahead == pqsa_channel::SCAN_LOOKAHEAD {
        return Ok(channel);
    }
    let mut bytes = channel.to_bytes();
    let encoded = u32::try_from(lookahead)
        .map_err(|_| Error::MalformedMetaAddress)?
        .to_be_bytes();
    bytes[82..86].copy_from_slice(&encoded);
    ScannerChannel::from_bytes(&bytes).map_err(Error::from)
}

fn channel_scan_match(kind: SchemeKind, matched: ChannelMatch, announced: &[u8; 20]) -> ScanMatch {
    ScanMatch {
        announced_matches_derived: matched.stealth_address == *announced,
        material: MatchMaterial {
            scheme: kind,
            stealth_address: matched.stealth_address,
            shared_secret: matched.shared_secret,
            channel_counter: Some(matched.counter.to_string()),
            channel_key: Some(matched.channel_key),
        },
    }
}

/// Convert a scanner channel into the upstream role-tagged watch capability.
pub fn channel_watch(kind: SchemeKind, scanner_blob: &[u8]) -> Result<TrackingCapability, Error> {
    if !kind.is_channel() {
        return Err(Error::MalformedMetaAddress);
    }
    let channel = ScannerChannel::from_bytes(scanner_blob).map_err(|_| Error::RoleMismatch)?;
    Ok(TrackingCapability::ChannelWatch {
        scheme: kind,
        bytes: channel.to_watch().to_bytes(),
    })
}

/// Derive the one-time scalar for immediate in-process transaction signing.
///
/// This function is Rust-only. The WASM facade never exports the returned scalar.
pub fn spend_key_for_match(
    keygen_master: &[u8],
    accepted_j: u64,
    material: &MatchMaterial,
) -> Result<Bytes32, Error> {
    match material.scheme {
        SchemeKind::MlkemPerPayment => {
            spend_payment::<SchemeId2>(keygen_master, accepted_j, material)
        }
        SchemeKind::HybridPerPayment => {
            spend_payment::<SchemeId3>(keygen_master, accepted_j, material)
        }
        SchemeKind::MlkemChannel => spend_channel::<SchemeId4>(keygen_master, accepted_j, material),
        SchemeKind::HybridChannel => {
            spend_channel::<SchemeId5>(keygen_master, accepted_j, material)
        }
    }
}

fn spend_payment<S>(
    keygen_master: &[u8],
    accepted_j: u64,
    material: &MatchMaterial,
) -> Result<Bytes32, Error>
where
    S: StealthScheme<
            Meta = PaymentMeta,
            Master = PaymentMaster,
            Tracking = PaymentTracking,
            Match = PaymentMatch,
            SpendKey = Bytes32,
        >,
{
    let (_, master, _) = payment_keys::<S>(keygen_master, accepted_j)?;
    let matched = PaymentMatch {
        stealth_address: material.stealth_address,
        shared_secret: material.shared_secret,
    };
    Ok(S::spend_key(&master, &matched)?)
}

fn spend_channel<C: ChannelScheme>(
    keygen_master: &[u8],
    accepted_j: u64,
    material: &MatchMaterial,
) -> Result<Bytes32, Error> {
    let (_, master, _) = channel_keys::<C>(keygen_master, accepted_j)?;
    let counter = material
        .channel_counter
        .as_deref()
        .ok_or(Error::MalformedMetaAddress)?
        .parse()
        .map_err(|_| Error::MalformedMetaAddress)?;
    let channel_key = material.channel_key.ok_or(Error::MalformedMetaAddress)?;
    let matched = ChannelMatch {
        stealth_address: material.stealth_address,
        shared_secret: material.shared_secret,
        counter,
        channel_key,
    };
    Ok(pqsa_channel::spend_key(&master, &matched)?)
}

fn payment_keys<S>(
    keygen_master: &[u8],
    accepted_j: u64,
) -> Result<(PaymentMeta, PaymentMaster, PaymentTracking), Error>
where
    S: StealthScheme<Meta = PaymentMeta, Master = PaymentMaster, Tracking = PaymentTracking>,
{
    let seed = keygen_seed(
        keygen_master,
        S::SCHEME_ID,
        S::NAME.as_bytes(),
        accepted_j,
        S::KEYGEN_SEED_BYTES,
    )?;
    Ok(S::keygen(&seed)?)
}

fn channel_keys<C: ChannelScheme>(
    keygen_master: &[u8],
    accepted_j: u64,
) -> Result<(pqsa_channel::MetaAddress, ChannelMaster, ChannelTracking), Error> {
    let seed = keygen_seed(
        keygen_master,
        C::SCHEME_ID,
        C::NAME.as_bytes(),
        accepted_j,
        C::KEYGEN_SEED_BYTES,
    )?;
    Ok(C::keygen(&seed)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn canonical_dispatch_is_pinned_to_upstream_constants() {
        assert_eq!(
            scheme_info(SchemeKind::MlkemPerPayment).id,
            SchemeId2::SCHEME_ID
        );
        assert_eq!(
            scheme_info(SchemeKind::HybridPerPayment).name,
            SchemeId3::NAME
        );
        assert_eq!(
            scheme_info(SchemeKind::MlkemChannel).id,
            SchemeId4::SCHEME_ID
        );
        assert_eq!(scheme_info(SchemeKind::HybridChannel).name, SchemeId5::NAME);
    }

    #[test]
    fn cross_scheme_sender_indexes_are_independent_records() {
        let master = [7_u8; 32];
        let two = reserve_sender(SchemeKind::MlkemPerPayment, &master, 0).unwrap();
        let four = reserve_sender(SchemeKind::MlkemChannel, &master, 0).unwrap();
        assert_eq!(two.index(), 0);
        assert_eq!(four.index(), 0);
        assert_eq!(two.next_index(), 1);
        assert_eq!(four.next_index(), 1);
    }
}
