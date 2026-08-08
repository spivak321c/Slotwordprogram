use crate::errors::SlotwordError;
use crate::state::*;
use anchor_lang::prelude::*;
use solana_sdk_ids::sysvar::slot_hashes;


//const SLOT_HASHES_SYSVAR: Pubkey = anchor_lang::solana_program::sysvar::slot_hashes::ID;
const SLOT_HASHES_SYSVAR: Pubkey = slot_hashes::ID;

#[derive(Accounts)]
#[instruction(day_index: u64)]
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

    /// CHECK: SlotHashes sysvar. Validated by address constraint.
    #[account(address = SLOT_HASHES_SYSVAR)]
    pub slot_hashes: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_day(
    ctx: Context<InitializeDay>,
    day_index: u64,
    solution_hash: [u8; 32],
) -> Result<()> {
    require!(
        ctx.accounts.authority.key() == ctx.accounts.config.authority,
        SlotwordError::Unauthorized
    );

    // Parse the SlotHashes sysvar buffer (Vec<(Slot, Hash)>):
    //   4-byte length prefix | entries of (8-byte slot | 32-byte hash)
    // The most recent entry is at index 0.
    let data = &ctx.accounts.slot_hashes.data.borrow();
    require!(data.len() >= 44, SlotwordError::NoSlotHash);
    let mut seed = [0u8; 32];
    seed.copy_from_slice(&data[12..44]);

    let daily = &mut ctx.accounts.daily_challenge;
    daily.day_index = day_index;
    daily.slot_hash_seed = seed;
    daily.solution_hash = solution_hash;
    daily.total_solvers = 0;
    daily.bump = ctx.bumps.daily_challenge;
    Ok(())
}
