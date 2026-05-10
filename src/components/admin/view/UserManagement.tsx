import { useState, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useAdminUsers } from '../../../hooks/useAdmin';
import { useAuth } from '../../auth/context/AuthContext';
import { authenticatedFetch } from '../../../utils/api';
import { Button } from '../../../shared/view/ui';
import { Users, UserPlus, Shield, ShieldOff, Trash2, Key, Info } from 'lucide-react';

export default function UserManagement() {
  const { t } = useTranslation('admin');
  const { user: currentUser } = useAuth();
  const {
    users,
    isLoading,
    error,
    fetchUsers,
    createUser,
    deleteUser,
    resetPassword,
    toggleUser,
  } = useAdminUsers();

  const [authMode, setAuthMode] = useState<'database' | 'linux'>('database');
  const [isLoadingAuthMode, setIsLoadingAuthMode] = useState(true);

  // Fetch auth mode on mount
  useEffect(() => {
    const fetchAuthMode = async () => {
      try {
        const response = await authenticatedFetch('/api/settings/auth-mode', { method: 'GET' });
        if (response.ok) {
          const data = await response.json();
          setAuthMode(data.authMode || 'database');
        }
      } catch (err) {
        console.error('Failed to fetch auth mode:', err);
      } finally {
        setIsLoadingAuthMode(false);
      }
    };
    fetchAuthMode();
  }, []);

  const isPamMode = authMode === 'linux';

  // Count admins to prevent deleting/disabling the last admin
  const adminCount = useMemo(() => users.filter(u => u.role === 'admin').length, [users]);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [showResetModal, setShowResetModal] = useState<number | null>(null);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<'user' | 'admin'>('user');
  const [resetPasswordValue, setResetPasswordValue] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    setActionError(null);
    const result = await createUser(newUsername, newPassword, newUserRole);
    if (result.success) {
      setShowCreateModal(false);
      setNewUsername('');
      setNewPassword('');
      setNewUserRole('user');
    } else {
      setActionError(result.error || 'Failed to create user');
    }
  };

  const handleResetPassword = async (userId: number) => {
    setActionError(null);
    const result = await resetPassword(userId, resetPasswordValue);
    if (result.success) {
      setShowResetModal(null);
      setResetPasswordValue('');
    } else {
      setActionError(result.error || 'Failed to reset password');
    }
  };

  const handleToggleUser = async (userId: number, isActive: boolean) => {
    setActionError(null);
    await toggleUser(userId, isActive);
  };

  const handleDeleteUser = async (userId: number) => {
    if (!confirm(t('users.confirmDelete'))) {
      return;
    }
    setActionError(null);
    const result = await deleteUser(userId);
    if (!result.success) {
      setActionError(result.error || 'Failed to delete user');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t('users.title')}</h2>
        <Button onClick={() => setShowCreateModal(true)} disabled={isPamMode || isLoadingAuthMode}>
          <UserPlus className="mr-2 h-4 w-4" />
          {t('users.createUser')}
        </Button>
      </div>

      {/* Loading state */}
      {(isLoading || isLoadingAuthMode) && (
        <div className="flex items-center justify-center p-8">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        </div>
      )}

      {/* PAM Mode Warning */}
      {isPamMode && !isLoadingAuthMode && (
        <div className="flex items-start gap-3 rounded-lg bg-blue-500/10 p-4 text-sm text-blue-600 dark:text-blue-400">
          <Info className="mt-0.5 h-5 w-5 flex-shrink-0" />
          <div>
            <p className="font-medium">{t('users.pamModeTitle')}</p>
            <p className="mt-1 text-muted-foreground">{t('users.pamModeDesc')}</p>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {actionError && (
        <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          {actionError}
        </div>
      )}

      <div className="rounded-md border">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/50 text-left text-sm">
              <th className="px-4 py-3 font-medium">{t('users.username')}</th>
              <th className="px-4 py-3 font-medium">{t('users.role')}</th>
              <th className="px-4 py-3 font-medium">{t('users.active')}</th>
              <th className="px-4 py-3 font-medium">{t('users.createdAt')}</th>
              <th className="px-4 py-3 font-medium">{t('users.lastLogin')}</th>
              <th className="px-4 py-3 font-medium">{t('users.actions')}</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b">
                <td className="px-4 py-3">{user.username}</td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      user.role === 'admin'
                        ? 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200'
                        : 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200'
                    }`}
                  >
                    {user.role === 'admin' ? (
                      <Shield className="mr-1 h-3 w-3" />
                    ) : null}
                    {user.role === 'admin' ? t('users.admin') : t('users.user')}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <span
                    className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
                      user.is_active
                        ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                        : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                    }`}
                  >
                    {user.is_active ? t('users.active') : t('users.inactive')}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {new Date(user.created_at).toLocaleDateString()}
                </td>
                <td className="px-4 py-3 text-sm text-muted-foreground">
                  {user.last_login
                    ? new Date(user.last_login).toLocaleDateString()
                    : '-'}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setShowResetModal(user.id)}
                      title={t('users.resetPassword')}
                      disabled={isPamMode}
                    >
                      <Key className="h-4 w-4" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleUser(user.id, !user.is_active)}
                      title={
                        user.role === 'admin' && user.is_active && adminCount === 1
                          ? t('users.cannotDisableLastAdmin', { defaultValue: 'Cannot disable the last admin' })
                          : (user.is_active ? t('users.inactive') : t('users.active'))
                      }
                      disabled={user.role === 'admin' && user.is_active && adminCount === 1 || isPamMode}
                      className={user.role === 'admin' && user.is_active && adminCount === 1 ? 'opacity-50' : ''}
                    >
                      {user.is_active ? (
                        <ShieldOff className="h-4 w-4" />
                      ) : (
                        <Shield className="h-4 w-4" />
                      )}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteUser(user.id)}
                      title={
                        user.role === 'admin' && adminCount === 1
                          ? t('users.cannotDeleteLastAdmin', { defaultValue: 'Cannot delete the last admin' })
                          : t('users.deleteUser')
                      }
                      className={`text-destructive hover:text-destructive ${user.role === 'admin' && adminCount === 1 ? 'opacity-50' : ''}`}
                      disabled={user.role === 'admin' && adminCount === 1 || isPamMode}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
            {users.length === 0 && !isLoading && (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  {t('users.noUsers')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Create User Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
            <h3 className="mb-4 text-lg font-semibold">{t('users.createUser')}</h3>
            <form onSubmit={handleCreateUser} className="space-y-4">
              <div>
                <label className="mb-1 block text-sm font-medium">{t('users.username')}</label>
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                  required
                  minLength={3}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">{t('users.password')}</label>
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                  required
                  minLength={6}
                />
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium">{t('users.role')}</label>
                <select
                  value={newUserRole}
                  onChange={(e) => setNewUserRole(e.target.value as 'user' | 'admin')}
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                >
                  <option value="user">{t('users.user')}</option>
                  <option value="admin">{t('users.admin')}</option>
                </select>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setShowCreateModal(false)}
                >
                  {t('users.cancel', { defaultValue: 'Cancel' })}
                </Button>
                <Button type="submit">{t('users.createUser')}</Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Reset Password Modal */}
      {showResetModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="w-full max-w-md rounded-lg bg-background p-6 shadow-lg">
            <h3 className="mb-4 text-lg font-semibold">{t('users.resetPassword')}</h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                handleResetPassword(showResetModal);
              }}
              className="space-y-4"
            >
              <div>
                <label className="mb-1 block text-sm font-medium">{t('users.password')}</label>
                <input
                  type="password"
                  value={resetPasswordValue}
                  onChange={(e) => setResetPasswordValue(e.target.value)}
                  className="w-full rounded-md border border-input bg-background px-3 py-2"
                  required
                  minLength={6}
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    setShowResetModal(null);
                    setResetPasswordValue('');
                  }}
                >
                  {t('users.cancel', { defaultValue: 'Cancel' })}
                </Button>
                <Button type="submit">{t('users.resetPassword')}</Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}