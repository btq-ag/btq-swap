import { useState, useCallback } from 'react';
import { api } from '../lib/api';
import { useSwapStore } from '../store/swapStore';
import type { Swap, SwapCreatePayload, SwapRate, PaginatedResponse } from '../types';

export function useSwap() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { activeSwaps, setActiveSwaps, updateSwap, addSwap, setRate, currentRate } =
    useSwapStore();

  const fetchRate = useCallback(async () => {
    try {
      const rate = await api.get<SwapRate>('/price');
      setRate(rate);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch market rate');
    }
  }, [setRate]);

  const fetchActiveSwaps = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.get<{ swaps: Swap[] }>('/swaps');
      setActiveSwaps(res.swaps ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch swaps');
      setActiveSwaps([]);
    } finally {
      setLoading(false);
    }
  }, [setActiveSwaps]);

  const fetchSwap = useCallback(async (id: string): Promise<Swap | null> => {
    try {
      const res = await api.get<{ swap: Swap }>(`/swaps/${id}`);
      return res.swap ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch swap');
      return null;
    }
  }, []);

  const createSwap = useCallback(
    async (payload: SwapCreatePayload): Promise<Swap | null> => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.post<{ swap: Swap }>('/swaps', payload);
        const swap = res.swap;
        addSwap(swap);
        return swap;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to create swap');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [addSwap]
  );

  const submitBtqTxid = useCallback(
    async (swapId: string, txid: string): Promise<Swap | null> => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.post<{ swap: Swap }>(`/swaps/${swapId}/submit-btq-htlc`, {
          btq_htlc_txid: txid,
          btq_htlc_vout: 0,
          btq_merkle_root: '',
          claim_leaf_hex: '',
          refund_leaf_hex: '',
          control_block_hex: '',
        });
        updateSwap(res.swap);
        return res.swap;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to submit txid');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [updateSwap]
  );

  const submitEvmTxHash = useCallback(
    async (swapId: string, txHash: string): Promise<Swap | null> => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.post<{ swap: Swap }>(`/swaps/${swapId}/confirm-btq-claim`, {
          btq_claim_txid: txHash,
        });
        updateSwap(res.swap);
        return res.swap;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to submit tx hash');
        return null;
      } finally {
        setLoading(false);
      }
    },
    [updateSwap]
  );

  const fetchHistory = useCallback(
    async (page = 1, limit = 20): Promise<{ swaps: Swap[] }> => {
      return api.get<{ swaps: Swap[] }>(
        `/swaps?limit=${limit}&offset=${(page - 1) * limit}`
      );
    },
    []
  );

  return {
    activeSwaps,
    currentRate,
    loading,
    error,
    fetchRate,
    fetchActiveSwaps,
    fetchSwap,
    createSwap,
    submitBtqTxid,
    submitEvmTxHash,
    fetchHistory,
  };
}
