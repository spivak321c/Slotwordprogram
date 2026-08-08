/**
 * Slotword TypeScript client — instruction builders, PDA helpers, and
 * commit-reveal hashing for the Slotword Anchor program.
 *
 * Usage:
 *   import { SlotwordClient } from "./slotword";
 *   const client = new SlotwordClient(program, usdcMint);
 *   const tx = await client.buildInitializeConfigTx(authority);
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, Idl, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/web3.js";
import { createHash } from "crypto";
import {
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

const SLOT_HASHES_SYSVAR = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111"
);

export class SlotwordClient {
  constructor(
    public readonly program: Program<Idl>,
    public readonly usdcMint: PublicKey
  ) {}

  // ---------------------------------------------------------------- PDAs

  configPda(): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      this.program.programId
    );
  }

  dailyChallengePda(dayIndex: BN | number): [PublicKey, number] {
    const bn = new BN(dayIndex);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("day"), bn.toArrayLike(Buffer, "le", 8)],
      this.program.programId
    );
  }

  solverRecordPda(dayIndex: BN | number, player: PublicKey): [PublicKey, number] {
    const bn = new BN(dayIndex);
    return PublicKey.findProgramAddressSync(
      [
        Buffer.from("solver"),
        bn.toArrayLike(Buffer, "le", 8),
        player.toBuffer(),
      ],
      this.program.programId
    );
  }

  playerProfilePda(player: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("profile"), player.toBuffer()],
      this.program.programId
    );
  }

  duelRoomPda(creator: PublicKey, roomUid: BN | number): [PublicKey, number] {
    const bn = new BN(roomUid);
    return PublicKey.findProgramAddressSync(
      [Buffer.from("room"), creator.toBuffer(), bn.toArrayLike(Buffer, "le", 8)],
      this.program.programId
    );
  }

  duelEntryPda(room: PublicKey, player: PublicKey): [PublicKey, number] {
    return PublicKey.findProgramAddressSync(
      [Buffer.from("entry"), room.toBuffer(), player.toBuffer()],
      this.program.programId
    );
  }

  roomEscrowAta(room: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(
      this.usdcMint,
      room,
      true // room is a PDA — allow owner off curve
    );
  }

  userAta(player: PublicKey): PublicKey {
    return getAssociatedTokenAddressSync(this.usdcMint, player);
  }

  // ----------------------------------------------------- Hashing helpers

  /** SHA-256(slot_hash_seed || word) — the daily solution hash. */
  static dailySolutionHash(slotHashSeed: Buffer, word: string): Buffer {
    return createHash("sha256")
      .update(slotHashSeed)
      .update(word)
      .digest();
  }

  /** SHA-256(slot_hash_seed || roomKey || "DUEL") — the per-room answer commitment (fixed at room creation). */
  static roomSolutionHash(slotHashSeed: Buffer, roomKey: PublicKey): Buffer {
    return createHash("sha256")
      .update(slotHashSeed)
      .update(roomKey.toBuffer())
      .update("DUEL")
      .digest();
  }

  /** SHA-256(room_solution_hash || word) — the per-room word commitment. Committed by the authority via set_duel_word; the plaintext word is never sent on-chain. */
  static duelSolutionHash(roomSolutionHash: Buffer, word: string): Buffer {
    return createHash("sha256")
      .update(roomSolutionHash)
      .update(word)
      .digest();
  }

  /** SHA-256(word || salt || player) — commit-reveal hash. */
  static commitHash(word: string, salt: Buffer, player: PublicKey): Buffer {
    return createHash("sha256")
      .update(word)
      .update(salt)
      .update(player.toBuffer())
      .digest();
  }

  // -------------------------------------------- Instruction builders

  initializeConfigIx(authority: PublicKey): TransactionInstruction {
    const [config] = this.configPda();
    return this.program.methods
      .initializeConfig()
      .accounts({
        config,
        authority,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  async initializeConfig(authority: PublicKey): Promise<string> {
    const [config] = this.configPda();
    return this.program.methods
      .initializeConfig()
      .accounts({
        config,
        authority,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async initializeDay(
    authority: PublicKey,
    dayIndex: BN | number,
    solutionHash: Buffer | number[]
  ): Promise<string> {
    const [daily] = this.dailyChallengePda(dayIndex);
    const [config] = this.configPda();
    return this.program.methods
      .initializeDay(new BN(dayIndex), Array.from(solutionHash))
      .accounts({
        dailyChallenge: daily,
        config,
        authority,
        slotHashes: SLOT_HASHES_SYSVAR,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async submitSolution(
    player: PublicKey,
    dayIndex: BN | number,
    word: string,
    attempts: number
  ): Promise<string> {
    const [solverRecord] = this.solverRecordPda(dayIndex, player);
    const [profile] = this.playerProfilePda(player);
    const [daily] = this.dailyChallengePda(dayIndex);
    const [config] = this.configPda();
    return this.program.methods
      .submitSolution(new BN(dayIndex), word, attempts)
      .accounts({
        solverRecord,
        playerProfile: profile,
        dailyChallenge: daily,
        config,
        player,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async createDuel(
    creator: PublicKey,
    dayIndex: BN | number,
    roomUid: BN | number,
    stakeAmount: BN | number,
    deadlineOffsetSeconds: BN | number
  ): Promise<string> {
    const [room] = this.duelRoomPda(creator, roomUid);
    const [creatorEntry] = this.duelEntryPda(room, creator);
    const [daily] = this.dailyChallengePda(dayIndex);
    const [config] = this.configPda();
    const creatorToken = this.userAta(creator);
    const roomEscrow = this.roomEscrowAta(room);
    return this.program.methods
      .createDuel(
        new BN(dayIndex),
        new BN(roomUid),
        new BN(stakeAmount),
        new BN(deadlineOffsetSeconds)
      )
      .accounts({
        duelRoom: room,
        creatorEntry,
        dailyChallenge: daily,
        config,
        creatorTokenAccount: creatorToken,
        roomEscrow,
        usdcMint: this.usdcMint,
        creator,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async joinDuel(
    opponent: PublicKey,
    room: PublicKey,
    creator: PublicKey,
    roomUid: BN | number
  ): Promise<string> {
    const [opponentEntry] = this.duelEntryPda(room, opponent);
    const opponentToken = this.userAta(opponent);
    const roomEscrow = this.roomEscrowAta(room);
    return this.program.methods
      .joinDuel()
      .accounts({
        room,
        opponentEntry,
        opponentTokenAccount: opponentToken,
        roomEscrow,
        usdcMint: this.usdcMint,
        opponent,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  /** Authority commits the per-room word commitment hash (SHA-256(room_solution_hash || word)). The plaintext word is never submitted on-chain. */
  async setDuelWord(
    authority: PublicKey,
    room: PublicKey,
    wordHash: Buffer | number[]
  ): Promise<string> {
    const [config] = this.configPda();
    return this.program.methods
      .setDuelWord(Array.from(wordHash))
      .accounts({
        room,
        config,
        authority,
      })
      .rpc();
  }

  async commitDuelSolution(
    player: PublicKey,
    room: PublicKey,
    word: string,
    salt: Buffer,
    attempts: number
  ): Promise<string> {
    const [entry] = this.duelEntryPda(room, player);
    const commit = SlotwordClient.commitHash(word, salt, player);
    return this.program.methods
      .commitDuelSolution(Array.from(commit), attempts)
      .accounts({
        room,
        entry,
        player,
      })
      .rpc();
  }

  async revealDuelSolution(
    player: PublicKey,
    room: PublicKey,
    dailyChallenge: PublicKey,
    word: string,
    salt: Buffer
  ): Promise<string> {
    const [entry] = this.duelEntryPda(room, player);
    return this.program.methods
      .revealDuelSolution(word, Array.from(salt))
      .accounts({
        room,
        entry,
        dailyChallenge,
        player,
      })
      .rpc();
  }

  async settleDuel(
    keeper: PublicKey,
    room: PublicKey,
    creator: PublicKey,
    opponent: PublicKey,
    platformAuthority: PublicKey
  ): Promise<string> {
    const [creatorEntry] = this.duelEntryPda(room, creator);
    const [opponentEntry] = this.duelEntryPda(room, opponent);
    const roomEscrow = this.roomEscrowAta(room);
    const creatorToken = this.userAta(creator);
    const opponentToken = this.userAta(opponent);
    const keeperToken = this.userAta(keeper);
    const platformToken = this.userAta(platformAuthority);
    const [config] = this.configPda();
    return this.program.methods
      .settleDuel()
      .accounts({
        room,
        creatorEntry,
        opponentEntry,
        roomEscrow,
        creatorTokenAccount: creatorToken,
        opponentTokenAccount: opponentToken,
        keeperTokenAccount: keeperToken,
        platformTokenAccount: platformToken,
        usdcMint: this.usdcMint,
        config,
        keeper,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  async cancelDuel(
    creator: PublicKey,
    room: PublicKey
  ): Promise<string> {
    const roomEscrow = this.roomEscrowAta(room);
    const creatorToken = this.userAta(creator);
    return this.program.methods
      .cancelDuel()
      .accounts({
        room,
        roomEscrow,
        creatorTokenAccount: creatorToken,
        usdcMint: this.usdcMint,
        creator,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  // ------------------------------------------------- Account fetchers

  async fetchConfig() {
    const [config] = this.configPda();
    return this.program.account.config.fetch(config);
  }

  async fetchDailyChallenge(dayIndex: BN | number) {
    const [daily] = this.dailyChallengePda(dayIndex);
    return this.program.account.dailyChallenge.fetch(daily);
  }

  async fetchDuelRoom(room: PublicKey) {
    return this.program.account.duelRoom.fetch(room);
  }

  async fetchDuelEntry(room: PublicKey, player: PublicKey) {
    const [entry] = this.duelEntryPda(room, player);
    return this.program.account.duelEntry.fetch(entry);
  }
}
