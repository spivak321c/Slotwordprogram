use crate::errors::SlotwordError;
use crate::state::*;
use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

#[derive(Accounts)]
pub struct RevealDuelSolution<'info> {
    #[account(
        has_one = daily_challenge,
        constraint = room.word_set @ SlotwordError::WordNotSet,
    )]
    pub room: Account<'info, DuelRoom>,

    #[account(
        mut,
        seeds = [b"entry", room.key().as_ref(), player.key().as_ref()],
        bump = entry.bump,
    )]
    pub entry: Account<'info, DuelEntry>,

    pub daily_challenge: Account<'info, DailyChallenge>,

    #[account(mut)]
    pub player: Signer<'info>,
}

pub fn reveal_duel_solution(
    ctx: Context<RevealDuelSolution>,
    word: String,
    salt: [u8; 32],
) -> Result<()> {
    require!(
        ctx.accounts.player.key() == ctx.accounts.room.creator
            || ctx.accounts.player.key() == ctx.accounts.room.opponent,
        SlotwordError::NotParticipant
    );

    let entry = &mut ctx.accounts.entry;
    require!(
        entry.commit_hash != [0u8; 32],
        SlotwordError::NotCommitted
    );
    require!(!entry.revealed, SlotwordError::AlreadyRevealed);

    // Verify commit-reveal: SHA-256(word || salt || player).
    let mut hasher = Sha256::new();
    hasher.update(word.as_bytes());
    hasher.update(salt);
    hasher.update(ctx.accounts.player.key().as_ref());
    let reconstructed = hasher.finalize();
    require!(
        reconstructed.as_slice() == entry.commit_hash,
        SlotwordError::InvalidReveal
    );

    // Verify the word is the correct room answer: SHA-256(slot_hash_seed || word).
    let room = &ctx.accounts.room;
    let mut hash = Sha256::new();
    hash.update(ctx.accounts.daily_challenge.slot_hash_seed);
    hash.update(word.as_bytes());
    let computed = hash.finalize();
    require!(
        computed.as_slice() == room.duel_solution_hash,
        SlotwordError::WrongWord
    );

    entry.revealed = true;
    Ok(())
}
