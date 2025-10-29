// Funções específicas para o comando /relatório

const { userMention, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { docControle } = require('./google.js'); // Importa docControle
const { formatPlayerList } = require('./lootUtils'); // Reutiliza formatPlayerList

// ID do canal de log (mesmo do loot)
//const LOG_CHANNEL_ID = '1015029328863576078'; // Confirme se este ID está correto
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

/**
 * Busca mesas elegíveis para o comando /relatório.
 * Filtra diferente para Staff (qualquer mesa) e Mestre (apenas as suas).
 * @param {string} userId - ID do Discord do usuário que executou o comando.
 * @param {string} username - Username do usuário que executou o comando.
 * @param {boolean} isStaff - Se o usuário tem o cargo Staff.
 * @param {GoogleSpreadsheet} docControle - Instância do docControle.
 * @returns {Promise<Array<GoogleSpreadsheetRow>>} - Array de linhas da planilha elegíveis.
 */
async function findEligibleTablesForRelatorio(userId, username, isStaff, docControle) {
  await docControle.loadInfo();
  const sheetHistorico = docControle.sheetsByTitle['Historico'];
  if (!sheetHistorico) {
    throw new Error("Aba 'Historico' não encontrada na planilha de Controle.");
  }
  await sheetHistorico.loadHeaderRow(1); // Assume header na linha 1
  const rows = await sheetHistorico.getRows();

  // Filtro base: Mesa Registrada (Sim) e Não Finalizada (Não)
  const baseFilter = row => row.get('Registrar Mesa') === 'Sim' && row.get('Mesa Finalizada') === 'Não';

  if (isStaff) {
    // Staff pode ver todas as mesas que atendem ao filtro base
    return rows.filter(baseFilter);
  } else {
    // Mestre só pode ver as SUAS mesas que atendem ao filtro base
    return rows.filter(row => baseFilter(row) && row.get('Narrador') === username);
  }
}

/**
 * Constrói o conteúdo da mensagem de log para o /relatório.
 * @param {object} state - O objeto de state do relatório. Contém options, players (com items).
 * @returns {string} - Conteúdo formatado da mensagem de log.
 */
function buildRelatorioLogContent(state) {
    // Usa o Mestre do state (pode ter sido inputado pelo Staff) ou o Mestre original
    const mestreIdToMention = state.options.mestreMencaoId || state.mestreId;
    const mestreMention = userMention(mestreIdToMention);
    const nomeMesaFormatado = state.options.nomeMesa ? `**${state.options.nomeMesa}**\n\n` : '';

    // Formata a lista de players (incluindo nível e itens inputados manualmente)
    const playersString = formatPlayerList(state.players, true, true); // Inclui itens e nível

    // Calcula Gold Bastião e Final a partir do Gold Total (se não for ignorado)
    let goldFinalPerPlayer = 0;
    let goldBastiãoTotal = 0;
    let criterio = state.options.criterio || "Não informado"; // Usa critério do input ou padrão

    if (!state.options.naoRolarLoot && typeof state.options.goldTotal === 'number' && state.players.length > 0) {
        const numPlayers = state.players.length;
        // Assume que state.options.goldTotal é o valor ANTES da divisão e do bastião
        // Gold por player ANTES do bastião = goldTotal / numPlayers
        const goldPerPlayerBeforeBastion = state.options.goldTotal;
        goldBastiãoTotal = (goldPerPlayerBeforeBastion * 0.20) * numPlayers;
        goldFinalPerPlayer = goldPerPlayerBeforeBastion * 0.80;
        // Arredonda para exibição
        goldFinalPerPlayer = parseFloat(goldFinalPerPlayer.toFixed(2));
        goldBastiãoTotal = parseFloat(goldBastiãoTotal.toFixed(2));
        // Adiciona info do gold total no critério se não foi informado
        if (!state.options.criterio) {
            criterio = `Gold Total Informado: ${state.options.goldTotal} PO`;
        }
    } else if (state.options.naoRolarLoot) {
        criterio = "Rolagem de gold ignorada.";
    }

    // Monta as linhas da mensagem
    const logMessageLines = [
      nomeMesaFormatado,
      `**Mestre:** ${mestreMention}`,
      `**Players:**\n${playersString}\n`,
      // Adiciona Loot/Bastião condicionalmente
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
 * Atualiza a planilha Histórico com os dados manuais do /relatório.
 * @param {object} state - O objeto de state do relatório. Contém selectedMessageId, players (com items, colIndex), options (goldTotal, naoRolarLoot).
 * @param {GoogleSpreadsheet} docControle - Instância do docControle.
 */
async function updateHistoricoForRelatorio(state, docControle) {
  try {
    await docControle.loadInfo();
    const sheetHistorico = docControle.sheetsByTitle['Historico'];
    if (!sheetHistorico) throw new Error("Aba 'Historico' não encontrada...");
    await sheetHistorico.loadHeaderRow(1);
    const rows = await sheetHistorico.getRows();

    // Encontra a linha pelo ID da mensagem original
    const rowIndexInArray = rows.findIndex(r => r.get('ID da Mensagem') === state.selectedMessageId);
    if (rowIndexInArray === -1) { throw new Error('Linha da mesa não encontrada para atualização.'); }

    // Calcula índices
    const sheetRowIndex_1_based = rowIndexInArray + 2;
    const rowIndex_0_based = rowIndexInArray + 1;

    // Carrega o range M:T
    const rangeToLoad = `M${sheetRowIndex_1_based}:T${sheetRowIndex_1_based}`;
    await sheetHistorico.loadCells(rangeToLoad);
    const cellsToUpdate = [];

    // M: Loot (PO) por Player
    const cellLoot = sheetHistorico.getCell(rowIndex_0_based, 12);
    let goldPerPlayerValue = 0;
    if (!state.options.naoRolarLoot && typeof state.options.goldTotal === 'number' && state.players.length > 0) {
        const goldPerPlayerBeforeBastion = state.options.goldTotal;// / state.players.length;
        goldPerPlayerValue = goldPerPlayerBeforeBastion * 0.80; // Salva o gold PÓS-bastião por player
    }
    cellLoot.value = !isNaN(goldPerPlayerValue) ? parseFloat(goldPerPlayerValue.toFixed(2)) : 0;
    cellsToUpdate.push(cellLoot);

    // N a S: Itens dos Jogadores
    for (let i = 0; i < 6; i++) {
      const targetColIndex = 5 + i; // Coluna original F-K
      // Acha o jogador no state pela coluna original
      const player = state.players.find(p => p.originalColIndex === targetColIndex);
      const cellItem = sheetHistorico.getCell(rowIndex_0_based, 13 + i); // Coluna N-S
      // Usa os itens que foram inputados manualmente (state.players[...].items)
      if (player && player.items && Array.isArray(player.items) && player.items.length > 0) {
        cellItem.value = player.items
          .filter(item => item && item.name && typeof item.amount === 'number' && item.amount > 0)
          .map(it => `${it.amount}x ${it.name}`)
          .join(', ');
      } else {
        cellItem.value = '';
      }
      cellsToUpdate.push(cellItem);
    }

    // T: Mesa Finalizada
    const cellFinalizada = sheetHistorico.getCell(rowIndex_0_based, 19);
    cellFinalizada.value = 'Sim';
    cellsToUpdate.push(cellFinalizada);

    // Salva
    await sheetHistorico.saveUpdatedCells(cellsToUpdate);
    console.log(`[INFO updateHistoricoForRelatorio] Planilha atualizada para linha ${sheetRowIndex_1_based}.`);

  } catch (error) {
    console.error("[ERRO updateHistoricoForRelatorio] Falha ao atualizar planilha:", error);
    throw new Error(`Falha ao atualizar a planilha Histórico: ${error.message}`);
  }
}

/**
 * Envia a mensagem de log para o /relatório. Reutiliza estrutura do sendLogMessage.
 * @param {object} state - O objeto de state do relatório.
 * @param {DiscordClient} client - Instância do client do Discord.
 */
async function sendRelatorioLogMessage(state, client) {
    try {
        const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
        if (!logChannel || !logChannel.isTextBased()) { throw new Error(`Canal de log ${LOG_CHANNEL_ID} não encontrado...`); }

        // Chama a função para construir o conteúdo específico do relatório
        const logMessageContent = buildRelatorioLogContent(state);

        // Cria o botão inicial "Escrever Relatório"
        const relatorioButtonInitial = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`escrever_relatorio|${state.mestreId}`).setLabel('Escrever Relatório').setStyle(ButtonStyle.Primary)
        );
        // Envia a mensagem
        const logMessage = await logChannel.send({ content: logMessageContent, components: [relatorioButtonInitial] });
        // Cria o botão atualizado com o ID da mensagem
        const relatorioButtonUpdated = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`escrever_relatorio|${state.mestreId}|${logMessage.id}`).setLabel('Escrever Relatório').setStyle(ButtonStyle.Primary)
        );
        // Edita a mensagem para incluir o ID no botão
        await logMessage.edit({ components: [relatorioButtonUpdated] });
        console.log(`[INFO sendRelatorioLogMessage] Mensagem de log enviada para ${logChannel.name} (ID: ${logMessage.id})`);

      } catch (error) {
        console.error("[ERRO sendRelatorioLogMessage] Falha ao enviar mensagem de log:", error);
        // Não relança, apenas loga
      }
}


module.exports = {
  findEligibleTablesForRelatorio,
  buildRelatorioLogContent,
  updateHistoricoForRelatorio,
  sendRelatorioLogMessage
};