import React from 'react';
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import type { User, Session } from '@/types';
import { nocaiAPI } from '@/utils/api';

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
  persist(
    (set, get) => ({
      user: null,
      session: null,
      isAuthenticated: false,
      isLoading: false,
      error: null,

      login: async (username: string, password: string) => {
        set({ isLoading: true, error: null });
        try {
          const result = await nocaiAPI.auth.login({ username, password });
          set({
            user: result.user,
            session: { user: result.user, token: result.token, expiresAt: result.expiresAt },
            isAuthenticated: true,
            isLoading: false,
          });
        } catch (error: any) {
          set({ isLoading: false, error: error.message || 'Login failed' });
          throw error;
        }
      },

      logout: async () => {
        set({ isLoading: true });
        try {
          await nocaiAPI.auth.logout();
        } finally {
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
          const session = await nocaiAPI.auth.getSession();
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
        } catch {
          set({ user: null, session: null, isAuthenticated: false, isLoading: false });
        }
      },

      changePassword: async (currentPassword: string, newPassword: string) => {
        set({ isLoading: true, error: null });
        try {
          await nocaiAPI.auth.changePassword({ currentPassword, newPassword });
          set({ isLoading: false });
        } catch (error: any) {
          set({ isLoading: false, error: error.message || 'Password change failed' });
          throw error;
        }
      },

      clearError: () => set({ error: null }),
    }),
    {
      name: 'nocai-auth',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        user: state.user,
        session: state.session,
        isAuthenticated: state.isAuthenticated,
      }),
    }
  )
);

export const AuthProvider = ({ children }: { children: React.ReactNode }) => {
  // Initialize auth on mount
  React.useEffect(() => {
    useAuthStore.getState().checkSession();
  }, []);

  return <>{children}</>;
};