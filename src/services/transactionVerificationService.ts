import crypto from 'crypto';
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SystemProgram,
  VersionedTransaction,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { SolanaNetwork } from '@/types/vacuum';
import { getAppConfig, getRpcUrlForNetwork, SOLANA_TX_MAX_COMPUTE_UNITS } from '@/lib/config';

export interface SimulationCheckResult {
  success: boolean;
  unitsConsumed: number;
  logs: string[];
  error?: string;
}

export interface OnChainVerificationResult {
  confirmed: boolean;
  signature: string;
  slot?: number;
  confirmationStatus?: 'processed' | 'confirmed' | 'finalized';
  actualFeeLamports?: number;
  error?: string;
}

export interface SignedTransactionVerificationInput {
  signedTxBase64: string;
  expectedUnsignedTxBase64?: string | null;
  expectedUserAddress: string;
  expectedFeePayerAddress: string;
  requireSponsorSignature?: boolean;
}

// ASN.1 SubjectPublicKeyInfo prefix for a 32-byte raw Ed25519 public key
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export class TransactionVerificationService {
  /**
   * Cryptographically verifies a 64-byte Ed25519 signature over raw message bytes
   * for a Solana PublicKey using Node's native OpenSSL crypto subsystem.
   */
  static verifyEd25519Signature(
    publicKey: PublicKey,
    messageBytes: Uint8Array,
    signatureBytes: Uint8Array
  ): boolean {
    if (!signatureBytes || signatureBytes.length !== 64) return false;
    if (!signatureBytes.some((b) => b !== 0)) return false;

    try {
      const derKey = Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(publicKey.toBytes())]);
      const keyObj = crypto.createPublicKey({
        key: derKey,
        format: 'der',
        type: 'spki',
      });
      return crypto.verify(
        null,
        Buffer.from(messageBytes),
        keyObj,
        Buffer.from(signatureBytes)
      );
    } catch {
      return false;
    }
  }

  /**
   * Inspects all SPL Token & Token-2022 CloseAccount instructions in a transaction
   * to verify that reclaimed rent lamports are sent strictly to `expectedUserAddress`
   * and never redirected to the sponsor or any third-party account.
   */
  static verifyCloseAccountRentDestination(
    tx: VersionedTransaction,
    expectedUserAddress: string
  ): { valid: boolean; reason?: string } {
    const staticKeys = tx.message.staticAccountKeys;
    if (!staticKeys || staticKeys.length === 0) {
      return { valid: false, reason: 'Transaction has no static account keys' };
    }

    const tokenProgId = TOKEN_PROGRAM_ID.toBase58();
    const token2022ProgId = TOKEN_2022_PROGRAM_ID.toBase58();

    for (const ix of tx.message.compiledInstructions) {
      const progKey = staticKeys[ix.programIdIndex];
      if (!progKey) continue;
      const progAddr = progKey.toBase58();
      const data = Buffer.from(ix.data);

      // SPL Token CloseAccount instruction discriminator = 9
      // Account layout: [0] = tokenAccount, [1] = rentDestination, [2] = ownerAuthority
      if ((progAddr === tokenProgId || progAddr === token2022ProgId) && data.length >= 1 && data[0] === 9) {
        const destKey = staticKeys[ix.accountKeyIndexes[1]];
        const authKey = staticKeys[ix.accountKeyIndexes[2]];
        if (!destKey || destKey.toBase58() !== expectedUserAddress) {
          return {
            valid: false,
            reason: `Security violation: CloseAccount rent refund destination (${
              destKey ? destKey.toBase58() : 'unknown'
            }) does not match authorized user wallet (${expectedUserAddress}).`,
          };
        }
        if (!authKey || authKey.toBase58() !== expectedUserAddress) {
          return {
            valid: false,
            reason: `Security violation: CloseAccount owner authority (${
              authKey ? authKey.toBase58() : 'unknown'
            }) does not match authorized user wallet (${expectedUserAddress}).`,
          };
        }
      }
    }

    return { valid: true };
  }

  /**
   * Validates that a sponsored transaction does NOT use the sponsor fee-payer keypair
   * as the source of direct SOL transfers, as the owner/authority of SPL token operations,
   * to redirect CloseAccount rent, or to pay uncapped ComputeBudget priority fees.
   */
  static validateSponsorInstructionSafety(
    tx: VersionedTransaction,
    sponsorPubkey: PublicKey,
    expectedUserAddress?: string
  ): { safe: boolean; reason?: string } {
    const staticKeys = tx.message.staticAccountKeys;
    if (!staticKeys || staticKeys.length === 0) {
      return { safe: false, reason: 'Transaction has no static account keys' };
    }

    if (!staticKeys[0].equals(sponsorPubkey)) {
      return {
        safe: false,
        reason: `Fee payer (index 0) is ${staticKeys[0].toBase58()}, expected sponsor ${sponsorPubkey.toBase58()}`,
      };
    }

    // In a sponsored user sweep, at least 2 required signatures must exist (index 0 = sponsor, index >= 1 = user)
    if (tx.message.header.numRequiredSignatures < 2) {
      return {
        safe: false,
        reason:
          'Sponsored transaction must require at least 2 signatures (Sponsor fee-payer + User owner)',
      };
    }

    const config = getAppConfig();
    const systemProgramId = SystemProgram.programId.toBase58();
    const computeBudgetId = ComputeBudgetProgram.programId.toBase58();
    const tokenProgId = TOKEN_PROGRAM_ID.toBase58();
    const token2022ProgId = TOKEN_2022_PROGRAM_ID.toBase58();

    for (const ix of tx.message.compiledInstructions) {
      const progKey = staticKeys[ix.programIdIndex];
      if (!progKey) continue;
      const progAddr = progKey.toBase58();
      const data = Buffer.from(ix.data);

      // 1. Check ComputeBudgetProgram limits (prevent priority-fee drain attacks)
      if (progAddr === computeBudgetId && data.length >= 1) {
        const cbType = data[0];
        // 2 = SetComputeUnitLimit (u32 LE at offset 1)
        if (cbType === 2 && data.length >= 5) {
          const units = data.readUInt32LE(1);
          if (units > SOLANA_TX_MAX_COMPUTE_UNITS) {
            return {
              safe: false,
              reason: `Security violation: ComputeUnitLimit (${units}) exceeds Solana maximum (${SOLANA_TX_MAX_COMPUTE_UNITS})`,
            };
          }
        }
        // 3 = SetComputeUnitPrice (u64 LE microLamports at offset 1)
        if (cbType === 3 && data.length >= 9) {
          const microLamports = data.readBigUInt64LE(1);
          if (microLamports > BigInt(config.sponsorship.maxPriorityMicroLamports)) {
            return {
              safe: false,
              reason: `Security violation: Priority fee (${microLamports.toString()} microLamports/CU) exceeds maximum allowed sponsor limit (${config.sponsorship.maxPriorityMicroLamports})`,
            };
          }
        }
      }

      // 2. Check SystemProgram instructions where sponsor (index 0) is the funding/source account
      if (progAddr === systemProgramId && data.length >= 4) {
        const sysIxType = data.readUInt32LE(0);
        // SystemInstruction: 0 = CreateAccount, 1 = Assign, 2 = Transfer, 4 = WithdrawNonceAccount, 8 = Allocate, 11 = TransferWithSeed
        if (
          (sysIxType === 2 || sysIxType === 0 || sysIxType === 1 || sysIxType === 4 || sysIxType === 8 || sysIxType === 11) &&
          ix.accountKeyIndexes[0] === 0
        ) {
          return {
            safe: false,
            reason: `Security violation: Sponsor fee-payer cannot be the source of a direct SystemProgram instruction (type ${sysIxType})`,
          };
        }
      }

      // 3. Check SPL Token & Token-2022 instructions where sponsor (index 0) is the authority/owner or rent recipient
      if ((progAddr === tokenProgId || progAddr === token2022ProgId) && data.length >= 1) {
        const tokenIxType = data[0];
        let authorityIndexInIx = -1;
        if (tokenIxType === 3 || tokenIxType === 4 || tokenIxType === 8 || tokenIxType === 9 || tokenIxType === 15) {
          authorityIndexInIx = 2;
        } else if (tokenIxType === 6) {
          authorityIndexInIx = 1;
        } else if (tokenIxType === 12 || tokenIxType === 13) {
          authorityIndexInIx = 3;
        }

        if (
          authorityIndexInIx >= 0 &&
          ix.accountKeyIndexes[authorityIndexInIx] === 0
        ) {
          return {
            safe: false,
            reason: `Security violation: Sponsor fee-payer cannot act as token owner/authority in SPL Token instruction (type ${tokenIxType})`,
          };
        }

        // For CloseAccount (type 9), forbid sponsor from receiving reclaimed rent and verify user destination
        if (tokenIxType === 9) {
          if (ix.accountKeyIndexes[1] === 0) {
            return {
              safe: false,
              reason:
                'Security violation: Sponsor fee-payer is forbidden from receiving reclaimed token-account rent',
            };
          }
          if (expectedUserAddress) {
            const rentDest = staticKeys[ix.accountKeyIndexes[1]];
            if (!rentDest || rentDest.toBase58() !== expectedUserAddress) {
              return {
                safe: false,
                reason: `Security violation: CloseAccount rent destination (${
                  rentDest ? rentDest.toBase58() : 'unknown'
                }) does not match user wallet (${expectedUserAddress})`,
              };
            }
          }
        }
      }
    }

    return { safe: true };
  }

  /**
   * Verifies transaction version, fee payer assignment, byte-for-byte message integrity against
   * the server-generated unsigned transaction (when present), CloseAccount rent destination,
   * and cryptographic Ed25519 signatures.
   */
  static verifySignedTransactionIntegrity(
    input: SignedTransactionVerificationInput
  ): { valid: boolean; error?: string; transaction?: VersionedTransaction } {
    let tx: VersionedTransaction;
    try {
      tx = VersionedTransaction.deserialize(Buffer.from(input.signedTxBase64, 'base64'));
    } catch (err) {
      return {
        valid: false,
        error: `Malformed VersionedTransaction base64 payload: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }

    if (tx.version !== 0 && tx.version !== 'legacy') {
      return {
        valid: false,
        error: `Unsupported transaction version: ${String(tx.version)}`,
      };
    }

    const staticKeys = tx.message.staticAccountKeys;
    if (!staticKeys || staticKeys.length === 0) {
      return { valid: false, error: 'Transaction missing static account keys' };
    }

    const actualFeePayer = staticKeys[0].toBase58();
    if (actualFeePayer !== input.expectedFeePayerAddress) {
      return {
        valid: false,
        error: `Fee payer mismatch: transaction fee payer is ${actualFeePayer}, expected ${input.expectedFeePayerAddress}`,
      };
    }

    const messageBytes = tx.message.serialize();

    // If the server generated and persisted an unsigned transaction for this batch,
    // verify the signed transaction message is byte-for-byte identical (preventing instruction tampering).
    if (input.expectedUnsignedTxBase64) {
      try {
        const expectedTx = VersionedTransaction.deserialize(
          Buffer.from(input.expectedUnsignedTxBase64, 'base64')
        );
        const expectedMessageBytes = expectedTx.message.serialize();
        if (!Buffer.from(messageBytes).equals(Buffer.from(expectedMessageBytes))) {
          return {
            valid: false,
            error:
              'Transaction message tampering detected: signed transaction message does not match server-authorized batch message',
          };
        }
      } catch {
        return {
          valid: false,
          error: 'Failed to deserialize stored batch transaction for integrity check',
        };
      }
    }

    // Verify any CloseAccount instruction sends rent strictly to expectedUserAddress
    const closeCheck = this.verifyCloseAccountRentDestination(tx, input.expectedUserAddress);
    if (!closeCheck.valid) {
      return {
        valid: false,
        error: closeCheck.reason || 'CloseAccount rent destination verification failed',
      };
    }

    const numRequired = tx.message.header.numRequiredSignatures;
    const requiredSignerKeys = staticKeys.slice(0, numRequired);

    // Locate user wallet in required signers and cryptographically verify Ed25519 signature
    const userSignerIdx = requiredSignerKeys.findIndex(
      (k) => k.toBase58() === input.expectedUserAddress
    );
    if (userSignerIdx === -1) {
      return {
        valid: false,
        error: `Authorized user wallet (${input.expectedUserAddress}) is not a required signer on the transaction`,
      };
    }

    const userSig = tx.signatures[userSignerIdx];
    const userPk = requiredSignerKeys[userSignerIdx];
    if (!this.verifyEd25519Signature(userPk, messageBytes, userSig)) {
      return {
        valid: false,
        error: `Cryptographic Ed25519 signature verification failed for user wallet (${input.expectedUserAddress})`,
      };
    }

    // If sponsor signature is also required to be present now, verify it
    if (input.requireSponsorSignature) {
      const sponsorSig = tx.signatures[0];
      const sponsorPk = staticKeys[0];
      if (!this.verifyEd25519Signature(sponsorPk, messageBytes, sponsorSig)) {
        return {
          valid: false,
          error: `Cryptographic Ed25519 signature verification failed for fee-payer (${input.expectedFeePayerAddress})`,
        };
      }
    }

    return { valid: true, transaction: tx };
  }

  /**
   * Simulates a serialized VersionedTransaction against the target Solana RPC
   * before broadcasting to catch any account or slippage errors early.
   */
  static async simulateVersionedTransaction(
    serializedTxBase64: string,
    network: SolanaNetwork,
    options?: { sigVerify?: boolean; replaceRecentBlockhash?: boolean }
  ): Promise<SimulationCheckResult> {
    const rpcUrl = getRpcUrlForNetwork(network);
    const connection = new Connection(rpcUrl, 'confirmed');
    const tx = VersionedTransaction.deserialize(Buffer.from(serializedTxBase64, 'base64'));

    const sigVerify = options?.sigVerify ?? false;
    const replaceRecentBlockhash = options?.replaceRecentBlockhash ?? !sigVerify;

    try {
      const sim = await connection.simulateTransaction(tx, {
        sigVerify,
        replaceRecentBlockhash,
      });

      if (sim.value.err) {
        return {
          success: false,
          unitsConsumed: sim.value.unitsConsumed ?? 0,
          logs: sim.value.logs ?? [],
          error: JSON.stringify(sim.value.err),
        };
      }

      return {
        success: true,
        unitsConsumed: sim.value.unitsConsumed ?? 0,
        logs: sim.value.logs ?? [],
      };
    } catch (err) {
      return {
        success: false,
        unitsConsumed: 0,
        logs: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Broadcasts a fully-signed VersionedTransaction directly to the Solana RPC
   * and verifies on-chain confirmation.
   */
  static async broadcastAndConfirmTransaction(
    signedTxBase64: string,
    network: SolanaNetwork
  ): Promise<OnChainVerificationResult> {
    const rpcUrl = getRpcUrlForNetwork(network);
    const connection = new Connection(rpcUrl, 'confirmed');
    const rawTx = Buffer.from(signedTxBase64, 'base64');

    try {
      const signature = await connection.sendRawTransaction(rawTx, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
        maxRetries: 3,
      });

      return await this.verifySignatureConfirmation(signature, network);
    } catch (err) {
      return {
        confirmed: false,
        signature: '',
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Verifies that a transaction signature is genuinely confirmed on the Solana blockchain.
   * Never marks an unconfirmed transaction as completed.
   */
  static async verifySignatureConfirmation(
    signature: string,
    network: SolanaNetwork,
    maxPollAttempts: number = 20
  ): Promise<OnChainVerificationResult> {
    if (!signature || signature.trim().length < 32) {
      return {
        confirmed: false,
        signature,
        error: 'Invalid transaction signature format',
      };
    }

    const rpcUrl = getRpcUrlForNetwork(network);
    const connection = new Connection(rpcUrl, 'confirmed');

    for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
      try {
        const statusRes = await connection.getSignatureStatuses([signature], {
          searchTransactionHistory: true,
        });
        const status = statusRes?.value?.[0];

        if (status) {
          if (status.err) {
            return {
              confirmed: false,
              signature,
              slot: status.slot,
              error: `Transaction failed on-chain: ${JSON.stringify(status.err)}`,
            };
          }

          if (
            status.confirmationStatus === 'confirmed' ||
            status.confirmationStatus === 'finalized'
          ) {
            let actualFeeLamports = 5_000;
            try {
              const parsedTx = await connection.getTransaction(signature, {
                commitment: 'confirmed',
                maxSupportedTransactionVersion: 0,
              });
              if (parsedTx?.meta?.fee) {
                actualFeeLamports = parsedTx.meta.fee;
              }
            } catch {
              // Optional fee metadata lookup
            }

            return {
              confirmed: true,
              signature,
              slot: status.slot,
              confirmationStatus: status.confirmationStatus,
              actualFeeLamports,
            };
          }
        }
      } catch {
        // Transient RPC poll error; continue polling
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    return {
      confirmed: false,
      signature,
      error: 'Transaction confirmation timed out waiting for Solana RPC confirmation.',
    };
  }

  static getExplorerUrl(signature: string, network: SolanaNetwork): string {
    const clusterParam = network === 'devnet' ? '?cluster=devnet' : '';
    return `https://solscan.io/tx/${signature}${clusterParam}`;
  }
}
