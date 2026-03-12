import express, { Request, Response } from 'express';

const router = express.Router();

router.get('/', (req: Request, res: Response) => {
    const channelId = (req.session as any).currentChannelId || 1;
    res.render('watch', {
        streamUrl: `/hls/ch${channelId}.m3u8`,
        username: (req as any).session?.username || ''
    });
});

export default router;
