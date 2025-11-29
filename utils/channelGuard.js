const { sheets } = require('./google.js');

// O cache para armazenar as regras (CommandName -> {id, tipo})
const channelRulesCache = new Map();

/**
 * Carrega as regras de permissão de canal da aba "Player ID" para o cache.
 * Deve ser chamado no 'index.js' quando o bot fica pronto (Ready).
 */
async function loadChannelRules() {
    try {
        await sheets.docSorteio.loadInfo();
        const sheet = sheets.docSorteio.sheetsByTitle['Player ID']; //
        if (!sheet) {
            console.error("[ERRO ChannelGuard] Aba 'Player ID' não encontrada.");
            return;
        }
        await sheet.loadHeaderRow(1);
        const rows = await sheet.getRows();
        
        channelRulesCache.clear(); // Limpa o cache antigo
        let count = 0;

        for (const row of rows) {
            const commandName = row.get('Canais específicos'); //
            const id = row.get('ID_Canal'); //
            const tipo = row.get('Tipo_Canal'); //

            // Adiciona ao cache apenas se a regra estiver completa
            if (commandName && id && tipo) {
                channelRulesCache.set(commandName.trim().toLowerCase(), { 
                    id: id.trim(), 
                    tipo: tipo.trim().toLowerCase() 
                });
                count++;
            }
        }
        console.log(`[INFO ChannelGuard] ${count} regras de canal carregadas.`);
    } catch (e) {
        console.error("[ERRO ChannelGuard] Falha ao carregar regras de canal:", e);
    }
}

/**
 * Verifica se uma interação de comando está a ser executada no local correto.
 * @param {string} commandName - O nome do comando (ex: "Inventário").
 * @param {import('discord.js').Interaction} interaction - A interação do comando.
 * @returns {boolean} - True se permitido, False se bloqueado.
 */
function checkChannelPermission(commandName, interaction) {
    const rule = channelRulesCache.get(commandName.trim().toLowerCase());

    // Se não há regra para este comando, permite a execução (default allow)
    if (!rule) {
        return true;
    }

    const channel = interaction.channel;
    if (!channel) return false; // Segurança

    let hasPermission = false;

    // Compara o ID e o Tipo
    switch (rule.tipo) {
        case 'text':
            // O ID do canal deve ser exatamente o ID da regra
            hasPermission = (channel.id === rule.id);
            break;
        case 'category':
            // O ID da categoria (parentId) do canal deve ser o ID da regra
            hasPermission = (channel.parentId === rule.id);
            break;
        case 'forum':
            // O ID da categoria (parentId) do post (thread) deve ser o ID do fórum
            hasPermission = (channel.parentId === rule.id);
            break;
        default:
            // Tipo de regra desconhecido, bloqueia por segurança
            console.warn(`[AVISO ChannelGuard] Tipo de regra desconhecido: ${rule.tipo}`);
            hasPermission = false;
    }
    
    return hasPermission;
}

module.exports = {
    loadChannelRules,
    checkChannelPermission
};