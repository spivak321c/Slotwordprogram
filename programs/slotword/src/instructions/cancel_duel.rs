use crate::errors::SlotwordError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

#[derive(Accounts)]
pub struct CancelDuel<'info> {
    #[account(
        mut,
        constraint = room.status == RoomStatus::Active @ SlotwordError::RoomNotActive,
        constraint = room.opponent == Pubkey::default() @ SlotwordError::RoomFull,
        constraint = room.creator == creator.key() @ SlotwordError::NotParticipant,
    )]
    pub room: Account<'info, DuelRoom>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = room,
    )]
    pub room_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = creator,
    )]
    pub creator_token_account: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn cancel_duel(ctx: Context<CancelDuel>) -> Result<()> {
    let stake = ctx.accounts.room.stake_amount;
    let room_bump = ctx.accounts.room.bump;
    let creator_key = ctx.accounts.room.creator;
    let room_uid = ctx.accounts.room.room_uid;
    let signer_seeds: [&[u8]; 3] = [b"room", creator_key.as_ref(), &room_uid.to_le_bytes()[..]];
    let signer = [&signer_seeds[..], &[room_bump][..]];

    let cpi_accounts = token_interface::TransferChecked {
        mint: ctx.accounts.usdc_mint.to_account_info(),
        from: ctx.accounts.room_escrow.to_account_info(),
        to: ctx.accounts.creator_token_account.to_account_info(),
        authority: ctx.accounts.room.to_account_info(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        cpi_accounts,
        &signer,
    );
    token_interface::transfer_checked(cpi_ctx, stake, USDC_DECIMALS)?;

    ctx.accounts.room.status = RoomStatus::Refunded;
    Ok(())
}
