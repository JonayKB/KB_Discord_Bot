import type { ReactionData } from "./reactionData.js";


export type ConfigData = {
    mensajeID: string;
    canalID: string;
    rolContadoID: string;
    reactions: [ReactionData]
};

