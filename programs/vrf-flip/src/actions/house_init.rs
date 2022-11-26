use crate::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, MintTo, Token, TokenAccount},
};

#[derive(Accounts)]
#[instruction(params: HouseInitParams)] // rpc parameters hint
pub struct HouseInit<'info> {
    #[account(
        init,
        space = 8 + std::mem::size_of::<HouseState>(),
        payer = payer,
        seeds = [HOUSE_SEED, mint.key().as_ref()],
        bump
    )]
    pub house: AccountLoader<'info, HouseState>,
    /// CHECK:
    #[account(mut, signer)]
    pub authority: AccountInfo<'info>,
    pub switchboard_mint: Box<Account<'info, Mint>>,
    #[account(
        mut,
        owner = SWITCHBOARD_PROGRAM_ID @ VrfFlipError::InvalidSwitchboardAccount,
        constraint = 
            switchboard_queue.load()?.unpermissioned_vrf_enabled == true @ VrfFlipError::OracleQueueRequiresPermissions
    )]
    pub switchboard_queue: AccountLoader<'info, OracleQueueAccountData>,
    pub mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = mint,
        associated_token::authority = house,
    )]
    pub house_vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub payer: Signer<'info>,

    // SYSTEM ACCOUNTS
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    /// CHECK:
    #[account(address = solana_program::sysvar::rent::ID)]
    pub rent: AccountInfo<'info>,
}

#[derive(Clone, AnchorSerialize, AnchorDeserialize)]
pub struct HouseInitParams {}

impl HouseInit<'_> {
    pub fn validate(
        &self,
        _ctx: &Context<Self>,
        _params: &HouseInitParams,
    ) -> anchor_lang::Result<()> {
        Ok(())
    }

    pub fn actuate(ctx: &Context<Self>, _params: &HouseInitParams) -> anchor_lang::Result<()> {
        msg!("house_init");

        let mint = &mut ctx.accounts.mint.key();

        let house_bump = ctx.bumps.get("house").unwrap().clone();
        let house_seeds: &[&[&[u8]]] = &[&[&HOUSE_SEED, mint.as_ref() , &[house_bump]]];

        msg!("minting 100_000_000 tokens to house vault");
        

        let house = &mut ctx.accounts.house.load_init()?;

        house.bump = house_bump;
        house.authority = ctx.accounts.authority.key().clone();
        house.switchboard_mint = ctx.accounts.switchboard_mint.key().clone();
        house.mint = ctx.accounts.mint.key().clone();
        house.switchboard_queue = ctx.accounts.switchboard_queue.key().clone();
        house.house_vault = ctx.accounts.house_vault.key().clone();

        Ok(())
    }
}
