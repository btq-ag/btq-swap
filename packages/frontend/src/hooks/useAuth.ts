import { useCallback, useEffect } from 'react';
import { useAccount, useSignMessage, useDisconnect } from 'wagmi';
import { SiweMessage } from 'siwe';
import { api } from '../lib/api';
import { useAuthStore } from '../store/authStore';
import type { User } from '../types';
import { showError } from '../components/common/ErrorToast';
import { trackEvent } from '../lib/telemetry';

export function useAuth() {
  const { address, isConnected, chainId } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();
  const { token, user, isAdmin, isAuthenticated, setAuth, clearAuth, hydrate } =
    useAuthStore();

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  useEffect(() => {
    if (!isConnected && isAuthenticated) {
      clearAuth();
    }
  }, [isConnected, isAuthenticated, clearAuth]);

  const signIn = useCallback(async () => {
    if (!address || !chainId) return;
    try {
      const { nonce } = await api.get<{ nonce: string }>('/auth/nonce');

      const message = new SiweMessage({
        domain: window.location.host,
        address,
        statement: 'Sign in to BTQ Swap',
        uri: window.location.origin,
        version: '1',
        chainId,
        nonce,
      });

      const messageStr = message.prepareMessage();
      const signature = await signMessageAsync({ message: messageStr });

      const result = await api.post<{ token: string; user: User }>(
        '/auth/verify',
        { message: messageStr, signature }
      );

      setAuth(result.token, result.user);
      void trackEvent('sign_in_success', { chainId });
    } catch (err) {
      void trackEvent('sign_in_failed', {
        chainId,
        message: err instanceof Error ? err.message : String(err),
      });
      showError(err);
      throw err;
    }
  }, [address, chainId, signMessageAsync, setAuth]);

  const signOut = useCallback(() => {
    clearAuth();
    disconnect();
  }, [clearAuth, disconnect]);

  return {
    address,
    isConnected,
    isAuthenticated,
    isAdmin,
    user,
    token,
    signIn,
    signOut,
  };
}
