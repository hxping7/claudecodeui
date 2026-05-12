import express from 'express';

import sessionManager from '../sessionManager.js';
import { sessionsDb } from '../modules/database/index.js';

const router = express.Router();

router.delete('/sessions/:sessionId', async (req, res) => {
    try {
        const { sessionId } = req.params;

        if (!sessionId || typeof sessionId !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(sessionId)) {
            return res.status(400).json({ success: false, error: 'Invalid session ID format' });
        }

        // Verify session ownership in PAM mode
        const userId = req.user?.id;
        if (userId) {
            const session = sessionsDb.getSessionById(sessionId);
            if (!session) {
                return res.status(404).json({ success: false, error: 'Session not found' });
            }
            if (session.user_id !== null && session.user_id !== userId) {
                return res.status(404).json({ success: false, error: 'Session not found' });
            }
        }

        await sessionManager.deleteSession(sessionId);
        sessionsDb.deleteSessionById(sessionId);
        res.json({ success: true });
    } catch (error) {
        console.error(`Error deleting Gemini session ${req.params.sessionId}:`, error);
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
