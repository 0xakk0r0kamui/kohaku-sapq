# PQSA conformance fixtures

Unmodified vectors from `namnc/pq-stealth-reference-public` at the `rev` pinned on
the workspace `pqsa-*` git dependencies. `manifest.json` checksums are verified by
`pqsa-conformance::load`; `tests/conformance.rs` asserts 48 executed scheme 2–5 cases.

Refresh with `scripts/update-pqsa-fixtures.sh PATH_TO_UPSTREAM_CHECKOUT`. The script
refuses any checkout that does not match the workspace pin.
