use btq_sol_htlc::{agreement_id, process_instruction, STATE_LEN};
use solana_program::{program_option::COption, program_pack::Pack};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{account::{Account, AccountSharedData}, clock::Clock, hash::hash, instruction::{AccountMeta, Instruction}, pubkey::Pubkey, rent::Rent, signature::{Keypair, Signer}, system_program, transaction::Transaction};
use spl_token::state::{Account as TokenAccount, AccountState};

const AMOUNT: u64 = 123;
const DEADLINE: u64 = 1000;
struct Test {
    ctx: ProgramTestContext, program: Pubkey, buyer: Keypair, seller: Keypair,
    mint: Pubkey, state: Pubkey, source: Pubkey, vault: Pubkey, dest: Pubkey,
}
fn tokens(mint: Pubkey, owner: Pubkey, amount: u64) -> Account {
    let mut data = vec![0; TokenAccount::LEN];
    TokenAccount::pack(TokenAccount { mint, owner, amount, delegate: COption::None, state: AccountState::Initialized,
        is_native: COption::None, delegated_amount: 0, close_authority: COption::None }, &mut data).unwrap();
    Account { lamports: Rent::default().minimum_balance(data.len()), data, owner: spl_token::id(), executable: false, rent_epoch: 0 }
}
impl Test {
    async fn new(prefund: u64) -> Self {
        let program=Pubkey::new_unique();let buyer=Keypair::new();let seller=Keypair::new();let mint=Pubkey::new_unique();
        let id=agreement_id(buyer.pubkey().as_ref(),seller.pubkey().as_ref(),mint.as_ref(),AMOUNT,hash(&[0;32]).as_ref(),DEADLINE);
        let state=Pubkey::find_program_address(&[b"htlc",&id],&program).0;
        let ata:Pubkey="ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL".parse().unwrap();
        let vault=Pubkey::find_program_address(&[state.as_ref(),spl_token::id().as_ref(),mint.as_ref()],&ata).0;
        let source=Pubkey::new_unique();let dest=Pubkey::new_unique();
        let mut test=ProgramTest::new("btq_sol_htlc",program,processor!(process_instruction));
        test.add_program("spl_token",spl_token::id(),processor!(spl_token::processor::Processor::process));
        for key in [buyer.pubkey(),seller.pubkey(),mint] { test.add_account(key,Account{lamports:1_000_000_000,owner:system_program::id(),..Account::default()}); }
        if prefund>0 {test.add_account(state,Account{lamports:prefund,owner:system_program::id(),..Account::default()});}
        test.add_account(source,tokens(mint,buyer.pubkey(),10*AMOUNT));
        test.add_account(vault,tokens(mint,state,7)); // Token donations must not prevent closure.
        test.add_account(dest,tokens(mint,seller.pubkey(),0));
        let ctx=test.start_with_context().await;
        let t=Self{ctx,program,buyer,seller,mint,state,source,vault,dest};t.time(100);t
    }
    fn time(&self, now:i64) {self.ctx.set_sysvar(&Clock{unix_timestamp:now,..Clock::default()});}
    fn lock(&self)->Instruction {
        let mut data=vec![0];data.extend(self.seller.pubkey().to_bytes());data.extend(hash(&[0;32]).to_bytes());data.extend(DEADLINE.to_le_bytes());data.extend(AMOUNT.to_le_bytes());
        Instruction{program_id:self.program,accounts:vec![AccountMeta::new(self.buyer.pubkey(),true),AccountMeta::new(self.state,false),AccountMeta::new(self.source,false),AccountMeta::new(self.vault,false),AccountMeta::new_readonly(spl_token::id(),false),AccountMeta::new_readonly(system_program::id(),false),AccountMeta::new_readonly(self.mint,false)],data}
    }
    fn spend(&self,claim:bool)->Instruction {
        let mut accounts=vec![AccountMeta::new(if claim {self.seller.pubkey()} else {self.buyer.pubkey()},true),AccountMeta::new(self.state,false),AccountMeta::new(self.vault,false),AccountMeta::new(if claim {self.dest} else {self.source},false),AccountMeta::new_readonly(spl_token::id(),false)];
        let data=if claim {accounts.push(AccountMeta::new(self.buyer.pubkey(),false));let mut d=vec![1];d.extend([0;32]);d} else {vec![2]};
        Instruction{program_id:self.program,accounts,data}
    }
    async fn send(&mut self,ix:Instruction,claim:bool)->bool {
        let blockhash=self.ctx.get_new_latest_blockhash().await.unwrap();
        let actor=if claim {&self.seller} else {&self.buyer};
        let tx=Transaction::new_signed_with_payer(&[ix],Some(&self.ctx.payer.pubkey()),&[&self.ctx.payer,actor],blockhash);
        self.ctx.banks_client.process_transaction(tx).await.is_ok()
    }
    async fn balance(&mut self,key:Pubkey)->u64 {self.ctx.banks_client.get_balance(key).await.unwrap()}
    async fn token_balance(&mut self,key:Pubkey)->u64 {TokenAccount::unpack(&self.ctx.banks_client.get_account(key).await.unwrap().unwrap().data).unwrap().amount}
    async fn closed(&mut self) {assert!(self.ctx.banks_client.get_account(self.state).await.unwrap().is_none());assert!(self.ctx.banks_client.get_account(self.vault).await.unwrap().is_none());}
}

#[tokio::test]
async fn prefunding_and_zero_preimage_claim_return_all_rent_and_donations() {
    let rent=Rent::default().minimum_balance(STATE_LEN);
    for prefund in [0,1,rent-1,rent,rent+999] {
        let mut t=Test::new(prefund).await;
        assert!(t.send(t.lock(),false).await);
        let state=t.ctx.banks_client.get_account(t.state).await.unwrap().unwrap();assert_eq!(state.data[0],2);
        let buyer=t.balance(t.buyer.pubkey()).await;
        let returned=t.balance(t.state).await+t.balance(t.vault).await;
        t.time(DEADLINE as i64-1);assert!(t.send(t.spend(true),true).await);
        assert_eq!(t.token_balance(t.dest).await,AMOUNT+7);assert_eq!(t.balance(t.buyer.pubkey()).await,buyer+returned);t.closed().await;
        assert!(!t.send(t.spend(true),true).await); // A closed escrow cannot be spent twice.
    }
}
#[tokio::test]
async fn refund_boundary_and_failed_claim_are_atomic() {
    let mut t=Test::new(1).await;assert!(t.send(t.lock(),false).await);
    t.time(DEADLINE as i64-1);assert!(!t.send(t.spend(false),false).await);
    t.time(DEADLINE as i64);assert!(!t.send(t.spend(true),true).await);
    assert_eq!(t.token_balance(t.vault).await,AMOUNT+7);
    let before=t.balance(t.buyer.pubkey()).await;let rent=t.balance(t.state).await+t.balance(t.vault).await;
    assert!(t.send(t.spend(false),false).await);assert_eq!(t.token_balance(t.source).await,10*AMOUNT+7);
    assert_eq!(t.balance(t.buyer.pubkey()).await,before+rent);t.closed().await;
}
#[tokio::test]
async fn rejects_noncanonical_vault_at_lock_and_settlement() {
    let mut t=Test::new(1).await;let other=Pubkey::new_unique();
    t.ctx.set_account(&other,&AccountSharedData::from(tokens(t.mint,t.state,AMOUNT)));
    let mut bad=t.lock();bad.accounts[3].pubkey=other;assert!(!t.send(bad,false).await);
    assert_eq!(t.token_balance(t.source).await,10*AMOUNT);
    assert!(t.send(t.lock(),false).await);
    let mut bad=t.spend(true);bad.accounts[2].pubkey=other;assert!(!t.send(bad,true).await);
    assert_eq!(t.token_balance(t.vault).await,AMOUNT+7);
    assert!(t.send(t.spend(true),true).await);
}
#[tokio::test]
async fn rejects_bad_secret_wrong_recipient_and_occupied_state_without_moving_tokens() {
    let mut t=Test::new(1).await;
    let mut occupied=Account::default();occupied.owner=t.program;occupied.lamports=Rent::default().minimum_balance(STATE_LEN);occupied.data=vec![0;STATE_LEN];
    t.ctx.set_account(&t.state,&AccountSharedData::from(occupied));assert!(!t.send(t.lock(),false).await);
    t.ctx.set_account(&t.state,&AccountSharedData::from(Account{lamports:1,owner:system_program::id(),..Account::default()}));
    assert!(t.send(t.lock(),false).await);
    let mut bad=t.spend(true);bad.data[1]=1;assert!(!t.send(bad,true).await);
    let mut bad=t.spend(true);bad.accounts[5].pubkey=t.seller.pubkey();assert!(!t.send(bad,true).await);
    let mut bad=t.spend(true);bad.accounts[3].pubkey=t.source;assert!(!t.send(bad,true).await);
    assert_eq!(t.token_balance(t.vault).await,AMOUNT+7);assert!(t.send(t.spend(true),true).await);
}
#[tokio::test]
async fn legacy_noncanonical_vault_remains_spendable_on_upgrade() {
    let mut t=Test::new(1).await;assert!(t.send(t.lock(),false).await);
    let mut old=t.ctx.banks_client.get_account(t.state).await.unwrap().unwrap();old.data[0]=1;t.ctx.set_account(&t.state,&AccountSharedData::from(old));
    let other=Pubkey::new_unique();t.ctx.set_account(&other,&AccountSharedData::from(tokens(t.mint,t.state,AMOUNT)));
    let mut spend=t.spend(true);spend.accounts.truncate(5);spend.accounts[2].pubkey=other;assert!(t.send(spend,true).await);
    let state=t.ctx.banks_client.get_account(t.state).await.unwrap().unwrap();assert_eq!(state.data[145],1);assert_eq!(t.token_balance(t.dest).await,AMOUNT);
}
