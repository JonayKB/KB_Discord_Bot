import { Router } from 'express';
import { asyncRoute, str } from '../../core/http';
import type { BotModule } from '../../core/module';
import type { NewsService } from './service';

export { NewsService } from './service';

/** Refresca el recuento de las encuestas y su cierre: Discord no avisa de ello con los intents actuales. */
const REFRESH_MS = 5 * 60_000;

export function createNewsModule(service: NewsService): BotModule {
    const router = Router();

    router.get('/', (_req, res) => res.json(service.getState()));

    router.put('/', asyncRoute(async (req, res) => {
        service.setConfig({ channelId: str(req.body?.channelId, 'channelId', { max: 32 }) || null });
        res.json(await service.publishNow());
    }));

    router.post('/publish', asyncRoute(async (_req, res) => {
        res.json(await service.publishNow());
    }));

    return {
        id: 'news',
        name: 'Noticias',
        description: 'Publica los últimos mensajes de un canal en un fichero JSON público que lee el launcher.',
        router,
        start(ctx) {
            const onChange = (channelId: string) => {
                if (service.isNewsChannel(channelId)) service.schedule();
            };
            ctx.listen('messageCreate', msg => onChange(msg.channelId));
            ctx.listen('messageUpdate', (_old, msg) => onChange(msg.channelId));
            ctx.listen('messageDelete', msg => onChange(msg.channelId));
            ctx.listen('messageDeleteBulk', (_msgs, channel) => onChange(channel.id));
            ctx.every(REFRESH_MS, () => service.publishNow());
            ctx.onStop(() => service.cancelScheduled());
            void service.publishNow();
        },
    };
}
