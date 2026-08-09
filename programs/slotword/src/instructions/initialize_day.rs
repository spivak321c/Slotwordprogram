use crate::errors::SlotwordError;
use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
#[instruction(day_index: u64, _slot_hash_seed: [u8; 32])]
pub struct InitializeDay<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + DailyChallenge::INIT_SPACE,
        seeds = [b"day", &day_index.to_le_bytes()[..]],
        bump
    )]
    pub daily_challenge: Account<'info, DailyChallenge>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_day(
    ctx: Context<InitializeDay>,
    day_index: u64,
    slot_hash_seed: [u8; 32],
    solution_hash: [u8; 32],
) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.config.authority,
        SlotwordError::Unauthorized
    );

    let daily = &mut ctx.accounts.daily_challenge;
    daily.day_index = day_index;
    daily.slot_hash_seed = slot_hash_seed;
    daily.solution_hash = solution_hash;
    daily.total_solvers = 0;
    daily.bump = ctx.bumps.daily_challenge;
    Ok(())
}
