use crate::errors::SlotwordError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};

/// Transfer `amount` of USDC from a PDA-owned escrow to a token account,
/// signed by the room PDA. Uses `transfer_checked` for Token-2022 safety.
pub fn escrow_transfer_from_room<'info>(
    token_program: &Interface<'info, TokenInterface>,
    usdc_mint: &InterfaceAccount<'info, Mint>,
    from_escrow: &InterfaceAccount<'info, TokenAccount>,
    to_acc: &InterfaceAccount<'info, TokenAccount>,
    authority: &AccountInfo<'info>,
    amount: u64,
    signer: &[&[&[u8]]; 2],
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let cpi_accounts = token_interface::TransferChecked {
        mint: usdc_mint.to_account_info(),
        from: from_escrow.to_account_info(),
        to: to_acc.to_account_info(),
        authority: authority.clone(),
    };
    let cpi_ctx = CpiContext::new_with_signer(
        token_program.to_account_info(),
        cpi_accounts,
        signer,
    );
    token_interface::transfer_checked(cpi_ctx, amount, USDC_DECIMALS)
}

/// Compute the platform fee, keeper tip, and platform-admin share of a pot.
pub fn fee_splits(
    total_pot: u64,
    platform_fee_bps: u16,
    keeper_tip_from_fee: bool,
    keeper_tip_usdc: u64,
) -> Result<(u64, u64, u64)> {
    let fee = total_pot
        .checked_mul(platform_fee_bps as u64)
        .ok_or(SlotwordError::Overflow)?
        / 10_000;
    let keeper_tip = if keeper_tip_from_fee {
        fee.min(keeper_tip_usdc)
    } else {
        0
    };
    let platform_fee = fee.saturating_sub(keeper_tip);
    Ok((fee, keeper_tip, platform_fee))
}
