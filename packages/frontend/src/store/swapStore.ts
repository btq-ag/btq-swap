import { create } from 'zustand';
import type { Swap, SwapRate } from '../types';

type SwapPatch = Partial<Swap> & { id: string };

interface SwapStore {
  activeSwaps: Swap[];
  currentRate: SwapRate | null;
  setActiveSwaps: (swaps: Swap[]) => void;
  updateSwap: (swap: SwapPatch) => void;
  addSwap: (swap: Swap) => void;
  removeSwap: (id: string) => void;
  setRate: (rate: SwapRate) => void;
}

export const useSwapStore = create<SwapStore>((set) => ({
  activeSwaps: [],
  currentRate: null,

  setActiveSwaps: (swaps) => set({ activeSwaps: swaps }),

  updateSwap: (swap) =>
    set((state) => ({
      activeSwaps: state.activeSwaps.map((s) =>
        s.id === swap.id ? { ...s, ...swap } : s
      ),
    })),

  addSwap: (swap) =>
    set((state) => ({
      activeSwaps: [swap, ...state.activeSwaps],
    })),

  removeSwap: (id) =>
    set((state) => ({
      activeSwaps: state.activeSwaps.filter((s) => s.id !== id),
    })),

  setRate: (rate) => set({ currentRate: rate }),
}));
