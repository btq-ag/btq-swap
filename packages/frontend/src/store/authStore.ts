import { create } from 'zustand';
import type { User } from '../types';

interface AuthStore {
  token: string | null;
  user: User | null;
  isAdmin: boolean;
  isAuthenticated: boolean;
  setAuth: (token: string, user: User) => void;
  clearAuth: () => void;
  hydrate: () => void;
}

export const useAuthStore = create<AuthStore>((set) => ({
  token: null,
  user: null,
  isAdmin: false,
  isAuthenticated: false,

  setAuth: (token, user) => {
    localStorage.setItem('btq_swap_token', token);
    localStorage.setItem('btq_swap_user', JSON.stringify(user));
    set({
      token,
      user,
      isAdmin: user.role === 'admin',
      isAuthenticated: true,
    });
  },

  clearAuth: () => {
    localStorage.removeItem('btq_swap_token');
    localStorage.removeItem('btq_swap_user');
    set({
      token: null,
      user: null,
      isAdmin: false,
      isAuthenticated: false,
    });
  },

  hydrate: () => {
    const token = localStorage.getItem('btq_swap_token');
    const raw = localStorage.getItem('btq_swap_user');
    if (token && raw) {
      try {
        const user: User = JSON.parse(raw);
        set({
          token,
          user,
          isAdmin: user.role === 'admin',
          isAuthenticated: true,
        });
      } catch {
        localStorage.removeItem('btq_swap_token');
        localStorage.removeItem('btq_swap_user');
      }
    }
  },
}));
