// utils/lootUtils.js
// Funções de formatação, busca de tabelas, update de planilha, log E LÓGICA DE BOTÕES

const {
  userMention,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,     // Necessário para handlePegarLootClick
  StringSelectMenuOptionBuilder, // Necessário para handlePegarLootClick
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
} = require('./google.js'); // <<< IMPORTA incrementarContagem E incrementarMesasMestradas

const { batchUpdateInventories } = require('./inventoryManager.js'); // <<< IMPORTA a nova função em LOTE

// Importa funções de cálculo e busca de nível (usadas em handleLootCalculation)
const { getPlayerLevels, calculateGold } = require('./lootLogic.js');

// ID do canal de log (Confirme se este ID está correto)
//const LOG_CHANNEL_ID = '1015029328863576078';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;

/**
 * Busca mesas elegíveis para loot para um narrador específico.
 * @param {string} username - O nome de usuário do narrador.
 * @param {GoogleSpreadsheet} docControle - Instância do docControle.
 * @returns {Promise<Array<GoogleSpreadsheetRow>>} - Array de linhas da planilha.
 */
async function findEligibleTables(username, docControle) {
  await docControle.loadInfo(); // Garante que a planilha está carregada
  const sheetHistorico = docControle.sheetsByTitle['Historico'];
  if (!sheetHistorico) {
    console.error("[ERRO findEligibleTables] Aba 'Historico' não encontrada.");
    throw new Error("Aba 'Historico' não encontrada na planilha de Controle.");
  }
  await sheetHistorico.loadHeaderRow(1); // Assume header na linha 1
  const rows = await sheetHistorico.getRows(); // Pega todas as linhas

  // Filtra as linhas conforme os critérios
  return rows.filter(row =>
    row.get('Narrador') === username &&
    row.get('Registrar Mesa') === 'Sim' &&
    row.get('Mesa Finalizada') === 'Não'
  );
}

/**
 * Formata a lista de jogadores para exibição.
 * * ATUALIZADO: Inclui "(Dobro Ativado)" se player.doubleActive for true.
 * @param {Array<object>} players - Array de objetos player do state.
 * @param {boolean} [includeItems=false] - Incluir itens pegos na string?
 * @param {boolean} [includeLevel=false] - Incluir nível na string?
 * @returns {string} - String formatada da lista de players.
 */
function formatPlayerList(players, includeItems = false, includeLevel = false) {
  // Verifica se o array de players é válido
  if (!players || !Array.isArray(players) || players.length === 0) {
    return 'Nenhum jogador encontrado.';
  }
  // Mapeia cada objeto player para uma string formatada
  return players.map(p => {
    // Garante que 'p' seja um objeto válido com as propriedades esperadas
    if (!p || typeof p !== 'object') return 'Jogador inválido';

    let playerLine = '';
    // Usa a menção (@) se o ID existir, caso contrário usa a tag
    const mentionOrTag = p.id ? userMention(p.id) : p.tag || 'Tag Desconhecida';
    const characterName = p.char || 'Personagem Desconhecido';
    playerLine += `${mentionOrTag} - ${characterName}`; // Formato base

    // Adiciona o nível se solicitado
    if (includeLevel) {
        // Verifica se p.level existe e é um número
        const levelText = (typeof p.level === 'number' && !isNaN(p.level)) ? p.level : '?';
        playerLine += ` (Nível ${levelText})`;
    }

    // Adiciona indicador de dobro se ativo
    if (p.doubleActive) {
        playerLine += " (Dobro Ativado)";
    }

    // Adiciona os itens se solicitado e se existirem
    if (includeItems && p.items && Array.isArray(p.items) && p.items.length > 0) {
      // Filtra itens inválidos e formata "Nx Nome"
      const itemText = p.items
         .filter(item => item && item.name && typeof item.amount === 'number' && item.amount > 0)
         .map(i => `${i.amount}x ${i.name}`)
         .join(', ');
      // Adiciona apenas se houver itens formatados
      if (itemText) {
          playerLine += " - " + itemText;
      }
    }
    return playerLine; // Retorna a linha formatada para este jogador
  }).join('\n'); // Junta todas as linhas com quebra de linha
}

/**
 * Formata a lista de drops disponíveis.
 * @param {Array<object>} allDrops - Array de itens do state.allDrops.
 * @returns {string} - String formatada (bloco de código) ou "Nenhum".
 */
function formatDropsList(allDrops) {
  // Verifica se o array é válido e tem itens
  if (!allDrops || !Array.isArray(allDrops) || allDrops.length === 0) {
    return "Nenhum"; // Retorna "Nenhum" se vazio ou inválido
  }
  // Filtra itens inválidos antes de formatar
  const validDrops = allDrops.filter(d => d && d.name && typeof d.amount === 'number' && d.amount > 0);
  // Se não houver drops válidos após filtrar
  if (validDrops.length === 0) {
      return "Nenhum";
  }
  // Formata cada item como "Nx Nome" e junta com quebra de linha dentro de um bloco de código
  return "```\n" + validDrops.map(d => `${d.amount}x ${d.name}`).join('\n') + "\n```";
}

/**
 * Constrói o conteúdo completo da mensagem principal de loot.
 * @param {object} state - O objeto de state do loot.
 * @param {string} playersString - A string formatada dos players.
 * @param {string} dropsString - A string formatada dos drops.
 * @returns {string} - Conteúdo completo da mensagem.
 */
function buildLootMessageContent(state, playersString, dropsString) {
  // Garante que state e suas propriedades existam com valores padrão
  const safeState = {
      options: { nomeMesa: '', ...(state?.options || {}) },
      mestreId: state?.mestreId || 'ID Desconhecido',
      goldFinalPerPlayer: state?.goldFinalPerPlayer || 0,
      criterio: state?.criterio || 'Critério indisponível',
      goldBastiãoTotal: state?.goldBastiãoTotal || 0,
  };

  // Formata o nome da mesa (se existir)
  const nomeMesaFormatado = safeState.options.nomeMesa ? `**${safeState.options.nomeMesa}**\n` : '';
  // Formata a menção do mestre
  const mestreMention = userMention(safeState.mestreId);
  // Garante que as strings de players e drops sejam válidas
  const safePlayersString = playersString || 'Nenhum jogador.';
  const safeDropsString = dropsString || 'Nenhum';

  // Monta o array de linhas da mensagem
  const messageLines = [
    nomeMesaFormatado,
    `**Mestre:** ${mestreMention}`,
    `**Players:**\n${safePlayersString}\n`,
    //`**Loot:** ${safeState.goldFinalPerPlayer} PO || ${safeState.criterio} ||`,
    //`**Bastião:** ${safeState.goldBastiãoTotal} PO\n`,
    `**Itens Dropados:**`,
    safeDropsString
  ];

  // Adiciona as linhas de Loot e Bastião APENAS se naoRolarLoot for false
  if (!safeState.options.naoRolarLoot) {
      // Insere as linhas na posição correta (antes de "Itens Dropados:")
      messageLines.splice(3, 0,
          `**Loot:** ${safeState.goldFinalPerPlayer} PO || ${safeState.criterio} ||`,
          `**Bastião:** ${safeState.goldBastiãoTotal} PO\n`
      );
  } else {
      // Opcional: Adicionar uma linha indicando que o loot foi ignorado
      messageLines.splice(3, 0, `*(Rolagem de Gold Ignorada)*\n`);
  }

  // Junta as linhas com quebra de linha
  return messageLines.join('\n');
}

/**
 * Lida com o clique no botão 'Calcular Loot'. Busca dados, calcula, e envia/edita a mensagem final.
 * @param {Discord.Interaction} interaction - A interação do botão.
 * @param {object} state - O objeto de state do loot.
 * @param {string} originalInteractionId - ID da interação original do /loot.
 */
async function handleLootCalculation(interaction, state, originalInteractionId) { // Removido originalMessage como param, pegamos de interaction
    // 1. Buscar a linha da mesa E SEU ÍNDICE CORRETO
    await docControle.loadInfo();
    const sheetHistorico = docControle.sheetsByTitle['Historico'];
    if (!sheetHistorico) throw new Error("Aba 'Historico' não encontrada.");
    await sheetHistorico.loadHeaderRow(1);
    const rows = await sheetHistorico.getRows();
    const rowIndexInArray = rows.findIndex(r => r.get('ID da Mensagem') === state.selectedMessageId);
    if (rowIndexInArray === -1) { throw new Error('Linha da mesa não encontrada no Histórico.'); }
    const mesaRow = rows[rowIndexInArray];
    state.mesaSheetRowIndex = rowIndexInArray + 2; // Salva índice 1-based
    // +++ ARMAZENA DATA E HORA DA MESA NO STATE +++
    state.dataMesa = mesaRow.get('Data') || '??/??/??';
    state.horarioMesa = mesaRow.get('Horário') || '??:??';
    // +++ FIM +++
    const tierString = mesaRow.get('Tier') || '';

    // 2. Buscar Níveis dos Jogadores
    const players = await getPlayerLevels(mesaRow, sheetHistorico.headerValues);

    // 3. Buscar IDs do Discord
    const playerTags = players.map(p => p.tag);
    const playerIds = await lookupIds(playerTags);
    const tagToIdMap = new Map();
    playerTags.forEach((tag, index) => { tagToIdMap.set(tag.toLowerCase(), playerIds[index] ? String(playerIds[index]) : null); });

    // 4. Salvar estado final dos players
    state.players = players.map(p => ({
      tag: p.tag, char: p.char, level: p.level, id: tagToIdMap.get(p.tag.toLowerCase()),
      items: [], colIndex: p.originalColIndex, activeMessageId: null, doubleActive: false // <<< INICIALIZA doubleActive
    }));

    // ===============================================
    // NOVA LÓGICA: Pular cálculo de gold se naoRolarLoot for true
    // ===============================================
    let goldPerPlayer = 0;
    let criterio = "Rolagem de gold ignorada.";
    let goldBastiãoTotal = 0;
    let goldFinalPerPlayer = 0;

    // Só calcula se a opção naoRolarLoot for FALSE
    if (!state.options.naoRolarLoot) {
        // 5. Calcular Gold
        const goldResult = calculateGold(players, tierString, state.options.lootPrevisto); // Função de lootLogic.js
        goldPerPlayer = goldResult.goldPerPlayer; // Atribui à variável externa
        criterio = goldResult.criterio; // Atribui à variável externa

        // 6. Distribuir Gold e salvar no state
        const numPlayers = state.players.length;
        goldBastiãoTotal = (goldPerPlayer * 0.20) * numPlayers; // Atribui à variável externa
        goldFinalPerPlayer = goldPerPlayer * 0.80; // Atribui à variável externa
    }

    // Salva os valores (calculados ou zerados) no state
    state.goldFinalPerPlayer = !isNaN(goldFinalPerPlayer) ? parseFloat(goldFinalPerPlayer.toFixed(2)) : 0;
    state.goldBastiãoTotal = !isNaN(goldBastiãoTotal) ? parseFloat(goldBastiãoTotal.toFixed(2)) : 0;
    state.criterio = criterio || "Erro no critério";
    // ===============================================

    // 7. Formatar Mensagem Final
    state.allDrops = [...(state.drops.mundanos||[]), ...(state.drops.itens||[]), ...(state.drops.materiais||[]), ...(state.drops.ervas||[]), ...(state.drops.pocoes||[])];
    const playersString = formatPlayerList(state.players, false, true); // Inclui nível
    const dropsString = formatDropsList(state.allDrops);
    const lootMessageContent = buildLootMessageContent(state, playersString, dropsString);

    // 8. Atualiza Discord
    // ===============================================
    // CORREÇÃO: Editar a MENSAGEM ORIGINAL do botão, não a interação
    // ===============================================
    // Pega a mensagem onde o botão "Calcular Loot" foi clicado
    const originalMessage = interaction.message;
    if (!originalMessage) {
        // Fallback: Se não conseguir encontrar a mensagem original, envia followUp
        console.warn("[AVISO handleLootCalculation] Mensagem original não encontrada na interação. Usando followUp.");
        await interaction.followUp({ content: 'Loot calculado! Mensagem de loot criada abaixo.', components: [], flags: [MessageFlagsBitField.Flags.Ephemeral] }); // Efêmero como fallback
    } else {
        // Edita a mensagem original para remover botões e confirmar
        await originalMessage.edit({ content: 'Loot calculado! Mensagem de loot criada abaixo.', components: [] });
    }
    // ===============================================

    // Envia a mensagem pública final (sem botões inicialmente)
    const lootMessage = await interaction.channel.send({ content: lootMessageContent, components: [] });

    // Atualiza o state com o ID da mensagem pública
    state.lootMessageId = lootMessage.id;
    interaction.client.pendingLoots.set(lootMessage.id, state); // Usa ID da MENSAGEM como chave
    interaction.client.pendingLoots.delete(originalInteractionId); // Remove state antigo

    // Cria os botões finais
    const lootButtons = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pegar_loot|${lootMessage.id}`).setLabel('Pegar Loot').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`encerrar_mesa|${lootMessage.id}`).setLabel('Encerrar Mesa').setStyle(ButtonStyle.Danger)
    );
    // Edita a mensagem pública para adicionar os botões
    await lootMessage.edit({ components: [lootButtons] });
}

/**
 * Lida com o clique no botão 'Pegar Loot'. Verifica permissão, mensagem ativa, e envia o menu de seleção.
 * ATUALIZADO: Sempre aparece, busca tokens, adiciona botão de Dobro.
 * @param {Discord.Interaction} interaction - A interação do botão.
 * @param {object} state - O objeto de state do loot.
 * @param {string} lootMessageId - ID da mensagem principal de loot.
 */
async function handlePegarLootClick(interaction, state, lootMessageId) {
    // Encontra o jogador que clicou
    const player = state.players.find(p => p.id === interaction.user.id);
    // Verifica se pertence à mesa
    if (!player) {
        await interaction.reply({ content: 'Você não faz parte desta mesa.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
        return;
    }

    // Verifica se já existe mensagem ativa para este jogador
    if (player.activeMessageId) {
        try {
            // Tenta buscar a mensagem anterior
            await interaction.channel.messages.fetch(player.activeMessageId);
            // Se encontrou, avisa que já está ativa
            console.log(`[AVISO Pegar Loot] Jogador ${player.tag} já possui msg ativa (${player.activeMessageId}).`);
            await interaction.reply({ content: 'Você já tem uma seleção de loot ativa. Finalize ou devolva os itens da seleção anterior.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
            return;
        } catch (error) {
            // Se deu erro 10008 (Unknown Message), a mensagem antiga não existe mais
            if (error.code === 10008) {
                console.log(`[INFO Pegar Loot] Msg ativa anterior (${player.activeMessageId}) não encontrada... Limpando ID.`);
                player.activeMessageId = null; // Permite prosseguir
            } else {
                // Outro erro
                console.error(`[ERRO Pegar Loot] Erro ao verificar msg ativa ${player.activeMessageId}:`, error);
                await interaction.reply({ content: 'Erro ao verificar seleção anterior...', flags: [MessageFlagsBitField.Flags.Ephemeral] });
                return;
            }
        }
    }

    // Busca a contagem de tokens do jogador ATUALMENTE
    const currentTokens = await getPlayerTokenCount(player.tag);
    const canAffordDouble = currentTokens >= 4;

    // Se não há drops disponíveis, informa e encerra
    if (!state.allDrops || !Array.isArray(state.allDrops) || state.allDrops.length === 0) {
        // Cria botão de Dobro
        const doubleButton = new ButtonBuilder()
            .setCustomId(`toggle_double_gold|${lootMessageId}|${player.id}`)
            // Label dinâmico: Ativar/Desativar (inicialmente Ativar)
            .setLabel(`Ativar Dobro (4 de ${currentTokens} 🎟️)`)
            .setStyle(ButtonStyle.Primary) // Azul para ativar
            .setDisabled(!canAffordDouble); // Desabilita se não pode pagar

        // Cria botão Finalizar (sem seleção de itens)
        const finalizeButton = new ButtonBuilder()
            .setCustomId(`finalizar_loot|${lootMessageId}|${player.id}`)
            .setLabel('Confirmar Gold') // Label diferente sem itens
            .setStyle(ButtonStyle.Success);

        // Responde PUBLICAMENTE
        await interaction.reply({
            content: `${userMention(player.id)}, você pode ativar o dobro de gold (${state.goldFinalPerPlayer} PO base).`,
            components: [new ActionRowBuilder().addComponents(doubleButton, finalizeButton)],
            allowedMentions: { users: [player.id] }
        });
        // Armazena o ID da mensagem criada
        const replyMessage = await interaction.fetchReply();
        player.activeMessageId = replyMessage.id;
        return;
    }

    // Cria o Select Menu
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`loot_item_select|${lootMessageId}`) // ID da mensagem principal
        .setPlaceholder('Selecione os itens que deseja pegar')
        .setMinValues(0) // Pode selecionar zero
        // Max = número total de unidades de itens
        .setMaxValues(Math.max(1, state.allDrops.map(i => i.amount || 0).reduce((a, b) => a + b, 0)));
    selectMenu.options.length = 0; // Limpa opções

    // Adiciona uma opção para CADA unidade de item, até o limite de 25
    let optionsAdded = 0;
    for (const item of state.allDrops) {
        if (!item || !item.name || typeof item.amount !== 'number' || item.amount <= 0) continue; // Pula inválidos
        const currentAmount = item.amount;
        for(let i = 0; i < currentAmount; i++) {
           if (optionsAdded >= 25) break; // Verifica ANTES de adicionar
           selectMenu.addOptions( new StringSelectMenuOptionBuilder().setValue(`${item.name}-${i}`).setLabel(item.name).setDescription(`(1 de ${currentAmount})`) );
           optionsAdded++;
        }
        if (optionsAdded >= 25) break; // Sai do loop externo
    }
    // Verifica se conseguiu adicionar alguma opção
    if (selectMenu.options.length === 0) {
         console.error("[ERRO Pegar Loot] Nenhum item válido para Select Menu...");
         await interaction.reply({ content: 'Erro interno ao listar itens...', flags: [MessageFlagsBitField.Flags.Ephemeral] });
         return;
    }

    // Cria botão de Dobro (igual ao caso sem drops)
    const doubleButton = new ButtonBuilder()
        .setCustomId(`toggle_double_gold|${lootMessageId}|${player.id}`)
        .setLabel(`Ativar Dobro (4 de ${currentTokens} 🎟️)`)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAffordDouble);

    // Cria o botão Finalizar
    const finalizeButton = new ButtonBuilder()
        .setCustomId(`finalizar_loot|${lootMessageId}|${player.id}`) // ID msg principal + ID player
        .setLabel('Finalizar Seleção')
        .setStyle(ButtonStyle.Success);

    // Responde PUBLICAMENTE mencionando o jogador
    await interaction.reply({
        content: `${userMention(player.id)}, selecione os itens que ${player.char} pegou:\n\n**Drops na mesa:**\n${state.allDrops.map(d => `${d.amount}x ${d.name}`).join('\n')}`,
        // Fileira 1: Menu Dropdown
        // Fileira 2: Botão Dobro, Botão Finalizar
        components: [new ActionRowBuilder().addComponents(selectMenu), new ActionRowBuilder().addComponents(doubleButton, finalizeButton)],
        allowedMentions: { users: [player.id] } // Garante a menção
    });

    // Armazena o ID da mensagem de seleção no state do jogador
    const replyMessage = await interaction.fetchReply();
    player.activeMessageId = replyMessage.id;
}

/**
 * Lida com o clique no botão 'Encerrar Mesa'. Edita msgs de player, atualiza planilha, envia log, limpa state.
 * ATUALIZADO: Adiciona contagem extra de XP (jogo na semana anterior) para quem usou Dobro.
 * @param {Discord.Interaction} interaction - A interação do botão.
 * @param {object} state - O objeto de state do loot.
 * @param {string} lootMessageId - ID da mensagem principal de loot.
 */
async function handleEncerrarMesaClick(interaction, state, lootMessageId) {

    // Define a mensagem de confirmação ANTES do try/catch principal
    let confirmationMessage = 'Mesa encerrada e registrada com sucesso!';
    let tokensSpentSuccessfully = true; // Flag para rastrear sucesso de tokens
    let tableCountUpdateSuccess = true; // Flag para rastrear sucesso da contagem de mesas
    // +++ ARMAZENA JOGADORES QUE GASTARAM +++
    const playersWhoSpentTokens = [];

    // 1. Edita mensagens ativas dos jogadores para remover botões
    if (state.players && Array.isArray(state.players)) {
        for (const player of state.players) {
            if (player.activeMessageId) { // Se o jogador tem uma msg de seleção/confirmação ativa
                try {
                    const playerMsg = await interaction.channel.messages.fetch(player.activeMessageId);
                    // Edita a mensagem apenas para remover os componentes (botões)
                    await playerMsg.edit({ components: [] });
                    console.log(`[INFO Encerrar Mesa] Botões removidos da msg ${player.activeMessageId} do player ${player.tag}.`);
                } catch (e) {
                    if (e.code !== 10008) { // Ignora erro "Unknown Message"
                        console.error(`Erro ao editar msg ${player.activeMessageId} do player ${player.tag} ao encerrar:`, e);
                    }
                }
                player.activeMessageId = null; // Limpa o ID do state do jogador
            }
        }
    }

    // ===============================================
    // NOVO: Gastar tokens dos jogadores que ativaram o dobro
    // ===============================================
    if (state.players && Array.isArray(state.players)) {
        for (const player of state.players) {
            if (player.doubleActive) {
                const success = await spendPlayerTokens(player.tag, 1); // Chama função do google.js
                if (!success) {
                    // Se falhar, avisa o mestre e continua, mas marca a flag
                    console.error(`[ERRO Encerrar Mesa] Falha ao gastar 4 tokens para ${player.tag}.`);
                    tokensSpentSuccessfully = false;
                } else {
                    // +++ SUCESSO: Adiciona à lista para reportar +++
                    playersWhoSpentTokens.push(player);
                }
            }
        }
    }
    // ===============================================

    // ===============================================
    // ALTERADO: Adicionar MESA JOGADA extra para quem usou Dobro (Semana ATUAL)
    // ===============================================
    try {
        // <<< ALTERAÇÃO: Busca offset da B1 da aba "Personagens" >>>
        await docSorteio.loadInfo(); // Garante sheet sorteio carregada
        const sheetPersonagens = docSorteio.sheetsByTitle['Personagens'];
        if (!sheetPersonagens) {
            throw new Error("Aba 'Personagens' não encontrada para buscar offset B1.");
        }
        await sheetPersonagens.loadCells('B1'); // Carrega B1
        const cellB1 = sheetPersonagens.getCellByA1('B1');
        const currentWeekOffset = parseInt(cellB1.value);
        if (isNaN(currentWeekOffset)) {
            throw new Error("Valor na célula B1 da aba 'Personagens' não é um número válido para offset.");
        }

        // <<< ALTERAÇÃO: Calcula índice da coluna da semana ATUAL (base 4) >>>
        const currentTargetColIndex = 4 + currentWeekOffset; // Col E (idx 4) + offset B1
        console.log(`[DEBUG Encerrar Mesa] Offset B1=${currentWeekOffset}, Índice da coluna alvo para contagem=${currentTargetColIndex}`);

        // Verifica se o índice da semana ATUAL é válido
        if (currentTargetColIndex >= 4 && state.players && Array.isArray(state.players)) { // Coluna E é índice 4
            // Reutiliza a sheetPersonagens que já carregamos
            // Não precisamos mais de rowsPrimario/rowsSecundario aqui

            for (const player of state.players) {
                if (player.doubleActive) {
                    // <<< ALTERAÇÃO: Chama incrementarContagem com sheetPersonagens e currentTargetColIndex >>>
                    console.log(`[INFO Encerrar Mesa - Contagem Extra] Tentando incrementar mesa para ${player.tag} na aba Personagens, coluna ${currentTargetColIndex}`);
                    const incrementSuccess = await incrementarContagem(sheetPersonagens, [player.tag], currentTargetColIndex);
                    // A função incrementarContagem já loga erros internos
                    if (!incrementSuccess) { // incrementarContagem retorna true/false implicitamente (ou lança erro)
                        console.error(`[ERRO Encerrar Mesa - Contagem Extra] Falha ao incrementar contagem da semana atual para ${player.tag}.`);
                        tableCountUpdateSuccess = false; // Marca falha
                    }
                }
            }
        } else {
             console.warn(`[AVISO Encerrar Mesa - Contagem Extra] Índice da coluna alvo (${currentTargetColIndex}) inválido. Pulando incremento extra.`);
        }
    } catch (countError) {
        console.error("[ERRO Encerrar Mesa - Contagem Extra] Falha crítica ao processar contagem extra:", countError);
        tableCountUpdateSuccess = false; // Marca falha crítica
    }
    // ===============================================

    // 2. Chama função utilitária para atualizar a planilha Histórico
    // (updateHistoricoSheet já foi atualizado para marcar "(Dobro Ativo)")
    await updateHistoricoSheet(state, docControle);

    // 3. Chama função utilitária para formatar a lista de players para o log (com itens e nível)
    const playersStringForLog = formatPlayerList(state.players, true, true);

    // 4. Chama função utilitária para enviar a mensagem de log
    // (sendLogMessage já foi atualizado para indicar Loot (Base))
    await sendLogMessage(state, interaction.client, playersStringForLog);

    // +++ ATUALIZA INVENTÁRIOS EM LOTE +++
    let inventoryUpdateOverallSuccess = true;
    if (state.players && Array.isArray(state.players)) {
        console.log(`[INFO Encerrar Mesa] Preparando ${state.players.length} atualizações de inventário em lote...`);
        const allPlayerChanges = []; // Array para enviar para a função em lote

        for (const player of state.players) {
            const changes = {
                gold: state.options.naoRolarLoot ? 0 : (player.doubleActive ? state.goldFinalPerPlayer * 2 : state.goldFinalPerPlayer),
                itemsToAdd: player.items || []
            };

            if (changes.gold !== 0 || changes.itemsToAdd.length > 0) {
                console.log(`[INFO Encerrar Mesa] Adicionando ao lote: ${player.tag} - ${player.char} (Gold: ${changes.gold.toFixed(2)}, Itens: ${changes.itemsToAdd.length})`);
                allPlayerChanges.push({
                    username: player.tag,
                    characterName: player.char,
                    changes: changes
                });
            }
        }

        // Chama a função em LOTE UMA VEZ
        if (allPlayerChanges.length > 0) {
            inventoryUpdateOverallSuccess = await batchUpdateInventories(allPlayerChanges, interaction.client);
            if (!inventoryUpdateOverallSuccess) {
                console.error("[ERRO Encerrar Mesa] batchUpdateInventories reportou uma falha parcial ou total.");
                confirmationMessage += `\n\n**Aviso:** Falha ao atualizar um ou mais inventários. Verifique os logs e a planilha manualmente.`;
            }
        }
    }
    // +++ FIM DA ATUALIZAÇÃO EM LOTE +++

    try {
        // state.mestreId (o ID do usuário) está no state
        const mestreUser = await interaction.client.users.fetch(state.mestreId);
        const mestreUsername = mestreUser.username; // Pega o username (ex: hdharder)
        
        if (mestreUsername) {
            await incrementarMesasMestradas(mestreUsername);
        } else {
            console.warn(`[AVISO encerrar_mesa] Não foi possível obter username do mestreId ${state.mestreId}`);
        }
    } catch (e) {
        console.error("[ERRO encerrar_mesa] Falha ao tentar incrementar mesas mestradas:", e);
        // Não impede o resto da função, apenas loga o erro.
    }

    // +++ 4.5. Envia o log de gasto de tokens (SE HOUVER) +++
    try {
        if (playersWhoSpentTokens.length > 0) {
            await sendTokenReportMessage(state, playersWhoSpentTokens, interaction.client);
        }
    } catch (tokenReportError) {
        console.error("[ERRO Encerrar Mesa] Falha ao enviar log de gasto de tokens:", tokenReportError);
        // Não impede o encerramento, mas avisa o mestre
        confirmationMessage += '\n\n**Aviso:** Houve uma falha ao *reportar* o gasto de tokens no canal de report.';
    }

    // 5. Edita a mensagem principal de loot para indicar que foi encerrada e remove botões
    if (interaction.message) { // Mensagem onde o botão Encerrar foi clicado
        try {
            await interaction.message.edit({ content: interaction.message.content + "\n\n**MESA ENCERRADA**", components: [] });
        } catch (e) {
            console.error("Erro ao editar msg de loot principal ao encerrar:", e);
        }
    }

    // 6. Remove o state da memória do bot
    interaction.client.pendingLoots.delete(lootMessageId);

    // 7. Confirma para o mestre (mensagem efêmera)
    if (!tokensSpentSuccessfully) {
        confirmationMessage += '\n\n**Aviso:** Houve uma falha ao registrar o gasto de tokens para um ou mais jogadores. Verifique a planilha `Tokens` manualmente.';
    }
    if (!tableCountUpdateSuccess) {
        confirmationMessage += '\n\n**Aviso:** Houve uma falha ao registrar a mesa jogada extra (para Double Gold). Verifique a planilha `Personagens`.';
    }
    // Usa a confirmationMessage que pode ter sido alterada
    await interaction.followUp({ content: confirmationMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] });
}


/** Atualiza a planilha Histórico */
async function updateHistoricoSheet(state, docControle) {
  try {
    await docControle.loadInfo();
    const sheetHistorico = docControle.sheetsByTitle['Historico'];
    if (!sheetHistorico) throw new Error("Aba 'Historico' não encontrada...");
    // Valida o índice da linha
    const sheetRowIndex_1_based = state.mesaSheetRowIndex;
    if (!sheetRowIndex_1_based || typeof sheetRowIndex_1_based !== 'number' || sheetRowIndex_1_based < 2) {
      throw new Error(`Índice da linha inválido: ${sheetRowIndex_1_based}`);
    }
    const rowIndex_0_based = sheetRowIndex_1_based - 1;
    // Carrega o range necessário
    const rangeToLoad = `M${sheetRowIndex_1_based}:T${sheetRowIndex_1_based}`;
    await sheetHistorico.loadCells(rangeToLoad);
    const cellsToUpdate = [];

    // Coluna M: Loot (PO) por Player
    const cellLoot = sheetHistorico.getCell(rowIndex_0_based, 12);
    // Salva o gold POR PLAYER (base), OU 0 se naoRolarLoot for true
    // A coluna M registrará o valor BASE por jogador
    let goldPerPlayerValue = state.options.naoRolarLoot ? 0 : (state.goldFinalPerPlayer || 0);
    cellLoot.value = !isNaN(goldPerPlayerValue) ? parseFloat(goldPerPlayerValue.toFixed(2)) : 0;
    cellsToUpdate.push(cellLoot);

    // Colunas N a S: Itens dos Jogadores (baseado na coluna original F-K)
    for (let i = 0; i < 6; i++) {
      const targetColIndex = 5 + i; // Coluna original (F=5, G=6, ...)
      const player = state.players.find(p => p.colIndex === targetColIndex);
      const cellItem = sheetHistorico.getCell(rowIndex_0_based, 13 + i); // Coluna N=13, O=14, ...
      let itemString = '';
      // Formata a string de itens do jogador encontrado
      if (player && player.items && Array.isArray(player.items) && player.items.length > 0) {
        itemString = player.items
          .filter(item => item && item.name && typeof item.amount === 'number' && item.amount > 0)
          .map(it => `${it.amount}x ${it.name}`)
          .join(', ');
      } 
      // Adiciona indicação de Dobro na coluna do item, se ativo
      if (player && player.doubleActive) {
          itemString = itemString ? `${itemString} (Dobro Ativo)` : '(Dobro Ativo)';
      }
      cellItem.value = itemString;
      cellsToUpdate.push(cellItem);
    }

    // Coluna T: Mesa Finalizada
    const cellFinalizada = sheetHistorico.getCell(rowIndex_0_based, 19);
    cellFinalizada.value = 'Sim';
    cellsToUpdate.push(cellFinalizada);

    // Salva as alterações
    await sheetHistorico.saveUpdatedCells(cellsToUpdate);
    console.log(`[INFO updateHistoricoSheet] Planilha atualizada para linha ${sheetRowIndex_1_based}.`);

  } catch (error) {
    console.error("[ERRO updateHistoricoSheet] Falha ao atualizar planilha:", error);
    throw new Error(`Falha ao atualizar a planilha Histórico: ${error.message}`);
  }
}

/** Envia a mensagem final de log */
async function sendLogMessage(state, client, playersStringWithItemsAndDouble) { // Renomeado param
  try {
    const logChannel = await client.channels.fetch(LOG_CHANNEL_ID);
    if (!logChannel || !logChannel.isTextBased()) { throw new Error(`Canal de log ${LOG_CHANNEL_ID} não encontrado...`); }
    // Formata os componentes da mensagem de log
    const nomeMesaFormatado = state.options.nomeMesa ? `**${state.options.nomeMesa}**\n` : '';
    const mestreMention = userMention(state.mestreId);
    // Usa a string formatada que já inclui Nível, Itens e (Dobro Ativado)
    const safePlayersString = playersStringWithItemsAndDouble || 'Nenhum jogador.';
    // Monta o conteúdo
    const logMessageLines = [ // Usa array para facilitar a inserção condicional
      nomeMesaFormatado,
      `**Mestre:** ${mestreMention}`,
      `**Players:**\n${safePlayersString}\n`, // String já contém (Dobro Ativado)
      // Adiciona Loot/Bastião condicionalmente (mostrando valores BASE)
      //`**Loot:** ${state.goldFinalPerPlayer} PO || ${state.criterio} ||`,
      //`**Bastião:** ${state.goldBastiãoTotal} PO\n`,
      `Relatório`,
      `(Área vazia)`
    //].join('\n');
    ];

    // Adiciona Loot/Bastião condicionalmente
    if (!state.options.naoRolarLoot) {
        logMessageLines.splice(3, 0,
            `**Loot:** ${state.goldFinalPerPlayer} PO || ${state.criterio} ||`,
            `**Bastião:** ${state.goldBastiãoTotal} PO\n`
        );
    } else {
        logMessageLines.splice(3, 0, `*(Rolagem de Gold Ignorada)*\n`);
    }
    const logMessageContent = logMessageLines.join('\n'); // Junta as linhas

    // Cria o botão inicial
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
    console.log(`[INFO sendLogMessage] Mensagem de log enviada para ${logChannel.name} (ID: ${logMessage.id})`);

  } catch (error) {
    console.error("[ERRO sendLogMessage] Falha ao enviar mensagem de log:", error);
    // Não relança o erro aqui, apenas loga, para não impedir o encerramento da mesa
    // throw new Error(`Falha ao enviar mensagem de log: ${error.message}`);
  }
}

// +++ NOVA FUNÇÃO: Envia log de gastos de Token +++
/** Envia a mensagem de log de gasto de tokens */
async function sendTokenReportMessage(state, playersWhoSpent, client) {
  // Busca o ID do canal de report de tokens do .env
  const TOKEN_REPORT_CHANNEL_ID = process.env.TOKEN_REPORT_ID;
  if (!TOKEN_REPORT_CHANNEL_ID) {
      console.warn("[AVISO sendTokenReportMessage] ID do canal de report de tokens (TOKEN_REPORT_ID) não definido no .env. Pulando.");
      return; // Sai silenciosamente se o ID não estiver configurado
  }

  try {
    const reportChannel = await client.channels.fetch(TOKEN_REPORT_CHANNEL_ID);
    if (!reportChannel || !reportChannel.isTextBased()) {
        throw new Error(`Canal de report de tokens ${TOKEN_REPORT_CHANNEL_ID} não encontrado ou não é um canal de texto.`);
    }

    // Formata a lista de jogadores
    const playersListString = playersWhoSpent.map(p => {
        // Usa a menção se tiver ID, senão a tag
        const mentionOrTag = p.id ? userMention(p.id) : p.tag;
        return `- ${mentionOrTag} (${p.char})`;
    }).join('\n');

    // Formata os dados da mesa (que buscamos em handleLootCalculation)
    const mestreMention = userMention(state.mestreId);
    const dataMesa = state.dataMesa; // Pego do state
    const horarioMesa = state.horarioMesa; // Pego do state
    const nomeMesaFormatado = state.options.nomeMesa ? ` (${state.options.nomeMesa})` : '';

    // Monta o conteúdo
    const reportMessageContent = [
      `Gasto de Tokens (Dobro de Loot):\n`,
      `**Mestre:** ${mestreMention}`,
      `**Mesa:** ${dataMesa} às ${horarioMesa}${nomeMesaFormatado}\n`,
      `**Jogadores (4 🎟️ cada):**`,
      `${playersListString}`
    ].join('\n');

    // +++ Pega os IDs dos jogadores para permitir a menção +++
    const playerIdsToMention = playersWhoSpent
        .map(p => p.id) // Extrai os IDs
        .filter(id => id != null); // Filtra IDs nulos (caso um jogador não tenha ID por algum motivo)

    // +++ Altera o allowedMentions para incluir os IDs +++
    await reportChannel.send({ content: reportMessageContent, allowedMentions: { users: playerIdsToMention } }); // Envia mencionando os jogadores
    console.log(`[INFO sendTokenReportMessage] Mensagem de report de tokens enviada para ${reportChannel.name}`);

  } catch (error) {
    console.error("[ERRO sendTokenReportMessage] Falha ao enviar mensagem de report de tokens:", error);
    // Relança o erro para que handleEncerrarMesaClick possa capturá-lo e avisar o mestre
    throw error;
  }
}

// Exporta as funções
module.exports = {
  findEligibleTables,
  formatPlayerList,
  formatDropsList,
  buildLootMessageContent,
  handleLootCalculation,    // << Lógica do botão calcular
  handlePegarLootClick,     // << Lógica do botão pegar_loot
  handleEncerrarMesaClick,  // << Lógica do botão encerrar_mesa
  updateHistoricoSheet,     // Chamado por handleEncerrarMesaClick
  sendLogMessage,           // Chamado por handleEncerrarMesaClick
  sendTokenReportMessage    // +++ EXPORTA A NOVA FUNÇÃO
};