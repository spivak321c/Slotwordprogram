use crate::errors::SlotwordError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct CommitDuelSolution<'info> {
    #[account(
        constraint = room.status == RoomStatus::Active @ SlotwordError::RoomNotActive,
        constraint = room.word_set @ SlotwordError::WordNotSet,
        constraint = room.opponent != Pubkey::default() @ SlotwordError::RoomNotReady,
    )]
    pub room: Account<'info, DuelRoom>,

    #[account(
        mut,
        seeds = [b"entry", room.key().as_ref(), player.key().as_ref()],
        bump = entry.bump,
    )]
    pub entry: Account<'info, DuelEntry>,

    #[account(mut)]
    pub player: Signer<'info>,
}

pub fn commit_duel_solution(
    ctx: Context<CommitDuelSolution>,
    commit_hash: [u8; 32],
    attempts: u8,
) -> Result<()> {
    require!(
        ctx.accounts.player.key() == ctx.accounts.room.creator
            || ctx.accounts.player.key() == ctx.accounts.room.opponent,
        SlotwordError::NotParticipant
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp
            >= ctx.accounts.entry.join_unix_timestamp + MIN_SOLVE_SECONDS,
        SlotwordError::SolvedTooFast
    );
    require!(
        ctx.accounts.entry.commit_hash == [0u8; 32],
        SlotwordError::AlreadyCommitted
    );

    let entry = &mut ctx.accounts.entry;
    entry.commit_hash = commit_hash;
    entry.commit_timestamp = clock.unix_timestamp;
    entry.attempts = attempts;
    Ok(())
}
