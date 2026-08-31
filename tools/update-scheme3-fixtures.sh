#!/usr/bin/env bash
# Copy vectors/ from a scheme3 checkout whose HEAD matches the Cargo.toml pin.
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
source_checkout="${1:?usage: $0 PATH_TO_PQ_STEALTH_SCHEME3_CHECKOUT}"
revision="$(sed -n '/^pqsa-core = .*pq-stealth-scheme3-public/ {
  s/.*rev = "\([0-9a-f]*\)".*/\1/p
}' "$root/Cargo.toml")"

if [[ -z "$revision" ]]; then
  echo "Cargo.toml has no pinned pqsa-core revision" >&2
  exit 1
fi

actual_revision="$(git -C "$source_checkout" rev-parse HEAD)"
if [[ "$actual_revision" != "$revision" ]]; then
  echo "Cargo.toml pins $revision but the source checkout is $actual_revision" >&2
  exit 1
fi

destination="$root/crates/pq-stealth-ts/tests/fixtures/scheme3"
for name in manifest.json section-1.json section-2_9.json; do
  cp "$source_checkout/vectors/$name" "$destination/$name"
done

cargo test -p pq-stealth-scheme3 --test conformance
