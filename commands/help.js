const { SlashCommandBuilder, EmbedBuilder, MessageFlagsBitField } = require('discord.js');
const { checkChannelPermission } = require('../utils/channelGuard.js'); // Importa o Channel Guard
const helpData = require('../help.json'); // Importa o novo JSON

// Cria um array com os nomes dos comandos para o autocomplete
const commandNames = Object.keys(helpData).map(key => ({
    name: helpData[key].name, // Ex: "/loot"
    value: key // Ex: "loot"
}));

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Mostra informações de ajuda sobre os comandos do bot.')
        .addStringOption(option =>
            option.setName('comando')
                .setDescription('Comando sobre o qual deseja ajuda (ex: loot).')
                .setRequired(false)
                .setAutocomplete(true) // Ativa o autocomplete
        ),
    
    // Informa ao index.js que este comando tem um autocomplete
    autocomplete: ['help'], // O nome da interação (baseado no nome do comando)

    // --- AUTOCOMPLETE HANDLER ---
    async handleAutocomplete(interaction) {
        try {
            const focusedValue = interaction.options.getFocused().toLowerCase();
            
            // Filtra os comandos
            const filtered = commandNames.filter(choice => 
                choice.name.toLowerCase().startsWith(focusedValue) || // Filtra por "/loot"
                choice.value.toLowerCase().startsWith(focusedValue)  // Filtra por "loot"
            ).slice(0, 25); // Limita a 25 opções

            await interaction.respond(
                filtered.map(choice => ({
                    name: choice.name, // Mostra "/loot"
                    value: choice.value // Retorna "loot"
                }))
            );
        } catch (error) {
            console.error("[ERRO Autocomplete /help]:", error);
            await interaction.respond([]).catch(() => {});
        }
    },

    // --- EXECUTE HANDLER ---
    async execute(interaction) {
        
        // === VERIFICAÇÃO DE CANAL ===
        // Verifica se o comando "Ajuda" está permitido neste canal
        /*const isAllowed = checkChannelPermission("Ajuda", interaction);
        if (!isAllowed) {
            await interaction.reply({
                content: "Este comando só pode ser usado no canal de ajuda designado.",
                flags: [MessageFlagsBitField.Flags.Ephemeral]
            });
            return;
        }*/

        // Responde de forma efêmera (apenas o usuário vê)
        await interaction.deferReply({ flags: [MessageFlagsBitField.Flags.Ephemeral] });

        try {
            const commandName = interaction.options.getString('comando'); // Ex: "loot"

            // CASO 1: Nenhum comando específico foi pedido
            if (!commandName) {
                const helpEmbed = new EmbedBuilder()
                    .setTitle('ℹ️ Ajuda do Bot Ayame')
                    .setDescription('Aqui está uma lista de todos os comandos disponíveis. Para mais detalhes, use `/help [comando]`.')
                    .setColor(0x5865F2); // Azul Discord

                for (const key in helpData) {
                    const cmd = helpData[key];
                    helpEmbed.addFields({
                        name: cmd.name,
                        value: cmd.description,
                        inline: true
                    });
                }
                // Garante que não ultrapassa 25 campos
                helpEmbed.setFields(helpEmbed.data.fields.slice(0, 25));

                await interaction.editReply({ embeds: [helpEmbed] });
                return;
            }

            // CASO 2: Um comando específico foi pedido
            const cmdInfo = helpData[commandName.toLowerCase()];

            if (!cmdInfo) {
                await interaction.editReply({ content: `Comando \`${commandName}\` não encontrado. Use \`/help\` para ver todos os comandos.` });
                return;
            }

            const detailEmbed = new EmbedBuilder()
                .setTitle(`Ajuda para: ${cmdInfo.name}`)
                .setColor(0xDAA520) // Dourado
                .addFields(
                    { name: 'Descrição', value: cmdInfo.description },
                    { name: 'Permissões', value: cmdInfo.permissions },
                    { name: 'Como Usar', value: cmdInfo.usage }
                );

            await interaction.editReply({ embeds: [detailEmbed] });

        } catch (error) {
            console.error("[ERRO /help execute]:", error);
            await interaction.editReply({ content: 'Ocorreu um erro ao buscar as informações de ajuda.' });
        }
    }
};