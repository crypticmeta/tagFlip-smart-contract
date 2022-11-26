import * as anchor from "@project-serum/anchor";
import * as anchor24 from "anchor-24-2";
import * as spl from "@solana/spl-token-v2";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Signer,
  SystemProgram,
  SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { promiseWithTimeout, sleep } from "@switchboard-xyz/sbv2-utils";
import {
  AnchorWallet,
  Callback,
  OracleQueueAccount,
  packTransactions,
  PermissionAccount,
  ProgramStateAccount,
  programWallet,
  VrfAccount,
} from "@switchboard-xyz/switchboard-v2";
import { UserState, UserStateJSON } from "./generated/accounts";
import { House } from "./house";
import { loadSwitchboard, loadVrfContext } from "./switchboard";
import {
  convertGameType,
  FlipProgram,
  GameTypeEnum,
  GameTypeValue,
} from "./types";
import { verifyPayerBalance } from "./utils";
import { Wallet } from "@project-serum/anchor";

export interface UserBetPlaced {
  roundId: anchor.BN;
  user: PublicKey;
  gameType: GameTypeEnum;
  betAmount: anchor.BN;
  guess: number;
  slot: number;
  timestamp: anchor.BN;
}

export interface UserBetSettled {
  roundId: anchor.BN;
  user: PublicKey;
  userWon: boolean;
  gameType: GameTypeEnum;
  betAmount: anchor.BN;
  escrowChange: anchor.BN;
  guess: number;
  result: number;
  slot: number;
  timestamp: anchor.BN;
}

export interface UserJSON extends UserStateJSON {
  publicKey: string;
}

const VRF_REQUEST_AMOUNT = new anchor.BN(2_000_000);

export class User {
  program: FlipProgram;
  publicKey: PublicKey;
  state: UserState;
  private readonly _programEventListeners: number[] = [];

  constructor(program: FlipProgram, publicKey: PublicKey, state: UserState) {
    this.program = program;
    this.publicKey = publicKey;
    this.state = state;
  }

  static async load(program: FlipProgram, authority: PublicKey, TOKENMINT: PublicKey): Promise<User> {
    
    const [houseKey] = House.fromSeeds(program, TOKENMINT);
    const [userKey] = User.fromSeeds(program, houseKey, authority);
    const userState = await UserState.fetch(
      program.provider.connection,
      userKey
    );
    if (!userState) {
      throw new Error(`User account does not exist`);
    }
    return new User(program, userKey, userState);
  }

  // static async getOrCreate(
  //   program: FlipProgram,
  //   authority: PublicKey,
  //   queuePubkey: PublicKey
  // ): Promise<User> {
  //   try {
  //     const user = await User.load(program, authority);
  //     return user;
  //   } catch (error) {}

  //   const [houseKey] = House.fromSeeds(program);
  //   return User.create(program, houseKey);
  // }

  getVrfAccount(switchboardProgram: anchor24.Program): VrfAccount {
    const vrfAccount = new VrfAccount({
      program: switchboardProgram as any,
      publicKey: this.state.vrf,
    });
    return vrfAccount;
  }

  async getQueueAccount(
    switchboardProgram: anchor24.Program
  ): Promise<OracleQueueAccount> {
    const vrfAccount = this.getVrfAccount(switchboardProgram);
    const vrfState = await vrfAccount.loadData();
    const queueAccount = new OracleQueueAccount({
      program: switchboardProgram as any,
      publicKey: vrfState.oracleQueue,
    });
    return queueAccount;
  }

  static fromSeeds(
    program: FlipProgram,
    housePubkey: PublicKey,
    authority: PublicKey
  ): [PublicKey, number] {
    return anchor.utils.publicKey.findProgramAddressSync(
      [
        Buffer.from("USERSTATESEED"),
        housePubkey.toBytes(),
        authority.toBytes(),
      ],
      program.programId
    );
  }

  async reload(): Promise<void> {
    const newState = await UserState.fetch(
      this.program.provider.connection,
      this.publicKey
    );
    if (newState === null) {
      throw new Error(`Failed to fetch the new User account state`);
    }
    this.state = newState;
  }

  toJSON(): UserJSON {
    return {
      publicKey: this.publicKey.toString(),
      ...this.state.toJSON(),
    };
  }

  static async getCallback(
    program: FlipProgram,
    house: House,
    user: PublicKey,
    escrow: PublicKey,
    vrf: PublicKey,
    rewardAddress: PublicKey,
    TOKENMINT: PublicKey,
  ): Promise<Callback> {
    const ixnCoder = new anchor.BorshInstructionCoder(program.idl);
    const callback: Callback = {
      programId: program.programId,
      ixData: ixnCoder.encode("userSettle", {}),
      accounts: [
        {
          pubkey: user,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: house.publicKey,
          isWritable: false,
          isSigner: false,
        },
        {
          pubkey: TOKENMINT,
          isWritable: false,
          isSigner: false
        },
        {
          pubkey: escrow,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: rewardAddress,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: house.state.houseVault,
          isWritable: true,
          isSigner: false,
        },
        {
          pubkey: vrf,
          isWritable: false,
          isSigner: false,
        },
        {
          pubkey: spl.TOKEN_PROGRAM_ID,
          isWritable: false,
          isSigner: false,
        },
      ],
    };
    return callback;
  }

  static async create(
    userWallet: anchor.AnchorProvider,
    program: FlipProgram,
    switchboardProgram: anchor24.Program,
    TOKENMINT: PublicKey,
  ): Promise<User> {
   
    const req = await User.createReq(program, switchboardProgram, TOKENMINT, userWallet.wallet.publicKey);

    const packedTxns = await packTransactions(
      program.provider.connection,
      [new Transaction().add(...req.ixns)],
      req.signers as Keypair[],
      userWallet.publicKey
    );

    console.log('signing with ', userWallet.wallet.publicKey.toBase58())

    const signedTxs = await userWallet.wallet.signAllTransactions(packedTxns);
    const promises = [];
    const sigs: string[] = [];
    for (let k = 0; k < packedTxns.length; k += 1) {
      // console.log(signedTxs[k]?.instructions.length, ' instruction length for k = ',k)
      // console.log(signedTxs[k]?.instructions[1]?.programId?.toBase58(), ' tx ', k)
      // if(k==1)
      // signedTxs[k].instructions.map((item, idx) => { 
      //   console.log('keys for instruction ', idx, ' of k=', k)
      //   if(idx == 1)
      //     item.keys.map((key, i) => {
      //       if (i == 0)
      //         console.log("user key")
      //       if (i == 1)
      //         console.log("house key")
      //       if (i == 2)
      //         console.log("mint key")
      //       if (i == 3)
      //         console.log("authority key")
      //       if (i == 4)
      //         console.log("escrow key")
      //       if (i == 5)
      //         console.log("reward_address key")
      //       if (i == 6)
      //         console.log("vrf key")
      //       if (i == 7)
      //         console.log("payer key")
      //     console.log(key.pubkey.toBase58(), ' key ',i, ' of ', item.keys.length)
      //   })
      // })
      const sig = await program.provider.connection.sendRawTransaction(
        signedTxs[k].serialize(),
        // req.signers,
        {
          skipPreflight: false,
          maxRetries: 10,
        }
      );
      console.log(sig, 'signed tx ',k)
      await program.provider.connection.confirmTransaction(sig);
      sigs.push(sig);
    }

    let retryCount = 5;
    while (retryCount) {
      const userState = await UserState.fetch(
        program.provider.connection,
        req.account
      );
      if (userState !== null) {
        return new User(program, req.account, userState);
      }
      await sleep(1000);
      --retryCount;
    }

    throw new Error(`Failed to create new UserAccount`);
  }

  static async createReq(
    program: FlipProgram,
    switchboardProgram: anchor24.Program,
    TOKENMINT: PublicKey,
    payerPubkey = programWallet(program as any).publicKey,
  ): Promise<{
    ixns: TransactionInstruction[];
    signers: Signer[];
    account: PublicKey;
  }> {

    const house = await House.load(program, TOKENMINT);
    const flipMint = await house.loadMint();

    const switchboardQueue = house.getQueueAccount(switchboardProgram);
    const switchboardMint = await switchboardQueue.loadMint();

    const escrowKeypair = anchor.web3.Keypair.generate();
    const vrfSecret = anchor.web3.Keypair.generate();

    const [userKey, userBump] = User.fromSeeds(
      program,
      house.publicKey,
      payerPubkey
    );
    console.log(userKey.toBase58(), 'userKey', payerPubkey.toBase58(), 'payer')
    const rewardAddress = await spl.getAssociatedTokenAddress(
      flipMint.address,
      payerPubkey,
      true
    );


    const [programStateAccount, stateBump] = ProgramStateAccount.fromSeed(
      switchboardProgram as any
    );
    const queue = await switchboardQueue.loadData();

    const callback = await User.getCallback(      
      program,
      house,
      userKey,
      escrowKeypair.publicKey,
      vrfSecret.publicKey,
      rewardAddress,
      TOKENMINT,
    );

    const [permissionAccount, permissionBump] = PermissionAccount.fromSeed(
      switchboardProgram as any,
      queue.authority,
      switchboardQueue.publicKey,
      vrfSecret.publicKey
    );

    const vrfEscrow = await spl.getAssociatedTokenAddress(
      switchboardMint.address,
      vrfSecret.publicKey,
      true
    );


    const txnIxns: TransactionInstruction[] = [
      // create VRF account
      spl.createAssociatedTokenAccountInstruction(
        payerPubkey,
        vrfEscrow,
        vrfSecret.publicKey,
        switchboardMint.address
      ),
      spl.createSetAuthorityInstruction(
        vrfEscrow,
        vrfSecret.publicKey,
        spl.AuthorityType.AccountOwner,
        programStateAccount.publicKey
      ),
      anchor.web3.SystemProgram.createAccount({
        fromPubkey: payerPubkey,
        newAccountPubkey: vrfSecret.publicKey,
        space: switchboardProgram.account.vrfAccountData.size,
        lamports:
          await program.provider.connection.getMinimumBalanceForRentExemption(
            switchboardProgram.account.vrfAccountData.size
          ),
        programId: switchboardProgram.programId,
      }),
      await switchboardProgram.methods
        .vrfInit({
          stateBump,
          callback: callback,
        })
        .accounts({
          vrf: vrfSecret.publicKey,
          escrow: vrfEscrow,
          authority: userKey,
          oracleQueue: switchboardQueue.publicKey,
          programState: programStateAccount.publicKey,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
        })
        .instruction(),
      // create permission account
      await switchboardProgram.methods
        .permissionInit({})
        .accounts({
          permission: permissionAccount.publicKey,
          authority: queue.authority,
          granter: switchboardQueue.publicKey,
          grantee: vrfSecret.publicKey,
          payer: payerPubkey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .instruction(),
      // create user account
      await program.methods
        .userInit({
          switchboardStateBump: stateBump,
          vrfPermissionBump: permissionBump,
        })
        .accounts({
          user: userKey,
          house: house.publicKey,
          mint: TOKENMINT,
          authority: payerPubkey,
          escrow: escrowKeypair.publicKey,
          rewardAddress: rewardAddress,
          vrf: vrfSecret.publicKey,
          payer: payerPubkey,
          systemProgram: anchor.web3.SystemProgram.programId,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
          associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .instruction(),
    ];

    return {
      ixns: txnIxns,
      signers: [vrfSecret, escrowKeypair],
      account: userKey,
    };
  }

  async placeBet(
    TOKENMINT: PublicKey,
    gameType: GameTypeValue,
    userGuess: number,
    betAmount: anchor.BN,
    switchboardTokenAccount?: PublicKey,
    payerPubkey = programWallet(this.program as any).publicKey
  ): Promise<string> {
    const req = await this.placeBetReq(
      TOKENMINT,
      gameType,
      userGuess,
      betAmount,
      switchboardTokenAccount,
      payerPubkey
    );
    
    req.ixns.map((items, idx) => {
      items.keys.map((item, i) => {
        if (i == 1) {
          console.log("house")
          console.log(item.pubkey.toBase58(), ' key at ', i)
        }
        else if (i == 3) {
          console.log("house_vault")
          console.log(item.pubkey.toBase58(), ' key at ', i)
        }
        else if (i == 5) {
          console.log("escrow")
          console.log(item.pubkey.toBase58(), ' key at ', i)
        }
        else if (i == 11) {
          console.log("vrf_escrow")
          console.log(item.pubkey.toBase58(), ' key at ', i)
        }
        else if (i == 12) {
          console.log("switchboard_program_state")
          console.log(item.pubkey.toBase58(), ' key at ', i)
        }
        else if (i == 14) {
          console.log("payer")
          console.log(item.pubkey.toBase58(), ' key at ', i)
        }
        else if (i == 15) {
          console.log("vrf_payer")
          console.log(item.pubkey.toBase58(), ' key at ', i)
        }
        else if (i == 16) {
          console.log("flip_payer")
          console.log(item.pubkey.toBase58(), ' key at ', i)
        }
        else {
          console.log(item.pubkey.toBase58(), ' key at ', i)
        }
        
      })
    })

    const signature = await this.program.provider.sendAndConfirm!(
      new Transaction().add(...req.ixns),
      req.signers
    );

    return signature;
  }

  async placeBetReq(
    TOKENMINT:PublicKey,
    gameType: GameTypeValue,
    userGuess: number,
    betAmount: anchor.BN,
    switchboardTokenAccount?: PublicKey,
    payerPubkey = programWallet(this.program as any).publicKey
  ): Promise<{ ixns: TransactionInstruction[]; signers: Signer[] }> {
    try {
      await verifyPayerBalance(this.program.provider.connection, payerPubkey);
    } catch {}

    const signers: Signer[] = [];
    const ixns: TransactionInstruction[] = [];
    const house = await House.load(this.program, TOKENMINT);

    const switchboard = await loadSwitchboard(
      this.program.provider as anchor.AnchorProvider
    );
    const vrfContext = await loadVrfContext(switchboard, this.state.vrf);

    let payersWrappedSolBalance: anchor.BN;
    let payerSwitchTokenAccount: PublicKey;
    console.log(switchboardTokenAccount.toBase58(), 'sta ')
    if (switchboardTokenAccount) {
      
      payerSwitchTokenAccount = switchboardTokenAccount;
      payersWrappedSolBalance = new anchor.BN(
        (
          await this.program.provider.connection.getTokenAccountBalance(
            switchboardTokenAccount
          )
        ).value.amount
      );
    } else {
      payerSwitchTokenAccount = await spl.getAssociatedTokenAddress(
        spl.NATIVE_MINT,
        payerPubkey
      );

      const payersWrappedSolAccountInfo =
        await this.program.provider.connection.getAccountInfo(
          payerSwitchTokenAccount
        );
      if (payersWrappedSolAccountInfo === null) {
        ixns.push(
          spl.createAssociatedTokenAccountInstruction(
            payerPubkey,
            payerSwitchTokenAccount,
            payerPubkey,
            spl.NATIVE_MINT
          )
        );
        payersWrappedSolBalance = new anchor.BN(0);
      } else {
        const tokenAccount = spl.AccountLayout.decode(
          payersWrappedSolAccountInfo.data
        );
        payersWrappedSolBalance = new anchor.BN(
          tokenAccount.amount.toString(10)
        );
      }
    }

    // check VRF escrow balance
    const vrfEscrowBalance = new anchor.BN(
      (
        await this.program.provider.connection.getTokenAccountBalance(
          vrfContext.publicKeys.vrfEscrow
        )
      ).value.amount
    );

    const combinedWrappedSolBalance =
      payersWrappedSolBalance.add(vrfEscrowBalance);

    if (combinedWrappedSolBalance.lt(VRF_REQUEST_AMOUNT)) {
      const wrapAmount = VRF_REQUEST_AMOUNT.sub(combinedWrappedSolBalance);

      const ephemeralAccount = Keypair.generate();
      const ephemeralWallet = await spl.getAssociatedTokenAddress(
        spl.NATIVE_MINT,
        ephemeralAccount.publicKey,
        false
      );
    

      signers.push(ephemeralAccount);
      ixns.push(
        spl.createAssociatedTokenAccountInstruction(
          payerPubkey,
          ephemeralWallet,
          ephemeralAccount.publicKey,
          spl.NATIVE_MINT
        ),
        SystemProgram.transfer({
          fromPubkey: payerPubkey,
          toPubkey: ephemeralWallet,
          lamports: wrapAmount.toNumber(),
        }),
        spl.createSyncNativeInstruction(ephemeralWallet),
        spl.createTransferInstruction(
          ephemeralWallet,
          vrfContext.publicKeys.vrfEscrow,
          ephemeralAccount.publicKey,
          wrapAmount.toNumber()
        ),
        spl.createCloseAccountInstruction(
          ephemeralWallet,
          payerPubkey,
          ephemeralAccount.publicKey
        )
      );
    }

    console.log(payerSwitchTokenAccount.toBase58(), 'psta')

    ixns.push(
      await this.program.methods
        .userBet({
          gameType: gameType,
          userGuess,
          betAmount,
        })
        .accounts({
          user: this.publicKey,
          house: this.state.house,
          mint: TOKENMINT,
          houseVault: house.state.houseVault,
          authority: this.state.authority,
          escrow: this.state.escrow,
          vrfPayer: payerSwitchTokenAccount,
          ...vrfContext.publicKeys,
          payer: payerPubkey,
          flipPayer: this.state.rewardAddress,
          recentBlockhashes: SYSVAR_RECENT_BLOCKHASHES_PUBKEY,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
        })
        .instruction()
    );

    return { ixns, signers };
  }

  async awaitFlip(
    expectedCounter: anchor.BN,
    timeout = 30
  ): Promise<UserState> {
    let accountWs: number;
    const awaitUpdatePromise = new Promise(
      (resolve: (value: UserState) => void) => {
        // console.log('resolving...')
        console.log('monitoring... ', this?.publicKey.toBase58())
        accountWs = this.program.provider.connection.onAccountChange(
          this?.publicKey ?? PublicKey.default,
          async (accountInfo) => {
            // console.log(accountInfo, 'accountInfo')
            const user = UserState.decode(accountInfo.data);
            // console.log(user.escrow.toBase58(), 'user')
            // console.log(user.currentRound.result, 'result')
            if (!expectedCounter.eq(user.currentRound.roundId)) {
              console.log('returning null')
              return;
            }
            if (user.currentRound.result === 0) {
              console.log('returning null 2')
              return;
            }
            resolve(user);
          }
        );
        // console.log(accountWs, 'accountWs')
      }
    );

    console.log('getting result...')

    const result = await promiseWithTimeout(
      timeout * 1000,
      awaitUpdatePromise,
      new Error(`flip user failed to update in ${timeout} seconds`)
    ).finally(() => {
      if (accountWs) {
        this.program.provider.connection.removeAccountChangeListener(accountWs);
      }
    });

    if (!result) {
      throw new Error(`failed to update flip user`);
    }

    return result;
  }

  async placeBetAndAwaitFlip(
    TOKENMINT:PublicKey,
    gameType: GameTypeValue,
    userGuess: number,
    betAmount: anchor.BN,
    switchboardTokenAccount?: PublicKey,
    timeout = 30
  ): Promise<UserState> {
    await this.reload();
    const currentCounter = this.state.currentRound.roundId;
    console.log(currentCounter, 'current Counter')

    try {
      const placeBetTxn = await this.placeBet(
        TOKENMINT,
        gameType,
        userGuess,
        betAmount,
        switchboardTokenAccount
      );
      console.log(placeBetTxn, 'tx')
    } catch (error) {
      console.error(error);
      throw error;
    }

    try {
      const userState = await this.awaitFlip(
        currentCounter.add(new anchor.BN(1)),
        timeout
      );
      console.log(userState, 'userState')
      return userState;
    } catch (error) {
      console.error(error);
      throw error;
    }
  }

  isWinner(userState?: UserState): boolean {
    const state = userState ?? this.state;
    if (state.currentRound.result === 0) {
      return false;
    }
    return state.currentRound.guess === state.currentRound.result;
  }

  async airdropReq(payerPubkey = programWallet(this.program as any).publicKey, TOKENMINT) {
    try {
      await verifyPayerBalance(this.program.provider.connection, payerPubkey);
    } catch {}

    const house = await House.load(this.program, TOKENMINT);
    const flipMint = await house.loadMint();
    const payerFlipTokenAccount = await spl.getAssociatedTokenAddress(
      flipMint.address,
      payerPubkey
    );
    const payerFlipTokenAccountInfo: anchor.web3.AccountInfo<Buffer> | null =
      await this.program.provider.connection
        .getAccountInfo(payerFlipTokenAccount)
        .catch((err) => {
          return null;
        });

    const ixn = await this.program.methods
      .userAirdrop({})
      .accounts({
        user: this.publicKey,
        house: house.publicKey,
        houseVault: house.state.houseVault,
        mint: flipMint.address,
        authority: payerPubkey,
        airdropTokenWallet: payerFlipTokenAccount,
        tokenProgram: spl.TOKEN_PROGRAM_ID,
      })
      .instruction();

    const ixns = [ixn];
    if (payerFlipTokenAccountInfo === null) {
      const createTokenAccountIxn = spl.createAssociatedTokenAccountInstruction(
        payerPubkey,
        payerFlipTokenAccount,
        payerPubkey,
        flipMint.address
      );
      ixns.unshift(createTokenAccountIxn);
    }

    return { ixns, signers: [] };
  }

  async airdrop(
    payerPubkey = programWallet(this.program as any).publicKey,
    TOKENMINT: PublicKey
  ): Promise<string> {
    const req = await this.airdropReq(payerPubkey, TOKENMINT);

    const signature = await this.program.provider.sendAndConfirm!(
      new Transaction().add(...req.ixns),
      req.signers
    );

    return signature;
  }

  watch(
    betPlaced: (event: UserBetPlaced) => Promise<void> | void,
    betSettled: (event: UserBetSettled) => Promise<void> | void
  ) {
    this._programEventListeners.push(
      this.program.addEventListener(
        "UserBetPlaced",
        async (event: UserBetPlaced, slot: number, signature: string) => {
          if (!this.publicKey.equals(event.user)) {
            return;
          }
          const gameType = GameTypeValue.COIN_FLIP;
          await betPlaced({
            ...event,
            gameType: convertGameType(event.gameType),
          });
        }
      )
    );

    this._programEventListeners.push(
      this.program.addEventListener(
        "UserBetSettled",
        async (event: UserBetSettled, slot: number, signature: string) => {
          if (!this.publicKey.equals(event.user)) {
            return;
          }
          await betSettled({
            ...event,
            gameType: convertGameType(event.gameType),
          });
        }
      )
    );
  }

  async unwatch() {
    while (this._programEventListeners.length) {
      const id = this._programEventListeners.pop();
      if (Number.isFinite(id)) await this.program.removeEventListener(id);
    }
  }
}
