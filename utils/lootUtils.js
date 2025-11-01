// utils/lootUtils.js
const {
  userMention,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlagsBitField
} = require('discord.js');

const { 
    docControle, 
    docSorteio, 
    lookupIds, 
    getPlayerTokenCount, 
    spendPlayerTokens, 
    incrementarContagem, 
    incrementarMesasMestradas 
} = require('./google.js'); 

const { batchUpdateInventories } = require('./inventoryManager.js');
const { getPlayerLevels, calculateGold } = require('./lootLogic.js');

// ID do canal de log
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

/**
 * Busca mesas elegíveis para loot para um narrador específico.
 */
async function findEligibleTables(username, docControle) {
  await docControle.loadInfo(); 
  const sheetHistorico = docControle.sheetsByTitle['Historico'];
  if (!sheetHistorico) {
    throw new Error("Aba 'Historico' não encontrada na planilha de Controle.");
  }
  await sheetHistorico.loadHeaderRow(1); 
  const rows = await sheetHistorico.getRows(); 

  return rows.filter(row =>
    row.get('Narrador') === username &&
    row.get('Registrar Mesa') === 'Sim' &&
    row.get('Mesa Finalizada') === 'Não'
  );
}

/**
 * Formata a lista de jogadores para exibição.
 */
function formatPlayerList(players, includeItems = false, includeLevel = false) {
  if (!players || !Array.isArray(players) || players.length === 0) {
    return 'Nenhum jogador encontrado.';
  }
  return players.map(p => {
    if (!p || typeof p !== 'object') return 'Jogador inválido';
    let playerLine = '';
    const mentionOrTag = p.id ? userMention(p.id) : p.tag || 'Tag Desconhecida';
    const characterName = p.char || 'Personagem Desconhecido';
    playerLine += `${mentionOrTag} - ${characterName}`; 
    if (includeLevel) {
        const levelText = (typeof p.level === 'number' && !isNaN(p.level)) ? p.level : '?';
        playerLine += ` (Nível ${levelText})`;
    }
    if (p.doubleActive) {
        playerLine += " (Dobro Ativado)";
    }
    if (includeItems && p.items && Array.isArray(p.items) && p.items.length > 0) {
      const itemText = p.items
         .filter(item => item && item.name && typeof item.amount === 'number' && item.amount > 0)
         .map(i => `${i.amount}x ${i.name}${i.isPredefined ? '*' : ''}`) // <<< MOSTRA O *
         .join(', ');
      if (itemText) {
          playerLine += " - " + itemText;
      }
    }
    return playerLine;
  }).join('\n'); 
}

/**
 * Formata a lista de drops disponíveis.
 * AGORA MOSTRA O *
 */
function formatDropsList(allDrops) {
  if (!allDrops || !Array.isArray(allDrops) || allDrops.length === 0) {
    return "Nenhum"; 
  }
  const validDrops = allDrops.filter(d => d && d.name && typeof d.amount === 'number' && d.amount > 0);
  if (validDrops.length === 0) {
      return "Nenhum";
  }
  return "```\n" + validDrops.map(d => `${d.amount}x ${d.name}${d.isPredefined ? '*' : ''}`).join('\n') + "\n```"; // <<< MOSTRA O *
}

/**
 * Constrói o conteúdo completo da mensagem principal de loot.
 */
function buildLootMessageContent(state, playersString, dropsString) {
  const safeState = {
      options: { nomeMesa: '', ...(state?.options || {}) },
      mestreId: state?.mestreId || 'ID Desconhecido',
      goldFinalPerPlayer: state?.goldFinalPerPlayer || 0,
      criterio: state?.criterio || 'Critério indisponível',
      goldBastiãoTotal: state?.goldBastiãoTotal || 0,
  };

  const nomeMesaFormatado = safeState.options.nomeMesa ? `**${safeState.options.nomeMesa}**\n` : '';
  const mestreMention = userMention(safeState.mestreId);
  const safePlayersString = playersString || 'Nenhum jogador.';
  const safeDropsString = dropsString || 'Nenhum';

  const messageLines = [
    nomeMesaFormatado,
    `**Mestre:** ${mestreMention}`,
    `**Players:**\n${safePlayersString}\n`,
    `**Itens Dropados:**`,
    safeDropsString
  ];

  if (!safeState.options.naoRolarLoot) {
      messageLines.splice(3, 0,
          `**Loot:** ${safeState.goldFinalPerPlayer} PO || ${safeState.criterio} ||`,
          `**Bastião:** ${safeState.goldBastiãoTotal} PO\n`
      );
  } else {
      messageLines.splice(3, 0, `*(Rolagem de Gold Ignorada)*\n`);
  }
  return messageLines.join('\n');
}

/**
 * Lida com o clique no botão 'Calcular Loot'.
 * AGORA USA 'nao_rolar_loot_com_vantagem'
 */
async function handleLootCalculation(interaction, state, originalInteractionId) { 
    await docControle.loadInfo();
    const sheetHistorico = docControle.sheetsByTitle['Historico'];
    if (!sheetHistorico) throw new Error("Aba 'Historico' não encontrada.");
    await sheetHistorico.loadHeaderRow(1);
    const rows = await sheetHistorico.getRows();
    const rowIndexInArray = rows.findIndex(r => r.get('ID da Mensagem') === state.selectedMessageId);
    if (rowIndexInArray === -1) { throw new Error('Linha da mesa não encontrada no Histórico.'); }
    const mesaRow = rows[rowIndexInArray];
    state.mesaSheetRowIndex = rowIndexInArray + 2; 
    state.dataMesa = mesaRow.get('Data') || '??/??/??';
    state.horarioMesa = mesaRow.get('Horário') || '??:??';
    const tierString = mesaRow.get('Tier') || '';

    const players = await getPlayerLevels(mesaRow, sheetHistorico.headerValues);

    const playerTags = players.map(p => p.tag);
    const playerIds = await lookupIds(playerTags);
    const tagToIdMap = new Map();
    playerTags.forEach((tag, index) => { tagToIdMap.set(tag.toLowerCase(), playerIds[index] ? String(playerIds[index]) : null); });

    state.players = players.map(p => ({
      tag: p.tag, char: p.char, level: p.level, id: tagToIdMap.get(p.tag.toLowerCase()),
      items: [], colIndex: p.originalColIndex, activeMessageId: null, doubleActive: false, extraGold: 0 // Adiciona extraGold
    }));

    let goldPerPlayer = 0;
    let criterio = "Rolagem de gold ignorada.";
    let goldBastiãoTotal = 0;
    let goldFinalPerPlayer = 0;

    if (!state.options.naoRolarLoot) {
        // <<< CORRIGIDO: Usa 'nao_rolar_loot_com_vantagem' >>>
        const hasAdvantage = !state.options.nao_rolar_loot_com_vantagem; 
        
        const goldResult = calculateGold(players, tierString, hasAdvantage); // Passa 'hasAdvantage'
        goldPerPlayer = goldResult.goldPerPlayer; 
        criterio = goldResult.criterio; 

        const numPlayers = state.players.length;
        goldBastiãoTotal = (goldPerPlayer * 0.20) * numPlayers; 
        goldFinalPerPlayer = goldPerPlayer * 0.80; 
    }

    state.goldFinalPerPlayer = !isNaN(goldFinalPerPlayer) ? parseFloat(goldFinalPerPlayer.toFixed(2)) : 0;
    state.goldBastiãoTotal = !isNaN(goldBastiãoTotal) ? parseFloat(goldBastiãoTotal.toFixed(2)) : 0;
    state.criterio = criterio || "Erro no critério";

    // Combina todos os drops (incluindo Misc)
    state.allDrops = [
        ...(state.drops.mundanos||[]), 
        ...(state.drops.itens||[]), 
        ...(state.drops.materiais||[]), 
        ...(state.drops.ervas||[]), 
        ...(state.drops.pocoes||[]),
        ...(state.drops.misc||[]), // <<< ADICIONADO
        ...(state.drops.gold_extra||[])
    ];
    
    const playersString = formatPlayerList(state.players, false, true); 
    const dropsString = formatDropsList(state.allDrops);
    const lootMessageContent = buildLootMessageContent(state, playersString, dropsString);

    const originalMessage = interaction.message;
    if (!originalMessage) {
        console.warn("[AVISO handleLootCalculation] Mensagem original não encontrada na interação. Usando followUp.");
        await interaction.followUp({ content: 'Loot calculado! Mensagem de loot criada abaixo.', components: [], flags: [MessageFlagsBitField.Flags.Ephemeral] }); 
    } else {
        await originalMessage.edit({ content: 'Loot calculado! Mensagem de loot criada abaixo.', components: [] });
    }

    const lootMessage = await interaction.channel.send({ content: lootMessageContent, components: [] });

    state.lootMessageId = lootMessage.id;
    interaction.client.pendingLoots.set(lootMessage.id, state); 
    interaction.client.pendingLoots.delete(originalInteractionId); 

    const lootButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pegar_loot|${lootMessage.id}`).setLabel('Pegar Loot').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`encerrar_mesa|${lootMessage.id}`).setLabel('Encerrar Mesa').setStyle(ButtonStyle.Danger)
    );
    await lootMessage.edit({ components: [lootButtons] });
}

/**
 * Lida com o clique no botão 'Pegar Loot'.
 * AGORA MOSTRA O *
 */
async function handlePegarLootClick(interaction, state, lootMessageId) {
    const player = state.players.find(p => p.id === interaction.user.id);
    if (!player) {
        await interaction.reply({ content: 'Você não faz parte desta mesa.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
        return;
    }
    if (player.activeMessageId) {
        try {
            await interaction.channel.messages.fetch(player.activeMessageId);
            console.log(`[AVISO Pegar Loot] Jogador ${player.tag} já possui msg ativa (${player.activeMessageId}).`);
            await interaction.reply({ content: 'Você já tem uma seleção de loot ativa. Finalize ou devolva os itens da seleção anterior.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
            return;
        } catch (error) {
            if (error.code === 10008) {
                console.log(`[INFO Pegar Loot] Msg ativa anterior (${player.activeMessageId}) não encontrada... Limpando ID.`);
                player.activeMessageId = null; 
            } else {
                console.error(`[ERRO Pegar Loot] Erro ao verificar msg ativa ${player.activeMessageId}:`, error);
                await interaction.reply({ content: 'Erro ao verificar seleção anterior...', flags: [MessageFlagsBitField.Flags.Ephemeral] });
                return;
            }
        }
    }

    const currentTokens = await getPlayerTokenCount(player.tag);
    const canAffordDouble = currentTokens >= 4; // <<< NOTA: A lógica do custo (4) está aqui

    // Se não há drops E não há gold, não faz nada
    if ((!state.allDrops || state.allDrops.length === 0) && state.options.naoRolarLoot) {
        await interaction.reply({ content: "Não há itens nem gold para pegar nesta mesa.", flags: [MessageFlagsBitField.Flags.Ephemeral] });
        return;
    }

    // Se não há drops, mas HÁ gold
    if (!state.allDrops || state.allDrops.length === 0) {
        const doubleButton = new ButtonBuilder()
            .setCustomId(`toggle_double_gold|${lootMessageId}|${player.id}`)
            .setLabel(`Ativar Dobro (4 de ${currentTokens} 🎟️)`)
            .setStyle(ButtonStyle.Primary) 
            .setDisabled(!canAffordDouble || state.options.naoRolarLoot); // Desabilita se não pode pagar OU se não há loot
        const finalizeButton = new ButtonBuilder()
            .setCustomId(`finalizar_loot|${lootMessageId}|${player.id}`)
            .setLabel('Confirmar Gold') 
            .setStyle(ButtonStyle.Success);
        await interaction.reply({
            content: `${userMention(player.id)}, você pode ativar o dobro de gold (${state.goldFinalPerPlayer} PO base).`,
            components: [new ActionRowBuilder().addComponents(doubleButton, finalizeButton)],
            allowedMentions: { users: [player.id] }
        });
        const replyMessage = await interaction.fetchReply();
        player.activeMessageId = replyMessage.id;
        return;
    }

    // Se HÁ drops
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`loot_item_select|${lootMessageId}`) 
        .setPlaceholder('Selecione os itens que deseja pegar')
        .setMinValues(0) 
        .setMaxValues(Math.max(1, state.allDrops.map(i => i.amount || 0).reduce((a, b) => a + b, 0)));
    selectMenu.options.length = 0; 

    let optionsAdded = 0;
    for (const item of state.allDrops) {
        if (!item || !item.name || typeof item.amount !== 'number' || item.amount <= 0) continue; 
        const currentAmount = item.amount;
        for(let i = 0; i < currentAmount; i++) {
           if (optionsAdded >= 25) break; 
           // <<< CORRIGIDO: Mostra o * no label >>>
           selectMenu.addOptions( new StringSelectMenuOptionBuilder()
                .setValue(`${item.name}-${i}`) // Valor é o nome completo (sem *)
                .setLabel(`${item.name}${item.isPredefined ? '*' : ''}`) // Label mostra o *
                .setDescription(`(1 de ${currentAmount})`) 
           );
           optionsAdded++;
        }
        if (optionsAdded >= 25) break; 
    }
    if (selectMenu.options.length === 0) {
         console.error("[ERRO Pegar Loot] Nenhum item válido para Select Menu...");
         await interaction.reply({ content: 'Erro interno ao listar itens...', flags: [MessageFlagsBitField.Flags.Ephemeral] });
         return;
    }

    const doubleButton = new ButtonBuilder()
        .setCustomId(`toggle_double_gold|${lootMessageId}|${player.id}`)
        .setLabel(`Ativar Dobro (4 de ${currentTokens} 🎟️)`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAffordDouble || state.options.naoRolarLoot); // Desabilita se não pode pagar OU se não há loot
    const finalizeButton = new ButtonBuilder()
        .setCustomId(`finalizar_loot|${lootMessageId}|${player.id}`) 
        .setLabel('Finalizar Seleção')
        .setStyle(ButtonStyle.Success);

    await interaction.reply({
        content: `${userMention(player.id)}, selecione os itens que ${player.char} pegou:\n\n**Drops na mesa:**\n${formatDropsList(state.allDrops)}`, // <<< USA formatDropsList
        components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(doubleButton, finalizeButton)],
        allowedMentions: { users: [player.id] } 
    });
    const replyMessage = await interaction.fetchReply();
    player.activeMessageId = replyMessage.id;
}

/**
 * Lida com o clique no botão 'Encerrar Mesa'.
 * AGORA IMPLEMENTA A LÓGICA DE DOBRAR ITENS *.
 */
async function handleEncerrarMesaClick(interaction, state, lootMessageId) {
    let confirmationMessage = 'Mesa encerrada e registrada com sucesso!';
    let tokensSpentSuccessfully = true; 
    let tableCountUpdateSuccess = true; 
    const playersWhoSpentTokens = [];

    // 1. Edita mensagens ativas dos jogadores
    if (state.players && Array.isArray(state.players)) {
        for (const player of state.players) {
            if (player.activeMessageId) { 
                try {
                    const playerMsg = await interaction.channel.messages.fetch(player.activeMessageId);
                    await playerMsg.edit({ components: [] });
                    console.log(`[INFO Encerrar Mesa] Botões removidos da msg ${player.activeMessageId} do player ${player.tag}.`);
                } catch (e) {
                    if (e.code !== 10008) { 
                        console.error(`Erro ao editar msg ${player.activeMessageId} do player ${player.tag} ao encerrar:`, e);
                    }
                }
                player.activeMessageId = null; 
            }
        }
    }

    // 2. Gastar tokens (se o "Double Gold" foi ativado)
    if (state.players && Array.isArray(state.players)) {
        for (const player of state.players) {
            if (player.doubleActive) {
                const success = await spendPlayerTokens(player.tag, 1); // Custo é 1 (para a coluna Double Up)
                if (!success) {
                    console.error(`[ERRO Encerrar Mesa] Falha ao gastar tokens para ${player.tag}.`);
                    tokensSpentSuccessfully = false;
                } else {
                    playersWhoSpentTokens.push(player);
                }
            }
        }
    }
    
    // 3. Adicionar MESA JOGADA extra para quem usou Dobro (Semana ATUAL)
    try {
        await docSorteio.loadInfo(); 
        const sheetPersonagens = docSorteio.sheetsByTitle['Personagens'];
        if (!sheetPersonagens) {
            throw new Error("Aba 'Personagens' não encontrada para buscar offset B1.");
        }
        await sheetPersonagens.loadCells('B1'); // Lê B1
        const cellB1 = sheetPersonagens.getCellByA1('B1');
        const currentWeekOffset = parseInt(cellB1.value);
        if (isNaN(currentWeekOffset)) {
            throw new Error("Valor na célula B1 da aba 'Personagens' não é um número válido para offset.");
        }

        const currentTargetColIndex = 3 + currentWeekOffset; // Col E (idx 4) + offset B1
        console.log(`[DEBUG Encerrar Mesa] Offset B1=${currentWeekOffset}, Índice da coluna alvo para contagem=${currentTargetColIndex}`);

        if (currentTargetColIndex >= 4 && state.players && Array.isArray(state.players)) { 
            for (const player of state.players) {
                if (player.doubleActive) {
                    // Chama incrementarContagem com o 'tipo' (Prim/Sec) do personagem
                    const playerRow = (await sheetPersonagens.getRows()).find(r => 
                        r.get('Nome')?.toLowerCase() === player.tag.toLowerCase() && 
                        r.get('Personagem')?.toLowerCase() === player.char.toLowerCase()
                    );
                    const charType = playerRow ? playerRow.get('Prim/Sec/Terc') : null;

                    if (charType) {
                        console.log(`[INFO Encerrar Mesa - Contagem Extra] Tentando incrementar mesa para ${player.tag} (Tipo ${charType}), coluna ${currentTargetColIndex}`);
                        const incrementSuccess = await incrementarContagem(sheetPersonagens, [player.tag], currentTargetColIndex, charType);
                        if (!incrementSuccess) {
                            console.error(`[ERRO Encerrar Mesa - Contagem Extra] Falha ao incrementar contagem da semana atual para ${player.tag}.`);
                            tableCountUpdateSuccess = false; 
                        }
                    } else {
                         console.warn(`[AVISO Encerrar Mesa - Contagem Extra] Não foi possível encontrar o Tipo (Prim/Sec/Terc) para ${player.tag} - ${player.char}. Pulando incremento extra.`);
                         tableCountUpdateSuccess = false;
                    }
                }
            }
        } else {
             console.warn(`[AVISO Encerrar Mesa - Contagem Extra] Índice da coluna alvo (${currentTargetColIndex}) inválido. Pulando incremento extra.`);
        }
    } catch (countError) {
        console.error("[ERRO Encerrar Mesa - Contagem Extra] Falha crítica ao processar contagem extra:", countError);
        tableCountUpdateSuccess = false; 
    }

    // 4. Atualizar planilha Histórico
    await updateHistoricoSheet(state, docControle);

    // 5. Formatar log
    const playersStringForLog = formatPlayerList(state.players, true, true);

    // 6. Enviar log
    await sendLogMessage(state, interaction.client, playersStringForLog);

    // 7. ATUALIZAR INVENTÁRIOS (com lógica de dobrar)
    let inventoryUpdateOverallSuccess = true;
    if (state.players && Array.isArray(state.players)) {
        console.log(`[INFO Encerrar Mesa] Preparando ${state.players.length} atualizações de inventário em lote...`);
        const allPlayerChanges = []; 

        for (const player of state.players) {
            /*
            // <<< LÓGICA DE DOBRAR ITENS >>>
            let finalGold = state.options.naoRolarLoot ? 0 : state.goldFinalPerPlayer;
            let finalItems = player.items || []; // items já contém { name, validationName, amount, isPredefined }

            if (player.doubleActive) {
                finalGold *= 2; // Dobra o gold
                // Dobra a quantidade APENAS dos itens pré-definidos
                finalItems = finalItems.map(item => {
                    if (item.isPredefined) {
                        return { ...item, amount: item.amount * 2 };
                    }
                    return item; // Retorna o item normal
                });
            }
            // <<< FIM DA LÓGICA DE DOBRAR >>>

            const changes = {
                gold: finalGold + (player.extraGold || 0), // Adiciona gold extra (que é 0 no /loot)
                itemsToAdd: finalItems
            };*/

            // +++ NOVA LÓGICA (combina Gold Extra e Itens Pré-definidos) +++
            let finalGold = state.options.naoRolarLoot ? 0 : state.goldFinalPerPlayer;
            let playerItems = player.items || []; 
            let extraGoldFromItems = 0; 
            const realItemsToAdd = []; 
 
            if (player.doubleActive) {
                finalGold *= 2; 
            }
 
            // Itera sobre os itens que o jogador pegou
            for (const item of playerItems) {
                // Verifica se o item é "XXX PO"
                const goldMatch = item.name.match(/^(\d+(?:[\.,]\d+)?)\s*PO$/);
                let itemAmount = item.amount;
 
                // Dobra a quantidade se for pré-definido E double estiver ativo
                if (player.doubleActive && item.isPredefined) {
                    itemAmount *= 2;
                }
 
                if (goldMatch) {
                    // É um item de gold, soma o valor
                    const goldValue = parseFloat(goldMatch[1].replace(',', '.'));
                    extraGoldFromItems += (goldValue * itemAmount);
                } else {
                    // É um item real, adiciona à lista
                    realItemsToAdd.push({ ...item, amount: itemAmount });
                }
            }
 
            const changes = {
                gold: finalGold + extraGoldFromItems, // Soma o gold base + o gold dos "itens"
                itemsToAdd: realItemsToAdd // Passa apenas os itens reais
            };
            // +++ FIM DA NOVA LÓGICA +++

            if (changes.gold !== 0 || changes.itemsToAdd.length > 0) {
                console.log(`[INFO Encerrar Mesa] Adicionando ao lote: ${player.tag} - ${player.char} (Gold: ${changes.gold.toFixed(2)}, Itens: ${changes.itemsToAdd.length})`);
                allPlayerChanges.push({
                    username: player.tag,
                    characterName: player.char,
                    changes: changes // Passa o objeto 'changes' completo
                });
            }
        }

        if (allPlayerChanges.length > 0) {
            inventoryUpdateOverallSuccess = await batchUpdateInventories(allPlayerChanges, interaction.client);
            if (!inventoryUpdateOverallSuccess) {
                console.error("[ERRO Encerrar Mesa] batchUpdateInventories reportou uma falha parcial ou total.");
                confirmationMessage += `\n\n**Aviso:** Falha ao atualizar um ou mais inventários. Verifique os logs e a planilha manualmente.`;
            }
        }
    }

    // 8. Incrementar Mesas Mestradas
    try {
        const mestreUser = await interaction.client.users.fetch(state.mestreId);
        const mestreUsername = mestreUser.username; 
        if (mestreUsername) {
            await incrementarMesasMestradas(mestreUsername);
        } else {
            console.warn(`[AVISO encerrar_mesa] Não foi possível obter username do mestreId ${state.mestreId}`);
        }
    } catch (e) {
        console.error("[ERRO encerrar_mesa] Falha ao tentar incrementar mesas mestradas:", e);
    }

    // 9. Enviar log de gasto de tokens
    try {
        if (playersWhoSpentTokens.length > 0) {
            await sendTokenReportMessage(state, playersWhoSpentTokens, interaction.client);
        }
    } catch (tokenReportError) {
        console.error("[ERRO Encerrar Mesa] Falha ao enviar log de gasto de tokens:", tokenReportError);
        confirmationMessage += '\n\n**Aviso:** Houve uma falha ao *reportar* o gasto de tokens no canal de report.';
    }

    // 10. Edita a mensagem principal de loot
    if (interaction.message) { 
        try {
            await interaction.message.edit({ content: interaction.message.content + "\n\n**MESA ENCERRADA**", components: [] });
        } catch (e) {
            console.error("Erro ao editar msg de loot principal ao encerrar:", e);
        }
    }

    // 11. Limpa state
    interaction.client.pendingLoots.delete(lootMessageId);

    // 12. Confirmação final
    if (!tokensSpentSuccessfully) {
        confirmationMessage += '\n\n**Aviso:** Houve uma falha ao registrar o gasto de tokens para um ou mais jogadores. Verifique a planilha `Tokens` manualmente.';
    }
    if (!tableCountUpdateSuccess) {
        confirmationMessage += '\n\n**Aviso:** Houve uma falha ao registrar a mesa jogada extra (para Double Gold). Verifique a planilha `Personagens`.';
    }
    await interaction.followUp({ content: confirmationMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] });
}


/** Atualiza a planilha Histórico */
async function updateHistoricoSheet(state, docControle) {
  try {
    await docControle.loadInfo();
    const sheetHistorico = docControle.sheetsByTitle['Historico'];
    if (!sheetHistorico) throw new Error("Aba 'Historico' não encontrada...");
    const sheetRowIndex_1_based = state.mesaSheetRowIndex;
    if (!sheetRowIndex_1_based || typeof sheetRowIndex_1_based !== 'number' || sheetRowIndex_1_based < 2) {
      throw new Error(`Índice da linha inválido: ${sheetRowIndex_1_based}`);
    }
    const rowIndex_0_based = sheetRowIndex_1_based - 1;
    const rangeToLoad = `M${sheetRowIndex_1_based}:T${sheetRowIndex_1_based}`;
    await sheetHistorico.loadCells(rangeToLoad);
    const cellsToUpdate = [];

    // Coluna M: Loot (PO) por Player
    const cellLoot = sheetHistorico.getCell(rowIndex_0_based, 12);
    let goldPerPlayerValue = state.options.naoRolarLoot ? 0 : (state.goldFinalPerPlayer || 0);
    cellLoot.value = !isNaN(goldPerPlayerValue) ? parseFloat(goldPerPlayerValue.toFixed(2)) : 0;
    cellsToUpdate.push(cellLoot);

    // Colunas N a S: Itens dos Jogadores
    for (let i = 0; i < 6; i++) {
      const targetColIndex = 5 + i; 
      const player = state.players.find(p => p.colIndex === targetColIndex);
      const cellItem = sheetHistorico.getCell(rowIndex_0_based, 13 + i); 
      let itemString = '';
      if (player && player.items && Array.isArray(player.items) && player.items.length > 0) {
        itemString = player.items
          .filter(item => item && item.name && typeof item.amount === 'number' && item.amount > 0)
          .map(it => `${it.amount}x ${it.name}${it.isPredefined ? '*' : ''}`) // <<< MOSTRA O *
          .join(', ');
      } 
      if (player && player.doubleActive) {
          itemString = itemString ? `${itemString} (Dobro Ativado)` : '(Dobro Ativado)';
      }
      cellItem.value = itemString;
      cellsToUpdate.push(cellItem);
    }

    // Coluna T: Mesa Finalizada
    const cellFinalizada = sheetHistorico.getCell(rowIndex_0_based, 19);
    cellFinalizada.value = 'Sim';
    cellsToUpdate.push(cellFinalizada);

    await sheetHistorico.saveUpdatedCells(cellsToUpdate);
    console.log(`[INFO updateHistoricoSheet] Planilha atualizada para linha ${sheetRowIndex_1_based}.`);

  } catch (error) {
    console.error("[ERRO updateHistoricoSheet] Falha ao atualizar planilha:", error);
    throw new Error(`Falha ao atualizar a planilha Histórico: ${error.message}`);
  }
}

/** Envia a mensagem final de log */
async function sendLogMessage(state, client, playersStringWithItemsAndDouble) { 
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!logChannel || !logChannel.isTextBased()) { throw new Error(`Canal de log ${LOG_CHANNEL_ID} não encontrado...`); }
    const nomeMesaFormatado = state.options.nomeMesa ? `**${state.options.nomeMesa}**\n` : '';
    const mestreMention = userMention(state.mestreId);
    const safePlayersString = playersStringWithItemsAndDouble || 'Nenhum jogador.';
    const logMessageLines = [ 
      nomeMesaFormatado,
      `**Mestre:** ${mestreMention}`,
      `**Players:**\n${safePlayersString}\n`, 
      `Relatório`,
      `(Área vazia)`
    ];
    if (!state.options.naoRolarLoot) {
        logMessageLines.splice(3, 0,
            `**Loot:** ${state.goldFinalPerPlayer} PO || ${state.criterio} ||`,
            `**Bastião:** ${state.goldBastiãoTotal} PO\n`
        );
    } else {
        logMessageLines.splice(3, 0, `*(Rolagem de Gold Ignorada)*\n`);
    }
    const logMessageContent = logMessageLines.join('\n'); 

    const relatorioButtonInitial = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`escrever_relatorio|${state.mestreId}`).setLabel('Escrever Relatório').setStyle(ButtonStyle.Primary)
    );
    const logMessage = await logChannel.send({ content: logMessageContent, components: [relatorioButtonInitial] });
    const relatorioButtonUpdated = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`escrever_relatorio|${state.mestreId}|${logMessage.id}`).setLabel('Escrever Relatório').setStyle(ButtonStyle.Primary)
    );
    await logMessage.edit({ components: [relatorioButtonUpdated] });
    console.log(`[INFO sendLogMessage] Mensagem de log enviada para ${logChannel.name} (ID: ${logMessage.id})`);

  } catch (error) {
    console.error("[ERRO sendLogMessage] Falha ao enviar mensagem de log:", error);
  }
}

/** Envia a mensagem de log de gasto de tokens */
async function sendTokenReportMessage(state, playersWhoSpent, client) {
  const TOKEN_REPORT_CHANNEL_ID = process.env.TOKEN_REPORT_ID;
  if (!TOKEN_REPORT_CHANNEL_ID) {
      console.warn("[AVISO sendTokenReportMessage] ID do canal de report de tokens (TOKEN_REPORT_ID) não definido no .env. Pulando.");
      return; 
  }
  try {
    const reportChannel = await client.channels.fetch(TOKEN_REPORT_CHANNEL_ID);
    if (!reportChannel || !reportChannel.isTextBased()) {
        throw new Error(`Canal de report de tokens ${TOKEN_REPORT_CHANNEL_ID} não encontrado ou não é um canal de texto.`);
    }
    const playersListString = playersWhoSpent.map(p => {
        const mentionOrTag = p.id ? userMention(p.id) : p.tag;
        return `- ${mentionOrTag} (${p.char})`;
    }).join('\n');
    const mestreMention = userMention(state.mestreId);
    const dataMesa = state.dataMesa; 
    const horarioMesa = state.horarioMesa; 
    const nomeMesaFormatado = state.options.nomeMesa ? ` (${state.options.nomeMesa})` : '';
    const reportMessageContent = [
      `Gasto de Tokens (Dobro de Loot):\n`,
      `**Mestre:** ${mestreMention}`,
      `**Mesa:** ${dataMesa} às ${horarioMesa}${nomeMesaFormatado}\n`,
      `**Jogadores (Custo: 1 "Double Up"):**`, // <<< MENSAGEM CORRIGIDA
      `${playersListString}`
    ].join('\n');
    const playerIdsToMention = playersWhoSpent
        .map(p => p.id) 
        .filter(id => id != null); 
    await reportChannel.send({ content: reportMessageContent, allowedMentions: { users: playerIdsToMention } }); 
    console.log(`[INFO sendTokenReportMessage] Mensagem de report de tokens enviada para ${reportChannel.name}`);
  } catch (error) {
    console.error("[ERRO sendTokenReportMessage] Falha ao enviar mensagem de report de tokens:", error);
    throw error;
  }
}

module.exports = {
  findEligibleTables,
  formatPlayerList,
  formatDropsList,
  buildLootMessageContent,
  handleLootCalculation,    
  handlePegarLootClick,     
  handleEncerrarMesaClick,  
  updateHistoricoSheet,     
  sendLogMessage,           
  sendTokenReportMessage    
};