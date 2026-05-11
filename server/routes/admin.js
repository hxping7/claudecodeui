/**
 * Admin routes - User management and admin-only operations
 */
import express from 'express';
import bcrypt from 'bcrypt';
import { userDb } from '../modules/database/index.js';
import { requireAdmin } from '../middleware/admin.js';

const router = express.Router();

// Helper: check if current user can modify target user
const canModifyUser = (currentUser, targetUserId, action = 'modify') => {
  const targetUser = userDb.getAllUsers().find(u => u.id === targetUserId);
  if (!targetUser) return { allowed: false, reason: 'User not found' };

  // Superadmin can modify anyone, but cannot disable/delete themselves
  if (currentUser.role === 'superadmin') {
    // Prevent superadmin from disabling/deleting themselves
    if (targetUser.id === currentUser.id && (action === 'delete' || action === 'disable')) {
      return { allowed: false, reason: 'Cannot disable or delete your own account' };
    }
    return { allowed: true };
  }

  // Admin cannot modify superadmin
  if (targetUser.role === 'superadmin') {
    return { allowed: false, reason: 'Cannot modify superadmin user' };
  }

  // Admin cannot modify other admins (except themselves)
  if (targetUser.role === 'admin' && targetUser.id !== currentUser.id) {
    return { allowed: false, reason: 'Cannot modify other admin users' };
  }

  // Prevent admin from disabling/deleting themselves
  if (targetUser.id === currentUser.id && (action === 'delete' || action === 'disable')) {
    return { allowed: false, reason: 'Cannot disable or delete your own account' };
  }

  return { allowed: true };
};

// Apply admin middleware to all routes
router.use(requireAdmin);

/**
 * GET /api/admin/users
 * List all users (admin only)
 */
router.get('/users', async (req, res) => {
  try {
    const users = userDb.getAllUsers();
    // Don't send password hashes
    const sanitizedUsers = users.map(user => ({
      id: user.id,
      username: user.username,
      created_at: user.created_at,
      last_login: user.last_login,
      is_active: Boolean(user.is_active),
      role: user.role,
      git_name: user.git_name,
      git_email: user.git_email,
      has_completed_onboarding: Boolean(user.has_completed_onboarding),
    }));
    res.json({ success: true, users: sanitizedUsers });
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * POST /api/admin/users
 * Create a new user (admin only)
 */
router.post('/users', async (req, res) => {
  try {
    const { username, password, role = 'user' } = req.body;

    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Validate role
    if (role !== 'admin' && role !== 'user') {
      return res.status(400).json({ error: 'Role must be admin or user' });
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const result = userDb.createUser(username.trim(), passwordHash, role);
    res.json({
      success: true,
      user: {
        id: result.id,
        username: result.username,
        role,
      }
    });
  } catch (error) {
    if (error.message?.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * PATCH /api/admin/users/:userId
 * Update user information (admin only)
 */
router.patch('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { username, git_name, git_email, role } = req.body;
    const numericUserId = parseInt(userId, 10);

    if (isNaN(numericUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Check permission to delete this user
    const perm = canModifyUser(req.user, numericUserId, 'delete');
    if (!perm.allowed) {
      return res.status(403).json({ error: perm.reason });
    }

    // Prevent changing own admin role
    if (req.user.id === numericUserId && role && role !== req.user.role) {
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    const updates = {};

    if (username !== undefined) {
      if (!username.trim()) {
        return res.status(400).json({ error: 'Username cannot be empty' });
      }
      updates.username = username.trim();
    }

    if (git_name !== undefined) {
      updates.git_name = git_name;
    }

    if (git_email !== undefined) {
      updates.git_email = git_email;
    }

    if (role !== undefined) {
      if (role !== 'superadmin' && role !== 'admin' && role !== 'user') {
        return res.status(400).json({ error: 'Role must be superadmin, admin or user' });
      }
      // Only superadmin can assign superadmin or admin role
      if (role === 'superadmin' && req.user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Only superadmin can assign superadmin role' });
      }
      if (role === 'admin' && req.user.role !== 'superadmin') {
        return res.status(403).json({ error: 'Only superadmin can assign admin role' });
      }
      updates.role = role;
    }

    const success = userDb.updateUser(numericUserId, updates);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    if (error.message?.includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'Username already exists' });
    }
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * DELETE /api/admin/users/:userId
 * Delete a user (admin only)
 */
router.delete('/users/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const numericUserId = parseInt(userId, 10);

    if (isNaN(numericUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Check permission to delete this user
    const perm = canModifyUser(req.user, numericUserId, 'delete');
    if (!perm.allowed) {
      return res.status(403).json({ error: perm.reason });
    }

    // Prevent deleting yourself
    if (req.user.id === numericUserId) {
      return res.status(400).json({ error: 'Cannot delete your own account' });
    }

    const success = userDb.deleteUser(numericUserId);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    console.error('Error deleting user:', error);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

/**
 * POST /api/admin/users/:userId/reset-password
 * Reset user password (admin only)
 * Note: Users can reset their own password, but cannot reset superadmin password
 */
router.post('/users/:userId/reset-password', async (req, res) => {
  try {
    const { userId } = req.params;
    const { password } = req.body;
    const numericUserId = parseInt(userId, 10);

    if (isNaN(numericUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Check if target is superadmin - only superadmin can reset superadmin password
    const targetUser = userDb.getAllUsers().find(u => u.id === numericUserId);
    if (targetUser?.role === 'superadmin' && req.user.role !== 'superadmin') {
      return res.status(403).json({ error: 'Cannot reset superadmin password' });
    }

    // Prevent non-superadmin from resetting other users' passwords (they can only reset their own)
    if (req.user.role !== 'superadmin' && numericUserId !== req.user.id) {
      return res.status(403).json({ error: 'Cannot reset other users\' passwords' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const saltRounds = 12;
    const passwordHash = await bcrypt.hash(password, saltRounds);

    const success = userDb.updatePassword(numericUserId, passwordHash);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    console.error('Error resetting password:', error);
    res.status(500).json({ error: 'Failed to reset password' });
  }
});

/**
 * PATCH /api/admin/users/:userId/toggle
 * Enable/disable user (admin only)
 */
router.patch('/users/:userId/toggle', async (req, res) => {
  try {
    const { userId } = req.params;
    const { isActive } = req.body;
    const numericUserId = parseInt(userId, 10);

    if (isNaN(numericUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Check permission to delete this user
    const perm = canModifyUser(req.user, numericUserId, 'delete');
    if (!perm.allowed) {
      return res.status(403).json({ error: perm.reason });
    }

    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ error: 'isActive must be a boolean' });
    }

    // Prevent disabling yourself
    if (req.user.id === numericUserId && !isActive) {
      return res.status(400).json({ error: 'Cannot disable your own account' });
    }

    const success = userDb.toggleUserActive(numericUserId, isActive);

    if (success) {
      res.json({ success: true });
    } else {
      res.status(404).json({ error: 'User not found' });
    }
  } catch (error) {
    console.error('Error toggling user:', error);
    res.status(500).json({ error: 'Failed to toggle user status' });
  }
});

export default router;