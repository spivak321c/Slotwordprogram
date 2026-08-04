use crate::errors::SlotwordError;
use crate::state::*;
use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{self, Mint, TokenAccount, TokenInterface};
use sha2::{Digest, Sha256};

#[derive(Accounts)]
#[instruction(day_index: u64, room_uid: u64, stake_amount: u64, deadline_offset_seconds: i64)]
pub struct CreateDuel<'info> {
    #[account(
        init,
        payer = creator,
        space = 8 + DuelRoom::INIT_SPACE,
        seeds = [b"room", creator.key().as_ref(), &room_uid.to_le_bytes()[..]],
        bump
    )]
    pub duel_room: Account<'info, DuelRoom>,

    #[account(
        init,
        payer = creator,
        space = 8 + DuelEntry::INIT_SPACE,
        seeds = [b"entry", duel_room.key().as_ref(), creator.key().as_ref()],
        bump
    )]
    pub creator_entry: Account<'info, DuelEntry>,

    #[account(
        seeds = [b"day", &day_index.to_le_bytes()[..]],
        bump = daily_challenge.bump,
    )]
    pub daily_challenge: Account<'info, DailyChallenge>,

    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,

    #[account(
        mut,
        token::mint = usdc_mint,
        token::authority = creator,
    )]
    pub creator_token_account: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init,
        payer = creator,
        associated_token::mint = usdc_mint,
        associated_token::authority = duel_room,
    )]
    pub room_escrow: InterfaceAccount<'info, TokenAccount>,

    pub usdc_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

pub fn create_duel(
    ctx: Context<CreateDuel>,
    _day_index: u64,
    room_uid: u64,
    stake_amount: u64,
    deadline_offset_seconds: i64,
) -> Result<()> {
    let config = &ctx.accounts.config;
    require!(
        stake_amount >= config.min_stake_usdc,
        SlotwordError::StakeTooLow
    );
    require!(
        stake_amount <= config.max_stake_usdc,
        SlotwordError::StakeTooHigh
    );
    require!(
        deadline_offset_seconds >= MIN_ROOM_SECONDS
            && deadline_offset_seconds <= MAX_ROOM_SECONDS,
        SlotwordError::InvalidDeadline
    );

    let daily = &ctx.accounts.daily_challenge;
    let mut hasher = Sha256::new();
    hasher.update(daily.slot_hash_seed);
    hasher.update(ctx.accounts.duel_room.key().as_ref());
    hasher.update(b"DUEL");
    let room_seed: [u8; 32] = hasher.finalize().into();

    let clock = Clock::get()?;
    let room = &mut ctx.accounts.duel_room;
    room.daily_challenge = ctx.accounts.daily_challenge.key();
    room.room_seed = room_seed;
    room.duel_solution_hash = [0u8; 32];
    room.word_set = false;
    room.creator = ctx.accounts.creator.key();
    room.opponent = Pubkey::default();
    room.stake_amount = stake_amount;
    room.status = RoomStatus::Active;
    room.deadline = clock.unix_timestamp + deadline_offset_seconds;
    room.creator_entry = ctx.accounts.creator_entry.key();
    room.opponent_entry = Pubkey::default();
    room.winner = Pubkey::default();
    room.room_uid = room_uid;
    room.bump = ctx.bumps.duel_room;

    let entry = &mut ctx.accounts.creator_entry;
    entry.duel = ctx.accounts.duel_room.key();
    entry.player = ctx.accounts.creator.key();
    entry.join_unix_timestamp = clock.unix_timestamp;
    entry.bump = ctx.bumps.creator_entry;

    let cpi_accounts = token_interface::TransferChecked {
        mint: ctx.accounts.usdc_mint.to_account_info(),
        from: ctx.accounts.creator_token_account.to_account_info(),
        to: ctx.accounts.room_escrow.to_account_info(),
        authority: ctx.accounts.creator.to_account_info(),
    };
    let cpi_ctx =
        CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
    token_interface::transfer_checked(cpi_ctx, stake_amount, USDC_DECIMALS)?;
    Ok(())
}
