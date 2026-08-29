#!/usr/bin/env bash
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
source_checkout="${1:?usage: $0 PATH_TO_REFERENCE_CHECKOUT [PATH_TO_SCHEME3_CHECKOUT]}"
scheme3_checkout="${2:-}"

pin_rev() {
  local pattern="$1"
  local revs
  revs="$(grep -E "$pattern" "$root/Cargo.toml" \
    | sed -n 's/.*rev = "\([0-9a-f]*\)".*/\1/p' \
    | sort -u)"
  if [[ -z "$revs" || "$(printf '%s\n' "$revs" | wc -l)" -ne 1 ]]; then
    echo "workspace crates matching $pattern are not pinned to one git rev" >&2
    exit 1
  fi
  printf '%s' "$revs"
}

revision="$(pin_rev '^pqsa-(core|kem|ec|per-payment|channel|conformance) = \{ git = ')"
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

if [[ -n "$scheme3_checkout" ]]; then
  s3_revision="$(pin_rev '^pqsa-s3-[a-z0-9-]+ = \{ ')"
  actual_s3="$(git -C "$scheme3_checkout" rev-parse HEAD)"
  if [[ "$actual_s3" != "$s3_revision" ]]; then
    echo "refusing scheme3 fixture update: Cargo.toml pins $s3_revision, checkout is $actual_s3" >&2
    exit 1
  fi
  s3_destination="$root/crates/pq-stealth/tests/fixtures/pqsa-s3-vectors"
  mkdir -p "$s3_destination"
  for name in manifest.json section-1.json section-2_9.json; do
    cp "$scheme3_checkout/vectors/$name" "$s3_destination/$name"
  done
fi

cargo test -p pq-stealth --test conformance
