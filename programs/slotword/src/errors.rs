use anchor_lang::error_code;

#[error_code]
pub enum SlotwordError {
    #[msg("Stake amount is below the minimum (0.5 USDC)")]
    StakeTooLow,
    #[msg("Stake amount is above the maximum (100 USDC)")]
    StakeTooHigh,
    #[msg("Room deadline offset must be between 300 and 3600 seconds")]
    InvalidDeadline,
    #[msg("Room is not active")]
    RoomNotActive,
    #[msg("Room already has an opponent")]
    RoomFull,
    #[msg("Caller is not a participant in this room")]
    NotParticipant,
    #[msg("Player attempted to commit before the 45-second minimum solve time")]
    SolvedTooFast,
    #[msg("Player has already committed a solution")]
    AlreadyCommitted,
    #[msg("Player has not committed a solution yet")]
    NotCommitted,
    #[msg("Player has already revealed")]
    AlreadyRevealed,
    #[msg("Reveal hash does not match the committed hash")]
    InvalidReveal,
    #[msg("Revealed word does not match the room's expected answer")]
    WrongWord,
    #[msg("Revealed word does not match the daily solution")]
    WrongDailyWord,
    #[msg("Room deadline has not been reached")]
    DeadlineNotReached,
    #[msg("Room deadline has passed; cannot join")]
    DeadlinePassed,
    #[msg("Unauthorized: only the configured authority may call this")]
    Unauthorized,
    #[msg("DailyChallenge for this day_index already exists")]
    DayAlreadyInitialized,
    #[msg("Player has already solved today")]
    AlreadySolved,
    #[msg("Invalid slot hash seed: sysvar returned no entries")]
    NoSlotHash,
    #[msg("Duel word has not been set yet")]
    WordNotSet,
    #[msg("Duel word has already been set")]
    WordAlreadySet,
    #[msg("Room is not ready: opponent has not joined")]
    RoomNotReady,
    #[msg("Arithmetic overflow")]
    Overflow,
}
