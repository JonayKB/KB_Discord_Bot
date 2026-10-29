import type { ConfirmationService } from '../modules/confirmations/service';
import type { MessagesService } from '../modules/messages/service';
import type { ServersService } from '../modules/servers/service';
import type { ReactionRolesService } from '../modules/reactions/service';

/**
 * Acceso global a los servicios para el código "legacy" (eventos, comandos y utilidades que
 * siguen funcionando como antes: bienvenida, estado del servidor, /setreaction).
 */
export interface Services {
    messages: MessagesService;
    confirmations: ConfirmationService;
    servers: ServersService;
    reactions: ReactionRolesService;
}

let current: Services | null = null;

export function setServices(s: Services): void {
    current = s;
}

export function getServices(): Services {
    if (!current) throw new Error('Los servicios aún no se han inicializado');
    return current;
}
