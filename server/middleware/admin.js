/**
 * Admin middleware - verifies admin role for protected routes
 */

/**
 * Middleware to verify admin role
 * Usage: router.get('/admin-only', requireAdmin, handler)
 */
export const requireAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role !== 'admin' && req.user.role !== 'superadmin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  next();
};

/**
 * Middleware to check if user is admin (for optional admin features)
 */
export const optionalAdmin = (req, res, next) => {
  // Add isAdmin helper to request
  req.isAdmin = req.user?.role === 'admin' || req.user?.role === 'superadmin';
  next();
};