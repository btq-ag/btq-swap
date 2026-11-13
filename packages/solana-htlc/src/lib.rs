//! SPL-token hash timelock. The buyer locks tokens for the seller. The seller
//! withdraws with the 32-byte preimage. The buyer refunds after the unix deadline.
//!
//! State (179 bytes):
//!   0        initialized (1)
//!   1..33    party_a
//!   33..65   party_b
//!   65..97   mint
//!   97..129  secret hash
//!   129..137 deadline (unix seconds, u64 le)
//!   137..145 amount (u64 le)
//!   145      flags (1 = withdrawn, 2 = refunded)
//!   146      bump
//!   147..179 revealed preimage (zeros until withdraw)

use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    hash::hash,
    program::invoke_signed,
    program_error::ProgramError,
    pubkey::Pubkey,
    system_instruction,
    sysvar::{clock::Clock, rent::Rent, Sysvar},
};

entrypoint!(process_instruction);

pub const STATE_LEN: usize = 179;
const TOKEN_PROGRAM: &str = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

fn token_program_id() -> Pubkey {
    TOKEN_PROGRAM.parse().unwrap()
}

fn read_u64(data: &[u8], at: usize) -> u64 {
    u64::from_le_bytes(data[at..at + 8].try_into().unwrap())
}

fn token_field(data: &[u8], mint_at: bool) -> Result<&[u8], ProgramError> {
    if data.len() < 72 {
        return Err(ProgramError::InvalidAccountData);
    }
    Ok(if mint_at { &data[0..32] } else { &data[32..64] })
}

pub fn agreement_id(party_a: &[u8], party_b: &[u8], mint: &[u8], amount: u64, secret_hash: &[u8], deadline: u64) -> [u8; 32] {
    let mut buf = Vec::with_capacity(32 * 4 + 16);
    buf.extend_from_slice(party_a);
    buf.extend_from_slice(party_b);
    buf.extend_from_slice(mint);
    buf.extend_from_slice(&amount.to_le_bytes());
    buf.extend_from_slice(secret_hash);
    buf.extend_from_slice(&deadline.to_le_bytes());
    hash(&buf).to_bytes()
}

fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match tag {
        0 => lock(program_id, accounts, rest),
        1 => withdraw(program_id, accounts, rest),
        2 => refund(program_id, accounts),
        _ => Err(ProgramError::InvalidInstructionData),
    }
}

fn lock(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 80 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let party_b = &data[0..32];
    let secret_hash = &data[32..64];
    let deadline = read_u64(data, 64);
    let amount = read_u64(data, 72);
    if amount == 0 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let now = Clock::get()?.unix_timestamp;
    if deadline as i64 <= now {
        return Err(ProgramError::InvalidArgument);
    }

    let iter = &mut accounts.iter();
    let party_a = next_account_info(iter)?;
    let state = next_account_info(iter)?;
    let source = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    let system_program = next_account_info(iter)?;
    let mint = next_account_info(iter)?;
    if !party_a.is_signer {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if token_program.key != &token_program_id() || system_program.key != &solana_program::system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }

    let id = agreement_id(party_a.key.as_ref(), party_b, mint.key.as_ref(), amount, secret_hash, deadline);
    let (pda, bump) = Pubkey::find_program_address(&[b"htlc", id.as_ref()], program_id);
    if state.key != &pda {
        return Err(ProgramError::InvalidSeeds);
    }
    if source.owner != token_program.key || vault.owner != token_program.key {
        return Err(ProgramError::IllegalOwner);
    }
    if token_field(&source.data.borrow(), true)? != mint.key.as_ref() || token_field(&vault.data.borrow(), true)? != mint.key.as_ref() {
        return Err(ProgramError::InvalidAccountData);
    }
    if token_field(&source.data.borrow(), false)? != party_a.key.as_ref() || token_field(&vault.data.borrow(), false)? != pda.as_ref() {
        return Err(ProgramError::InvalidAccountData);
    }

    let rent = Rent::get()?.minimum_balance(STATE_LEN);
    invoke_signed(
        &system_instruction::create_account(party_a.key, state.key, rent, STATE_LEN as u64, program_id),
        &[party_a.clone(), state.clone(), system_program.clone()],
        &[&[b"htlc".as_ref(), id.as_ref(), &[bump]]],
    )?;

    {
        let mut body = state.data.borrow_mut();
        body[0] = 1;
        body[1..33].copy_from_slice(party_a.key.as_ref());
        body[33..65].copy_from_slice(party_b);
        body[65..97].copy_from_slice(mint.key.as_ref());
        body[97..129].copy_from_slice(secret_hash);
        body[129..137].copy_from_slice(&deadline.to_le_bytes());
        body[137..145].copy_from_slice(&amount.to_le_bytes());
        body[146] = bump;
    }

    token_transfer(source, vault, party_a, token_program, amount, &[])
}

fn withdraw(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    if data.len() != 32 {
        return Err(ProgramError::InvalidInstructionData);
    }
    let iter = &mut accounts.iter();
    let party_b = next_account_info(iter)?;
    let state = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let dest = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    if !party_b.is_signer || token_program.key != &token_program_id() || state.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let now = Clock::get()?.unix_timestamp;
    let (_pda, bump, amount) = open_state(state, program_id, true, now)?;
    if &state.data.borrow()[33..65] != party_b.key.as_ref() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if hash(data).to_bytes().as_ref() != &state.data.borrow()[97..129] {
        return Err(ProgramError::InvalidArgument);
    }
    if token_field(&dest.data.borrow(), false)? != party_b.key.as_ref() {
        return Err(ProgramError::InvalidAccountData);
    }
    let id = agreement_from(state);
    let bump_seed = [bump];
    token_transfer(vault, dest, state, token_program, amount, &[b"htlc".as_ref(), id.as_ref(), bump_seed.as_ref()])?;
    let mut body = state.data.borrow_mut();
    body[145] |= 1;
    body[147..179].copy_from_slice(data);
    Ok(())
}

fn refund(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let iter = &mut accounts.iter();
    let party_a = next_account_info(iter)?;
    let state = next_account_info(iter)?;
    let vault = next_account_info(iter)?;
    let dest = next_account_info(iter)?;
    let token_program = next_account_info(iter)?;
    if !party_a.is_signer || token_program.key != &token_program_id() || state.owner != program_id {
        return Err(ProgramError::IllegalOwner);
    }
    let now = Clock::get()?.unix_timestamp;
    let (_pda, bump, amount) = open_state(state, program_id, false, now)?;
    if &state.data.borrow()[1..33] != party_a.key.as_ref() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    if token_field(&dest.data.borrow(), false)? != party_a.key.as_ref() {
        return Err(ProgramError::InvalidAccountData);
    }
    let id = agreement_from(state);
    let bump_seed = [bump];
    token_transfer(vault, dest, state, token_program, amount, &[b"htlc".as_ref(), id.as_ref(), bump_seed.as_ref()])?;
    state.data.borrow_mut()[145] |= 2;
    Ok(())
}

fn agreement_from(state: &AccountInfo) -> [u8; 32] {
    let data = state.data.borrow();
    agreement_id(&data[1..33], &data[33..65], &data[65..97], read_u64(&data, 137), &data[97..129], read_u64(&data, 129))
}

fn open_state(state: &AccountInfo, program_id: &Pubkey, claim: bool, now: i64) -> Result<(Pubkey, u8, u64), ProgramError> {
    let data = state.data.borrow();
    if data.len() != STATE_LEN || data[0] != 1 || data[145] != 0 {
        return Err(ProgramError::InvalidAccountData);
    }
    let deadline = read_u64(&data, 129) as i64;
    if claim && deadline <= now {
        return Err(ProgramError::InvalidArgument);
    }
    if !claim && deadline > now {
        return Err(ProgramError::InvalidArgument);
    }
    let id = agreement_id(&data[1..33], &data[33..65], &data[65..97], read_u64(&data, 137), &data[97..129], read_u64(&data, 129));
    let (pda, bump) = Pubkey::find_program_address(&[b"htlc", id.as_ref()], program_id);
    if state.key != &pda || data[146] != bump {
        return Err(ProgramError::InvalidSeeds);
    }
    Ok((pda, bump, read_u64(&data, 137)))
}

fn token_transfer<'a>(
    source: &AccountInfo<'a>,
    dest: &AccountInfo<'a>,
    authority: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    amount: u64,
    seeds: &[&[u8]],
) -> ProgramResult {
    let mut ix_data = vec![3u8];
    ix_data.extend_from_slice(&amount.to_le_bytes());
    let ix = solana_program::instruction::Instruction {
        program_id: *token_program.key,
        accounts: vec![
            solana_program::instruction::AccountMeta::new(*source.key, false),
            solana_program::instruction::AccountMeta::new(*dest.key, false),
            solana_program::instruction::AccountMeta::new_readonly(*authority.key, true),
        ],
        data: ix_data,
    };
    if seeds.is_empty() {
        solana_program::program::invoke(&ix, &[source.clone(), dest.clone(), authority.clone(), token_program.clone()])
    } else {
        invoke_signed(&ix, &[source.clone(), dest.clone(), authority.clone(), token_program.clone()], &[seeds])
    }
}
