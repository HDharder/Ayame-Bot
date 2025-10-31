// utils/relatorioUtils.js
const { userMention, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { docControle } = require('./google.js'); 
const { getPlayerLevels, calculateGold } = require('./lootLogic.js'); // <<< IMPORTA LÓGICA DO LOOT
const { batchUpdateInventories } = require('./inventoryManager.js'); // <<< IMPORTA GESTOR DE INVENTÁRIO
const { formatPlayerList } = require('./lootUtils'); // Reutiliza formatPlayerList

const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

/**
 * Busca mesas elegíveis para o comando /relatório.
 */
async function findEligibleTablesForRelatorio(userId, username, isStaff, docControle) {
  await docControle.loadInfo();
  const sheetHistorico = docControle.sheetsByTitle['Historico'];
  if (!sheetHistorico) {
    throw new Error("Aba 'Historico' não encontrada na planilha de Controle.");
  }
  await sheetHistorico.loadHeaderRow(1); 
  const rows = await sheetHistorico.getRows();

  const baseFilter = row => row.get('Registrar Mesa') === 'Sim' && row.get('Mesa Finalizada') === 'Não'; //

  if (isStaff) {
    return rows.filter(baseFilter); //
  } else {
    return rows.filter(row => baseFilter(row) && row.get('Narrador') === username); //
  }
}

/**
 * Função auxiliar para consolidar itens do state.itemsData para state.items
 */
function consolidateItems(state) {
    state.players.forEach(p => {
        p.items = []; 
        if (p.itemsData) {
            for (const key in p.itemsData) { 
                if (Array.isArray(p.itemsData[key])) {
                    p.items.push(...p.itemsData[key]); 
                }
            }
        }
        // Adiciona o Gold Extra como um "item" para o log (com ambos os campos)
        if (p.extraGold && p.extraGold > 0) {
            p.items.push({ 
                name: `[Extra] ${p.extraGold.toFixed(2)} PO`, 
                validationName: `[Extra] ${p.extraGold.toFixed(2)} PO`, 
                amount: 1 
            });
        }
    });
}

/**
 * Constrói o conteúdo da mensagem de log para o /relatório.
 */
function buildRelatorioLogContent(state) {
    const mestreIdToMention = state.options.mestreMencaoId || state.mestreId;
    const mestreMention = userMention(mestreIdToMention);
    const nomeMesaFormatado = state.options.nomeMesa ? `**${state.options.nomeMesa}**\n\n` : '';

    // Formata a lista de players (incluindo nível e itens inputados manualmente)
    const playersString = formatPlayerList(state.players, true, true); // Inclui itens e nível

    const goldFinalPerPlayer = state.goldFinalPerPlayer || 0;
    const goldBastiãoTotal = state.goldBastiãoTotal || 0;
    const criterio = state.criterio || "Não informado";

    const logMessageLines = [
      nomeMesaFormatado,
      `**Mestre:** ${mestreMention}`,
      `**Players:**\n${playersString}\n`,
      ...(state.options.naoRolarLoot
          ? [`*(Rolagem de Gold Ignorada)*\n`]
          : [`**Loot:** ${goldFinalPerPlayer} PO || ${criterio} ||`,
             `**Bastião:** ${goldBastiãoTotal} PO\n`]
      ),
      `Relatório`,
      `(Área vazia)`
    ];

    return logMessageLines.join('\n');
}

/**
 * Envia a mensagem de log para o /relatório.
 */
async function sendRelatorioLogMessage(state, client, logContent) {
    try {
        const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
        if (!logChannel || !logChannel.isTextBased()) { throw new Error(`Canal de log ${LOG_CHANNEL_ID} não encontrado...`); }
        
        const relatorioButtonInitial = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`escrever_relatorio|${state.mestreId}`).setLabel('Escrever Relatório').setStyle(ButtonStyle.Primary)
        );
        const logMessage = await logChannel.send({ content: logContent, components: [relatorioButtonInitial] });
        const relatorioButtonUpdated = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`escrever_relatorio|${state.mestreId}|${logMessage.id}`).setLabel('Escrever Relatório').setStyle(ButtonStyle.Primary)
        );
        await logMessage.edit({ components: [relatorioButtonUpdated] });
        console.log(`[INFO sendRelatorioLogMessage] Mensagem de log enviada para ${logChannel.name} (ID: ${logMessage.id})`);
      } catch (error) {
        console.error("[ERRO sendRelatorioLogMessage] Falha ao enviar mensagem de log:", error);
      }
}

/**
 * Atualiza a planilha Histórico com os dados manuais do /relatório.
 */
async function updateHistoricoForRelatorio(state, docControle) {
  try {
    await docControle.loadInfo();
    const sheetHistorico = docControle.sheetsByTitle['Historico'];
    if (!sheetHistorico) throw new Error("Aba 'Historico' não encontrada...");
    await sheetHistorico.loadHeaderRow(1);
    const rows = await sheetHistorico.getRows();

    const rowIndexInArray = rows.findIndex(r => r.get('ID da Mensagem') === state.selectedMessageId); //
    if (rowIndexInArray === -1) { throw new Error('Linha da mesa não encontrada para atualização.'); } //

    const sheetRowIndex_1_based = rowIndexInArray + 2;
    const rowIndex_0_based = rowIndexInArray + 1;

    const rangeToLoad = `M${sheetRowIndex_1_based}:T${sheetRowIndex_1_based}`; //
    await sheetHistorico.loadCells(rangeToLoad); //
    const cellsToUpdate = [];

    // M: Loot (PO) por Player
    const cellLoot = sheetHistorico.getCell(rowIndex_0_based, 12); //
    cellLoot.value = state.goldFinalPerPlayer; //
    cellsToUpdate.push(cellLoot); //

    // N a S: Itens dos Jogadores
    for (let i = 0; i < 6; i++) { //
      const targetColIndex = 5 + i; //
      const player = state.players.find(p => p.originalColIndex === targetColIndex); //
      const cellItem = sheetHistorico.getCell(rowIndex_0_based, 13 + i); //
      if (player && player.items && Array.isArray(player.items) && player.items.length > 0) { //
        cellItem.value = player.items
          .filter(item => item && item.name && typeof item.amount === 'number' && item.amount > 0)
          .map(it => `${it.amount}x ${it.name}`)
          .join(', '); //
      } else {
        cellItem.value = ''; //
      }
      cellsToUpdate.push(cellItem); //
    }

    // T: Mesa Finalizada
    const cellFinalizada = sheetHistorico.getCell(rowIndex_0_based, 19); //
    cellFinalizada.value = 'Sim'; //
    cellsToUpdate.push(cellFinalizada); //

    await sheetHistorico.saveUpdatedCells(cellsToUpdate); //
    console.log(`[INFO updateHistoricoForRelatorio] Planilha 'Historico' atualizada para linha ${sheetRowIndex_1_based}.`);

  } catch (error) {
    console.error("[ERRO updateHistoricoForRelatorio] Falha ao atualizar planilha:", error);
    throw new Error(`Falha ao atualizar a planilha Histórico: ${error.message}`);
  }
}

/**
 * Função centralizada que calcula o gold, atualiza o Histórico E ATUALIZA O INVENTÁRIO.
 */
async function handleRelatorioFinalization(state, docControle, client) {
  try {
    await docControle.loadInfo();
    const sheetHistorico = docControle.sheetsByTitle['Historico'];
    if (!sheetHistorico) throw new Error("Aba 'Historico' não encontrada.");
    await sheetHistorico.loadHeaderRow(1);
    const rows = await sheetHistorico.getRows();
    const rowIndexInArray = rows.findIndex(r => r.get('ID da Mensagem') === state.selectedMessageId);
    if (rowIndexInArray === -1) { throw new Error('Linha da mesa não encontrada para atualização.'); }
    const mesaRow = rows[rowIndexInArray]; 
    const tierString = mesaRow.get('Tier') || '';

    // === 1. CALCULAR GOLD (Rolado, Manual ou Ignorado) ===
    let goldPerPlayer = 0;
    let criterio = state.options.criterio || "Não informado";
    let goldBastiãoTotal = 0;
    let goldFinalPerPlayer = 0;
    const numPlayers = state.players.length; 

    if (state.options.naoRolarLoot) { //
        criterio = "Rolagem de gold ignorada.";
    } else if (state.options.goldTotal !== null && state.options.goldTotal !== undefined) { //
        // Gold Manual
        const goldPerPlayerBeforeBastion = state.options.goldTotal;
        goldBastiãoTotal = (goldPerPlayerBeforeBastion * 0.20) * numPlayers;
        goldFinalPerPlayer = goldPerPlayerBeforeBastion * 0.80;
        if (!state.options.criterio) {
            criterio = `Gold Total Informado: ${state.options.goldTotal} PO`;
        }
    } else {
        // Gold Rolado
        const playerLevels = state.players.map(p => p.level); //
        const goldResult = calculateGold(playerLevels, tierString, false); //
        goldPerPlayer = goldResult.goldPerPlayer;
        criterio = goldResult.criterio;
        goldBastiãoTotal = (goldPerPlayer * 0.20) * numPlayers;
        goldFinalPerPlayer = goldPerPlayer * 0.80;
    }

    state.goldFinalPerPlayer = !isNaN(goldFinalPerPlayer) ? parseFloat(goldFinalPerPlayer.toFixed(2)) : 0; //
    state.goldBastiãoTotal = !isNaN(goldBastiãoTotal) ? parseFloat(goldBastiãoTotal.toFixed(2)) : 0; //
    state.criterio = criterio; //

    // === 2. CONSOLIDAR ITENS ===
    consolidateItems(state); //

    // === 3. ATUALIZAR PLANILHA HISTORICO ===
    await updateHistoricoForRelatorio(state, docControle); //

    // === 4. ATUALIZAR INVENTÁRIOS (batchUpdate) ===
    console.log(`[INFO RelatorioFinal] Iniciando atualização de inventários para ${state.players.length} jogadores...`);
    const allPlayerChanges = [];
    for (const player of state.players) {
        const baseGold = state.goldFinalPerPlayer;
        const extraGold = player.extraGold || 0; 
        const totalGoldForInventory = baseGold + extraGold;

        // Filtra o "item" de gold extra para não ir ao inventário
        const realItemsToAdd = (player.items || []).filter(item => 
            !item.validationName.startsWith('[Extra]') // <<< CORRIGIDO: Filtra pelo nome de validação
        );
        const changes = {
            gold: totalGoldForInventory,
            itemsToAdd: realItemsToAdd // Passa o array de objetos { name, validationName, amount }
        };
        
        if (changes.gold !== 0 || changes.itemsToAdd.length > 0) { //
            console.log(`[INFO RelatorioFinal] Adicionando ao lote: ${player.tag} - ${player.char} (Gold: ${changes.gold.toFixed(2)}, Itens: ${changes.itemsToAdd.length})`);
            allPlayerChanges.push({
                username: player.tag,
                characterName: player.char,
                changes: changes
            });
        }
    }
    if (allPlayerChanges.length > 0) { //
        // <<< ALTERADO: Chama o batchUpdate, que agora entende validationName >>>
        const batchSuccess = await batchUpdateInventories(allPlayerChanges, client); 
        if (!batchSuccess) { //
            console.error("[ERRO RelatorioFinal] batchUpdateInventories reportou falha.");
            throw new Error("Falha ao atualizar um ou mais inventários via batchUpdate."); //
        }
    }

    // === 5. ENVIAR LOG (Após tudo) ===
    const logContent = buildRelatorioLogContent(state); //
    await sendRelatorioLogMessage(state, client, logContent); //

  } catch (error) {
    console.error("[ERRO handleRelatorioFinalization] Falha ao finalizar relatório:", error);
    throw error; // Relança o erro para o handleButton/handleSelect
  }
}


module.exports = {
  findEligibleTablesForRelatorio,
  handleRelatorioFinalization // <<< EXPORTA A NOVA FUNÇÃO UNIFICADA
};