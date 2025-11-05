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
            //.setDescription(`*Publicado em: ${latestUpdate.date}*`)
            .setTimestamp();

        // Adiciona campos para cada secção
        let description = `*Publicado em: ${latestUpdate.date}*\n`;
        if (latestUpdate.features.length > 0) {
            description += '\n**✨ Novas Features**\n' + '• ' + latestUpdate.features.join('\n• ');
        }
        if (latestUpdate.fixes.length > 0) {
            description += '\n\n**🐛 Correções de Bugs**\n' + '• ' + latestUpdate.fixes.join('\n• ');
        }
        if (latestUpdate.backend.length > 0) {
            description += '\n\n**⚙️ Backend/Outros**\n' + '• ' + latestUpdate.backend.join('\n• ');
        }

        // Trunca a descrição se ela (por algum motivo) ultrapassar o limite
        if (description.length > 4096) {
            description = description.substring(0, 4093) + '...';
        }
        embed.setDescription(description);
        // +++ FIM DA CORREÇÃO +++

        await interaction.reply({ embeds: [embed] });
    }
};