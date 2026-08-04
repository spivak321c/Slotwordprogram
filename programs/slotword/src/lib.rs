use anchor_lang::prelude::*;

pub mod errors;
pub mod instructions;
pub mod state;

pub use errors::*;
pub use instructions::*;
pub use state::*;

declare_id!("S1otword11111111111111111111111111111111111");

#[program]
pub mod slotword {
    use super::*;

    pub fn initialize_config(ctx: Context<InitializeConfig>) -> Result<()> {
        instructions::initialize_config::initialize_config(ctx)
    }

    pub fn initialize_day(
        ctx: Context<InitializeDay>,
        day_index: u64,
        solution_hash: [u8; 32],
    ) -> Result<()> {
        instructions::initialize_day::initialize_day(ctx, day_index, solution_hash)
    }

    pub fn submit_solution(
        ctx: Context<SubmitSolution>,
        day_index: u64,
        word: String,
        attempts: u8,
    ) -> Result<()> {
        instructions::submit_solution::submit_solution(ctx, day_index, word, attempts)
    }

    pub fn create_duel(
        ctx: Context<CreateDuel>,
        day_index: u64,
        room_uid: u64,
        stake_amount: u64,
        deadline_offset_seconds: i64,
    ) -> Result<()> {
        instructions::create_duel::create_duel(
            ctx,
            day_index,
            room_uid,
            stake_amount,
            deadline_offset_seconds,
        )
    }

    pub fn join_duel(ctx: Context<JoinDuel>) -> Result<()> {
        instructions::join_duel::join_duel(ctx)
    }

    pub fn set_duel_word(ctx: Context<SetDuelWord>, solution_hash: [u8; 32]) -> Result<()> {
        instructions::set_duel_word::set_duel_word(ctx, solution_hash)
    }

    pub fn commit_duel_solution(
        ctx: Context<CommitDuelSolution>,
        commit_hash: [u8; 32],
        attempts: u8,
    ) -> Result<()> {
        instructions::commit_duel_solution::commit_duel_solution(ctx, commit_hash, attempts)
    }

    pub fn reveal_duel_solution(
        ctx: Context<RevealDuelSolution>,
        word: String,
        salt: [u8; 32],
    ) -> Result<()> {
        instructions::reveal_duel_solution::reveal_duel_solution(ctx, word, salt)
    }

    pub fn settle_duel(ctx: Context<SettleDuel>) -> Result<()> {
        instructions::settle_duel::settle_duel(ctx)
    }

    pub fn cancel_duel(ctx: Context<CancelDuel>) -> Result<()> {
        instructions::cancel_duel::cancel_duel(ctx)
    }
}
