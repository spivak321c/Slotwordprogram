use crate::errors::SlotwordError;
use crate::state::*;
use anchor_lang::prelude::*;
use sha2::{Digest, Sha256};

#[derive(Accounts)]
#[instruction(day_index: u64, _word: String, _attempts: u8)]
pub struct SubmitSolution<'info> {
    #[account(
        init,
        payer = player,
        space = 8 + SolverRecord::INIT_SPACE,
        seeds = [b"solver", &day_index.to_le_bytes()[..], player.key().as_ref()],
        bump
    )]
    pub solver_record: Account<'info, SolverRecord>,

    #[account(
        init_if_needed,
        payer = player,
        space = 8 + PlayerProfile::INIT_SPACE,
        seeds = [b"profile", player.key().as_ref()],
        bump
    )]
    pub player_profile: Account<'info, PlayerProfile>,

    #[account(
        mut,
        seeds = [b"day", &day_index.to_le_bytes()[..]],
        bump = daily_challenge.bump,
    )]
    pub daily_challenge: Account<'info, DailyChallenge>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn submit_solution(
    ctx: Context<SubmitSolution>,
    day_index: u64,
    word: String,
    attempts: u8,
) -> Result<()> {
    let daily = &ctx.accounts.daily_challenge;

    let mut hasher = Sha256::new();
    hasher.update(daily.slot_hash_seed);
    hasher.update(word.as_bytes());
    let result = hasher.finalize();
    require!(
        result.as_slice() == daily.solution_hash,
        SlotwordError::WrongDailyWord
    );

    let clock = Clock::get()?;
    let record = &mut ctx.accounts.solver_record;
    record.day_index = day_index;
    record.player = ctx.accounts.player.key();
    record.attempts = attempts;
    record.solved_timestamp = clock.unix_timestamp;
    record.bump = ctx.bumps.solver_record;

    let profile = &mut ctx.accounts.player_profile;
    // Guard against `init_if_needed` reinitialization: a profile may already
    // exist for this player (seeds include player.key, so only this player can
    // touch it). If it does, it must already be theirs; otherwise the account
    // is freshly zeroed by Anchor and we set its identity + bump.
    if profile.player == Pubkey::default() {
        profile.player = ctx.accounts.player.key();
        profile.bump = ctx.bumps.player_profile;
    } else {
        require!(
            profile.player == ctx.accounts.player.key(),
            SlotwordError::Unauthorized
        );
    }
    profile.total_solves = profile.total_solves.saturating_add(1);
    profile.current_streak = profile.current_streak.saturating_add(1);
    if profile.current_streak > profile.best_streak {
        profile.best_streak = profile.current_streak;
    }

    let daily = &mut ctx.accounts.daily_challenge;
    daily.total_solvers = daily.total_solvers.saturating_add(1);
    Ok(())
}
