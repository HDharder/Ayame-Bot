const { MessageFlagsBitField } = require('discord.js');

// Puxa os IDs do .env
const NARRADOR_ROLES = (process.env.ROLE_ID_NARRADOR || '').split(','); // Permite múltiplos IDs separados por vírgula
const STAFF_ROLES = (process.env.ROLE_ID_STAFF || '').split(',');       // Permite múltiplos IDs

// Cria um "enum" (objeto) para facilitar a chamada
const AuthLevels = {
    PLAYER: 'PLAYER',       // (Ainda não usado, mas bom ter)
    NARRADOR: 'NARRADOR',
    STAFF: 'STAFF',
    // (Você pode adicionar mais níveis aqui, ex: ADMIN)
};

/**
 * Verifica se um usuário tem a permissão necessária para executar uma interação.
 * Se não tiver, responde automaticamente à interação com uma mensagem de erro.
 *
 * @param {import('discord.js').Interaction} interaction A interação a ser verificada.
 * @param {object} criteria Os critérios de permissão.
 * @param {string[]} [criteria.allowedLevels] - Níveis de permissão (ex: [AuthLevels.NARRADOR, AuthLevels.STAFF]).
 * @param {string[]} [criteria.allowedUsers] - Array de IDs de usuários permitidos (ex: [state.mestreId]).
 * @returns {Promise<boolean>} - True se o usuário tiver permissão, False caso contrário.
 */
async function checkAuth(interaction, criteria = {}) {
    const { allowedLevels = [], allowedUsers = [] } = criteria;
    const member = interaction.member;
    const user = interaction.user;

    // 1. Verifica se é um usuário específico permitido (ex: o mestre do /loot)
    if (allowedUsers.length > 0 && allowedUsers.includes(user.id)) {
        return true; // É o usuário dono da interação
    }

    // 2. Verifica se o usuário tem os cargos de nível
    if (allowedLevels.length > 0) {
        if (!member || !member.roles) {
             // Fallback para interações DM ou usuário sem 'member' (raro)
             await replyNoAuth(interaction, "Não foi possível verificar seus cargos.");
             return false;
        }

        // Verifica se o usuário tem *qualquer* um dos cargos permitidos
        const hasPermission = member.roles.cache.some(role => {
            if (allowedLevels.includes(AuthLevels.NARRADOR) && NARRADOR_ROLES.includes(role.id)) {
                return true;
            }
            if (allowedLevels.includes(AuthLevels.STAFF) && STAFF_ROLES.includes(role.id)) {
                return true;
            }
            return false;
        });

        if (hasPermission) {
            return true;
        }
    }
    
    // 3. Se nenhuma verificação passou, ele não tem permissão
    const levelNames = allowedLevels.join(' ou ');
    await replyNoAuth(interaction, `Você precisa ser ${levelNames} para usar esta função.`);
    return false;
}

/**
 * Responde a uma interação com uma mensagem de "Sem Permissão" padronizada.
 */
async function replyNoAuth(interaction, message) {
    const replyContent = {
        content: message || 'Você não tem permissão para fazer isso.',
        flags: [MessageFlagsBitField.Flags.Ephemeral]
    };

    try {
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp(replyContent);
        } else {
            await interaction.reply(replyContent);
        }
    } catch (e) {
        console.error("Erro ao enviar resposta de 'Sem Permissão':", e);
    }
}

// Exporta a função principal e o "enum"
module.exports = {
    checkAuth,
    AuthLevels
};