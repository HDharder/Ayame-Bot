const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
// Importa o ficheiro JSON diretamente!
const changelog = require('../changelog.json');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('updates')
        .setDescription('Mostra as últimas atualizações do bot.'),
        
    async execute(interaction) {
        // Pega a atualização MAIS RECENTE (o primeiro item do array)
        const latestUpdate = changelog.updates[0];

        const embed = new EmbedBuilder()
            .setTitle(`🎉 Atualização v${latestUpdate.version}: ${latestUpdate.title}`)
            .setColor(0x5865F2)
            .setDescription(`*Publicado em: ${latestUpdate.date}*`)
            .setTimestamp();

        // Adiciona campos para cada secção
        if (latestUpdate.features.length > 0) {
            embed.addFields({ 
                name: '✨ Novas Features', 
                value: '• ' + latestUpdate.features.join('\n• ') 
            });
        }
        if (latestUpdate.fixes.length > 0) {
            embed.addFields({ 
                name: '🐛 Correções de Bugs', 
                value: '• ' + latestUpdate.fixes.join('\n• ') 
            });
        }
        if (latestUpdate.backend.length > 0) {
            embed.addFields({ 
                name: '⚙️ Backend/Outros', 
                value: '• ' + latestUpdate.backend.join('\n• ') 
            });
        }

        await interaction.reply({ embeds: [embed] });
    }
};