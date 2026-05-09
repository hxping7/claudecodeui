/**
 * Admin routes - User management and admin-only operations
 */
import express from 'express';
import bcrypt from 'bcrypt';
import { userDb } from '../modules/database/index.js';
import { requireAdmin } from '../middleware/admin.js';

const router = express.Router();

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

    // Prevent changing own admin role
    if (req.user.id === numericUserId && role && role !== 'admin') {
      return res.status(400).json({ error: 'Cannot demote yourself from admin' });
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
      if (role !== 'admin' && role !== 'user') {
        return res.status(400).json({ error: 'Role must be admin or user' });
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
 */
router.post('/users/:userId/reset-password', async (req, res) => {
  try {
    const { userId } = req.params;
    const { password } = req.body;
    const numericUserId = parseInt(userId, 10);

    if (isNaN(numericUserId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
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