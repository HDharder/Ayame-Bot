// commands/staff.js
const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlagsBitField } = require('discord.js');
const { checkAuth, AuthLevels } = require('../utils/auth.js'); //
const { 
    fetchServerStats, 
    fetchCaravanStatus, 
    processCaravanDistribution 
} = require('../utils/staffUtils.js'); //

module.exports = {
    data: new SlashCommandBuilder()
        .setName('staff')
        .setDescription('Exibe o painel de controlo de staff com estatísticas e gestão.'),

    buttons: ['staff_distribute_caravan'], // O ID do nosso botão

    async execute(interaction) {
        // 1. Verificação de Permissão (APENAS Staff)
        const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF] }); //
        if (!hasAuth) {
            return; // checkAuth já enviou a resposta de erro
        }

        // Defer público (como pedido)
        await interaction.deferReply({ ephemeral: false });

        try {
            // 2. Busca os dados (em paralelo)
            const [stats, caravan] = await Promise.all([
                fetchServerStats(), //
                fetchCaravanStatus()  //
            ]);

            // 3. Monta o Embed
            const embed = new EmbedBuilder()
                .setTitle('Painel de Controlo do Staff')
                .setColor(0xAA0000) // Vermelho escuro
                .setTimestamp()
                .addFields(
                    { name: 'Jogadores Ativos', value: String(stats.playerCount), inline: true },
                    { name: 'Personagens Registrados', value: String(stats.characterCount), inline: true },
                    { name: 'Nível Mais Alto', value: String(stats.maxLevel), inline: true },
                    { name: 'Mesas (Contagem Semanal)', value: String(stats.tablesThisWeek), inline: true },
                    { name: '---', value: '---', inline: false },
                    { name: 'Caravana Bastião', value: caravan.text, inline: false }
                );

            // 4. Prepara o Botão (se aplicável)
            const components = [];
            if (caravan.status === 'READY') {
                const row = new ActionRowBuilder()
                    .addComponents(
                        new ButtonBuilder()
                            .setCustomId('staff_distribute_caravan')
                            .setLabel('Distribuir Itens da Caravana')
                            .setStyle(ButtonStyle.Success)
                    );
                components.push(row);
            }

            // 5. Responde
            await interaction.editReply({ embeds: [embed], components: components });

        } catch (error) {
            console.error("[ERRO /staff execute]:", error);
            await interaction.editReply({ content: 'Ocorreu um erro ao buscar os dados do painel.' });
        }
    },

    async handleButton(interaction) {
        const [action] = interaction.customId.split('|');
        if (action !== 'staff_distribute_caravan') return;

        // 1. Verificação de Permissão (Redundante, mas seguro)
        const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF] }); //
        if (!hasAuth) {
            return;
        }
        
        // 2. Desabilita o botão para evitar clique duplo
        await interaction.update({ 
            content: 'Processando entrega da caravana... ⏳', 
            embeds: interaction.message.embeds, // Mantém o embed original
            components: [] // Remove o botão
        });

        // 3. Executa a lógica pesada
        const result = await processCaravanDistribution(interaction.client); //

        // 4. Envia o resultado como um follow-up
        if (result.success) {
            await interaction.followUp({ content: result.message, ephemeral: false });
        } else {
            await interaction.followUp({ content: `**Falha na Distribuição:** ${result.message}`, ephemeral: false });
        }
    }
};