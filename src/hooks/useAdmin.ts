import { useCallback, useState } from 'react';
import { api } from '../utils/api';

export type AdminUser = {
  id: number;
  username: string;
  created_at: string;
  last_login: string | null;
  is_active: boolean;
  role: 'admin' | 'user';
  git_name: string | null;
  git_email: string | null;
  has_completed_onboarding: boolean;
};

export type AgentConfig = {
  anthropicBaseUrl: string | null;
  openaiBaseUrl: string | null;
  geminiBaseUrl: string | null;
  cursorBaseUrl: string | null;
  updatedAt: string | null;
  updatedBy: number | null;
};

export function useAdminUsers() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.getUsers();
      const data = await response.json();
      if (data.success) {
        setUsers(data.users);
      } else {
        setError(data.error || 'Failed to fetch users');
      }
    } catch (err) {
      setError('Failed to fetch users');
      console.error('Error fetching users:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const createUser = useCallback(async (username: string, password: string, role: 'admin' | 'user' = 'user') => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.createUser(username, password, role);
      const data = await response.json();
      if (data.success) {
        await fetchUsers();
        return { success: true };
      } else {
        setError(data.error || 'Failed to create user');
        return { success: false, error: data.error };
      }
    } catch (err) {
      const errorMsg = 'Failed to create user';
      setError(errorMsg);
      console.error('Error creating user:', err);
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, [fetchUsers]);

  const updateUser = useCallback(async (userId: number, updates: Partial<AdminUser>) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.updateUser(userId, updates);
      const data = await response.json();
      if (data.success) {
        await fetchUsers();
        return { success: true };
      } else {
        setError(data.error || 'Failed to update user');
        return { success: false, error: data.error };
      }
    } catch (err) {
      const errorMsg = 'Failed to update user';
      setError(errorMsg);
      console.error('Error updating user:', err);
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, [fetchUsers]);

  const deleteUser = useCallback(async (userId: number) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.deleteUser(userId);
      const data = await response.json();
      if (data.success) {
        await fetchUsers();
        return { success: true };
      } else {
        setError(data.error || 'Failed to delete user');
        return { success: false, error: data.error };
      }
    } catch (err) {
      const errorMsg = 'Failed to delete user';
      setError(errorMsg);
      console.error('Error deleting user:', err);
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, [fetchUsers]);

  const resetPassword = useCallback(async (userId: number, newPassword: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.resetPassword(userId, newPassword);
      const data = await response.json();
      if (data.success) {
        return { success: true };
      } else {
        setError(data.error || 'Failed to reset password');
        return { success: false, error: data.error };
      }
    } catch (err) {
      const errorMsg = 'Failed to reset password';
      setError(errorMsg);
      console.error('Error resetting password:', err);
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, []);

  const toggleUser = useCallback(async (userId: number, isActive: boolean) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.admin.toggleUser(userId, isActive);
      const data = await response.json();
      if (data.success) {
        await fetchUsers();
        return { success: true };
      } else {
        setError(data.error || 'Failed to toggle user');
        return { success: false, error: data.error };
      }
    } catch (err) {
      const errorMsg = 'Failed to toggle user';
      setError(errorMsg);
      console.error('Error toggling user:', err);
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, [fetchUsers]);

  return {
    users,
    isLoading,
    error,
    fetchUsers,
    createUser,
    updateUser,
    deleteUser,
    resetPassword,
    toggleUser,
  };
}

export function useAgentConfig() {
  const [config, setConfig] = useState<AgentConfig | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchConfig = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.settings.getAgentConfig();
      const data = await response.json();
      if (data.success) {
        setConfig(data.config);
      } else {
        setError(data.error || 'Failed to fetch agent config');
      }
    } catch (err) {
      setError('Failed to fetch agent config');
      console.error('Error fetching agent config:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const updateConfig = useCallback(async (updates: Partial<AgentConfig> & Record<string, string | null>) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.settings.updateAgentConfig(updates);
      const data = await response.json();
      if (data.success) {
        setConfig(data.config);
        return { success: true };
      } else {
        setError(data.error || 'Failed to update agent config');
        return { success: false, error: data.error };
      }
    } catch (err) {
      const errorMsg = 'Failed to update agent config';
      setError(errorMsg);
      console.error('Error updating agent config:', err);
      return { success: false, error: errorMsg };
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    config,
    isLoading,
    error,
    fetchConfig,
    updateConfig,
  };
}