//! Pure protocol dispatch and persisted-state transitions for PQ stealth payments.
//!
//! This crate deliberately has no provider, keystore, or storage interface. The TypeScript
//! adapter owns all host I/O; this crate owns only state shapes and calls into the pinned `pqsa`
//! implementation for protocol operations and serialization.

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub mod dispatch;

/// Unknown values require migration. A pqsa git rev change does not.
pub const SCHEMA_VERSION: u32 = 1;

/// The four protocol rungs shipped by phase 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SchemeKind {
    MlkemPerPayment,
    HybridPerPayment,
    MlkemChannel,
    HybridChannel,
}

impl SchemeKind {
    /// Whether the scheme retains per-counterparty channel state.
    #[must_use]
    pub const fn is_channel(self) -> bool {
        matches!(self, Self::MlkemChannel | Self::HybridChannel)
    }
}

/// Errors surfaced across the WASM boundary.
#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum Error {
    #[error("malformed meta-address or protocol payload")]
    MalformedMetaAddress,
    #[error("sender operational state is missing or partial")]
    MissingOperationalState,
    #[error("persisted channel has the wrong upstream role")]
    RoleMismatch,
    #[error("channel opening is already pending: {0}")]
    ChannelOpeningPending(String),
    #[error("stealth account has insufficient native gas")]
    InsufficientGas,
    #[error("storage operation failed: {0}")]
    Storage(String),
    #[error("schema version {found} is not supported; migration required")]
    MigrationRequired { found: u32 },
    #[error("sender seed was rejected and its index must remain burned")]
    SeedRejected,
    #[error("sender counter is exhausted")]
    CounterExhausted,
    #[error("tracking capability does not bind to this meta-address")]
    TrackingKeyMismatch,
    #[error("protocol operation failed: {0}")]
    Protocol(String),
    #[error("invalid transaction-state transition")]
    InvalidTransition,
}

impl From<pqsa_core::Error> for Error {
    fn from(value: pqsa_core::Error) -> Self {
        match value {
            pqsa_core::Error::Malformed => Self::MalformedMetaAddress,
            pqsa_core::Error::SeedRejected => Self::SeedRejected,
            pqsa_core::Error::CounterExhausted => Self::CounterExhausted,
            pqsa_core::Error::TrackingKeyMismatch => Self::TrackingKeyMismatch,
            other => Self::Protocol(format!("{other:?}")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Envelope<T> {
    pub schema_version: u32,
    pub value: T,
}

impl<T> Envelope<T> {
    #[must_use]
    pub fn new(value: T) -> Self {
        Self {
            schema_version: SCHEMA_VERSION,
            value,
        }
    }

    pub fn into_current(self) -> Result<T, Error> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(Error::MigrationRequired {
                found: self.schema_version,
            });
        }
        Ok(self.value)
    }
}

/// Chain-independent recipient identity manifest for one scheme.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdentityRecord {
    pub scheme: SchemeKind,
    pub scheme_id: u64,
    pub scheme_name: String,
    pub accepted_j: u64,
    /// Exact upstream ERC-6538 serialization.
    pub meta_address: Vec<u8>,
}

/// Chain-independent, next-unused sender index for one `(accountIndex, scheme)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SenderEntropyRecord {
    pub scheme: SchemeKind,
    pub next_index: u64,
}

/// Explicitly scoped tracking export.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "capability", rename_all = "kebab-case")]
pub enum TrackingCapability {
    PerPaymentTracking { scheme: SchemeKind, bytes: Vec<u8> },
    ChannelTracking { scheme: SchemeKind, bytes: Vec<u8> },
    ChannelWatch { scheme: SchemeKind, bytes: Vec<u8> },
}

/// Exact upstream announcement tuple, without inspecting its protocol fields.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WireAnnouncement {
    pub scheme: SchemeKind,
    pub scheme_id: u64,
    pub stealth_address: [u8; 20],
    pub ephemeral_pubkey: Vec<u8>,
    pub metadata: Vec<u8>,
}

/// The match material necessary to reconstruct the upstream `Match` at spend time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MatchMaterial {
    pub scheme: SchemeKind,
    pub stealth_address: [u8; 20],
    pub shared_secret: [u8; 32],
    pub channel_counter: Option<String>,
    pub channel_key: Option<[u8; 32]>,
}

/// One scanner result and the §2.8 announced/derived comparison.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanMatch {
    pub material: MatchMaterial,
    pub announced_matches_derived: bool,
}

/// Output of scanning one channel row, including the complete new channel book.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChannelScanOutput {
    pub matched: Option<ScanMatch>,
    pub channel_blobs: Vec<Vec<u8>>,
}

/// A chain position, retained with its block hash for reorg detection.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlockPosition {
    pub number: String,
    pub hash: String,
}

/// A note/holding found by scanning. Historical entries remain after they are spent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoteRecord {
    pub id: String,
    pub event_id: String,
    pub match_material: MatchMaterial,
    pub asset: String,
    pub amount: String,
    pub spent: bool,
    pub block_number: String,
    pub block_hash: String,
    pub transaction_hash: String,
    pub log_index: String,
    pub diagnostics: Vec<String>,
}

/// A complete scanner view at one canonical chain position.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScannerSnapshot {
    pub cursor: Option<BlockPosition>,
    pub channel_book: Vec<Vec<u8>>,
    pub notes: Vec<NoteRecord>,
    pub seen_event_ids: Vec<String>,
}

impl Default for ScannerSnapshot {
    fn default() -> Self {
        Self {
            cursor: None,
            channel_book: Vec::new(),
            notes: Vec::new(),
            seen_event_ids: Vec::new(),
        }
    }
}

/// One atomic scanner checkpoint per `(chain, accountIndex, scheme)`.
///
/// `finalized` is the rollback base. `current` includes the replayable tentative tail.
/// Keeping both snapshots, inactive channels, and tentative block identities in this one
/// value prevents a failed host `set` from advancing the cursor without its notes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct ScannerCheckpoint {
    pub finalized: ScannerSnapshot,
    pub current: ScannerSnapshot,
    pub inactive_channels: Vec<Vec<u8>>,
    pub tentative: Vec<BlockPosition>,
}

/// The durable lifecycle of an announcement/funding or spend operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum OperationStage {
    Prepared,
    Signed,
    Submitted,
    AnnouncementMined,
    FundingReady,
    FundingSubmitted,
    Complete,
}

/// Semantic operation class used by the pure lifecycle reducer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OperationKind {
    Registration,
    Payment,
    Spend,
}

/// Host observations reduced into a durable operation stage without performing I/O.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub struct LifecycleObservation {
    pub primary_attempt: bool,
    pub primary_broadcast: bool,
    pub primary_success: bool,
    pub funding_attempt: bool,
    pub funding_broadcast: bool,
    pub funding_success: bool,
}

/// Canonical pure lifecycle transition used by TypeScript after it gathers receipts.
#[must_use]
pub const fn reconcile_stage(
    kind: OperationKind,
    observed: LifecycleObservation,
) -> OperationStage {
    match kind {
        OperationKind::Registration | OperationKind::Spend => {
            if observed.primary_success {
                OperationStage::Complete
            } else if observed.primary_attempt && observed.primary_broadcast {
                OperationStage::Submitted
            } else if observed.primary_attempt {
                OperationStage::Signed
            } else {
                OperationStage::Prepared
            }
        }
        OperationKind::Payment => {
            if !observed.primary_success {
                if observed.primary_attempt && observed.primary_broadcast {
                    OperationStage::Submitted
                } else if observed.primary_attempt {
                    OperationStage::Signed
                } else {
                    OperationStage::Prepared
                }
            } else if observed.funding_success {
                OperationStage::Complete
            } else if observed.funding_attempt && observed.funding_broadcast {
                OperationStage::FundingSubmitted
            } else {
                OperationStage::FundingReady
            }
        }
    }
}

/// One broadcast attempt. Replacements append; they never rewrite semantic material.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct SubmissionAttempt {
    pub transaction_hash: String,
    pub raw_transaction: Option<String>,
    pub replaces: Option<String>,
}

/// A prepared operation whose announcement material remains immutable across reorgs/replacements.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PreparedOperation {
    pub id: String,
    pub scheme: SchemeKind,
    pub stage: OperationStage,
    pub announcement: WireAnnouncement,
    pub sender_channel: Option<Vec<u8>>,
    pub announcement_intent: String,
    pub funding_intent: Option<String>,
    pub attempts: Vec<SubmissionAttempt>,
    pub abandoned: bool,
}

impl PreparedOperation {
    /// Advance exactly one lifecycle edge.
    pub fn advance(&mut self, next: OperationStage) -> Result<(), Error> {
        let valid = matches!(
            (self.stage, next),
            (OperationStage::Prepared, OperationStage::Signed)
                | (OperationStage::Signed, OperationStage::Submitted)
                | (OperationStage::Prepared, OperationStage::Submitted)
                | (OperationStage::Submitted, OperationStage::AnnouncementMined)
                | (
                    OperationStage::AnnouncementMined,
                    OperationStage::FundingReady
                )
                | (
                    OperationStage::FundingReady,
                    OperationStage::FundingSubmitted
                )
                | (OperationStage::FundingSubmitted, OperationStage::Complete)
        );
        if !valid {
            return Err(Error::InvalidTransition);
        }
        self.stage = next;
        Ok(())
    }

    /// Roll back only chain-observation state; reserved entropy and payloads are untouched.
    pub fn reorg(&mut self, announcement_still_mined: bool, funding_still_mined: bool) {
        self.stage = if !announcement_still_mined {
            if self.attempts.is_empty() {
                OperationStage::Prepared
            } else {
                OperationStage::Submitted
            }
        } else if !funding_still_mined {
            OperationStage::FundingReady
        } else {
            self.stage
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_schema_requires_migration() {
        let mut envelope = Envelope::new(7_u8);
        envelope.schema_version += 1;
        assert!(matches!(
            envelope.into_current(),
            Err(Error::MigrationRequired { .. })
        ));
    }

    #[test]
    fn a_reorg_never_changes_announcement_material() {
        let announcement = WireAnnouncement {
            scheme: SchemeKind::MlkemPerPayment,
            scheme_id: 2,
            stealth_address: [1; 20],
            ephemeral_pubkey: vec![2],
            metadata: vec![3],
        };
        let mut operation = PreparedOperation {
            id: "op".into(),
            scheme: SchemeKind::MlkemPerPayment,
            stage: OperationStage::Complete,
            announcement: announcement.clone(),
            sender_channel: None,
            announcement_intent: "announce".into(),
            funding_intent: Some("fund".into()),
            attempts: vec![SubmissionAttempt {
                transaction_hash: "0x01".into(),
                raw_transaction: None,
                replaces: None,
            }],
            abandoned: false,
        };
        operation.reorg(false, false);
        assert_eq!(operation.stage, OperationStage::Submitted);
        assert_eq!(operation.announcement, announcement);
    }

    #[test]
    fn pure_reducer_moves_chain_observation_backward_only() {
        let submitted = LifecycleObservation {
            primary_attempt: true,
            primary_broadcast: true,
            ..LifecycleObservation::default()
        };
        assert_eq!(
            reconcile_stage(OperationKind::Payment, submitted),
            OperationStage::Submitted
        );
        assert_eq!(
            reconcile_stage(
                OperationKind::Payment,
                LifecycleObservation {
                    primary_success: true,
                    funding_attempt: true,
                    funding_broadcast: true,
                    funding_success: true,
                    ..submitted
                }
            ),
            OperationStage::Complete
        );
        assert_eq!(
            reconcile_stage(OperationKind::Payment, submitted),
            OperationStage::Submitted
        );
    }
}
