// commands/gasto.js
const { SlashCommandBuilder, EmbedBuilder, MessageFlagsBitField, userMention } = require('discord.js');

// Importa as funções de utilitários que vamos usar
const { getChannelOwner } = require('../utils/inventarioUtils.js'); //
const { parseItemInput } = require('../utils/itemUtils.js'); //
const { getItemCategory, parseInventoryString } = require('../utils/itemUtils.js'); //
const { batchRemoveInventories } = require('../utils/inventoryManager.js'); //
const { checkChannelPermission } = require('../utils/channelGuard.js'); //
const { docInventario, docCraft, getValuesFromSheet, setValuesInSheet } = require('../utils/google.js'); //

// Pega o ID do canal de log (o mesmo usado pelo /loot e /relatorio)
//const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; //

module.exports = {
    data: new SlashCommandBuilder()
        .setName('gasto')
        .setDescription('Registra um gasto (ouro ou itens) do seu personagem neste canal.')
        .addStringOption(option =>
            option.setName('observacao')
                .setDescription('Obrigatório: Explique o motivo do gasto (ex: "Compra na loja", "Craft").')
                .setRequired(true)
        )
        .addStringOption(option =>
            option.setName('ouro')
                .setDescription('Opcional: A quantidade de ouro a ser removida (ex: 150.5).')
                .setRequired(false)
        )
        .addStringOption(option =>
            option.setName('itens')
                .setDescription('Opcional: Os itens a serem removidos (ex: "1x Poção, 2x Adaga").')
                .setRequired(false)
        ),

    async execute(interaction) {
        
        // 1. VERIFICAÇÃO INICIAL DE CANAL (Channel Guard)
        // Reutiliza a mesma regra do /inventario para garantir que só funcione lá
        const isAllowedInChannel = checkChannelPermission('Inventário', interaction); //
        if (!isAllowedInChannel) {
            await interaction.reply({
                content: "Este comando só pode ser usado num canal de inventário (post de fórum) designado.",
                flags: [MessageFlagsBitField.Flags.Ephemeral]
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            // 2. VERIFICAÇÃO DE DONO DO CANAL
            const channelInfo = await getChannelOwner(interaction.channel.id); //
            
            if (!channelInfo || !channelInfo.owner || !channelInfo.characterRow) {
                await interaction.editReply({
                    content: 'Este canal não está registrado para nenhum inventário. Use `/inventario` primeiro.'
                });
                return;
            }

            if (channelInfo.owner.trim().toLowerCase() !== interaction.user.username.trim().toLowerCase()) {
                await interaction.editReply({
                    content: `Este inventário pertence a **${channelInfo.owner}**. Apenas o dono pode registrar gastos.`
                });
                return;
            }

            // 3. PROCESSAMENTO DOS INPUTS
            const characterRow = channelInfo.characterRow;
            const goldString = interaction.options.getString('ouro');
            const itemsString = interaction.options.getString('itens');
            const observacao = interaction.options.getString('observacao');

            // Validação de preenchimento
            if (!goldString && !itemsString) {
                await interaction.editReply({
                    content: "Erro: Você deve preencher pelo menos um dos campos: `ouro` ou `itens`."
                });
                return;
            }

            // Parse dos inputs
            const requestedGoldAmount = parseFloat(goldString?.replace(',', '.')) || 0;
            // Usamos parseItemInput (true = isMisc, não precisamos validar)
            const requestedItemsToRemove = itemsString ? parseItemInput(itemsString, true) : [];

            if (requestedGoldAmount < 0) {
                 await interaction.editReply({ content: "Erro: O valor do ouro não pode ser negativo." });
                 return;
            }

            // 4. PRÉ-VALIDAÇÃO (Verifica se o jogador tem os recursos)
            const username = characterRow.get('JOGADOR');
            const characterName = characterRow.get('PERSONAGEM');

            let validGoldAmount = 0;
            const validItemsToRemove = [];
            const errorMessages = [];

            // 4a. Validar Ouro
            const currentGold = parseFloat(characterRow.get('Total')) || 0;
            if (requestedGoldAmount > 0) {
                if (currentGold >= requestedGoldAmount) {
                    validGoldAmount = requestedGoldAmount;
                } else {
                    errorMessages.push(`Ouro insuficiente (Possui: ${currentGold.toFixed(2)} PO / Pedido: ${requestedGoldAmount.toFixed(2)} PO).`);
                }
            }

            // 4b. Validar Itens
            if (requestedItemsToRemove.length > 0) {
                // Agrupa os itens do inventário por categoria para checagem
                const inventoryByCategory = new Map();
                
                for (const item of requestedItemsToRemove) {
                    const category = await getItemCategory(item.validationName, docCraft); //
                    if (!inventoryByCategory.has(category)) {
                        // Carrega o inventário da categoria (ex: "Armas") e parseia
                        const currentString = characterRow.get(category) || '';
                        inventoryByCategory.set(category, parseInventoryString(currentString)); //
                    }

                    const inventoryMap = inventoryByCategory.get(category);
                    const itemInInventory = inventoryMap.get(item.name.toLowerCase());
                    const currentAmount = itemInInventory ? itemInInventory.amount : 0;

                    if (currentAmount >= item.amount) {
                        validItemsToRemove.push(item);
                    } else {
                        errorMessages.push(`Item insuficiente (Possui: ${currentAmount}x ${item.name} / Pedido: ${item.amount}x).`);
                    }
                }
            }

            // 5. VERIFICAÇÃO FINAL
            if (validGoldAmount === 0 && validItemsToRemove.length === 0) {
                await interaction.editReply({
                    content: `O comando foi cancelado. Nenhum gasto válido pôde ser processado.\n\n**Erros:**\n• ${errorMessages.join('\n• ')}`
                });
                return;
            }

            // 6. EXECUÇÃO DA REMOÇÃO (Apenas com itens válidos)
            const payload = [{
                username: username,
                characterName: characterName,
                changes: {
                    gold: validGoldAmount,
                    itemsToRemove: validItemsToRemove
                }
            }];

            // Chama a função que criamos
            const success = await batchRemoveInventories(payload, interaction.client); 

            if (!success) {
                await interaction.editReply({
                    content: 'Ocorreu um erro ao salvar as alterações na planilha. Verifique os logs do bot e tente novamente.'
                });
                return;
            }

            // 7. ENVIO DO LOG (Apenas do que foi removido)
            //if (LOG_CHANNEL_ID) {
                try {
                    const logChannel = interaction.channel; // Pega o canal atual (o canal do inventário)
                    
                    const itemsLogString = validItemsToRemove.length > 0
                        ? validItemsToRemove.map(item => `${item.amount}x ${item.name}`).join(', ')
                        : 'Nenhum';

                    const logEmbed = new EmbedBuilder()
                        .setTitle('Registro de Gasto')
                        .setColor(0xFFA500) // Laranja
                        .addFields(
                            { name: 'Jogador', value: userMention(interaction.user.id), inline: true },
                            { name: 'Personagem', value: characterName, inline: true },
                            { name: 'Canal', value: interaction.channel.toString(), inline: true },
                            { name: 'Ouro Removido', value: `${validGoldAmount.toFixed(2)} PO`, inline: true },
                            { name: 'Itens Removidos', value: `\`\`\`${itemsLogString}\`\`\`` },
                            { name: 'Observação (Motivo)', value: `\`\`\`${observacao}\`\`\`` }
                        )
                        .setTimestamp();
                    
                    if (logChannel && logChannel.isTextBased()) {
                        // +++ INÍCIO DA MODIFICAÇÃO (Salvar ID do Log) +++
                        const logMessage = await logChannel.send({ embeds: [logEmbed] });
                        const newLogId = logMessage.id;

                        // 2. Pega a planilha e o critério (já temos 'characterRow')
                        
                        const criteria = { 'JOGADOR': username, 'PERSONAGEM': characterName };

                        // +++ CORREÇÃO: Pega a planilha 'Inventário' diretamente +++
                        await docInventario.loadInfo(); //
                        const sheet = docInventario.sheetsByTitle['Inventário']; //
                        if (!sheet) throw new Error("Aba 'Inventário' não encontrada ao tentar salvar o log de gasto.");

                        // 3. Pega a string atual da coluna "Gastos"
                        const currentGastosResult = await getValuesFromSheet(sheet, criteria, ['Gastos']); //
                        let currentGastosString = '';
                        if (currentGastosResult.length > 0 && currentGastosResult[0]['Gastos']) {
                            currentGastosString = String(currentGastosResult[0]['Gastos']);
                        }

                        // 4. Acrescenta o novo ID
                        const newGastosString = currentGastosString.trim() === ''
                            ? newLogId
                            : `${currentGastosString},${newLogId}`;

                        // 5. Salva a string atualizada na planilha
                        await setValuesInSheet(sheet, criteria, { 'Gastos': newGastosString }); //
                        console.log(`[INFO /gasto] ID de log ${newLogId} salvo na planilha para ${characterName}.`);
                        // +++ FIM DA MODIFICAÇÃO +++
                    }
                } catch (logError) {
                    console.error("[ERRO /gasto] Falha ao enviar log OU salvar ID do log:", logError);
                }
            //}

            // 8. RESPOSTA FINAL
            let finalMessage = 'Gasto registrado com sucesso! Seu inventário no canal foi atualizado.';
            if (errorMessages.length > 0) {
                finalMessage += `\n\n**Avisos (itens/ouro não removidos):**\n• ${errorMessages.join('\n• ')}`;
            }
            await interaction.editReply({
                content: finalMessage
            });

        } catch (error) {
            console.error("[ERRO /gasto execute]:", error);
            await interaction.editReply({ content: 'Ocorreu um erro inesperado ao processar seu gasto.' });
        }
    }
};