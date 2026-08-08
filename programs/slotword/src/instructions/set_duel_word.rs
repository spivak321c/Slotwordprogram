use crate::errors::SlotwordError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct SetDuelWord<'info> {
    #[account(
        mut,
        constraint = room.status == RoomStatus::Active @ SlotwordError::RoomNotActive,
        constraint = !room.word_set @ SlotwordError::WordAlreadySet,
    )]
    pub room: Account<'info, DuelRoom>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub authority: Signer<'info>,
}

/// The authority commits the per-room word WITHOUT publishing it.
///
/// The room's answer commitment (`room_solution_hash = SHA-256(slot_hash_seed
/// || room.key() || "DUEL")`) is fixed at room creation. The word is derived
/// off-chain (`word = wordlist[room_solution_hash % len]`) and stays secret —
/// players must solve it via the hint API. Only its hash is committed here:
///
///   duel_solution_hash = SHA-256(room_solution_hash || word)
///
/// The plaintext word is never submitted on-chain, so a player who has not
/// solved the word cannot learn it from the ledger. `reveal_duel_solution`
/// recomputes this hash from the revealed word and compares against the
/// committed value.
pub fn set_duel_word(ctx: Context<SetDuelWord>, word_hash: [u8; 32]) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.config.authority,
        SlotwordError::Unauthorized
    );
    require!(word_hash != [0u8; 32], SlotwordError::InvalidCommitHash);

    let room = &mut ctx.accounts.room;
    room.duel_solution_hash = word_hash;
    room.word_set = true;
    Ok(())
}
