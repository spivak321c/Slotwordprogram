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

pub fn set_duel_word(ctx: Context<SetDuelWord>, solution_hash: [u8; 32]) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.config.authority,
        SlotwordError::Unauthorized
    );
    let room = &mut ctx.accounts.room;
    room.duel_solution_hash = solution_hash;
    room.word_set = true;
    Ok(())
}
