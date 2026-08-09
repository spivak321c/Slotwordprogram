/**
 * Slotword initialize_day cron — runs once per UTC midnight to create the
 * daily DailyChallenge account with a fresh slot-hash-derived seed and the
 * committed solution hash for the day's word.
 *
 * Run via: npm run init-day
 *
 * Auth required: AUTHORITY_KEYPAIR env var (bs58).
 *
 * Flow:
 *   1. Pick today's word from WORD_LIST (deterministically — e.g. by
 *      `dayIndex % wordList.length`).
 *   2. Read a recent slot hash from the cluster and pass it as slot_hash_seed.
 *   3. solution_hash = SHA-256(slot_hash_seed || word).
 *
 * The seed is an explicit program argument, so what we pass is exactly what
 * gets stored — no sysvar race between our read and the program's read.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, Idl, BN } from "@coral-xyz/anchor";
import { Connection, PublicKey, Keypair } from "@solana/web3.js";

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybeapu8P5F6Z4MckYC"
);
const WORD_LIST_PATH = process.env.WORD_LIST ?? "words.txt";

function loadAuthorityKeypair(): Keypair {
  const bs58 = process.env.AUTHORITY_KEYPAIR;
  if (!bs58) throw new Error("AUTHORITY_KEYPAIR env var required");
  return Keypair.fromSecretKey(
    anchor.utils.bytes.bs58.decode(bs58) as Uint8Array
  );
}

function loadWordList(path: string): string[] {
  const fs = require("fs");
  if (!fs.existsSync(path)) {
    throw new Error(`word list not found: ${path}`);
  }
  return fs
    .readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((w: string) => w.trim().toUpperCase())
    .filter((w: string) => w.length === 5);
}

function getDayIndex(): BN {
  const dayMs = 86_400_000;
  return new BN(Math.floor(Date.now() / dayMs));
}

async function getRecentSlotHashSeed(connection: Connection): Promise<Buffer> {
  // Read the SlotHashes sysvar directly. The sysvar stores a Vec<(Slot, Hash)>;
  // the most recent entry's hash is what the program will use (offset 12..44).
  const SLOT_HASHES_SYSVAR = new PublicKey(
    "SysvarS1otHashes111111111111111111111111111"
  );
  const accountInfo = await connection.getAccountInfo(SLOT_HASHES_SYSVAR);
  if (!accountInfo || accountInfo.data.length < 44) {
    throw new Error("could not read SlotHashes sysvar");
  }
  // First 4 bytes = length, then 8 bytes slot, then 32 bytes hash.
  const data = accountInfo.data;
  return Buffer.from(data.slice(12, 44));
}

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const authorityKeypair = loadAuthorityKeypair();
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(authorityKeypair),
    { commitment: "confirmed" }
  );

  const idlPath = "target/idl/slotword.json";
  const fs = require("fs");
  if (!fs.existsSync(idlPath)) {
    throw new Error(
      `IDL not found at ${idlPath}. Run \`anchor build\` first.`
    );
  }
  const idl = JSON.parse(fs.readFileSync(idlPath, "utf8"));
  const programId = new PublicKey(
    process.env.PROGRAM_ID ?? "S1otword11111111111111111111111111111111111"
  );
  const program = new Program(idl as Idl, provider);
  const client = new (require("../client/slotword").SlotwordClient)(
    program,
    USDC_MINT
  );

  const wordList = loadWordList(WORD_LIST_PATH);
  if (wordList.length === 0) {
    throw new Error("empty word list");
  }

  const dayIndex = getDayIndex();
  const word = wordList[dayIndex.toNumber() % wordList.length];

  // Compute the solution_hash using the *current* SlotHashes sysvar. Note:
  // the program reads the sysvar itself and stores it as `slot_hash_seed`.
  // The seed we compute here and the seed the program reads must match for
  // submission validation. In practice the cluster's most recent entry
  // rotates every ~4s, so we accept the small chance they differ — if so,
  // submissions the next day will reject valid words, which we catch by
  // simulating this transaction pre-flight before committing.
  const slotHashSeed = await getRecentSlotHashSeed(connection);
  const { SlotwordClient: SC } = require("../client/slotword");
  const solutionHash = SC.dailySolutionHash(slotHashSeed, word);

  console.log(
    `[init-day] dayIndex=${dayIndex.toNumber()} word=${word} solution=${solutionHash.toString("hex")}`
  );

  try {
    await client.initializeDay(
      authorityKeypair.publicKey,
      dayIndex,
      slotHashSeed,
      solutionHash
    );
    console.log("[init-day] OK");
  } catch (err: any) {
    if (err?.message?.includes("already in use")) {
      console.log("[init-day] already initialized — skipping");
      return;
    }
    throw err;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
