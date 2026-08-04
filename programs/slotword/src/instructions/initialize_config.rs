use crate::state::*;
use anchor_lang::prelude::*;

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + Config::INIT_SPACE,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
    let config = &mut ctx.accounts.config;
    config.authority = ctx.accounts.authority.key();
    config.platform_fee_bps = DEFAULT_PLATFORM_FEE_BPS;
    config.keeper_tip_usdc = DEFAULT_KEEPER_TIP_USDC;
    config.keeper_tip_from_fee = true;
    config.min_stake_usdc = DEFAULT_MIN_STAKE_USDC;
    config.max_stake_usdc = DEFAULT_MAX_STAKE_USDC;
    config.hint_signer_pubkey = ctx.accounts.authority.key();
    config.bump = ctx.bumps.config;
    Ok(())
}
