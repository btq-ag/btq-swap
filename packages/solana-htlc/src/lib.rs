//! SPL-token hash timelock. The buyer locks tokens for the seller. The seller
//! withdraws with the 32-byte preimage. The buyer refunds after the unix deadline.
//!
//! State (179 bytes):
//!   0        version (1 = legacy, 2 = canonical vault with rent cleanup)
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
    program::{invoke, invoke_signed},
    program_pack::Pack,
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

fn token_account(account: &AccountInfo) -> Result<spl_token::state::Account, ProgramError> {
    if account.owner != &token_program_id() { return Err(ProgramError::IllegalOwner); }
    spl_token::state::Account::unpack(&account.data.borrow())
}

fn canonical_vault(state: &Pubkey, mint: &Pubkey) -> Pubkey {
    let ata: Pubkey = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL".parse().unwrap();
    Pubkey::find_program_address(&[state.as_ref(), token_program_id().as_ref(), mint.as_ref()], &ata).0
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

pub fn process_instruction(program_id: &Pubkey, accounts: &[AccountInfo], data: &[u8]) -> ProgramResult {
    let (tag, rest) = data.split_first().ok_or(ProgramError::InvalidInstructionData)?;
    match tag {
        0 => lock(program_id, accounts, rest),
        1 => withdraw(program_id, accounts, rest),
        2 if rest.is_empty() => refund(program_id, accounts),
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
    if vault.key != &canonical_vault(state.key, mint.key) { return Err(ProgramError::InvalidSeeds); }
    let source_data = token_account(source)?;
    let vault_data = token_account(vault)?;
    if source_data.mint != *mint.key || vault_data.mint != *mint.key ||
        source_data.owner != *party_a.key || vault_data.owner != pda ||
        vault_data.delegate.is_some() || vault_data.close_authority.is_some() {
        return Err(ProgramError::InvalidAccountData);
    }
    // A transfer to a PDA must not prevent its legitimate initialization.
    if state.owner != &solana_program::system_program::id() || !state.data_is_empty() || state.executable {
        return Err(ProgramError::AccountAlreadyInitialized);
    }
    let rent = Rent::get()?.minimum_balance(STATE_LEN);
    let topup = rent.saturating_sub(state.lamports());
    if topup > 0 {
        invoke(&system_instruction::transfer(party_a.key, state.key, topup),
            &[party_a.clone(), state.clone(), system_program.clone()])?;
    }
    let bump_seed = [bump];
    let seeds = &[b"htlc".as_ref(), id.as_ref(), bump_seed.as_ref()];
    invoke_signed(&system_instruction::allocate(state.key, STATE_LEN as u64),
        &[state.clone(), system_program.clone()], &[seeds])?;
    invoke_signed(&system_instruction::assign(state.key, program_id),
        &[state.clone(), system_program.clone()], &[seeds])?;

    {
        let mut body = state.data.borrow_mut();
        body[0] = 2;
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
    let party_a = if state.data.borrow()[0] == 2 { next_account_info(iter)? } else { party_b };
    settle(state, vault, dest, token_program, party_b, party_a, bump, amount, Some(data))
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
    let (_, bump, amount) = open_state(state, program_id, false, now)?;
    if &state.data.borrow()[1..33] != party_a.key.as_ref() {
        return Err(ProgramError::MissingRequiredSignature);
    }
    settle(state, vault, dest, token_program, party_a, party_a, bump, amount, None)
}

fn settle<'a>(state: &AccountInfo<'a>, vault: &AccountInfo<'a>, dest: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>, recipient: &AccountInfo<'a>, rent_recipient: &AccountInfo<'a>,
    bump: u8, amount: u64, preimage: Option<&[u8]>) -> ProgramResult {
    let body = state.data.borrow();
    let modern = body[0] == 2;
    let mint = Pubkey::new_from_array(body[65..97].try_into().unwrap());
    if modern && rent_recipient.key.as_ref() != &body[1..33] { return Err(ProgramError::InvalidArgument); }
    drop(body);
    let source_data = token_account(vault)?;
    let dest_data = token_account(dest)?;
    if source_data.owner != *state.key || source_data.mint != mint ||
        dest_data.owner != *recipient.key || dest_data.mint != mint || vault.key == dest.key ||
        source_data.amount < amount {
        return Err(ProgramError::InvalidAccountData);
    }
    if modern && (vault.key != &canonical_vault(state.key, &mint) || !rent_recipient.is_writable) {
        return Err(ProgramError::InvalidArgument);
    }
    let id = agreement_from(state);
    let bump_seed = [bump];
    let seeds = &[b"htlc".as_ref(), id.as_ref(), bump_seed.as_ref()];
    // Include unsolicited token donations so they cannot prevent CloseAccount.
    token_transfer(vault, dest, state, token_program, if modern { source_data.amount } else { amount }, seeds)?;
    if modern {
        invoke_signed(&spl_token::instruction::close_account(token_program.key, vault.key, rent_recipient.key, state.key, &[])?,
            &[vault.clone(), rent_recipient.clone(), state.clone(), token_program.clone()], &[seeds])?;
        let total = rent_recipient.lamports().checked_add(state.lamports()).ok_or(ProgramError::ArithmeticOverflow)?;
        **rent_recipient.try_borrow_mut_lamports()? = total;
        **state.try_borrow_mut_lamports()? = 0;
        state.realloc(0, false)?;
        state.assign(&solana_program::system_program::id());
    } else {
        // Legacy state never recorded its vault. Preserve its settlement semantics on upgrade.
        let mut body = state.data.borrow_mut();
        body[145] = if preimage.is_some() { 1 } else { 2 };
        if let Some(key) = preimage { body[147..179].copy_from_slice(key); }
    }
    Ok(())
}

fn agreement_from(state: &AccountInfo) -> [u8; 32] {
    let data = state.data.borrow();
    agreement_id(&data[1..33], &data[33..65], &data[65..97], read_u64(&data, 137), &data[97..129], read_u64(&data, 129))
}

fn open_state(state: &AccountInfo, program_id: &Pubkey, claim: bool, now: i64) -> Result<(Pubkey, u8, u64), ProgramError> {
    let data = state.data.borrow();
    if data.len() != STATE_LEN || !matches!(data[0], 1 | 2) || data[145] != 0 {
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
