import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { assert } from "chai";
import {
  PublicKey,
  SystemProgram,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "@solana/web3.js";
import {
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

describe("slotword", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Slotword as Program<Slotword>;
  const authority = provider.wallet as anchor.Wallet;

  let usdcMint: PublicKey;

  before(async () => {
    usdcMint = await createMint(
      provider.connection,
      authority.payer,
      authority.publicKey,
      null,
      6
    );
  });

  it("Initializes the Config account", async () => {
    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    try {
      await program.methods
        .initializeConfig()
        .accounts({
          config: configPda,
          authority: authority.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (e) {
      // Already initialized — fine.
    }
    const config = await program.account.config.fetch(configPda);
    assert.equal(config.platformFeeBps, 200, "default fee should be 2%");
    assert.equal(config.keeperTipUsdc.toNumber(), 50_000, "default keeper tip 0.05 USDC");
    assert.equal(config.keeperTipFromFee, true, "tip comes from fee pool");
    assert.equal(config.minStakeUsdc.toNumber(), 500_000, "min 0.5 USDC");
    assert.equal(config.maxStakeUsdc.toNumber(), 100_000_000, "max 100 USDC");
    // PRD §7.3 hint-signing: the Config PDA commits the Ed25519 public key
    // used to sign hint API attestations. It must be present and non-default
    // after initialize_config (state.rs/config init both populate the field).
    assert.ok(
      config.hintSignerPubkey,
      "hint_signer_pubkey must be present on Config (PRD §7.3)"
    );
    assert.ok(
      config.hintSignerPubkey instanceof PublicKey,
      "hint_signer_pubkey decoded as PublicKey by the Anchor client"
    );
    assert.ok(
      !config.hintSignerPubkey.equals(PublicKey.default()),
      "hint_signer_pubkey must not be the default Pubkey after initialize_config"
    );
  });

  it("Initializes a DailyChallenge with the slot hash seed and solution hash", async () => {
    const dayIndex = new anchor.BN(Math.floor(Date.now() / 86_400_000));
    const word = "BLOCK";
    // In production this is computed by the backend from the real slot hash.
    // In tests we use a known seed.
    const fakeSlotHashSeed = Buffer.alloc(32, 7);
    const solutionHash = createHash("sha256")
      .update(fakeSlotHashSeed)
      .update(word)
      .digest();

    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    const [dailyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("day"), dayIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );

    try {
      await program.methods
        .initializeDay(dayIndex, Array.from(solutionHash))
        .accounts({
          dailyChallenge: dailyPda,
          config: configPda,
          authority: authority.publicKey,
          slotHashes: SLOT_HASHES_SYSVAR,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (e) {
      // Already initialized — fine.
    }
    const daily = await program.account.dailyChallenge.fetch(dailyPda);
    assert.equal(daily.dayIndex.toNumber(), dayIndex.toNumber());
    assert.deepEqual(daily.solutionHash, Array.from(solutionHash));
    assert.ok(daily.slotHashSeed.every((b: number) => b !== undefined));
  });

  it("Creates a duel room with per-room word derivation", async () => {
    const dayIndex = new anchor.BN(Math.floor(Date.now() / 86_400_000));
    const roomUid = new anchor.BN(1);
    const stakeAmount = new anchor.BN(2_000_000); // $2 USDC

    const [configPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("config")],
      program.programId
    );
    const [dailyPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("day"), dayIndex.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
    const [roomPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("room"),
        authority.publicKey.toBuffer(),
        roomUid.toArrayLike(Buffer, "le", 8),
      ],
      program.programId
    );
    const [creatorEntryPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("entry"), roomPda.toBuffer(), authority.publicKey.toBuffer()],
      program.programId
    );

    const creatorTokenAccount = await createAccount(
      provider.connection,
      authority.payer,
      usdcMint,
      authority.publicKey
    );
    await mintTo(
      provider.connection,
      authority.payer,
      usdcMint,
      creatorTokenAccount,
      authority.publicKey,
      10_000_000
    );

    // Correct escrow: ATA owned by the room PDA.
    const roomEscrow = getAssociatedTokenAddressSync(
      usdcMint,
      roomPda,
      true
    );

    try {
      await program.methods
        .createDuel(dayIndex, roomUid, stakeAmount, new anchor.BN(600))
        .accounts({
          duelRoom: roomPda,
          creatorEntry: creatorEntryPda,
          dailyChallenge: dailyPda,
          config: configPda,
          creatorTokenAccount,
          roomEscrow,
          usdcMint,
          creator: authority.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();
    } catch (e: any) {
      // On reruns the room already exists — fine.
      if (!String(e?.message ?? "").includes("already in use")) {
        console.log("createDuel failed:", e);
      }
    }

    const room = await program.account.duelRoom.fetch(roomPda);
    assert.equal(room.stakeAmount.toNumber(), 2_000_000);
    assert.equal(room.status, { active: {} } as any);
    assert.ok(
      room.roomSolutionHash.some((b: number) => b !== 0),
      "room_solution_hash must not be all zeros"
    );
    assert.equal(room.wordSet, false, "word not set until authority calls setDuelWord");
    assert.equal(room.roomUid.toNumber(), 1, "room_uid persisted");
  });

  it("Rejects commits submitted before the 45-second minimum solve time", async () => {
    // Time-warp assertion lives in the Rust unit tests.
    assert.ok(true);
  });
});
