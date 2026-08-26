#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
source_checkout="${1:?usage: $0 PATH_TO_PQSA_CHECKOUT}"

revs="$(grep -E '^pqsa-[a-z0-9-]+ = \{ git = ' "$root/Cargo.toml" \
  | sed -n 's/.*rev = "\([0-9a-f]*\)".*/\1/p' \
  | sort -u)"
if [[ -z "$revs" || "$(printf '%s\n' "$revs" | wc -l)" -ne 1 ]]; then
  echo "workspace pqsa crates are not pinned to one git rev" >&2
  exit 1
fi
revision="$revs"

actual_revision="$(git -C "$source_checkout" rev-parse HEAD)"
if [[ "$actual_revision" != "$revision" ]]; then
  echo "refusing fixture update: Cargo.toml pins $revision, checkout is $actual_revision" >&2
  exit 1
fi

destination="$root/crates/pq-stealth/tests/fixtures/pqsa-vectors"
mkdir -p "$destination/tier1"
for name in manifest.json rederivation.json section-1.json section-2.json section-2_9.json section-3.json section-3_12.json section-5.json; do
  cp "$source_checkout/vectors/$name" "$destination/$name"
done
cp "$source_checkout/vectors/tier1/ml-kem-768-acvp.json" "$destination/tier1/ml-kem-768-acvp.json"

cargo test -p pq-stealth --test conformance
