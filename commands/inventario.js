// commands/inventario.js
const { 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    StringSelectMenuOptionBuilder, 
    MessageFlagsBitField 
} = require('discord.js');
const { findUserCharacters, getChannelOwner, registerChannel, buildInventoryEmbed, deleteOldMessage } = require('../utils/inventarioUtils.js'); // <<< Adiciona deleteOldMessage
const { checkChannelPermission } = require('../utils/channelGuard.js'); // +++ IMPORTA O GUARD +++

// client.pendingInventarios = new Map(); (Inicializado no index.js)

module.exports = {
    data: new SlashCommandBuilder()
        .setName('inventario')
        .setDescription('Exibe o inventário do seu personagem neste canal.')
        .setDMPermission(false), // Não permitir em DMs

    // Informa ao index.js que este comando gere este select menu
    selects: ['inventario_select_char'],

    async execute(interaction) {

        // === VERIFICAÇÃO DE CANAL ===
        //
        const isAllowed = checkChannelPermission('Inventário', interaction);
        if (!isAllowed) {
            await interaction.reply({
                content: "Este comando só pode ser usado num canal de inventário (post de fórum) designado.",
                flags: [MessageFlagsBitField.Flags.Ephemeral]
            });
            return;
        }
        
        
        // === Defer Update e Apagar Mensagem ===
        await interaction.deferReply({ ephemeral: true });

        try {
            // 1. Verifica se o canal já está registrado
            const channelInfo = await getChannelOwner(interaction.channel.id); // Retorna {owner, characterRow} ou null
            let owner = channelInfo ? channelInfo.owner : null;
            let existingRow = channelInfo ? channelInfo.characterRow : null;

            // Se registrado por OUTRO jogador, bloqueia
            if (owner && owner.trim().toLowerCase() !== interaction.user.username.trim().toLowerCase()) {
                await interaction.editReply({
                    content: `Este canal já está registrado como o inventário de **${owner}**.`,
                    flags: [MessageFlagsBitField.Flags.Ephemeral] // Sintaxe corrigida
                });
                return;
            }
            // Se registrado pelo MESMO jogador, mas a linha não foi encontrada (erro interno?), avisa
            if (owner && owner.trim().toLowerCase() === interaction.user.username.trim().toLowerCase() && !existingRow) {
                 await interaction.editReply({
                    content: `Erro ao encontrar os dados do inventário já registrado neste canal. Contacte um admin.`,
                    flags: [MessageFlagsBitField.Flags.Ephemeral]
                });
                return;
            }

            // 2. Busca os personagens do JOGADOR ATUAL
            const characters = await findUserCharacters(interaction.user.username);

            if (!characters || characters.length === 0) {
                await interaction.editReply({
                    content: "Você não possui nenhum personagem registrado na planilha 'Inventário'.",
                    flags: [MessageFlagsBitField.Flags.Ephemeral] // Sintaxe corrigida
                });
                return;
            }

            // 3. Se tiver só 1 personagem, exibe direto
            if (characters.length === 1) {
                const selectedCharRow = characters[0];
                //await registerChannel(charRow, interaction.channel.id);
                const embed = await buildInventoryEmbed(charRow);
                // Envia a nova mensagem (ou edita a resposta do defer)
                const message = await interaction.editReply({ embeds: [embed] });
                // Registra o canal e ID da mensagem, passando o client
                // A função registerChannel agora lida com apagar a msg antiga se necessário
                // Passa a linha selecionada E a lista completa (neste caso, com 1 item)
                await registerChannel(selectedCharRow, characters, interaction.channel.id, message.id, interaction.client);
                return;
            }

            // 4. Se tiver múltiplos, mostra o Select Menu
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`inventario_select_char|${interaction.id}`)
                .setPlaceholder('Selecione o personagem...');

            characters.slice(0, 25).forEach((charRow, index) => {
                const charName = charRow.get('PERSONAGEM') || 'Personagem Sem Nome';
                const primSec = charRow.get('Prim/Sec/Terc') || '?';
                
                // === CORREÇÃO ESTÁ AQUI ===
                // Usamos APENAS o rowIndex. Ele é 100% único para cada linha.
                const uniqueValue = String(index);
                
                selectMenu.addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel(charName)
                        .setDescription(`(Prim/Sec: ${primSec})`)
                        .setValue(uniqueValue) // Define o valor único (ex: "0", "1", "2")
                );
            });

            // Guarda o state para o handleSelect
            if (!interaction.client.pendingInventarios) {
                interaction.client.pendingInventarios = new Map();
            }
            interaction.client.pendingInventarios.set(interaction.id, {
                username: interaction.user.username,
                characters: characters // Guarda as linhas encontradas
            });

            await interaction.editReply({
                content: "Você tem múltiplos personagens. Qual inventário deseja exibir neste canal?",
                components: [new ActionRowBuilder().addComponents(selectMenu)],
                flags: [MessageFlagsBitField.Flags.Ephemeral] // Sintaxe corrigida
            });
        } catch (e) {
            console.error("[ERRO /inventario execute]", e);
             const replyPayload = { content: `Erro ao executar o comando: ${e.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] };
             if (interaction.deferred || interaction.replied) {
                await interaction.editReply(replyPayload).catch(console.error);
             } else {
                await interaction.reply(replyPayload).catch(console.error);
             }
        }
    },

    async handleSelect(interaction) {
        const [action, originalInteractionId] = interaction.customId.split('|');
        if (action !== 'inventario_select_char') return;
        
        try {
            const state = interaction.client.pendingInventarios.get(originalInteractionId);
            if (!state || state.username.trim().toLowerCase() !== interaction.user.username.trim().toLowerCase()) {
                await interaction.reply({ content: "Esta seleção expirou ou não pertence a você.", flags: [MessageFlagsBitField.Flags.Ephemeral] });
                return;
            }

            // O valor é o ÍNDICE DO ARRAY (em string) que definimos
            const selectedIndex = parseInt(interaction.values[0]); // ex: "1" -> 1
            
            // Encontra a linha correspondente no state usando o ÍNDICE
            // Pega o objeto row do personagem selecionado
            const selectedCharRow = state.characters[selectedIndex];

            if (!selectedCharRow) {
                await interaction.reply({ content: "Erro: Não foi possível encontrar o personagem selecionado.", flags: [MessageFlagsBitField.Flags.Ephemeral] });
                return;
            }

            // Defer PÚBLICO
            await interaction.deferReply({ ephemeral: false }); // <-- 1. Cria a msg "A pensar..."

            const embed = await buildInventoryEmbed(selectedCharRow);
            
            // === Editar a Resposta ===
            // 3. EDITA a msg "A pensar..." e coloca o embed nela.
            const message = await interaction.editReply({ embeds: [embed] }); // <<< CORRIGIDO

            // Passa a linha selecionada E a lista completa de personagens do jogador (state.characters)
            await registerChannel(selectedCharRow, state.characters, interaction.channel.id, message.id, interaction.client);

            interaction.client.pendingInventarios.delete(originalInteractionId);
            
            //await interaction.followUp({ content: "Inventário exibido!", flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(()=>{});

        } catch (e) {
            console.error("[ERRO /inventario handleSelect]", e);
             const replyPayload = { content: `Erro ao processar seleção: ${e.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] };
             if (interaction.deferred || interaction.replied) {
                await interaction.followUp(replyPayload).catch(()=>{});
             } else {
                await interaction.reply(replyPayload).catch(()=>{});
             }
        }
    }
};