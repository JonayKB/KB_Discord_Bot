import type { ConfirmationService } from '../modules/confirmations/service';
import type { MessagesService } from '../modules/messages/service';

/**
 * Acceso global a los servicios para el código "legacy" (eventos y utilidades que
 * siguen funcionando como antes: bienvenida, estado del servidor, roles por reacción).
 */
export interface Services {
    messages: MessagesService;
    confirmations: ConfirmationService;
}

let current: Services | null = null;

export function setServices(s: Services): void {
    current = s;
}

export function getServices(): Services {
    if (!current) throw new Error('Los servicios aún no se han inicializado');
    return current;
}
