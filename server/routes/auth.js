import express from 'express';
import bcrypt from 'bcrypt';
import { userDb, appConfigDb } from '../modules/database/index.js';
import { getConnection } from '../modules/database/connection.js';
import { generateToken, authenticateToken } from '../middleware/auth.js';
import { getLinuxUserInfo, authenticateWithLinux } from '../modules/auth/linux-pam-auth.js';

const router = express.Router();
const db = getConnection();

// Get current auth mode
function getAuthMode() {
  return appConfigDb.get('auth_mode') || 'database';
}

// Check auth status and setup requirements
router.get('/status', async (req, res) => {
  try {
    const hasUsers = await userDb.hasUsers();
    res.json({ 
      needsSetup: !hasUsers,
      isAuthenticated: false // Will be overridden by frontend if token exists
    });
  } catch (error) {
    console.error('Auth status error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// User registration - first user becomes admin, subsequent users are regular users
router.post('/register', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    if (username.length < 3 || password.length < 6) {
      return res.status(400).json({ error: 'Username must be at least 3 characters, password at least 6 characters' });
    }

    // Use a transaction to prevent race conditions
    db.prepare('BEGIN').run();
    try {
      // Check if this is the first user (becomes admin)
      const userCount = userDb.countUsers();
      const isFirstUser = userCount === 0;
      const role = isFirstUser ? 'admin' : 'user';

      // Hash password
      const saltRounds = 12;
      const passwordHash = await bcrypt.hash(password, saltRounds);

      // Create user with role
      const user = userDb.createUser(username, passwordHash, role);

      // Generate token
      const token = generateToken({ ...user, role });

      db.prepare('COMMIT').run();

      // Update last login (non-fatal, outside transaction)
      userDb.updateLastLogin(user.id);

      res.json({
        success: true,
        user: { id: user.id, username: user.username, role },
        token
      });
    } catch (error) {
      db.prepare('ROLLBACK').run();
      throw error;
    }

  } catch (error) {
    console.error('Registration error:', error);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      res.status(409).json({ error: 'Username already exists' });
    } else {
      res.status(500).json({ error: 'Internal server error' });
    }
  }
});

// User login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Validate input
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const authMode = getAuthMode();

    if (authMode === 'linux') {
      // Linux PAM authentication mode - verify password via PAM
      const authResult = await authenticateWithLinux(username, password);
      if (!authResult.success) {
        return res.status(401).json({ error: 'Invalid username or password' });
      }

      // Get or create user in database (auto-provisioning)
      let user = userDb.getUserByUsername(username);
      if (!user) {
        // Determine role: check if user is in admin list
        const adminUsers = (appConfigDb.get('linux_admin_users') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        const isAdmin = adminUsers.includes(username.toLowerCase());
        const role = isAdmin ? 'admin' : 'user';

        // Auto-create user with appropriate role
        user = userDb.createUser(username, 'PAM_AUTH_PLACEHOLDER', role);
      }

      // Generate token with Linux user info
      const token = generateToken({
        ...user,
        homeDir: authResult.homeDir,
        uid: authResult.uid,
        gid: authResult.gid,
      });

      // Update last login
      userDb.updateLastLogin(user.id);

      res.json({
        success: true,
        user: { id: user.id, username: user.username, role: user.role || 'user' },
        token,
        workspaceRoot: authResult.homeDir,
        authMode: 'linux'
      });
      return;
    }

    // Database authentication mode (default)
    // Get user from database
    const user = userDb.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Generate token
    const token = generateToken(user);

    // Update last login
    userDb.updateLastLogin(user.id);

    res.json({
      success: true,
      user: { id: user.id, username: user.username, role: user.role || 'user' },
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get current user (protected route)
router.get('/user', authenticateToken, (req, res) => {
  res.json({
    user: req.user
  });
});

// Logout (client-side token removal, but this endpoint can be used for logging)
router.post('/logout', authenticateToken, (req, res) => {
  // In a simple JWT system, logout is mainly client-side
  // This endpoint exists for consistency and potential future logging
  res.json({ success: true, message: 'Logged out successfully' });
});

export default router;
