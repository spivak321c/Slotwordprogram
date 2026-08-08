import * as anchor from "@coral-xyz/anchor";
import { Program, BN, Wallet } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  PublicKey,
  SystemProgram,
  Keypair,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { createHash } from "crypto";
import { Slotword } from "../target/types/slotword";

const SLOT_HASHES_SYSVAR = new PublicKey(
  "SysvarS1otHashes111111111111111111111111111"
);

const DUEL_WORD = "LODGE";
const dailyWord = "BLOCK";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const sha256 = (...parts: (Buffer | string)[]) =>
  createHash("sha256")
    .update(
      Buffer.concat(
        parts.map((p) => (typeof p === "string" ? Buffer.from(p) : p))
      )
    )
    .digest();

/** Assert a promise rejects with a given Anchor error code (or msg substring). */
async function expectError(p: Promise<any>, code?: string) {
  try {
    await p;
    assert.fail(code ? `expected "${code}" to be thrown` : "expected rejection");
  } catch (e: any) {
    if (!code) return;
    const errCode: string | undefined = e?.error?.errorCode?.code;
    const msg: string = typeof e?.message === "string" ? e.message : "";
    assert.ok(
      errCode === code || msg.includes(code),
      `expected "${code}" but got "${errCode ?? msg?.slice(0, 240)}"`
    );
  }
}

describe("slotword comprehensive", function () {
  // Tests with the 45s solve floor and multi-setup rooms need far more than
  // mocha's default 2s timeout.
  this.timeout(300_000);

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Slotword as Program<Slotword>;
  const authority = provider.wallet as Wallet;
  const authorityKey = authority.publicKey;

  let usdcMint: PublicKey;
  let configPda: PublicKey;
  let dailyPda: PublicKey;
  let dayIndex: BN;
  let dailyHash: Buffer; // SHA-256(real slot seed || BLOCK)

  const ALICE = Keypair.generate();
  const BOB = Keypair.generate();

  let aliceToken: PublicKey;
  let bobToken: PublicKey;
  let keeperToken: PublicKey;
  let platformToken: PublicKey;

  // ----- PDA helpers ------------------------------------------------
  const roomPda = (creator: PublicKey, uid: BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("room"), creator.toBuffer(), uid.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];
  const entryPda = (room: PublicKey, player: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("entry"), room.toBuffer(), player.toBuffer()],
      program.programId
    )[0];
  const escrowPda = (room: PublicKey) =>
    getAssociatedTokenAddressSync(usdcMint, room, true);
  const tokBalance = async (t: PublicKey) =>
    Number((await provider.connection.getTokenAccountBalance(t)).value.amount);

  // ----- instruction builders (kept close to the IDL) ----------------
  const createRoomIx = (
    creator: PublicKey,
    uid: BN,
    stake: BN,
    deadline: BN,
    creatorToken: PublicKey
  ) =>
    program.methods
      .createDuel(dayIndex, uid, stake, deadline)
      .accounts({
        duelRoom: roomPda(creator, uid),
        creatorEntry: entryPda(roomPda(creator, uid), creator),
        dailyChallenge: dailyPda,
        config: configPda,
        creatorTokenAccount: creatorToken,
        roomEscrow: escrowPda(roomPda(creator, uid)),
        usdcMint,
        creator,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      });

  const joinRoomI = (room: PublicKey, opponent: PublicKey, token: PublicKey) =>
    program.methods
      .joinDuel()
      .accounts({
        room,
        opponentEntry: entryPda(room, opponent),
        opponentTokenAccount: token,
        roomEscrow: escrowPda(room),
        usdcMint,
        opponent,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      });

  const setWordI = (room: PublicKey, wordHash: Buffer) =>
    program.methods
      .setDuelWord(Array.from(wordHash))
      .accounts({ room, config: configPda, authority: authorityKey });

  const commitI = (room: PublicKey, player: PublicKey, wordHash: Buffer, attempts: number) =>
    program.methods
      .commitDuelSolution(Array.from(wordHash), attempts)
      .accounts({ room, entry: entryPda(room, player), player });

  const revealI = (room: PublicKey, player: PublicKey, word: string, salt: Buffer) =>
    program.methods
      .revealDuelSolution(word, Array.from(salt))
      .accounts({
        room,
        entry: entryPda(room, player),
        dailyChallenge: dailyPda,
        player,
      });

  // ------------------------------------------------------------------
  // Suite setup
  // ------------------------------------------------------------------
  before(async () => {
    for (const k of [ALICE, BOB]) {
      await provider.connection.requestAirdrop(
        k.publicKey,
        5 * anchor.web3.LAMPORTS_PER_SOL
      );
    }
    await sleep(500);

    usdcMint = await createMint(
      provider.connection,
      authority.payer,
      authorityKey,
      null,
      6
    );

    [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    try {
      await program.methods
        .initializeConfig()
        .accounts({ config: configPda, authority: authorityKey })
        .rpc();
    } catch (_) {}

    dayIndex = new BN(Math.floor(Date.now() / 86_400_000));
    [dailyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("day"), dayIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    // The program reads the REAL slot-hashes sysvar seed, so the test must
    // use the same seed it will derive (data[12..44] = newest hash).
    const sysvar = await provider.connection.getAccountInfo(SLOT_HASHES_SYSVAR);
    assert.ok(sysvar, "slot hashes sysvar available");
    const slotSeed = Buffer.from(sysvar!.data.slice(12, 44));
    dailyHash = sha256(slotSeed, dailyWord);

    try {
      await program.methods
        .initializeDay(dayIndex, Array.from(dailyHash))
        .accounts({
          dailyChallenge: dailyPda,
          config: configPda,
          authority: authorityKey,
          slotHashes: SLOT_HASHES_SYSVAR,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (e: any) {
      throw new Error(`initializeDay failed: ${e?.message}`);
    }

    // Token accounts for the main duel fixtures.
    aliceToken = await createAccount(provider.connection, authority.payer, usdcMint, ALICE.publicKey);
    bobToken = await createAccount(provider.connection, authority.payer, usdcMint, BOB.publicKey);
    keeperToken = await createAccount(provider.connection, authority.payer, usdcMint, authorityKey);
    platformToken = await createAccount(provider.connection, authority.payer, usdcMint, authorityKey);
    await mintTo(provider.connection, authority.payer, usdcMint, aliceToken, authorityKey, 10_000_000);
    await mintTo(provider.connection, authority.payer, usdcMint, bobToken, authorityKey, 10_000_000);
  });

  // ================================================================
  // 1. Config
  // ================================================================
  it("1.1 Config initialized with defaults and hint signer", async () => {
    const cfg = await program.account.config.fetch(configPda);
    assert.equal(cfg.platformFeeBps, 200);
    assert.equal(cfg.keeperTipUsdc.toNumber(), 50_000);
    assert.equal(cfg.keeperTipFromFee, true);
    assert.equal(cfg.minStakeUsdc.toNumber(), 500_000);
    assert.equal(cfg.maxStakeUsdc.toNumber(), 100_000_000);
    assert.ok(cfg.hintSignerPubkey.equals(authorityKey));
  });

  // ================================================================
  // 2. Daily challenge
  // ================================================================
  it("2.1 DailyChallenge stores day index, seed and solution hash", async () => {
    const daily = await program.account.dailyChallenge.fetch(dailyPda);
    assert.equal(daily.dayIndex.toNumber(), dayIndex.toNumber());
    assert.equal(daily.slotHashSeed.length, 32);
    assert.deepEqual(Array.from(daily.solutionHash), Array.from(dailyHash));
  });

  it("2.2 submit_solution rejects a wrong word", async () => {
    const [rec] = PublicKey.findProgramAddressSync(
      [Buffer.from("solver"), dayIndex.toArrayLike(Buffer, "le", 8), ALICE.publicKey.toBuffer()],
      program.programId
    );
    const [prof] = PublicKey.findProgramAddressSync(
      [Buffer.from("profile"), ALICE.publicKey.toBuffer()],
      program.programId
    );
    await expectError(
      program.methods
        .submitSolution(dayIndex, "WRONG", 3)
        .accounts({
          solverRecord: rec,
          playerProfile: prof,
          dailyChallenge: dailyPda,
          config: configPda,
          player: ALICE.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([ALICE])
        .rpc(),
      "WrongDailyWord"
    );
  });

  it("2.3 submit_solution with the correct word writes SolverRecord + Profile", async () => {
    const [rec] = PublicKey.findProgramAddressSync(
      [Buffer.from("solver"), dayIndex.toArrayLike(Buffer, "le", 8), ALICE.publicKey.toBuffer()],
      program.programId
    );
    const [prof] = PublicKey.findProgramAddressSync(
      [Buffer.from("profile"), ALICE.publicKey.toBuffer()],
      program.programId
    );
    await program.methods
      .submitSolution(dayIndex, dailyWord, 3)
      .accounts({
        solverRecord: rec,
        playerProfile: prof,
        dailyChallenge: dailyPda,
        config: configPda,
        player: ALICE.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([ALICE])
      .rpc();

    const record = await program.account.solverRecord.fetch(rec);
    assert.equal(record.attempts, 3);
    assert.equal(record.player.toBase58(), ALICE.publicKey.toBase58());
    assert.ok(record.solvedTimestamp.toNumber() > 0);

    const profile = await program.account.playerProfile.fetch(prof);
    assert.equal(profile.totalSolves, 1);
    assert.equal(profile.currentStreak, 1);
    assert.equal(profile.bestStreak, 1);
  });

  it("2.4 duplicate submit_solution for the same day is rejected", async () => {
    const [rec] = PublicKey.findProgramAddressSync(
      [Buffer.from("solver"), dayIndex.toArrayLike(Buffer, "le", 8), ALICE.publicKey.toBuffer()],
      program.programId
    );
    const [prof] = PublicKey.findProgramAddressSync(
      [Buffer.from("profile"), ALICE.publicKey.toBuffer()],
      program.programId
    );
    await expectError(
      program.methods
        .submitSolution(dayIndex, dailyWord, 2)
        .accounts({
          solverRecord: rec,
          playerProfile: prof,
          dailyChallenge: dailyPda,
          config: configPda,
          player: ALICE.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([ALICE])
        .rpc()
    );
  });

  // ================================================================
  // 3. Duel room lifecycle
  // ================================================================
  let roomA: PublicKey;      // happy-path duel: Alice (creator) vs Bob
  let roomAEntry: PublicKey; // Alice's entry
  const ROOM_UID_A = new BN(777);
  const STAKE = new BN(2_000_000);

  it("3.1 create_duel stores room state and locks the stake", async () => {
    roomA = roomPda(ALICE.publicKey, ROOM_UID_A);
    await createRoomI(ALICE.publicKey, ROOM_UID_A, STAKE, new BN(600), aliceToken)
      .signers([ALICE])
      .rpc();

    const room = await program.account.duelRoom.fetch(roomA);
    assert.equal(room.stakeAmount.toNumber(), 2_000_000);
    assert.deepEqual(room.status, { active: {} } as any);
    assert.ok(room.roomSolutionHash.some(Number), "room solution hash non-zero");
    assert.equal(room.wordSet, false);
    assert.equal(room.roomUid.toNumber(), ROOM_UID_A.toNumber());
    assert.equal(await tokBalance(escrowPda(roomA)), 2_000_000, "stake held in escrow");
  });

  it("3.2 create_duel rejects stake below the config minimum", async () => {
    const uid = new BN(2);
    await expectError(
      createRoomI(BOB.publicKey, uid, new BN(400_000), new BN(600), bobToken)
        .signers([BOB])
        .rpc(),
      "StakeTooLow"
    );
  });

  it("3.3 create_duel rejects a deadline outside [300, 3600]", async () => {
    const uid = new BN(3);
    await expectError(
      createRoomI(BOB.publicKey, uid, STAKE, new BN(3601), bobToken)
        .signers([BOB])
        .rpc(),
      "InvalidDeadline"
    );
  });

  it("3.4 cancel is only allowed by the room creator (NotParticipant)", async () => {
    const uid = new BN(4);
    const room = roomPda(BOB.publicKey, uid);
    await createRoomI(BOB.publicKey, uid, STAKE, new BN(600), bobToken)
      .signers([BOB])
      .rpc();
    await expectError(
      program.methods
        .cancelDuel()
        .accounts({
          room,
          roomEscrow: escrowPda(room),
          creatorTokenAccount: aliceToken,
          usdcMint,
          creator: ALICE.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([ALICE])
        .rpc(),
      "NotParticipant"
    );
  });

  it("3.5 creator can cancel a room with no opponent and gets the full stake back", async () => {
    const creatorC = Keypair.generate();
    await provider.connection.requestAirdrop(creatorC.publicKey, 5 * anchor.web3.LAMPORTS_PER_SOL);
    const cToken = await createAccount(provider.connection, authority.payer, usdcMint, creatorC.publicKey);
    await mintTo(provider.connection, authority.payer, usdcMint, cToken, authorityKey, 5_000_000);

    const uid = new BN(5);
    const room = roomPda(creatorC.publicKey, uid);
    await createRoomI(creatorC.publicKey, uid, new BN(1_500_000), new BN(600), cToken)
      .signers([creatorC])
      .rpc();

    const before = await tokBalance(cToken);
    await program.methods
      .cancelDuel()
      .accounts({
        room,
        roomEscrow: escrowPda(room),
        creatorTokenAccount: cToken,
        usdcMint,
        creator: creatorC.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([creatorC])
      .rpc();
    const after = await tokBalance(cToken);

    assert.equal(after - before, 1_500_000, "full stake returned");
    assert.deepEqual(
      (await program.account.duelRoom.fetch(room)).status,
      { refunded: {} } as any
    );
  });

  it("3.6 cancel after an opponent joined is rejected (RoomFull)", async () => {
    const uid = new BN(6);
    const room = roomPda(BOB.publicKey, uid);
    await createRoomI(BOB.publicKey, uid, STAKE, new BN(600), bobToken)
      .signers([BOB])
      .rpc();
    await joinRoomI(room, ALICE.publicKey, aliceToken)
      .signers([ALICE])
      .rpc();
    await expectError(
      program.methods
        .cancelDuel()
        .accounts({
          room,
          roomEscrow: escrowPda(room),
          creatorTokenAccount: bobToken,
          usdcMint,
          creator: BOB.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([BOB])
        .rpc(),
      "RoomFull"
    );
  });

  it("3.7 join_duel fills the room and doubles the escrow", async () => {
    await joinRoomI(roomA, BOB.publicKey, bobToken)
      .signers([BOB])
      .rpc();
    const room = await program.account.duelRoom.fetch(roomA);
    assert.equal(room.opponent.toBase58(), BOB.publicKey.toBase58());
    assert.equal(await tokBalance(escrowPda(roomA)), 4_000_000);
  });

  it("3.8 a full room rejects additional joiners", async () => {
    const carol = Keypair.generate();
    await provider.connection.requestAirdrop(carol.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL);
    await expectError(
      joinRoomI(roomA, carol.publicKey, bobToken).signers([carol]).rpc(),
      "RoomFull"
    );
  });

  it("3.9 the creator cannot self-join (NotParticipant)", async () => {
    // Fresh single-player room: the join passes the RoomFull constraint
    // (opponent == default) but must be refused in the handler.
    const uid = new BN(14);
    const room = roomPda(ALICE.publicKey, uid);
    await createRoomI(ALICE.publicKey, uid, STAKE, new BN(600), aliceToken)
      .signers([ALICE])
      .rpc();
    await expectError(
      joinRoomI(room, ALICE.publicKey, aliceToken).signers([ALICE]).rpc(),
      "NotParticipant"
    );
  });

  // ================================================================
  // 4. Word commitment, commit and reveal
  // ================================================================
  const saltAlice = Buffer.alloc(32, 1);
  const saltBob = Buffer.alloc(32, 2);

  /** Fetch the room's on-chain solution commitment (SHA-256(seed||room||"DUEL")) */
  async function roomSolutionHash(room: PublicKey) {
    return (await program.account.duelRoom.fetch(room)).roomSolutionHash;
  }

  it("4.1 set_duel_word with a zero hash is rejected", async () => {
    await expectError(
      setWordI(roomA, Buffer.alloc(32, 0)).rpc(),
      "InvalidCommitHash"
    );
  });

  it("4.2 non-authority set_duel_word is rejected", async () => {
    const intruder = Keypair.generate();
    await provider.connection.requestAirdrop(intruder.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL);
    const oct = sha256(Buffer.concat([(await roomSolutionHash(roomA)), Buffer.from(DUEL_WORD)]));
    await expectError(
      program.methods
        .setDuelWord(Array.from(oct))
        .accounts({ room: roomA, config: configPda, authority: intruder.publicKey })
        .signers([intruder])
        .rpc(),
      "Unauthorized"
    );
  });

  it("4.3 authority commits SHA-256(room_solution_hash || word) — no plaintext", async () => {
    const commit = sha256(Buffer.concat([await roomSolutionHash(roomA), Buffer.from(DUEL_WORD)]));
    await setWordI(roomA, commit).rpc();
    const room = await program.account.duelRoom.fetch(roomA);
    assert.equal(room.wordSet, true);
    assert.equal(
      Buffer.from(room.duelSolutionHash).toString("hex"),
      commit.toString("hex"),
      "stored commit equals client-computed hash"
    );
  });

  it("4.4 second set_duel_word is rejected (WordAlreadySet)", async () => {
    await expectError(setWordI(roomA, Buffer.alloc(32, 3)).rpc(), "WordAlreadySet");
  });

  // A second room that never gets its word committed.
  let roomNoWord: PublicKey;
  before(async () => {
    roomNoWord = roomPda(BOB.publicKey, new BN(8));
    await createRoomI(BOB.publicKey, new BN(8), STAKE, new BN(600), bobToken)
      .signers([BOB])
      .rpc();
  });

  it("4.5 commit before the word is set is rejected (WordNotSet)", async () => {
    await expectError(
      commitI(roomNoWord, BOB.publicKey, Array.from(Buffer.alloc(32, 1)), 0)
        .signers([BOB])
        .rpc(),
      "WordNotSet"
    );
  });

  it("4.6 commit within the 45s solve floor is rejected (SolvedTooFast)", async () => {
    // Fresh room (joined seconds ago) with the word committed: the floor
    // runs from the join timestamp, so this commit must still be too fast.
    const uid = new BN(10);
    const room = roomPda(ALICE.publicKey, uid);
    await createRoomI(ALICE.publicKey, uid, STAKE, new BN(600), aliceToken)
      .signers([ALICE])
      .rpc();
    await joinRoomI(room, BOB.publicKey, bobToken)
      .signers([BOB])
      .rpc();
    const commitWord = sha256(Buffer.concat([await roomSolutionHash(room), Buffer.from(DUEL_WORD)]));
    await setWordI(room, commitWord).rpc();
    const commit = sha256(Buffer.concat([Buffer.from(DUEL_WORD), saltAlice, ALICE.publicKey.toBytes()]));
    await expectError(
      commitI(room, ALICE.publicKey, Array.from(commit), 3).signers([ALICE]).rpc(),
      "SolvedTooFast"
    );
  });

  it("4.7 commit without an entry account is rejected (account layer)", async () => {
    // The handler's NotParticipant guard is unreachable through the RPC:
    // an entry PDA only exists for creator/opponent, so a stranger's commit
    // fails while loading the entry account (anchor AccountNotInitialized).
    // The program-level guard is exercised by Rust unit tests.
    const carol = Keypair.generate();
    await provider.connection.requestAirdrop(carol.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL);
    await expectError(
      commitI(roomA, carol.publicKey, Array.from(Buffer.alloc(32, 4)), 3)
        .signers([carol])
        .rpc()
    );
  });

  it("4.8 valid commits after the 45-second minimum (slow happy path)", async () => {
    // The 45s floor runs from creator-entry creation (3.1) and opponent
    // join (3.7); both are long past by now.
    const commitA = sha256(Buffer.concat([Buffer.from(DUEL_WORD), saltAlice, ALICE.publicKey.toBytes()]));
    await commitI(roomA, ALICE.publicKey, Array.from(commitA), 3)
      .signers([ALICE])
      .rpc();

    const commitB = sha256(Buffer.concat([Buffer.from(DUEL_WORD), saltBob, BOB.publicKey.toBytes()]));
    // Bob joined at 3.7 which is also well before now.
    await commitI(roomA, BOB.publicKey, Array.from(commitB), 4)
      .signers([BOB])
      .rpc();

    const aEntry = await program.account.duelEntry.fetch(entryPda(roomA, ALICE.publicKey));
    const bEntry = await program.account.duelEntry.fetch(entryPda(roomA, BOB.publicKey));
    assert.ok(aEntry.commitHash.some(Number));
    assert.ok(aEntry.commitTimestamp.toNumber() > 0);
    assert.equal(aEntry.attempts, 3);
    assert.ok(
      bEntry.commitTimestamp.toNumber() >= aEntry.commitTimestamp.toNumber(),
      "Alice committed first"
    );
  });

  it("4.9 a second commit is rejected (AlreadyCommitted)", async () => {
    const commitA = sha256(Buffer.concat([Buffer.from(DUEL_WORD), saltAlice, ALICE.publicKey.toBytes()]));
    await expectError(
      commitI(roomA, ALICE.publicKey, Array.from(commitA), 3).signers([ALICE]).rpc(),
      "AlreadyCommitted"
    );
  });

  it("4.10 reveal without a prior commit is rejected (NotCommitted)", async () => {
    // Fresh room where the creator's entry exists (created by create_duel)
    // but no commit was made yet.
    const uid = new BN(16);
    const room = roomPda(ALICE.publicKey, uid);
    await createRoomI(ALICE.publicKey, uid, STAKE, new BN(600), aliceToken)
      .signers([ALICE])
      .rpc();
    const commitWord = sha256(Buffer.concat([await roomSolutionHash(room), Buffer.from(DUEL_WORD)]));
    await setWordI(room, commitWord).rpc();
    await expectError(
      revealI(room, ALICE.publicKey, DUEL_WORD, saltAlice).signers([ALICE]).rpc(),
      "NotCommitted"
    );
  });

  it("4.11 reveal with a wrong salt is rejected (InvalidReveal)", async () => {
    await expectError(
      revealI(roomA, ALICE.publicKey, DUEL_WORD, Buffer.alloc(32, 0xaa))
        .signers([ALICE])
        .rpc(),
      "InvalidReveal"
    );
  });

  it("4.12 reveal with the wrong word is rejected (InvalidReveal)", async () => {
    // The commit-reveal reconstruction SHA-256(word||salt||player) fails
    // before the room-word check, so the error surfaces as InvalidReveal.
    await expectError(
      revealI(roomA, BOB.publicKey, "WRONG", saltBob).signers([BOB]).rpc(),
      "InvalidReveal"
    );
  });

  it("4.13 valid reveal marks the entry revealed", async () => {
    await revealI(roomA, ALICE.publicKey, DUEL_WORD, saltAlice)
      .signers([ALICE])
      .rpc();
    const entry = await program.account.duelEntry.fetch(entryPda(roomA, ALICE.publicKey));
    assert.equal(entry.revealed, true);
  });

  it("4.14 a second reveal is rejected (AlreadyRevealed)", async () => {
    await expectError(
      revealI(roomA, ALICE.publicKey, DUEL_WORD, saltAlice)
        .signers([ALICE])
        .rpc(),
      "AlreadyRevealed"
    );
  });

  // ================================================================
  // 5. Settlement
  // ================================================================
  const settleAccounts = (room: PublicKey) => ({
    room,
    creatorEntry: entryPda(room, ALICE.publicKey),
    opponentEntry: entryPda(room, BOB.publicKey),
    roomEscrow: escrowPda(room),
    creatorTokenAccount: aliceToken,
    opponentTokenAccount: bobToken,
    keeperTokenAccount: keeperToken,
    platformTokenAccount: platformToken,
    usdcMint,
    config: configPda,
    keeper: authorityKey,
    tokenProgram: TOKEN_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  });

  it("5.1 settle before deadline and before both reveals is rejected (DeadlineNotReached)", async () => {
    // Alice has revealed; Bob has not; room deadline (600s) is in the future.
    await expectError(
      program.methods.settleDuel().accounts(settleAccounts(roomA)).rpc(),
      "DeadlineNotReached"
    );
  });

  it("5.2 settle with both revealed pays winner, keeper tip and platform fee", async () => {
    // Final reveal from Bob.
    await revealI(roomA, BOB.publicKey, DUEL_WORD, saltBob)
      .signers([BOB])
      .rpc();

    const escrowA = escrowPda(roomA);
    const aliceBefore = await tokBalance(aliceToken);
    const bobBefore = await tokBalance(bobToken);
    const keeperBefore = await tokBalance(keeperToken);
    const platformBefore = await tokBalance(platformToken);

    await program.methods
      .settleDuel()
      .accounts(settleAccounts(roomA))
      .rpc();

    const room = await program.account.duelRoom.fetch(roomA);
    assert.deepEqual(room.status, { settled: {} } as any);
    assert.equal(
      room.winner.toBase58(),
      ALICE.publicKey.toBase58(),
      "earlier commit (Alice) wins"
    );
    assert.equal(await tokBalance(escrowA), 0, "escrow fully drained");

    // Economics: pot 4 USDC, 2% fee = 80k units; keeper min(fee, 50k).
    const pot = 4_000_000;
    const fee = (pot * 200) / 10_000;
    assert.equal(await tokBalance(aliceToken) - aliceBefore, pot - fee, "winner: pot - fee");
    assert.equal(await tokBalance(bobToken) - bobBefore, 0, "loser: nothing");
    assert.equal(
      (await tokBalance(keeperToken)) - keeperBefore,
      Math.min(fee, 50_000),
      "keeper fee tip"
    );
    assert.equal(
      (await tokBalance(platformToken)) - platformBefore,
      fee - Math.min(fee, 50_000),
      "platform fee remainder"
    );
  });

  it("5.3 a settled room cannot be settled twice (RoomNotActive)", async () => {
    await expectError(
      program.methods.settleDuel().accounts(settleAccounts(roomA)).rpc(),
      "RoomNotActive"
    );
  });

  it("5.4 duplicate payout accounts are rejected (Overflow guard)", async () => {
    // Fresh room Q: creator Alice, joiner Carol, word committed, both commit
    // and reveal quickly (the guard fires before the deadline check).
    const uid = new BN(11);
    const room = roomPda(ALICE.publicKey, uid);
    await createRoomI(ALICE.publicKey, uid, new BN(1_000_000), new BN(600), aliceToken)
      .signers([ALICE])
      .rpc();
    const carol = Keypair.generate();
    await provider.connection.requestAirdrop(carol.publicKey, 1 * anchor.web3.LAMPORTS_PER_SOL);
    const carolToken = await createAccount(provider.connection, authority.payer, usdcMint, carol.publicKey);
    await mintTo(provider.connection, authority.payer, usdcMint, carolToken, authorityKey, 5_000_000);
    await joinRoomI(room, carol.publicKey, carolToken)
      .signers([carol])
      .rpc();
    const commitWord = sha256(Buffer.concat([await roomSolutionHash(room), Buffer.from(DUEL_WORD)]));
    await setWordI(room, commitWord).rpc();
    await sleep(46_000); // pass the solve-time floor

    const saltA = Buffer.alloc(32, 5);
    const saltC = Buffer.alloc(32, 6);
    const ca = sha256(Buffer.concat([Buffer.from(DUEL_WORD), saltA, ALICE.publicKey.toBytes()]));
    const cc = sha256(Buffer.concat([Buffer.from(DUEL_WORD), saltC, carol.publicKey.toBytes()]));
    await commitI(room, ALICE.publicKey, Array.from(ca), 3).signers([ALICE]).rpc();
    await commitI(room, carol.publicKey, Array.from(cc), 3).signers([carol]).rpc();
    await revealI(room, ALICE.publicKey, DUEL_WORD, saltA).signers([ALICE]).rpc();
    await revealI(room, carol.publicKey, DUEL_WORD, saltC).signers([carol]).rpc();

    // Pass the SAME token account as both keeper and platform payout. Both
    // are authority-owned, so the token constraints pass and the duplicate
    // guard in the handler must reject (Overflow).
    const badSettle = {
      room,
      creatorEntry: entryPda(room, ALICE.publicKey),
      opponentEntry: entryPda(room, carol.publicKey),
      roomEscrow: escrowPda(room),
      creatorTokenAccount: aliceToken,
      opponentTokenAccount: carolToken,
      keeperTokenAccount: keeperToken,
      platformTokenAccount: keeperToken, // dup with keeper
      usdcMint,
      config: configPda,
      keeper: authorityKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };
    await expectError(
      program.methods.settleDuel().accounts(badSettle).rpc(),
      "Overflow"
    );
  });

  it("5.5 tie-by-equal-timestamp splits the pot without fees", async () => {
    // Fresh room T: singe tx commits both players in the same slot.
    const uid = new BN(12);
    const room = roomPda(ALICE.publicKey, uid);
    const escrow = escrowPda(room);
    await createRoomI(ALICE.publicKey, uid, STAKE, new BN(600), aliceToken)
      .signers([ALICE])
      .rpc();
    await joinRoomI(room, BOB.publicKey, bobToken)
      .signers([BOB])
      .rpc();
    const commitWord = sha256(Buffer.concat([await roomSolutionHash(room), Buffer.from(DUEL_WORD)]));
    await setWordI(room, commitWord).rpc();
    await sleep(46_000);

    const saltA = Buffer.alloc(32, 11);
    const saltB = Buffer.alloc(32, 22);
    const ca = sha256(Buffer.concat([Buffer.from(DUEL_WORD), saltA, ALICE.publicKey.toBytes()]));
    const cb = sha256(Buffer.concat([Buffer.from(DUEL_WORD), saltB, BOB.publicKey.toBytes()]));
    const ixA = await commitI(room, ALICE.publicKey, Array.from(ca), 3)
      .signers([ALICE]).instruction();
    const ixB = await commitI(room, BOB.publicKey, Array.from(cb), 4)
      .signers([BOB]).instruction();
    const tx = new anchor.web3.Transaction().add(ixA, ixB);
    await provider.sendAndConfirm(tx, [ALICE, BOB], { skipPreflight: true });

    await revealI(room, ALICE.publicKey, DUEL_WORD, saltA).signers([ALICE]).rpc();
    await revealI(room, BOB.publicKey, DUEL_WORD, saltB).signers([BOB]).rpc();

    const aliceBefore = await tokBalance(aliceToken);
    const escrowBefore = await tokBalance(escrow);
    const platformBefore = await tokBalance(platformToken);
    await program.methods
      .settleDuel()
      .accounts(settleAccounts(room))
      .rpc();

    const roomAfter = await program.account.duelRoom.fetch(room);
    assert.equal(
      roomAfter.winner.toBase58(),
      PublicKey.default.toBase58(),
      "tie yields no winner"
    );
    assert.equal(await tokBalance(escrow), 0, "escrow drained");
    assert.equal(
      await tokBalance(aliceToken) - aliceBefore,
      2_000_000,
      "split returns the stake"
    );
    assert.equal(
      await tokBalance(platformToken) - platformBefore,
      0,
      "no fee is taken on a tie"
    );
  });

  // The solo-timeout refund path (Case 3) needs a 300s wait and is covered
  // by the keeper cron integration plus the Rust unit tests.
  it.skip("5.6 timeout-with-no-reveal refunds both players", () => {});
});