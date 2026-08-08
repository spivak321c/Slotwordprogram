use crate::errors::SlotwordError;
use crate::instructions::helpers::{escrow_transfer_from_room, fee_splits};
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface};

#[derive(Accounts)]
pub struct SettleDuel<'info> {
    #[account(
        mut,
        constraint = room.status == RoomStatus::Active @ SlotwordError::RoomNotActive,
        constraint = room.opponent != Pubkey::default() @ SlotwordError::RoomNotReady,
    )]
    pub room: Account<'info, DuelRoom>,

    #[account(
        mut,
        seeds = [b"entry", room.key().as_ref(), room.creator.as_ref()],
        bump = creator_entry.bump,
    )]
    pub creator_entry: Account<'info, DuelEntry>,

    #[account(
        mut,
        seeds = [b"entry", room.key().as_ref(), room.opponent.as_ref()],
        bump = opponent_entry.bump,
    )]
    pub opponent_entry: Account<'info, DuelEntry>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = room,
    )]
    pub room_escrow: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = room.creator,
    )]
    pub creator_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = room.opponent,
    )]
    pub opponent_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = keeper,
    )]
    pub keeper_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = config.authority,
    )]
    pub platform_token_account: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(mut)]
    pub keeper: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn settle_duel(ctx: Context<SettleDuel>) -> Result<()> {
    // Defense against duplicate-mutable-account accounting bugs (security §7):
    // creator and opponent must be distinct, and the four payout token accounts
    // must be distinct as well — otherwise sequential CPIs into the same account
    // would obfuscate the recorded balance and let the keeper/authority skim.
    require!(
        ctx.accounts.room.creator != ctx.accounts.room.opponent,
        SlotwordError::NotParticipant
    );
    {
        let c = ctx.accounts.creator_token_account.key();
        let o = ctx.accounts.opponent_token_account.key();
        let k = ctx.accounts.keeper_token_account.key();
        let p = ctx.accounts.platform_token_account.key();
        require!(c != o && c != k && c != p && o != k && o != p && k != p, SlotwordError::Overflow);
        require!(c != ctx.accounts.room_escrow.key(), SlotwordError::Overflow);
        require!(o != ctx.accounts.room_escrow.key(), SlotwordError::Overflow);
        require!(k != ctx.accounts.room_escrow.key(), SlotwordError::Overflow);
        require!(p != ctx.accounts.room_escrow.key(), SlotwordError::Overflow);
    }

    let clock = Clock::get()?;
    let creator_revealed = ctx.accounts.creator_entry.revealed;
    let opponent_revealed = ctx.accounts.opponent_entry.revealed;
    let both_revealed = creator_revealed && opponent_revealed;
    let deadline_reached = clock.unix_timestamp >= ctx.accounts.room.deadline;
    require!(
        both_revealed || deadline_reached,
        SlotwordError::DeadlineNotReached
    );

    let stake = ctx.accounts.room.stake_amount;
    let total_pot = stake.checked_mul(2).ok_or(SlotwordError::Overflow)?;
    let room_bump = ctx.accounts.room.bump;
    let creator_key = ctx.accounts.room.creator;
    let room_uid = ctx.accounts.room.room_uid;

    let signer_seeds: [&[u8]; 4] = [
        b"room",
        creator_key.as_ref(),
        &room_uid.to_le_bytes()[..],
        &[room_bump],
    ];
    let signer: &[&[&[u8]]] = &[&signer_seeds[..]];

    if both_revealed {
        let creator_ts = ctx.accounts.creator_entry.commit_timestamp;
        let opponent_ts = ctx.accounts.opponent_entry.commit_timestamp;
        if creator_ts == opponent_ts {
            let half = total_pot / 2;
            escrow_transfer_from_room(
                &ctx.accounts.token_program,
                &ctx.accounts.usdc_mint,
                &ctx.accounts.room_escrow,
                &ctx.accounts.creator_token_account,
                &ctx.accounts.room.to_account_info(),
                half,
                signer,
            )?;
            escrow_transfer_from_room(
                &ctx.accounts.token_program,
                &ctx.accounts.usdc_mint,
                &ctx.accounts.room_escrow,
                &ctx.accounts.opponent_token_account,
                &ctx.accounts.room.to_account_info(),
                total_pot - half,
                signer,
            )?;
            ctx.accounts.room.status = RoomStatus::Settled;
            ctx.accounts.room.winner = Pubkey::default();
            return Ok(());
        }
        let winner_is_creator = creator_ts < opponent_ts;
        //settle_win(&ctx, total_pot, winner_is_creator, signer)?;
        settle_win(
    &ctx.accounts.token_program,
    &ctx.accounts.usdc_mint,
    &ctx.accounts.room_escrow,
    &ctx.accounts.creator_token_account,
    &ctx.accounts.opponent_token_account,
    &ctx.accounts.keeper_token_account,
    &ctx.accounts.platform_token_account,
    &ctx.accounts.room,
    &ctx.accounts.config,
    total_pot,
    winner_is_creator,
    signer,
)?;
        ctx.accounts.room.status = RoomStatus::Settled;
        ctx.accounts.room.winner = if winner_is_creator {
            ctx.accounts.room.creator
        } else {
            ctx.accounts.room.opponent
        };
        return Ok(());
    }

    if creator_revealed {
        //settle_win(&ctx, total_pot, true, signer)?;
        settle_win(
    &ctx.accounts.token_program,
    &ctx.accounts.usdc_mint,
    &ctx.accounts.room_escrow,
    &ctx.accounts.creator_token_account,
    &ctx.accounts.opponent_token_account,
    &ctx.accounts.keeper_token_account,
    &ctx.accounts.platform_token_account,
    &ctx.accounts.room,
    &ctx.accounts.config,
    total_pot,
    true,
    signer,
)?;
        ctx.accounts.room.status = RoomStatus::Settled;
        ctx.accounts.room.winner = ctx.accounts.room.creator;
        return Ok(());
    }
    if opponent_revealed {
        //settle_win(&ctx, total_pot, false, signer)?;
        settle_win(
    &ctx.accounts.token_program,
    &ctx.accounts.usdc_mint,
    &ctx.accounts.room_escrow,
    &ctx.accounts.creator_token_account,
    &ctx.accounts.opponent_token_account,
    &ctx.accounts.keeper_token_account,
    &ctx.accounts.platform_token_account,
    &ctx.accounts.room,
    &ctx.accounts.config,
    total_pot,
    false,
    signer,
)?;
        ctx.accounts.room.status = RoomStatus::Settled;
        ctx.accounts.room.winner = ctx.accounts.room.opponent;
        return Ok(());
    }

    // Neither revealed — refund both stakes.
    escrow_transfer_from_room(
        &ctx.accounts.token_program,
        &ctx.accounts.usdc_mint,
        &ctx.accounts.room_escrow,
        &ctx.accounts.creator_token_account,
        &ctx.accounts.room.to_account_info(),
        stake,
        signer,
    )?;
    escrow_transfer_from_room(
        &ctx.accounts.token_program,
        &ctx.accounts.usdc_mint,
        &ctx.accounts.room_escrow,
        &ctx.accounts.opponent_token_account,
        &ctx.accounts.room.to_account_info(),
        stake,
        signer,
    )?;
    ctx.accounts.room.status = RoomStatus::Refunded;
    ctx.accounts.room.winner = Pubkey::default();
    Ok(())
}

fn settle_win<'info>(
    token_program: &Interface<'info, TokenInterface>,
    usdc_mint: &InterfaceAccount<'info, Mint>,
    room_escrow: &InterfaceAccount<'info, TokenAccount>,
    creator_token_account: &InterfaceAccount<'info, TokenAccount>,
    opponent_token_account: &InterfaceAccount<'info, TokenAccount>,
    keeper_token_account: &InterfaceAccount<'info, TokenAccount>,
    platform_token_account: &InterfaceAccount<'info, TokenAccount>,
    room: &Account<'info, DuelRoom>,
    config: &Account<'info, Config>,
    total_pot: u64,
    winner_is_creator: bool,
    signer: &[&[&[u8]]],
) -> Result<()> {
    let (_fee, keeper_tip, platform_fee) = fee_splits(
        total_pot,
        config.platform_fee_bps,
        config.keeper_tip_from_fee,
        config.keeper_tip_usdc,
    )?;

    let winner_payout = total_pot
        .checked_sub(_fee)
        .ok_or(SlotwordError::Overflow)?;

    let winner_acc = if winner_is_creator {
        creator_token_account
    } else {
        opponent_token_account
    };

    escrow_transfer_from_room(
        token_program,
        usdc_mint,
        room_escrow,
        winner_acc,
        &room.to_account_info(),
        winner_payout,
        signer,
    )?;

    if keeper_tip > 0 {
        escrow_transfer_from_room(
            token_program,
            usdc_mint,
            room_escrow,
            keeper_token_account,
            &room.to_account_info(),
            keeper_tip,
            signer,
        )?;
    }

    if platform_fee > 0 {
        escrow_transfer_from_room(
            token_program,
            usdc_mint,
            room_escrow,
            platform_token_account,
            &room.to_account_info(),
            platform_fee,
            signer,
        )?;
    }

    Ok(())
}