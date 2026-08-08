// Pure-Rust unit tests for the Slotword program.
// Run with: cargo test --manifest-path programs/slotword/Cargo.toml
//
// Note: These tests exercise pure hash/economics logic without deploying
// the program. For end-to-end coverage use `anchor test` (TypeScript) or
// add a separate LiteSVM/Surfpool integration-test crate.

#![cfg(test)]

use solana_keypair::Keypair;
use solana_pubkey::Pubkey;
use solana_signer::Signer;

#[test]
fn test_smoke_keypair() {
    let payer = Keypair::new();
    assert!(payer.pubkey() != Pubkey::default());
}

#[test]
fn test_commit_revealed_word_distinct_per_room() {
    // Psychological test: two rooms on the same day should NOT have the
    // same room_solution_hash. If they did, the prior-knowledge cheat would
    // not be fully addressed.
    use sha2::{Digest, Sha256};
    let slot_hash_seed = [7u8; 32];

    let room_a = Pubkey::new_unique();
    let room_b = Pubkey::new_unique();

    let mut ha = Sha256::new();
    ha.update(slot_hash_seed);
    ha.update(room_a.to_bytes());
    ha.update(b"DUEL");
    let digest_a = ha.finalize();

    let mut hb = Sha256::new();
    hb.update(slot_hash_seed);
    hb.update(room_b.to_bytes());
    hb.update(b"DUEL");
    let digest_b = hb.finalize();

    assert_ne!(
        digest_a.as_slice(),
        digest_b.as_slice(),
        "two rooms on the same day must hash to different room_solution_hash values"
    );
}

#[test]
fn test_per_room_word_differs_from_daily_word() {
    // The duel word must NOT equal the daily free word for the prior-knowledge
    // cheat fix to work. The daily solution_hash = SHA-256(slot_hash_seed || word).
    // The room_solution_hash = SHA-256(slot_hash_seed || room.key() || "DUEL").
    // For the same word, the daily solution_hash and the room_solution_hash
    // must differ.
    use sha2::{Digest, Sha256};
    let slot_hash_seed = [9u8; 32];
    let word = b"BLOCK";
    let room = Pubkey::new_unique();

    let mut daily_hasher = Sha256::new();
    daily_hasher.update(slot_hash_seed);
    daily_hasher.update(word);
    let daily_digest = daily_hasher.finalize();

    let mut room_hasher = Sha256::new();
    room_hasher.update(slot_hash_seed);
    room_hasher.update(room.to_bytes());
    room_hasher.update(b"DUEL");
    let room_digest = room_hasher.finalize();

    assert_ne!(
        daily_digest.as_slice(),
        room_digest.as_slice(),
        "daily solution_hash and room_solution_hash must differ even when the word is the same"
    );
}

#[test]
fn test_duel_word_commitment_round_trip() {
    // Option 1 scheme: the word is committed WITHOUT publishing it.
    //   room_solution_hash = SHA-256(slot_hash_seed || room.key() || "DUEL")  (at creation)
    //   commitment         = SHA-256(room_solution_hash || word)             (set_duel_word)
    // Reveal recomputes SHA-256(room_solution_hash || word) and compares.
    use sha2::{Digest, Sha256};
    let slot_hash_seed = [11u8; 32];
    let room = Pubkey::new_unique();
    let word = b"CRANE";

    let mut room_hasher = Sha256::new();
    room_hasher.update(slot_hash_seed);
    room_hasher.update(room.to_bytes());
    room_hasher.update(b"DUEL");
    let room_solution_hash = room_hasher.finalize();

    // The authority commits the hash — the plaintext word never goes on-chain.
    let mut commit_hasher = Sha256::new();
    commit_hasher.update(room_solution_hash.as_slice());
    commit_hasher.update(word);
    let commitment = commit_hasher.finalize();

    // Reveal: same computation must match.
    let mut reveal_hasher = Sha256::new();
    reveal_hasher.update(room_solution_hash.as_slice());
    reveal_hasher.update(word);
    let recomputed = reveal_hasher.finalize();
    assert_eq!(commitment.as_slice(), recomputed.as_slice());

    // A wrong word must fail the reveal check.
    let mut wrong_hasher = Sha256::new();
    wrong_hasher.update(room_solution_hash.as_slice());
    wrong_hasher.update(b"WRONG");
    let wrong = wrong_hasher.finalize();
    assert_ne!(commitment.as_slice(), wrong.as_slice());

    // The commitment must NOT leak the word via the old plaintext-style
    // daily formula (SHA-256(seed || word)) — inputs differ structurally.
    let mut daily_style = Sha256::new();
    daily_style.update(slot_hash_seed);
    daily_style.update(word);
    assert_ne!(commitment.as_slice(), daily_style.finalize().as_slice());
}

#[test]
fn test_reveal_validation_round_trip() {
    // Commit-Reveal integrity: SHA-256(word || salt || wallet) must match
    // on commit and on reveal. Wrong salt must fail.
    use sha2::{Digest, Sha256};
    let word = b"STAKE";
    let salt = [42u8; 32];
    let wallet = Pubkey::new_unique();

    let mut hasher = Sha256::new();
    hasher.update(word);
    hasher.update(salt);
    hasher.update(wallet.to_bytes());
    let commit_hash = hasher.finalize();

    // Same inputs on reveal must produce the same hash.
    let mut reveal_hasher = Sha256::new();
    reveal_hasher.update(word);
    reveal_hasher.update(salt);
    reveal_hasher.update(wallet.to_bytes());
    let reveal_hash = reveal_hasher.finalize();

    assert_eq!(commit_hash.as_slice(), reveal_hash.as_slice());

    // A wrong salt must produce a different hash.
    let wrong_salt = [0u8; 32];
    let mut wrong_hasher = Sha256::new();
    wrong_hasher.update(word);
    wrong_hasher.update(wrong_salt);
    wrong_hasher.update(wallet.to_bytes());
    let wrong_hash = wrong_hasher.finalize();
    assert_ne!(commit_hash.as_slice(), wrong_hash.as_slice());
}

#[test]
fn test_keeper_tip_is_sustainable() {
    // Economic test from the roast: at $2 stake (2_000_000 USDC units at 6 decimals),
    // 2% platform fee on the $4 pot = $0.08 = 80_000 units.
    // Keeper tip floor is 0.05 USDC (50_000 units). If keeper_tip_from_fee = true,
    // the tip is min(fee, keeper_tip_usdc).
    // At $2 stakes, the fee covers the tip, so the keeper earns the full 50_000 floor
    // and the platform keeps the 30_000 remainder.
    let stake: u64 = 2_000_000; // $2 USDC at 6 decimals
    let platform_fee_bps: u16 = 200; // 2%
    let keeper_tip_usdc: u64 = 50_000; // $0.05
    let total_pot = stake * 2;
    let fee = total_pot * (platform_fee_bps as u64) / 10_000;
    assert_eq!(fee, 80_000, "2% of $4 pot = $0.08 = 80_000 units");

    let keeper_tip = fee.min(keeper_tip_usdc);
    assert_eq!(keeper_tip, keeper_tip_usdc, "fee covers tip, so keeper earns full floor");

    let net_platform_revenue = fee - keeper_tip;
    assert_eq!(net_platform_revenue, 30_000, "platform keeps $0.03");

    // Triangle case: at $0.50 stake (minimum), pot = $1, fee = $0.02 = 20_000.
    // Tip floor (50_000) > fee (20_000), so keeper earns the full fee.
    let small_stake: u64 = 500_000;
    let small_pot = small_stake * 2;
    let small_fee = small_pot * (platform_fee_bps as u64) / 10_000;
    assert_eq!(small_fee, 20_000, "2% of $1 pot = $0.02 = 20_000 units");
    let small_tip = small_fee.min(keeper_tip_usdc);
    assert_eq!(small_tip, small_fee, "fee does NOT cover tip, keeper earns full fee");
    assert!(small_tip < keeper_tip_usdc, "keeper does not earn the full floor at minimum stakes");
}
