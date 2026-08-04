# Slotword
**Tagline:** *The word is locked to the slot. The slot is locked to the chain.*
**Product Requirements Document**
**Version:** 6.3 (Renamed: Slotword) | **Network:** Solana Mainnet | **Target Date:** July 14, 2026

## 1. What It Is
Slotword is a daily on-chain word puzzle. Players guess a five-letter crypto term in up to six attempts. Every solve and competition result is recorded on-chain against the player's wallet and is verifiable after the day ends.

Players compete free for daily leaderboard rank, or stake USDC in a 1v1 duel where the faster solver wins the pot on-chain. Two on-chain mechanisms secure the game:

- **Commit-before-guess:** The daily answer hash is committed on-chain before any player makes a guess. The answer cannot be retroactively changed after the first guess.
- **Commit-Reveal for duels:** In staked duels, players submit a hash of their answer before submitting the plaintext word, so the loser cannot copy the winner's answer from the public ledger. Each duel uses a **separately-seeded word** so prior knowledge of the daily free word does not help.

Settlement executes in a single Anchor instruction. The platform runs the primary keeper on a scheduled job; the instruction can also be called by any wallet as a fallback.

## 2. Game Modes
**Practice Mode**
No wallet required. The puzzle loads from the server-side hint API. Solves are not recorded on-chain. Zero-friction onboarding for players unfamiliar with crypto vocabulary or the game format.

**Daily Free Mode**
Wallet connected. The player solves the daily word in up to six attempts via the hint API. On a correct solve, the server returns the word alongside the final hint response. The client uses this word to sign and submit the `submit_solution` transaction. The Anchor program verifies correctness and writes a `SolverRecord` PDA storing the player's attempt count. The global daily leaderboard ranks all solvers by fewest attempts; submission order serves as the tiebreak.

**1v1 Staked Duel (Commit-Reveal, Per-Room Word)**
One player creates a duel room and escrows USDC on-chain. A second player joins by matching the stake. Both players solve a **word derived for this specific room** (not the daily free word). To prevent answer-copying from the public ledger, staked duels use a 2-step cryptographic handshake:

1. **Lock (Commit):** Upon solving, the player submits a hidden hash of their answer + a secret salt. The smart contract locks in their exact timestamp.
2. **Verify (Reveal):** The player submits the plaintext word and salt. The contract verifies it matches the locked hash and the per-room expected answer (derived from the daily seed and the room's key, see Section 3).

Because the duel word is derived per room and is distinct from the daily free word, a player who solved the daily free puzzle in the morning has **no advantage** entering an evening duel. The Commit-Reveal flow prevents the loser from copying the winner's Reveal transaction to tie. Settlement resolves all outcome paths based on the **Commit timestamps**.

**Frontend Commit-Reveal UX (honest spec):** The two transactions require two wallet signatures. Where the player's wallet supports atomic multi-instruction transactions (most modern Solana wallets), both instructions are bundled into a single signed transaction so the user sees one approval popup. Where the wallet does not, the UI shows an explicit two-step state indicator: "1/2 Locking your answer…" → "2/2 Verifying…", with a retry button on step 2 if the Reveal transaction is dropped. The previous "single loading spinner" abstraction is removed — it hid a failure mode users must be able to see.

## 3. Architecture Overview
**Daily initialization** — runs once at UTC midnight via backend cron
```text
  Clock sysvar
  unix_timestamp / 86_400 ──────────> day_index

  SlotHashes sysvar
  most recent slot hash ─────────────> slot_hash_seed (stored for auditability)

  Backend computes:
  solution_hash = SHA-256(slot_hash_seed || word)

  Backend calls initialize_day(solution_hash)
  → DailyChallenge PDA created on-chain
```

**Per-room duel word derivation** — critical for duel integrity
```text
  The DailyChallenge PDA stores: day_index, slot_hash_seed, solution_hash.
  The DuelRoom PDA stores: room_id, daily_challenge, stake, deadline, ...

  When a duel is created, the contract commits to a per-room answer:
  room_solution_hash = SHA-256(slot_hash_seed || room.key() || "DUEL")

  The hint server derives the SAME per-room word for room members by
  looking up the entry in the word list whose hash matches
  room_solution_hash.

  Result: a daily-free solver has zero information about the duel word.
  Two duel rooms on the same day use different words.
  The backend operator picks the daily word but does NOT pick the
  per-room word — it is deterministically derived from on-chain state
  the operator cannot control (slot_hash_seed) and the room's own pubkey.
```

**Player solve loop — Daily Free**
```text
  Client POST /api/hint { wallet, day_index, guess }
        ← Server evaluates guess against private word
        ← Returns { hints, solved, attempts_remaining }
        ← When solved == true, also returns { word }

  Client constructs transaction:
    submit_solution(word, attempts)

  Anchor program:
    SHA-256(daily.slot_hash_seed || word) == daily.solution_hash  ✓
    Creates SolverRecord PDA
    Updates PlayerProfile (streak)
```

**Staked Duel Loop (Commit-Reveal, per-room word)**
```text
  [Player solves the room's per-room word via Hint API and gets the plaintext]

  Step 1: Commit (Lock)
  Client generates local `salt`.
  Client constructs: commit_hash = SHA-256(word || salt || player_wallet)
  Client submits: `commit_duel_solution(commit_hash)`
  Anchor program:
    Saves commit_hash to DuelEntry.
    Locks in commit_timestamp = Clock::get().unix_timestamp.

  Step 2: Reveal (Verify)
  Client submits: `reveal_duel_solution(word, salt)`
  Anchor program:
    Reconstructs hash: SHA-256(word || salt || player_wallet)
    Validates: reconstructed_hash == entry.commit_hash
    Validates: SHA-256(slot_hash_seed || word || room.key() || "DUEL")
                 == room.room_solution_hash
    Marks entry.revealed = true.
```

## 4. Trust Model

Two earlier versions of this PRD claimed "the daily word is structurally impossible to change" and similar. That was overstatement. This section now states the trust model plainly.

**What Is Fully On-Chain and Trustless**
*   **Day seed:** `slot_hash_seed` extracted from the SlotHashes sysvar at `initialize_day` time — a Solana-native commitment no other party can forge or retroactively change. Once `initialize_day` is mined, the seed used for the day's hashes is fixed.
*   **Per-room answer commitment:** `room_solution_hash = SHA-256(slot_hash_seed || room.key() || "DUEL")` is committed when the room is created. The room's pubkey depends on the creator and a UID, so neither the backend nor the creator can predict it in advance. The per-room word is therefore not chosen by the operator.
*   **Answer verification:** The SHA-256 check runs inside the Anchor instruction. The program cannot be told to accept a wrong answer — for the daily word or for any room's word.
*   **Duel Timing:** `solve_time` is determined strictly by the `commit_timestamp`. Both values are on-chain. The client provides no timing input.
*   **Escrow:** USDC held in a token account owned by the DuelRoom PDA. No third party can withdraw it.
*   **Settlement:** `settle_duel` resolves deterministically from on-chain state. The platform runs the primary keeper on cron. Any wallet may also call `settle_duel` as a fallback.

**What Is Trusted (Backend Coordinator) — honestly stated**
*   **Daily Free word selection** from a private server-side vocabulary. The operator picks the daily word and submits it via `initialize_day`. The operator therefore controls the *difficulty* of the daily word and can, in principle, choose a word that favors themselves or a known wallet for the free leaderboard. They cannot, however, change the word after `initialize_day` is mined.
*   **Daily Free guess evaluation** in the hint API. Guess responses come from the server; a malicious server could mislead a player about a guess.
*   **Per-room hint evaluation.** The per-room word is derived deterministically from on-chain state (the operator cannot pick it), but the hint responses for guesses against it are still served by the backend. A malicious backend could give one player correct hints and another player wrong hints in the same room. Mitigation: the per-room hint response is signed by the server with a key whose public half is committed on-chain; a player who received a wrong hint can prove it on-chain after the duel.
*   **Liveness of the keeper cron and the hint API.** If the backend is down, daily free play and duel hint evaluation stop. Escrowed USDC is never at risk — `settle_duel` is permissionless and the deadline enforced — but no new duels can be created and no solve commits can be accompanied by hints.

**What the operator explicitly cannot do**
*   Change the daily word after it is committed on-chain.
*   Pick the per-room word (it is derived from on-chain state the operator does not control).
*   Alter any on-chain state the operator did not author (solve records, escrow, settlement).
*   Withdraw escrowed USDC that does not belong to them.
*   Retroactively change the outcome of any committed or revealed duel.

**Verifiability**
At UTC midnight, the previous day's word is published on the leaderboard page. Any player can verify: `SHA-256(stored_slot_hash_seed || published_word) == stored_solution_hash` in the DailyChallenge PDA. The per-room word for any past room is verifiable from the same DailyChallenge seed plus the published room pubkey (`SHA-256(slot_hash_seed || room.key() || "DUEL") == room.room_solution_hash`).

## 5. Anti-Cheat & Exploit Mitigation

Slotword prevents three classes of cheat: (a) answer-copying from the public ledger, (b) prior-knowledge attacks from free play, and (c) instant-commit racing by players who already know the word. v6.0 of this PRD only addressed (a). v6.1 addresses all three.

### 5.1 Answer-Copying — prevented by Commit-Reveal
In staked games, submitting a plaintext answer on-chain exposes the winner to answer-copying by the loser. Slotword uses a 2-step SHA-256 Commit-Reveal flow:

1. **Commit (Lock):** The client generates a local `salt` and submits `SHA-256(word + salt + wallet)` on-chain via `commit_duel_solution`. The answer is hidden, but the player's wallet and the exact block timestamp are bound to that hash on-chain.
2. **Reveal (Verify):** The client submits the plaintext `word` and `salt` via `reveal_duel_solution`. The Anchor program verifies the hash matches the commitment and the per-room expected answer.
3. **Anti-Copycat guarantee:** Because the duel outcome is tied strictly to the *Commit* timestamp, a losing player cannot copy the winner's Reveal transaction to tie the game — the winner's timestamp is historically cemented by the time the plaintext word is visible on-chain.

This is SHA-256 with a 2-step flow. v6.0 of this PRD described the same mechanism as "enterprise-grade cryptography" and "deep Solana integration." Both phrases overstated it. The mechanism is straightforward; the value is in the integration with Solana's low fees and finality, not in the cryptography being exotic.

### 5.2 Prior-Knowledge Attacks — prevented by per-room word derivation
**The attack v6.0 did not address:** A player who solves the daily free puzzle at 09:00 UTC knows the daily word. They join a duel at 23:00 UTC and commit instantly at the 45-second mark. The 45-second minimum does nothing — they had 14 hours to solve. They beat any honest duelist who is currently solving.

**The v6.1 fix:** The duel word is not the daily free word. It is `SHA-256(slot_hash_seed || room.key() || "DUEL")` mapped to the word list — different per room, different from the daily word, and not selected by the operator. A free-puzzle solver has zero information about any duel word. Each room requires its own solving effort.

### 5.3 Instant-Commit Racing — partially mitigated, honestly disclosed
The 45-second minimum from room join to commit mitigates blind racing. It does not prevent a player who can solve a five-letter word in 45 seconds from committing at the minimum. We accept this: speed of solving is the skill being rewarded. The 45-second minimum exists only to prevent stale pre-known words from being committed in the first slot. With per-room words (5.2), the value of the minimum is reduced but kept as a defense-in-depth.

### 5.4 Hint API abuse
10 guess requests per wallet + day_index pair. 60 requests per IP per day as a secondary layer for script mitigation. Additional rate-limit hardening in post-grant scope (Section 12).

### 5.5 What Slotword does NOT prevent (explicitly)
- **Operator choosing easy daily words for themselves.** The operator picks the daily free word and can theoretically pre-solve it through a fresh wallet for free leaderboard rank. This is not solvable without removing operator word selection (see Section 12, Pyth entropy roadmap).
- **Operator serving wrong hints to specific wallets.** Mitigated by signed hints (Section 4); fully solvable only by client-side word derivation, which is post-grant scope.
- **Player collusion in 1v1 duels.** Two wallets controlled by one party can farm the free leaderboard; for duels, they can only move their own USDC between their own wallets minus the 2% fee. We accept this until multiplayer tournaments enable real anti-collusion designs.


## 6. Smart Contract Specification
**Framework:** Anchor 0.30 | **Language:** Rust | **Network:** Solana Mainnet

### Accounts
```rust
// PDA seeds: [ "day ", day_index.to_le_bytes()]
#[account]
pub struct DailyChallenge {
    pub day_index:      u64,      
    pub slot_hash_seed: [u8; 32], 
    pub solution_hash:  [u8; 32], 
    pub total_solvers:  u32,
    pub bump:           u8,
}

// PDA seeds: [ "room", creator.key().as_ref(), room_uid.to_le_bytes()]
#[account]
pub struct DuelRoom {
    pub daily_challenge:    Pubkey,
    pub room_solution_hash: [u8; 32],   // SHA-256(slot_hash_seed || room.key() || "DUEL")
    pub creator:            Pubkey,
    pub opponent:           Pubkey,
    pub stake_amount:       u64,         // USDC units
    pub status:             RoomStatus,  // Active | Settled | Refunded
    pub deadline:           i64,         // unix_timestamp after which CASE 2/3 may resolve
    pub creator_entry:      Pubkey,
    pub opponent_entry:     Pubkey,
    pub winner:             Pubkey,      // Set on settle
    pub bump:               u8,
}

// PDA seeds: [ "entry ", duel_room.key().as_ref(), player.key().as_ref()]
#[account]
pub struct DuelEntry {
    pub duel:                Pubkey,
    pub player:              Pubkey,
    pub join_unix_timestamp: i64,
    pub commit_hash:         [u8; 32], // Zeroed until commit_duel_solution
    pub commit_timestamp:    i64,      // Zeroed until commit_duel_solution
    pub revealed:            bool,
    pub attempts:            u8,       // Client-reported, display only
    pub bump:                u8,
}

// PDA seeds: [ "config" ]
#[account]
pub struct Config {
    pub platform_fee_bps:   u16,    // 200 = 2%
    pub keeper_tip_usdc:    u64,    // FIXED LAMPORT/USDC UNITS, e.g. 0.05 USDC = 50_000
    pub keeper_tip_from_fee: bool,  // true => tip comes out of platform fee, not the pot
    pub authority:          Pubkey,
    pub hint_signer_pubkey: Pubkey, // Ed25519 key used to sign hint API attestations (Section 7.3)
    pub bump:               u8,
}
// (SolverRecord, PlayerProfile remain identical to v5)
```

### Core Instructions
**`create_duel(stake_amount: u64, deadline_offset_seconds: i64)`**
*   **Validates:** `stake_amount >= MIN_STAKE` (e.g., 0.5 USDC) and `<= MAX_STAKE` (e.g., 100 USDC).
*   **Validates:** `deadline_offset_seconds >= 300` (min 5-minute room) and `<= 3600` (max 1-hour room).
*   **Logic:** Derives `room_solution_hash = SHA-256(daily.slot_hash_seed || room.key() || "DUEL")`, where `daily` is the current day's DailyChallenge PDA and `room.key()` is the new DuelRoom PDA's pubkey.
*   **Effects:** Creates DuelRoom, escrows creator's USDC into the room-owned token account, creates creator's DuelEntry with `join_unix_timestamp = clock.unix_timestamp`.

**`join_duel(room: Pubkey)`**
*   **Validates:** `room.status == Active` and `room.opponent == Pubkey::default()`.
*   **Validates:** Caller transfers `stake_amount` USDC into the room escrow.
*   **Effects:** Sets `room.opponent = caller`, creates opponent's DuelEntry with `join_unix_timestamp = clock.unix_timestamp`. Now both entries' 45-second clocks start running.

**`commit_duel_solution(commit_hash: [u8; 32], attempts: u8)`**
*   **Validates:** `room.status == Active`.
*   **Validates:** `clock.unix_timestamp >= entry.join_unix_timestamp + 45` (45-second minimum solve time).
*   **Validates:** `entry.commit_hash == [0; 32]` (prevents double commits).
*   **Updates:** `entry.commit_hash = commit_hash`, `entry.commit_timestamp = clock.unix_timestamp`, `entry.attempts = attempts`.

**`reveal_duel_solution(word: String, salt: [u8; 32])`**
*   **Validates:** `entry.commit_timestamp > 0` (must commit first).
*   **Validates:** `entry.revealed == false`.
*   **Validates:** `SHA-256(word || salt || player.key()) == entry.commit_hash`.
*   **Validates:** `SHA-256(daily.slot_hash_seed || word || room.key() || "DUEL") == room.room_solution_hash`. (Note: validates against the **per-room** word, not the daily free word.)
*   **Updates:** `entry.revealed = true`.

**`settle_duel()`**
*   **Validates:** `room.status == Active`.
*   **Validates:** Both entries revealed OR `clock.unix_timestamp >= room.deadline`.
*   **Resolution Matrix:**
    *   **CASE 1 (Both Revealed):** Winner = lower `commit_timestamp`. Exact tie (`==`) → 50/50 split.
    *   **CASE 2 (One Revealed, Deadline Breached):** The revealer claims the full pot.
    *   **CASE 3 (Neither Revealed, Deadline Breached):** Full refunds to both players, no platform fee, no keeper tip.
*   **Fees:** `platform_fee_bps` (default 200 = 2%) of the **winning side only**.
*   **Keeper tip (fixed, sustainable):** `config.keeper_tip_usdc` (default 0.05 USDC = 50_000 units) paid to `tx.signer()` from the platform fee pool when `config.keeper_tip_from_fee == true`. Caller is responsible for priority fees on the settle transaction.

**Keeper economics — explicitly stated.** At 2% platform fee on a $2 duel, the platform fee is $0.04. From that, $0.05 keeper tip is not sustainable. Two corrections applied in v6.1:
1. The keeper tip floor is **0.05 USDC** but only paid **if the platform fee on that duel covers it**; otherwise the keeper tip is the full platform fee (so the keeper always earns non-zero, the platform never pays out of pocket).
2. **The platform is the primary keeper** — runs `settle_duel` on a 10-second cron for any room past its deadline or with both reveals. The permissionless-any-wallet path exists only as a fallback if the platform's keeper is down. v6.0 claimed permissionlessness as the primary mechanism; that was not economically viable and is corrected here.

## 7. Hint API

The hint API serves two distinct word-resolution paths. v6.0 treated them identically; v6.1 separates them because duel words are derived differently from the daily free word.

### 7.1 Daily Free / Practice Hints
```text
POST /api/hint
{
  "wallet": "<pubkey>",     // null for Practice mode
  "day_index": 12345,
  "guess": "BLOCK"
}

Response (incorrect):
{
  "hints": ["correct", "absent", "present", "absent", "absent"],
  "solved": false,
  "attempts_remaining": 4
}

Response (correct):
{
  "hints": ["correct", "correct", "correct", "correct", "correct"],
  "solved": true,
  "attempts_remaining": 3,
  "word": "BLOCK"
}
```

The server evaluates guesses against the **daily free word** (selected by the operator and committed on-chain via `initialize_day`). On correct solve, the server returns the plaintext word so the client can construct a `submit_solution` transaction.

**Rate limits:** 10 guess requests per wallet + day_index pair. 60 requests per IP per day.

### 7.2 Duel Room Hints (per-room word)
```text
POST /api/hint/duel
{
  "wallet": "<pubkey>",
  "room": "<room_pubkey>",
  "guess": "STAKE"
}

Response (identical structure to 7.1, but evaluated against the per-room word)
```

The server derives the per-room word by:
1. Fetching the current `DailyChallenge.slot_hash_seed` from on-chain state.
2. Computing `SHA-256(slot_hash_seed || room.key() || "DUEL")`.
3. Mapping the hash to the word list (modular index into the sorted vocabulary).
4. Evaluating the guess against that word.

The server does **not** choose the per-room word. It derives it deterministically from on-chain state. This is the critical difference from the daily free path.

**Rate limits:** 10 guess requests per wallet + room pair. One active room per wallet at a time.

### 7.3 Hint Signing (integrity guarantee)
Every hint response is signed by the server with an Ed25519 key whose public half is stored in the on-chain `Config` PDA. If a player receives a wrong hint (e.g., the server says "absent" for a letter that is actually "correct"), the player can submit the signed hint response on-chain after the duel as a dispute proof. This does not prevent the attack in real time, but creates an auditable trail and a reputation cost for the operator. Full client-side word derivation (which eliminates this attack surface entirely) is in post-grant scope (Section 12).

## 8. Tech Stack
| Layer | Technology |
| :--- | :--- |
| Smart contract | Anchor 0.30 + Rust |
| RPC + indexing | Helius (websocket subscriptions for live leaderboard updates) |
| Web application | Next.js 14 + Tailwind CSS |
| Wallet | @solana/wallet-adapter-react |
| Backend | Next.js API routes — hint server + initialize_day cron at UTC midnight |
| Database | Supabase Postgres — game sessions, word list, leaderboard cache |
| Token | SPL USDC mainnet |
| Deployment | Vercel |
| AI coding tools | [Specify paid subscription here — receipts totaling $200 required at tranche 2 submission] |

## 9. Frontend Screens
*(Identical to v5, plus the additions below.)*

### Duel Room screen — explicit two-step Commit-Reveal UX
The previous "single loading spinner" abstraction is removed. The Duel Room screen shows an explicit two-step state:

| State | UI |
| :--- | :--- |
| Idle | "Ready to lock your answer." |
| Commit pending | "1/2 Locking your answer… waiting for wallet signature." |
| Commit confirmed | "Answer locked at block N. Commit timestamp: T." |
| Reveal pending | "2/2 Verifying… waiting for wallet signature." |
| Reveal confirmed | "Verified. Awaiting opponent / settlement." |
| Reveal failed | "Reveal transaction was dropped. Retry before deadline: MM:SS. [Retry]" + "Why did this happen?" explainer. |
| Deadline passed, not revealed | "Room expired. Outcome CASE 2/3 will be applied by the keeper." |

Where the player's wallet supports atomic multi-instruction transactions (Phantom, Solflare, Backpack — all do on modern versions), Commit and Reveal are bundled into one signed transaction so the user signs once. The split UI above is the fallback for wallets that do not support this and for any failure mid-flow.

### Transaction preview before every wallet popup
Before each wallet signature, the UI shows a plain-language preview:
- For Commit: "You are locking your answer hash. No word is revealed. Your timestamp will be set to block T."
- For Reveal: "You are revealing your answer <WORD> and salt. Your stake is already locked; this only proves your previous Commit was correct."
- For `settle_duel`: "You are triggering settlement. You will receive a keeper tip of 0.05 USDC if the platform keeper has not already settled."

Estimated Solana priority fee and total transaction cost in SOL + USD is shown for every transaction.

### Shareable room deep links
Every duel room has a URL `slotword.app/duel/<room_pubkey>` that loads the room directly. Create-duel flow ends by copying this link to clipboard. Two-player games live on share links — without them, matching requires both players to be on the rooms browser simultaneously.

### Hint API transaction memos
All on-chain instructions include a `memo` instruction in the same transaction with plain-language text:
- `commit_duel_solution` → "Locking answer hash for duel room <short_room_id>."
- `reveal_duel_solution` → "Revealing answer for duel room <short_room_id>."
- `settle_duel` → "Settling duel room <short_room_id>. Winner: <short_winner>."

This makes wallet approval dialogs human-readable. Solana Explorer and most wallet UIs render memos inline.


## 10. Build Milestones

The v6.0 timeline compressed a normal team's month of work into Week 2 ("Web App + Hint Server"). v6.1 redistributes work honestly and adds distribution milestones before mainnet — because real USDC stakes on a contract nobody uses is not a meaningful checkpoint.

**Week 1 — Smart Contract Core (by June 23)**
Deploy `DailyChallenge`, `DuelRoom`, `DuelEntry`, `Config` accounts and the `initialize_day`, `create_duel`, `join_duel`, `commit_duel_solution`, `reveal_duel_solution`, `settle_duel` instructions to devnet.
*Test coverage required before checkpoint:*
*   Per-room word: `room_solution_hash = SHA-256(slot_hash_seed || room.key() || "DUEL")` produces a different word from `daily.solution_hash` and different across two rooms on the same day.
*   `commit_duel_solution` before 45 seconds → `SolvedTooFast`.
*   `commit_duel_solution` at second 46 → accepted, `commit_timestamp` locked.
*   `reveal_duel_solution` with wrong salt → `InvalidReveal`.
*   `reveal_duel_solution` with correct salt but wrong word (daily free word) → `WrongWord`.
*   `reveal_duel_solution` with the correct per-room word → accepted, `revealed = true`.
*   `settle_duel` Cases 1, 2, 3 all settle correctly including the keeper tip paid from the platform fee.
*   **Checkpoint:** Full 1v1 duel settled on devnet using the per-room word and Commit-Reveal flow. Winner receives devnet USDC, keeper receives the configured tip.

**Week 2 — Hint Server + Daily Free Play (by June 30)**
Hint API deployed with per-room word derivation (the server derives both `daily.solution_hash` and per-room `room_solution_hash` from the same word list, so a player joining a duel gets a different word than a free player). `initialize_day` cron on devnet. Next.js app with Practice and Daily Free screens functional end-to-end. The Commit-Reveal flow is **not** wired into the UI this week — only Daily Free.
*   **Checkpoint:** Daily free puzzle playable on devnet, SolverRecord PDA writes verified, leaderboard updates live.

**Week 3 — Duel UX + Frontend Hardening (by July 7)**
Duel Room screen with explicit two-step Commit-Reveal UI (per Section 9). Atomic multi-instruction transaction bundling for wallets that support it; explicit split state for those that don't. Transaction previews, memos, shareable room deep links. Practice → Daily → Duel onboarding. Create/Join flows. Rooms browser with live open rooms.
*   **Checkpoint:** Full duel flow on devnet — create, join, both solve the **per-room word**, commit, reveal, `settle_duel` called either by the platform keeper cron or by a third wallet (fallback), USDC distributed correctly.

**Week 4 — Distribution + Mainnet (by July 14)**
Pre-mainnet distribution milestone: post the playable devnet URL to three targeted communities (Colosseum/Superteam Discord, r/CryptoCurrency dApp thread, one Wordle-adjacent community such as a puzzle Discord) with an explicit ask. Goal: 25 unique wallets complete a devnet puzzle before mainnet deploy. Track conversion from "viewed the URL" → "connected a wallet" → "solved once." This is the first real metric of the build.

If the devnet-25-wallets milestone is missed, mainnet deploy slips by 3 days. Mainnet is not the place to discover there is no audience.

Then: smart contract deployed to Solana mainnet, hint API rate-limit monitoring live, `initialize_day` cron running on mainnet, first real USDC duel settled on mainnet. Load test: 10 simultaneous duels settled by the platform keeper without RPC errors or priority-fee exhaustion.
*   **Checkpoint:** Mainnet staked duel — real USDC transferred to winner, keeper tip paid, transaction confirmed on mainnet Solana Explorer. Live web URL on Vercel. Public GitHub repo (Anchor program MIT licensed; word list remains private). 2-minute demo video. $200 AI subscription receipt ready for tranche 2.

## 11. Primary KPI
**Realistic KPI for a 4-week build with no existing community:** 25 unique wallets complete a puzzle on Solana mainnet AND at least $100 USDC total volume settled through staked duel rooms by July 14, 2026. (At $2 average stakes, this is 50 settled duels.)

**Stretch KPI (target, not requirement):** 100 unique wallets AND $500 USDC volume. We report both numbers honestly in the tranche 2 submission regardless of which is reached.

**Anti-vanity:** We do not report "wallets connected." We report "wallets that submitted a `submit_solution` transaction AND had it confirmed on mainnet." A connected wallet that never solved counts as zero. We do not report "rooms created." We report "rooms settled." These definitions are checked by querying the program's transaction history on Helius at checkpoint.

## 12. Post-Grant Roadmap (Out of Scope for This Grant)
*   **Pyth Network entropy integration — removes backend word selection entirely.** This is the single biggest trust reduction available. The daily word is selected by Pyth randomness instead of the operator; the operator's word list becomes a vocabulary table rather than a selector. High priority for v2.
*   **Client-side word derivation.** Move hash-to-word lookup client-side so the backend cannot serve wrong hints to a target wallet. Requires a public, versioned word list (Arweave-static, hashed, committed on-chain in the Config PDA).
*   React Native mobile app with Solana Mobile Stack and Seed Vault signing
*   Compressed NFT streak badges via Light Protocol
*   Multi-player tournaments (3–20 players, tiered prize distribution) — required for any meaningful anti-collusion design
*   Multi-token staking (SOL, BONK, additional SPL tokens)
*   Season leaderboards with champion badges
*   **Revenue path beyond the grant:** raise the platform fee from 2% to 3% once $1k weekly volume is sustained; introduce a paid "duel host" tier with custom words; Sponsored tournament rounds (word lists sponsored by Solana ecosystem projects). Without one of these, the product is grant-dependent and dies when the grant ends.

## 13. Demo Script (2 Minutes)

v6.0's demo script used phrases like "structurally impossible," "enterprise-grade cryptography," and "deep Solana integration." These were marketing language that overstated the architecture and would hurt credibility with technical reviewers. v6.1 rewrites the script to say exactly what happens on-chain, no more.

**[0:00–0:20] The problem**
Open the NYT Wordle page. "This game runs on a server the NYT controls. After the acquisition, they changed and removed words overnight. Players have no way to verify the puzzle was fair. Slotword commits the answer hash on-chain before any player guesses — and lets you stake real money on being faster than another player."

**[0:20–0:55] Solve the daily puzzle**
Open Slotword. Show the DailyChallenge PDA on Solana Explorer — point out `solution_hash` and `slot_hash_seed`. "This hash was committed at midnight UTC, before any player made a guess. The seed comes from the SlotHashes sysvar — Solana's own block history."

Solve the puzzle in 3 guesses. Submit. Show the SolverRecord PDA appearing on-chain. "My solve is now on-chain. After midnight, the word is published and anyone can verify: SHA-256 of the seed plus the word equals the hash that was committed this morning."

**[0:55–1:30] Live staked duel**
Create a duel room, stake $2 USDC. Show the escrow balance on Explorer. Join from a second wallet. "Notice: the duel uses a different word than the daily free puzzle. It is derived from the same slot hash seed plus this room's own pubkey. I solved the daily puzzle already this morning — that gives me zero advantage here."

Both solve. Show the two-step Commit-Reveal UI: Player 1 signs one transaction that bundles the Commit and Reveal instructions. "Player 1's answer hash and timestamp are now locked on-chain. Player 2 cannot see the word yet — only the hash. By the time Player 2 can see the plaintext, Player 1's timestamp is already cemented."

The platform keeper settles the duel automatically. Show USDC transferred to the winner on Explorer.

**[1:30–2:00] The close**
"Three things to take away. One: the answer hash is committed before any guess — the operator cannot change the puzzle after the fact. Two: each duel room uses its own word derived from on-chain state, so prior knowledge of the daily puzzle does not help. Three: USDC escrow and settlement are fully on-chain — the platform runs the keeper, but any wallet can settle as a fallback. The operator still picks the daily word from a private list — removing that last trust assumption is the first item on our post-grant roadmap via Pyth entropy. Everything else is already verifiable."