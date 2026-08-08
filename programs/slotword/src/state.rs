use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct DailyChallenge {
    pub day_index: u64,
    pub slot_hash_seed: [u8; 32],
    pub solution_hash: [u8; 32],
    pub total_solvers: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct DuelRoom {
    pub daily_challenge: Pubkey,
    pub room_solution_hash: [u8; 32],
    pub duel_solution_hash: [u8; 32],
    pub word_set: bool,
    pub creator: Pubkey,
    pub opponent: Pubkey,
    pub stake_amount: u64,
    pub status: RoomStatus,
    pub deadline: i64,
    pub creator_entry: Pubkey,
    pub opponent_entry: Pubkey,
    pub winner: Pubkey,
    pub room_uid: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum RoomStatus {
    Active,
    Settled,
    Refunded,
}

#[account]
#[derive(InitSpace)]
pub struct DuelEntry {
    pub duel: Pubkey,
    pub player: Pubkey,
    pub join_unix_timestamp: i64,
    pub commit_hash: [u8; 32],
    pub commit_timestamp: i64,
    pub revealed: bool,
    pub attempts: u8,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct SolverRecord {
    pub day_index: u64,
    pub player: Pubkey,
    pub attempts: u8,
    pub solved_timestamp: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct PlayerProfile {
    pub player: Pubkey,
    pub total_solves: u32,
    pub current_streak: u32,
    pub best_streak: u32,
    pub duels_won: u32,
    pub duels_lost: u32,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub authority: Pubkey,
    pub platform_fee_bps: u16,
    pub keeper_tip_usdc: u64,
    pub keeper_tip_from_fee: bool,
    pub min_stake_usdc: u64,
    pub max_stake_usdc: u64,
    pub hint_signer_pubkey: Pubkey,
    pub bump: u8,
}

pub const DEFAULT_PLATFORM_FEE_BPS: u16 = 200;
pub const DEFAULT_KEEPER_TIP_USDC: u64 = 50_000;
pub const DEFAULT_MIN_STAKE_USDC: u64 = 500_000;
pub const DEFAULT_MAX_STAKE_USDC: u64 = 100_000_000;
pub const MIN_ROOM_SECONDS: i64 = 300;
pub const MAX_ROOM_SECONDS: i64 = 3600;
pub const MIN_SOLVE_SECONDS: i64 = 45;
pub const USDC_DECIMALS: u8 = 6;
