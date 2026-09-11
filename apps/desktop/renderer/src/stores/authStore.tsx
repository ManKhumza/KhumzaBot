import React from 'react';
import { create } from 'zustand';
import type { User, Session } from '@/types';
import { nocaiAPI } from '@/utils/api';
import { userFacingError, withTimeout } from '@/utils/errors';
import { chatDrafts } from '@/stores/chatDrafts';

interface AuthState {
  user: User | null;
  session: Session | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;
  
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>()(
    (set) => ({
      user: null,
      session: null,
      isAuthenticated: false,
      isLoading: true,
      error: null,

      login: async (username: string, password: string) => {
        set({ error: null });
        try {
          const result = await nocaiAPI.auth.login({ username, password });
          set({
            user: result.user,
            session: { user: result.user, token: result.token, expiresAt: result.expiresAt },
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error: any) {
          set({ isLoading: false, error: userFacingError(error, 'Sign-in failed. Try again.') });
          throw error;
        }
      },

      logout: async () => {
        set({ isLoading: true });
        try {
          await nocaiAPI.auth.logout();
        } catch (error) {
          set({ error: userFacingError(error, 'The backend could not confirm sign-out. Restart local services before signing in again.') });
        } finally {
          chatDrafts.clear();
          set({
            user: null,
            session: null,
            isAuthenticated: false,
            isLoading: false,
          });
        }
      },

      checkSession: async () => {
        set({ isLoading: true });
        try {
          const session = await withTimeout(nocaiAPI.auth.getSession(), 'Session check timed out. Open diagnostics or retry local services.');
          if (session) {
            set({
              user: session.user,
              session: { user: session.user, token: '', expiresAt: '' },
              isAuthenticated: true,
              isLoading: false,
            });
          } else {
            set({ user: null, session: null, isAuthenticated: false, isLoading: false });
          }
        } catch (error) {
          set({ user: null, session: null, isAuthenticated: false, isLoading: false, error: userFacingError(error) });
        }
      },

      changePassword: async (currentPassword: string, newPassword: string) => {
        set({ error: null });
        try {
          await nocaiAPI.auth.changePassword({ currentPassword, newPassword });
          set((state) => {
            const user = state.user ? { ...state.user, mustChangePassword: false } : null;
            return {
              user,
              session: state.session && user ? { ...state.session, user } : state.session,
              isLoading: false,
            };
          });
        } catch (error: any) {
          set({ isLoading: false, error: userFacingError(error, 'Password change failed.') });
          throw error;
        }
      },

      clearError: () => set({ error: null }),
    })
);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  // Initialize auth on mount
  React.useEffect(() => {
    useAuthStore.getState().checkSession();
  }, []);

  return <>{children}</>;
};
