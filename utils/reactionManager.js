// utils/reactionManager.js

/**
 * Registra um ouvinte de reação para uma mensagem específica.
 * @param {import('discord.js').Client} client - O cliente Discord.
 * @param {string} messageId - O ID da mensagem a ser ouvida.
 * @param {object} options - As condições para acionar o ouvinte.
 * @param {string} options.commandName - O nome do comando (data.name) que irá lidar com a reação.
 * @param {string} options.emojiIdentifier - O nome (para unicode, ex: '✅') ou ID (para emoji customizado).
 * @param {string[]} [options.allowedUsers] - Array de IDs de usuários permitidos.
 * @param {string[]} [options.allowedRoles] - Array de IDs de cargos permitidos.
 * @param {any} [options.extraData] - Dados extras para passar ao handler (ex: { info: "Votação" }).
 */
function registerReactionListener(client, messageId, options) {
    if (!client || !messageId || !options || !options.commandName || !options.emojiIdentifier) {
        console.error("[ERRO registerReactionListener] Faltando parâmetros obrigatórios (client, messageId, commandName, emojiIdentifier).");
        return;
    }
    
    // Inicializa o Map se for a primeira vez
    if (!client.reactionListeners) {
        client.reactionListeners = new Map();
    }

    // +++ CORREÇÃO (BUG 2): Adiciona o wrapper de timestamp +++
    const data = {
            commandName: options.commandName,
            emojiIdentifier: options.emojiIdentifier,
            allowedUsers: options.allowedUsers || [],
            allowedRoles: options.allowedRoles || [],
            extraData: options.extraData || null
    };

    client.reactionListeners.set(messageId, { data: data, timestamp: Date.now() });
    console.log(`[INFO reactionManager] Ouvinte de reação registrado para a mensagem ${messageId}.`);
}

/**
 * Remove um ouvinte de reação de uma mensagem.
 * @param {import('discord.js').Client} client - O cliente Discord.
 * @param {string} messageId - O ID da mensagem.
 */
function removeReactionListener(client, messageId) {
    if (client.reactionListeners && client.reactionListeners.delete(messageId)) {
        console.log(`[INFO reactionManager] Ouvinte de reação removido da mensagem ${messageId}.`);
    }
}

module.exports = {
    registerReactionListener,
    removeReactionListener
};