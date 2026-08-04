/**
 * Slotword keeper script.
 *
 * Responsibilities (per PRD §10):
 *   1. Call `set_duel_word` for newly-created rooms that don't yet have a word
 *      set (the platform backend derives the word from room.seed and an off-chain
 *      word list, then commits SHA-256(slot_hash_seed || word) on-chain).
 *   2. Call `settle_duel` for rooms past their deadline where both parties have
 *      revealed (or where the deadline passed).
 *
 * Run via: npm run keeper
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, Idl, BN } from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { createHash } from "crypto";
import { SlotwordClient } from "../client/slotword";

// Load idle accounts we need:
//   AUTHORITY_KEYPAIR — the platform's authority keypair (env: bs58 string)
//   KEEPER_KEYPAIR    — optionally a separate keeper keypair
//   USDC_MINT         — the USDC mint address (string)
//   RPC_URL           — Solana RPC endpoint
//   WORD_LIST         — newline-separated 5-letter words, idempotent production order

const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const USDC_MINT = new PublicKey(
  process.env.USDC_MINT ?? "EPjFWdd5AufqSSqeM2qN1xzybeapu8P5F6Z4M3sGckYC"
);
const WORD_LIST_PATH = process.env.WORD_LIST ?? "words.txt";
const POLL_INTERVAL_MS = Number(process.env.POLL_MS ?? 5_000);

function loadAuthorityKeypair(): Keypair {
  const bs58 = process.env.AUTHORITY_KEYPAIR;
  if (!bs58) {
    throw new Error(
      "AUTHORITY_KEYPAIR env var required (bs58-encoded secret key)"
    );
  }
  return Keypair.fromSecretKey(
    anchor.utils.bytes.bs58.decode(bs58) as Uint8Array
  );
}

function loadKeeperKeypair(authorityKeypair: Keypair): Keypair {
  const bs58 = process.env.KEEPER_KEYPAIR;
  if (!bs58) return authorityKeypair;
  return Keypair.fromSecretKey(
    anchor.utils.bytes.bs58.decode(bs58) as Uint8Array
  );
}

function loadWordList(path: string): string[] {
  const fs = require("fs");
  return fs
    .readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((w: string) => w.trim().toUpperCase())
    .filter((w: string) => w.length === 5);
}

function deriveWordFromRoomSeed(roomSeed: Buffer, wordList: string[]): string {
  // Treat the first 4 bytes of the room seed as a little-endian u32 index.
  const idx = roomSeed.readUInt32LE(0) % wordList.length;
  return wordList[idx];
}

async function main() {
  const connection = new Connection(RPC_URL, "processed");
  const provider = new anchor.AnchorProvider(
    connection,
    new anchor.Wallet(loadAuthorityKeypair()),
    { commitment: "processed" }
  );

  // Load IDL from target/idl/slotword.json (built by `anchor build`).
  const idlPath = "target/idl/slotword.json";
  const idl = require("fs").readFileSync(idlPath, "utf8");
  const programId = new PublicKey(
    process.env.PROGRAM_ID ?? "S1otword11111111111111111111111111111111111"
  );
  const program = new Program(JSON.parse(idl) as Idl, provider);
  const client = new SlotwordClient(program, USDC_MINT);

  const wordList = loadWordList(WORD_LIST_PATH);
  const authorityKeypair = loadAuthorityKeypair();
  const keeperKeypair = loadKeeperKeypair(authorityKeypair);
  if (wordList.length === 0) {
    console.log("[keeper] WARNING: empty word list — set_duel_word disabled");
  }

  console.log(
    `[keeper] polling every ${POLL_INTERVAL_MS}ms rpc=${RPC_URL} usdc=${USDC_MINT.toBase58()}`
  );

  while (true) {
    try {
      await pollAndProcess(
        program,
        client,
        connection,
        authorityKeypair,
        keeperKeypair,
        wordList
      );
    } catch (err) {
      console.error("[keeper] poll error:", err);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function pollAndProcess(
  program: Program<Idl>,
  client: SlotwordClient,
  connection: Connection,
  authorityKeypair: Keypair,
  keeperKeypair: Keypair,
  wordList: string[]
) {
  // Fetch all DuelRoom accounts via getProgramAccounts with a filter on
  // status == Active (discriminated enum byte = 0).
  // The account discriminator for DuelRoom is the first 8 bytes (sha256 of
  // "account:Slotword::DuelRoom"); the status field sits at a fixed offset.
  // Easiest approach: fetch all accounts and filter in TS.

  const rooms = await program.account.duelRoom.all();
  for (const { account, publicKey } of rooms) {
    const room = account as any;
    if (room.status?.active === undefined) continue; // only Active rooms

    // 1. set_duel_word if not yet set
    if (!room.wordSet && wordList.length > 0) {
      try {
        await processSetDuelWord(
          client,
          connection,
          authorityKeypair,
          room,
          publicKey,
          wordList
        );
      } catch (err) {
        console.error(`[keeper] set_duel_word ${publicKey.toBase58()}:`, err);
      }
      continue;
    }

    // 2. settle_duel if deadline passed AND opponent joined
    if (
      room.opponent &&
      !room.opponent.equals(PublicKey.default)
    ) {
      const clock = await connection.getBlockTime(await connection.getSlot());
      if (clock && clock >= room.deadline.toNumber()) {
        try {
          await processSettleDuel(
            client,
            authorityKeypair,
            keeperKeypair,
            room,
            publicKey
          );
        } catch (err) {
          console.error(
            `[keeper] settle_duel ${publicKey.toBase58()}:`,
            err
          );
        }
      }
    }
  }
}

async function processSetDuelWord(
  client: SlotwordClient,
  connection: Connection,
  authorityKeypair: Keypair,
  room: any,
  roomPubkey: PublicKey,
  wordList: string[]
) {
  // Fetch the daily challenge to get the slot_hash_seed
  const daily = await client.fetchDailyChallenge(
    room.dailyChallenge.dayIndex
  );
  const word = deriveWordFromRoomSeed(
    Buffer.from(room.roomSeed),
    wordList
  );
  const solutionHash = SlotwordClient.duelSolutionHash(
    Buffer.from(daily.slotHashSeed),
    word
  );
  console.log(
    `[keeper] set_duel_word room=${roomPubkey.toBase58()} word=${word}`
  );
  await client.setDuelWord(authorityKeypair.publicKey, roomPubkey, solutionHash);
}

async function processSettleDuel(
  client: SlotwordClient,
  authorityKeypair: Keypair,
  keeperKeypair: Keypair,
  room: any,
  roomPubkey: PublicKey
) {
  console.log(`[keeper] settle_duel room=${roomPubkey.toBase58()}`);
  await client.settleDuel(
    keeperKeypair.publicKey,
    roomPubkey,
    room.creator,
    room.opponent,
    authorityKeypair.publicKey
  );
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
