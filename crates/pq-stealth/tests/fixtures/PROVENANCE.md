# PQSA conformance fixtures

`pqsa-vectors/` is unmodified from `namnc/pq-stealth-reference-public` at the `rev` pinned
on the workspace `pqsa-{core,kem,ec,per-payment,channel,conformance}` git dependencies.
`manifest.json` checksums are verified by `pqsa-conformance::load`. Scheme 3 rows in that
tree are not executed here: hybrid per-payment is the standalone export.

`pqsa-s3-vectors/` is unmodified from `namnc/pq-stealth-scheme3-public` at the `rev` pinned
on the workspace `pqsa-s3-*` git dependencies. `tests/conformance.rs` runs V3-09 against
`pqsa-s3-per-payment::SchemeId3` and the reference runner for schemes 2, 4, and 5.

Refresh with `scripts/update-pqsa-fixtures.sh PATH_TO_REFERENCE_CHECKOUT PATH_TO_SCHEME3_CHECKOUT`.
The script refuses any checkout that does not match the matching workspace pin.
