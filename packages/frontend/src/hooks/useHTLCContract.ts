import { useCallback } from 'react';
import {
  useWriteContract,
  useWaitForTransactionReceipt,
  useReadContract,
} from 'wagmi';
import { parseUnits } from 'viem';
import {
  HTLC_CONTRACT_ADDRESS,
  USDT_CONTRACT_ADDRESS,
  HTLC_ABI,
  ERC20_ABI,
} from '../lib/constants';

export function useHTLCContract() {
  const { writeContractAsync, data: txHash, isPending: isWriting } = useWriteContract();

  const { isLoading: isConfirming, isSuccess: isConfirmed } =
    useWaitForTransactionReceipt({ hash: txHash });

  const approveUSDT = useCallback(
    async (amount: string) => {
      const parsed = parseUnits(amount, 6);
      return writeContractAsync({
        address: USDT_CONTRACT_ADDRESS,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [HTLC_CONTRACT_ADDRESS, parsed],
      });
    },
    [writeContractAsync]
  );

  const lockUSDT = useCallback(
    async (
      receiver: `0x${string}`,
      hashlock: `0x${string}`,
      timelock: bigint,
      amount: string
    ) => {
      const parsed = parseUnits(amount, 6);
      return writeContractAsync({
        address: HTLC_CONTRACT_ADDRESS,
        abi: HTLC_ABI,
        functionName: 'newContract',
        args: [receiver, hashlock, timelock, USDT_CONTRACT_ADDRESS, parsed],
      });
    },
    [writeContractAsync]
  );

  const claimUSDT = useCallback(
    async (contractId: `0x${string}`, preimage: `0x${string}`) => {
      return writeContractAsync({
        address: HTLC_CONTRACT_ADDRESS,
        abi: HTLC_ABI,
        functionName: 'withdraw',
        args: [contractId, preimage],
      });
    },
    [writeContractAsync]
  );

  const refundUSDT = useCallback(
    async (contractId: `0x${string}`) => {
      return writeContractAsync({
        address: HTLC_CONTRACT_ADDRESS,
        abi: HTLC_ABI,
        functionName: 'refund',
        args: [contractId],
      });
    },
    [writeContractAsync]
  );

  const useContractDetails = (contractId: `0x${string}` | undefined) => {
    return useReadContract({
      address: HTLC_CONTRACT_ADDRESS,
      abi: HTLC_ABI,
      functionName: 'getContract',
      args: contractId ? [contractId] : undefined,
      query: { enabled: !!contractId },
    });
  };

  return {
    approveUSDT,
    lockUSDT,
    claimUSDT,
    refundUSDT,
    useContractDetails,
    txHash,
    isWriting,
    isConfirming,
    isConfirmed,
  };
}
