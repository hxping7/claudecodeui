import type { User } from './modules/database/repositories/users.db.js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}

export {};