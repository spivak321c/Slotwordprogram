use crate::errors::SlotwordError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

#[derive(Accounts)]
pub struct JoinDuel<'info> {
    #[account(
        mut,
        constraint = room.status == RoomStatus::Active @ SlotwordError::RoomNotActive,
        constraint = room.opponent == Pubkey::default() @ SlotwordError::RoomFull,
    )]
    pub room: Account<'info, DuelRoom>,

    #[account(
        init,
        payer = opponent,
        space = 8 + DuelEntry::INIT_SPACE,
        seeds = [b"entry", room.key().as_ref(), opponent.key().as_ref()],
        bump
    )]
    pub opponent_entry: Account<'info, DuelEntry>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = opponent,
    )]
    pub opponent_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = room,
    )]
    pub room_escrow: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub opponent: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn join_duel(ctx: Context<JoinDuel>) -> Result<()> {
    // Refuse self-join: a creator cannot also be the opponent.
    require!(
        ctx.accounts.opponent.key() != ctx.accounts.room.creator,
        SlotwordError::NotParticipant
    );

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp < ctx.accounts.room.deadline,
        SlotwordError::DeadlinePassed
    );

    let room_key = ctx.accounts.room.key();
    let stake = ctx.accounts.room.stake_amount;

    let room = &mut ctx.accounts.room;
    room.opponent = ctx.accounts.opponent.key();
    room.opponent_entry = ctx.accounts.opponent_entry.key();

    let entry = &mut ctx.accounts.opponent_entry;
    entry.duel = room_key;
    entry.player = ctx.accounts.opponent.key();
    entry.join_unix_timestamp = clock.unix_timestamp;
    entry.bump = ctx.bumps.opponent_entry;

    let cpi_accounts = token_interface::TransferChecked {
        mint: ctx.accounts.usdc_mint.to_account_info(),
        from: ctx.accounts.opponent_token_account.to_account_info(),
        to: ctx.accounts.room_escrow.to_account_info(),
        authority: ctx.accounts.opponent.to_account_info(),
    };
    let cpi_ctx =
        CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, stake, USDC_DECIMALS)?;
    Ok(())
}
