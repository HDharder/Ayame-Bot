// commands/relatorio.js
const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlagsBitField,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  PermissionsBitField
} = require('discord.js');

// +++ IMPORTA O NOVO UTILITÁRIO DE AUTENTICAÇÃO +++
const { checkAuth, AuthLevels } = require('../utils/auth.js');

// Importações de Lógica
const { docControle, docCraft, lookupIds } = require('../utils/google.js');
const { validateItems, parseItemInput } = require('../utils/itemUtils.js');
const {
  findEligibleTablesForRelatorio,
  buildRelatorioLogContent,
  updateHistoricoForRelatorio,
  sendRelatorioLogMessage
} = require('../utils/relatorioUtils.js'); // Funções específicas deste comando

// Mapa para guardar estados pendentes deste comando
// interaction.client.pendingRelatorios = new Map(); (inicializado no index.js)

module.exports = {

  // 1. DEFINIÇÃO DO COMANDO
  data: new SlashCommandBuilder()
    .setName('relatorio')
    .setDescription('Cria manualmente o log de finalização de uma mesa registrada.')
    .addNumberOption(option => option.setName('gold_total').setDescription('Gold TOTAL rolado (antes do bastião). Obrigatório, coloque 0 se for ignorar loot.').setRequired(true))
    .addStringOption(option => option.setName('nome_mesa').setDescription('Opcional: Nome da mesa para o log.').setRequired(false))
    .addUserOption(option => option.setName('mestre').setDescription('Opcional (Staff): Mestre da mesa, se não for você.').setRequired(false))
    .addBooleanOption(option => option.setName('drop_itens').setDescription('Houve drop de Itens? (Habilita input)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_materiais').setDescription('Houve drop de Materiais? (Habilita input)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_ervas').setDescription('Houve drop de Ervas? (Habilita input)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_pocoes').setDescription('Houve drop de Poções? (Habilita input)').setRequired(false))
    .addBooleanOption(option => option.setName('ignorar_loot').setDescription('Ignorar cálculo/registro de Gold? (Default: False)').setRequired(false))
    //.addNumberOption(option => option.setName('gold_total').setDescription('Opcional: Gold TOTAL rolado (antes do bastião), se não ignorar loot.').setRequired(false))
    .addStringOption(option => option.setName('criterio').setDescription('Opcional: Texto do critério da rolagem de gold.').setRequired(false)),

  // 2. QUAIS INTERAÇÕES ESTE ARQUIVO GERENCIA
  selects: ['relatorio_select_mesa'],
  modals: [
    'modal_relatorio_item',
    'modal_relatorio_material',
    'modal_relatorio_erva',
    'modal_relatorio_pocao',
    // Reutiliza o modal de relatório do loot.js
    'modal_relatorio' // Para o botão final 'Escrever Relatório'
  ],
  buttons: [
    'relatorio_add_item', // Padrão: relatorio_add_[tipo]_[playerIndex]
    'relatorio_add_material',
    'relatorio_add_erva',
    'relatorio_add_pocao',
    'relatorio_next_player', // Padrão: relatorio_next_player_[playerIndex]
    // Reutiliza o botão de relatório do loot.js
    'escrever_relatorio' // Para o botão final 'Escrever Relatório'
  ],

  // 3. EXECUÇÃO DO COMANDO PRINCIPAL (/relatorio)
  async execute(interaction) {
    // Verifica permissão (Mestre ou Staff)
    // +++ USA O NOVO CHECKER +++
    const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.NARRADOR, AuthLevels.STAFF] });
    if (!hasAuth) {
      return;
    }
    // Defer público para mostrar a seleção de mesa
    await interaction.deferReply();

    try {
        // Coleta opções
        const mentionedMestre = interaction.options.getUser('mestre');
        // +++ USA O NOVO CHECKER (só para staff) +++
        if (mentionedMestre && !(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF] }))) {
          // A mensagem de erro já foi enviada pelo checkAuth
          return;
        }
        const options = {
          nomeMesa: interaction.options.getString('nome_mesa') || '',
          mestreMencaoId: mentionedMestre ? mentionedMestre.id : null, // Guarda o ID se staff mencionou outro mestre
          dropItens: interaction.options.getBoolean('drop_itens') ?? false,
          dropMateriais: interaction.options.getBoolean('drop_materiais') ?? false,
          dropErvas: interaction.options.getBoolean('drop_ervas') ?? false,
          dropPocoes: interaction.options.getBoolean('drop_pocoes') ?? false,
          naoRolarLoot: interaction.options.getBoolean('ignorar_loot') ?? false,
          //goldTotal: interaction.options.getNumber('gold_total') ?? null, // Pega como número ou null
          goldTotal: interaction.options.getNumber('gold_total'),
          criterio: interaction.options.getString('criterio') || null,
        };

        /*// Validação básica do gold
        if (!options.naoRolarLoot && options.goldTotal === null) {
            await interaction.editReply("Se 'ignorar_loot' for `False`, você precisa fornecer o `gold_total` rolado.");
            return;
        }
        if (options.naoRolarLoot && options.goldTotal !== null) {
            await interaction.editReply("Se 'ignorar_loot' for `True`, o `gold_total` será ignorado. Deixe-o em branco.");
            return;
        }*/


        // Chama utilitário para buscar mesas
        const mesasAbertas = await findEligibleTablesForRelatorio(interaction.user.id, interaction.user.username, isStaff, docControle);
        if (mesasAbertas.length === 0) {
          const msg = isStaff ? 'Nenhuma mesa registrada encontrada pendente de finalização.' : 'Você não possui mesas registradas pendentes de finalização.';
          await interaction.editReply(msg);
          return;
        }

        // Cria Select Menu
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`relatorio_select_mesa|${interaction.id}`)
            .setPlaceholder('Selecione a mesa para criar o relatório');
        mesasAbertas.slice(0, 25).forEach(row => {
            const data = row.get('Data') || '??/??/??';
            const horario = row.get('Horário') || '??:??';
            const narrador = row.get('Narrador') || '???';
            const nomeMesa = row.get('Nome da Mesa') || '';
            const messageId = row.get('ID da Mensagem');
            if (!messageId) { console.warn(`Mesa ${row.rowIndex} sem ID...`); return; }
            let label = nomeMesa ? `${nomeMesa} (${narrador} - ${data})` : `Mesa ${narrador} - ${data} ${horario}`;
            selectMenu.addOptions( new StringSelectMenuOptionBuilder().setLabel(label.substring(0, 100)).setValue(messageId) );
        });
        if (selectMenu.options.length === 0) { await interaction.editReply('Nenhuma mesa válida encontrada...'); return; }

        // Inicializa e armazena state
        if (!interaction.client.pendingRelatorios) { interaction.client.pendingRelatorios = new Map(); }
        interaction.client.pendingRelatorios.set(interaction.id, {
          step: 'select_mesa', options: options, interactionId: interaction.id,
          mestreId: interaction.user.id, // Quem INICIOU o comando
          isStaffExecutor: interaction.member.roles.cache.some(roleId => (process.env.ROLE_ID_STAFF || '').split(',').includes(roleId)) // Verifica pelo ID
        });

        // Edita reply
        const rowComponent = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.editReply({ content: 'Selecione a mesa para a qual deseja criar o relatório:', components: [rowComponent] });

    } catch (error) { // Erro no execute
        console.error("Erro no comando /relatorio (execute):", error);
        const errorMessage = `Erro ao iniciar /relatorio: ${error.message}`.substring(0,1900);
        if (interaction.deferred || interaction.replied) { await interaction.editReply({ content: errorMessage, components: [] }).catch(console.error); }
        else { await interaction.reply({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error); }
    }
  }, // Fim execute

  // 4. GERENCIADOR DE SELECT MENUS
  async handleSelect(interaction) {
    const [action, originalInteractionId] = interaction.customId.split('|');

    // --- Seleção da Mesa para Relatório ---
    if (action === 'relatorio_select_mesa') {
      try {
          await interaction.deferUpdate(); // Confirma seleção
          const state = interaction.client.pendingRelatorios.get(originalInteractionId);
          // Verifica state e permissão (quem iniciou a interação original)
          // +++ USA O NOVO CHECKER +++
          if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] }))) {
            return;
          }
          const selectedMessageId = interaction.values[0]; // ID da mensagem da mesa no histórico

          // Busca a linha da mesa selecionada para pegar os jogadores
          await docControle.loadInfo();
          const sheetHistorico = docControle.sheetsByTitle['Historico'];
          if (!sheetHistorico) throw new Error("Aba 'Historico' não encontrada.");
          await sheetHistorico.loadHeaderRow(1);
          const rows = await sheetHistorico.getRows();
          const mesaRow = rows.find(r => r.get('ID da Mensagem') === selectedMessageId);
          if (!mesaRow) { throw new Error('Linha da mesa selecionada não encontrada.'); }

          // Extrai jogadores da linha (F-K), parseando tag, char, level e colIndex
          const playerInfos = []; // Array temporário para guardar {tag, char, level, colIndex}
          state.players = [];
          for (let i = 5; i <= 10; i++) {
              const playerStringRaw = mesaRow._rawData[i];
              if (playerStringRaw && String(playerStringRaw).trim() !== '') {
                  const playerString = String(playerStringRaw).trim();
                  const parts = playerString.split(' - ');
                  let tag = playerString, char = 'Desconhecido', level = 1;
                  if (parts.length >= 3) {
                      tag = parts[0].trim();
                      const levelStr = parts[parts.length - 1].trim();
                      level = parseInt(levelStr) || 1;
                      char = parts.slice(1, -1).join(' - ').trim() || 'Desconhecido';
                  } else if (parts.length === 2) { tag = parts[0].trim(); char = parts[1].trim(); }
                  // Adiciona ao array temporário
                  playerInfos.push({ tag, char, level, originalColIndex: i });
              }
          }
          if (playerInfos.length === 0) { throw new Error('Nenhum jogador encontrado na linha da mesa.'); }

          // --- BUSCA OS IDs DOS JOGADORES ---
          const playerTags = playerInfos.map(p => p.tag); // Pega todas as tags
          const playerIds = await lookupIds(playerTags); // Busca os IDs (de google.js)
          // Cria um mapa Tag -> ID
          const tagToIdMap = new Map();
          playerTags.forEach((tag, index) => {
              tagToIdMap.set(tag.toLowerCase(), playerIds[index] ? String(playerIds[index]) : null);
          });

          // --- SALVA state.players COM O ID ---
          state.players = playerInfos.map(pInfo => ({
              tag: pInfo.tag,
              char: pInfo.char,
              level: pInfo.level,
              id: tagToIdMap.get(pInfo.tag.toLowerCase()) || null, // <<< ADICIONA O ID
              originalColIndex: pInfo.originalColIndex,
              items: [] // Inicializa items
          }));
          // ------------------------------------

          // Atualiza state
          state.step = 'input_player_drops';
          state.selectedMessageId = selectedMessageId; // Confirma o ID da mesa
          state.currentPlayerIndex = 0; // Começa com o primeiro jogador

          // Verifica se precisa pedir drops
          const needsDropInput = state.options.dropItens || state.options.dropMateriais || state.options.dropErvas || state.options.dropPocoes;

          if (needsDropInput) {
              // --- Mostra interface para adicionar drops do PRIMEIRO jogador ---
              const currentPlayer = state.players[0];
              const playerIdentifier = `${currentPlayer.tag} (${currentPlayer.char} - Nv ${currentPlayer.level})`;
              const dropButtons = [];
              if (state.options.dropItens) { dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_item|${originalInteractionId}|0`).setLabel('Itens').setStyle(ButtonStyle.Secondary)); }
              if (state.options.dropMateriais) { dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_material|${originalInteractionId}|0`).setLabel('Materiais').setStyle(ButtonStyle.Secondary)); }
              if (state.options.dropErvas) { dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_erva|${originalInteractionId}|0`).setLabel('Ervas').setStyle(ButtonStyle.Secondary)); }
              if (state.options.dropPocoes) { dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_pocao|${originalInteractionId}|0`).setLabel('Poções').setStyle(ButtonStyle.Secondary)); }
              // Botão para avançar
              const nextButtonLabel = state.players.length > 1 ? 'Próximo Jogador' : 'Finalizar Drops';
              dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_next_player|${originalInteractionId}|0`).setLabel(nextButtonLabel).setStyle(ButtonStyle.Success));

              const row = new ActionRowBuilder().addComponents(dropButtons.slice(0,5)); // Max 5 botões

              await interaction.editReply({
                  content: `**Adicionando Drops para:** ${playerIdentifier}\n\nUse os botões para adicionar os drops que este jogador recebeu. Clique no botão verde quando terminar para este jogador.`,
                  components: [row]
              });
              // Salva o ID da mensagem de input de drops
              const dropInputMsg = await interaction.fetchReply();
              state.dropInputMessageId = dropInputMsg.id;

          } else {
              // --- Pula direto para a finalização (sem drops) ---
              await interaction.editReply({ content: "Mesa selecionada. Gerando relatório final...", components: [] });

              // Chama função para construir o conteúdo do log
              const logContent = buildRelatorioLogContent(state); // Passa o state atualizado
              // Chama função para enviar a mensagem de log
              await sendRelatorioLogMessage(state, interaction.client);
              // Chama função para atualizar a planilha
              await updateHistoricoForRelatorio(state, docControle);

              // Limpa o state
              interaction.client.pendingRelatorios.delete(originalInteractionId);
              // Confirma finalização
              await interaction.followUp({ content: 'Relatório gerado e mesa finalizada com sucesso (sem drops inputados)!', flags: [MessageFlagsBitField.Flags.Ephemeral] });
          }

      } catch (error) {
          console.error("Erro no handleSelect (relatorio_select_mesa):", error);
          const errorMessage = `Erro ao processar seleção de mesa: ${error.message}`.substring(0,1900);
          if (interaction.replied || interaction.deferred) { await interaction.editReply({ content: errorMessage, components: [] }).catch(console.error); }
          else { await interaction.reply({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error); }
      }
    } // Fim if relatorio_select_mesa

    // --- Seleção de Itens (Reutilizado do loot.js, mas NÃO DEVE SER CHAMADO AQUI) ---
    // Este select menu é do comando /loot, o /relatorio não o utiliza.
    // else if (action === 'loot_item_select') { ... }

  }, // Fim handleSelect

  // 5. GERENCIADOR DE MODAIS
  async handleModal(interaction) {
    const [action, originalInteractionOrMessageId, playerIndexStr] = interaction.customId.split('|'); // Pega playerIndex se existir

    // --- Modal de Registro de Drops POR JOGADOR ---
    if (action.startsWith('modal_relatorio_')) { // Ex: modal_relatorio_item
      const originalInteractionId = originalInteractionOrMessageId;
      const playerIndex = parseInt(playerIndexStr); // Converte índice para número

      await interaction.deferUpdate(); // Confirma recebimento
      const state = interaction.client.pendingRelatorios.get(originalInteractionId);
      // Valida state, permissão e índice do jogador
      // +++ USA O NOVO CHECKER +++
      if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] })) || isNaN(playerIndex) || playerIndex >= state.players.length || playerIndex < 0) {
        await interaction.followUp({ content: 'Formulário inválido/expirado ou jogador não encontrado.', flags: [MessageFlagsBitField.Flags.Ephemeral] }); // Msg customizada
        return;
      }
      const input = interaction.fields.getTextInputValue('drop_input'); // ID do TextInput
      if (!input || input.trim() === '') {
          await interaction.followUp({ content: 'Nenhum item foi digitado.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
          return;
      }

      // Chama parseItemInput (itemUtils)
      const items = parseItemInput(input);
      let sheetName = ''; let itemTypeKey = ''; // Chave para salvar no player.items (ex: 'itens')

      // Determina tipo e aba
      if (action === 'modal_relatorio_item') { sheetName = 'Itens'; itemTypeKey = 'itens'; }
      else if (action === 'modal_relatorio_material') { sheetName = 'Materiais'; itemTypeKey = 'materiais'; }
      else if (action === 'modal_relatorio_erva') { sheetName = 'Ervas'; itemTypeKey = 'ervas'; }
      else if (action === 'modal_relatorio_pocao') { sheetName = 'Poções'; itemTypeKey = 'pocoes'; }
      else { await interaction.followUp({ content: 'Tipo de modal desconhecido.', flags: [MessageFlagsBitField.Flags.Ephemeral] }); return; }

      try {
        // Chama validateItems (itemUtils)
        const notFound = await validateItems(items, sheetName, docCraft);
        if (notFound.length > 0) {
          await interaction.followUp({ content: `**Erro:** Itens não encontrados em "${sheetName}":\n\`\`\`${notFound.join('\n')}\`\`\`\nCorrija e tente adicionar novamente.`, flags: [MessageFlagsBitField.Flags.Ephemeral] });
          return;
        }

        // --- ATUALIZA O STATE DO JOGADOR ---
        const currentPlayer = state.players[playerIndex];
        // Adiciona/Sobrescreve os itens DESTE TIPO para este jogador
        // Usamos um objeto dentro de items para separar por tipo
        if (!currentPlayer.itemsData) currentPlayer.itemsData = {}; // Inicializa se não existir
        currentPlayer.itemsData[itemTypeKey] = items; // Salva { name, amount }

        // --- ATUALIZA A MENSAGEM DE INPUT DE DROPS ---
        if (!state.dropInputMessageId) { throw new Error("ID da mensagem de input não encontrado."); }
        const dropInputMsg = await interaction.channel.messages.fetch(state.dropInputMessageId);
        if (!dropInputMsg) { throw new Error("Mensagem de input não encontrada."); }

        // Remonta a string de drops para ESTE jogador
        let currentDropsString = "**Drops Adicionados para este jogador:**\n";
        let playerHasDrops = false;
        const dropTypes = { itens:'Itens', materiais:'Materiais', ervas:'Ervas', pocoes:'Poções'};
        for(const key in dropTypes) {
            if (currentPlayer.itemsData && currentPlayer.itemsData[key] && currentPlayer.itemsData[key].length > 0) {
                playerHasDrops = true;
                currentDropsString += `${dropTypes[key]}: \`${currentPlayer.itemsData[key].map(i => `${i.amount}x ${i.name}`).join(', ')}\`\n`;
            }
        }
        if (!playerHasDrops) currentDropsString += "Nenhum";

        // Pega a parte inicial da mensagem (identificação do jogador)
        const contentBase = dropInputMsg.content.split('\n\n**Drops Adicionados para este jogador:**')[0];

        // Edita a mensagem de input
        await dropInputMsg.edit({
            content: `${contentBase}\n\n${currentDropsString}`,
            components: dropInputMsg.components // Mantém os botões
        });
        await interaction.followUp({ content: `${sheetName} adicionados para ${currentPlayer.tag}!`, flags: [MessageFlagsBitField.Flags.Ephemeral] });

      } catch (e) {
        console.error("Erro ao processar modal de drop de relatório:", e);
        const errorMessage = `Erro ao processar ${sheetName}: ${e.message}`.substring(0,1900);
        await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      }
    } // Fim if modal_relatorio_

    // --- Modal de Relatório (Final - Reutilizado) ---
    else if (action === 'modal_relatorio') {
      const logMessageId = originalInteractionOrMessageId;
      try {
        await interaction.deferUpdate();
        const logMessage = await interaction.channel.messages.fetch(logMessageId);
        if (!logMessage) { await interaction.followUp({ content: 'Msg de log não encontrada.', flags: [MessageFlagsBitField.Flags.Ephemeral] }); return; }
        const relatorioText = interaction.fields.getTextInputValue('relatorio_input');
        const originalContent = logMessage.content.split('\nRelatório')[0];
        const newContent = `${originalContent}\nRelatório\n\`\`\`\n${relatorioText}\n\`\`\``;
        await logMessage.edit({ content: newContent });
      } catch (e) { /* ... tratamento de erro ... */ }
    } // Fim if modal_relatorio
  }, // Fim handleModal

  // 6. GERENCIADOR DE BOTÕES
  async handleButton(interaction) {
    const customIdParts = interaction.customId.split('|');
    const action = customIdParts[0];
    const originalInteractionId = customIdParts[1]; // ID da interação /relatorio
    const playerIndexStr = customIdParts[2]; // Índice do jogador para botões de drop/next
    const logMessageId = customIdParts[2]; // ID da msg de log para escrever_relatorio

    let state;
    // Recupera state SÓ para ações de relatório
    if (action.startsWith('relatorio_')) {
        state = interaction.client.pendingRelatorios.get(originalInteractionId);
        // Verifica state e permissão (quem iniciou /relatorio)
        // +++ USA O NOVO CHECKER +++
        if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] }))) {
            return;
        }
    } else if (action === 'escrever_relatorio') {
        // Lógica específica abaixo
    } else {
        // Ignora botões de outros comandos (loot, etc.)
        // Se precisar que este arquivo lide com mais botões, adicione aqui.
        // Por segurança, podemos apenas retornar ou logar.
        console.log(`[INFO relatorio.js] Ignorando botão com ação não relacionada: ${action}`);
        // Pode ser necessário responder se o index.js não tratar isso
        // await interaction.deferUpdate().catch(()=>{}); // Apenas confirma para evitar erro
        return;
    }


    try {
        // --- Botões para ABRIR MODAL de drops por jogador ---
        if (action.startsWith('relatorio_add_')) { // Ex: relatorio_add_item
          const playerIndex = parseInt(playerIndexStr);
          // Valida índice
          if (isNaN(playerIndex) || playerIndex !== state.currentPlayerIndex) {
              await interaction.reply({ content: 'Botão inválido ou fora de ordem.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
              return;
          }

          let modal; let itemType = ''; // Tipo para o ID do modal
          // Cria modal correspondente
          if (action === 'relatorio_add_item') { itemType = 'item'; modal = new ModalBuilder().setCustomId(`modal_relatorio_${itemType}|${originalInteractionId}|${playerIndex}`).setTitle(`Adicionar Itens para ${state.players[playerIndex].tag}`); }
          else if (action === 'relatorio_add_material') { itemType = 'material'; modal = new ModalBuilder().setCustomId(`modal_relatorio_${itemType}|${originalInteractionId}|${playerIndex}`).setTitle(`Adicionar Materiais para ${state.players[playerIndex].tag}`); }
          else if (action === 'relatorio_add_erva') { itemType = 'erva'; modal = new ModalBuilder().setCustomId(`modal_relatorio_${itemType}|${originalInteractionId}|${playerIndex}`).setTitle(`Adicionar Ervas para ${state.players[playerIndex].tag}`); }
          else if (action === 'relatorio_add_pocao') { itemType = 'pocao'; modal = new ModalBuilder().setCustomId(`modal_relatorio_${itemType}|${originalInteractionId}|${playerIndex}`).setTitle(`Adicionar Poções para ${state.players[playerIndex].tag}`); }

          // Adiciona TextInput comum
          if (modal) {
              modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('drop_input').setLabel(`Itens/Materiais/Etc (Ex: Item A, 3x Item B)`).setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
              await interaction.showModal(modal); // Mostra o formulário
          } else {
              await interaction.reply({ content: 'Tipo de drop inválido.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
          }
        } // Fim relatorio_add_

        // --- Botão Próximo Jogador / Finalizar Drops ---
        else if (action === 'relatorio_next_player') {
            const playerIndex = parseInt(playerIndexStr);
            // Valida índice
            if (isNaN(playerIndex) || playerIndex !== state.currentPlayerIndex) {
                await interaction.reply({ content: 'Botão inválido ou fora de ordem.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
                return;
            }
            await interaction.deferUpdate(); // Confirma clique

            // Incrementa o índice
            state.currentPlayerIndex++;

            // Verifica se ainda há jogadores
            if (state.currentPlayerIndex < state.players.length) {
                // --- Prepara para o PRÓXIMO jogador ---
                const nextPlayer = state.players[state.currentPlayerIndex];
                const nextPlayerIndex = state.currentPlayerIndex;
                const nextPlayerIdentifier = `${nextPlayer.tag} (${nextPlayer.char} - Nv ${nextPlayer.level})`;

                // Cria botões para o próximo jogador
                const nextDropButtons = [];
                if (state.options.dropItens) { nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_item|${originalInteractionId}|${nextPlayerIndex}`).setLabel('Itens').setStyle(ButtonStyle.Secondary)); }
                if (state.options.dropMateriais) { nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_material|${originalInteractionId}|${nextPlayerIndex}`).setLabel('Materiais').setStyle(ButtonStyle.Secondary)); }
                if (state.options.dropErvas) { nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_erva|${originalInteractionId}|${nextPlayerIndex}`).setLabel('Ervas').setStyle(ButtonStyle.Secondary)); }
                if (state.options.dropPocoes) { nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_pocao|${originalInteractionId}|${nextPlayerIndex}`).setLabel('Poções').setStyle(ButtonStyle.Secondary)); }
                // Atualiza label do botão "Next"
                const nextButtonLabel = (nextPlayerIndex === state.players.length - 1) ? 'Finalizar Drops' : 'Próximo Jogador';
                nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_next_player|${originalInteractionId}|${nextPlayerIndex}`).setLabel(nextButtonLabel).setStyle(ButtonStyle.Success));

                const nextRow = new ActionRowBuilder().addComponents(nextDropButtons.slice(0,5));

                // Edita a mensagem de input de drops para o próximo jogador
                await interaction.editReply({
                    content: `**Adicionando Drops para:** ${nextPlayerIdentifier}\n\nUse os botões para adicionar os drops que este jogador recebeu. Clique no botão verde quando terminar para este jogador.\n\n**Drops Adicionados para este jogador:**\nNenhum`, // Reseta a lista exibida
                    components: [nextRow]
                });

            } else {
                // --- FINALIZAÇÃO: Todos os jogadores processados ---
                await interaction.editReply({ content: "Todos os drops inputados. Gerando relatório final...", components: [] });

                // Consolida os itens de 'itemsData' para 'items' em cada player
                state.players.forEach(p => {
                    p.items = []; // Reseta a lista final
                    if (p.itemsData) {
                        for (const key in p.itemsData) {
                            if (Array.isArray(p.itemsData[key])) {
                                p.items.push(...p.itemsData[key]); // Junta todos os tipos de drop
                            }
                        }
                        // Opcional: Consolidar itens com mesmo nome se adicionou de tipos diferentes?
                        // Ex: 1x Iron (Material) + 2x Iron (Item) -> 3x Iron?
                        // Se necessário, adicionar lógica de consolidação aqui. Por enquanto, só junta.
                    }
                });

                // Chama função para construir o conteúdo do log
                const logContent = buildRelatorioLogContent(state);
                // Chama função para enviar a mensagem de log
                await sendRelatorioLogMessage(state, interaction.client);
                // Chama função para atualizar a planilha
                await updateHistoricoForRelatorio(state, docControle);

                // Limpa o state
                interaction.client.pendingRelatorios.delete(originalInteractionId);
                // Confirma finalização para o usuário
                await interaction.followUp({ content: 'Relatório gerado e mesa finalizada com sucesso!', flags: [MessageFlagsBitField.Flags.Ephemeral] });
            }
        }

        // --- Botão de ESCREVER RELATÓRIO (Reutilizado do loot.js) ---
        else if (action === 'escrever_relatorio') {
            // logMessageId foi extraído no início
            const [_, mestreId] = interaction.customId.split('|'); // Pega mestreId do botão
             // Verifica permissão aqui
            // +++ USA O NOVO CHECKER +++
            if (!(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [mestreId] }))) {
              return;
            }

            // Lógica de buscar mensagem e mostrar modal
            const logMessage = await interaction.channel.messages.fetch(logMessageId);
            if (!logMessage) { await interaction.reply({ content: 'Msg de log não encontrada.', flags: [MessageFlagsBitField.Flags.Ephemeral] }); return; }
            let currentReport = ""; const reportMatch = logMessage.content.match(/Relatório\n```\n([\s\S]+?)\n```/); if (reportMatch && reportMatch[1]) { currentReport = reportMatch[1].trim(); if(currentReport === '(Área vazia)') currentReport = '';}
            const modal = new ModalBuilder().setCustomId(`modal_relatorio|${logMessageId}`).setTitle('Relatório da Missão');
            modal.addComponents(new ActionRowBuilder().addComponents( new TextInputBuilder().setCustomId('relatorio_input').setLabel('Escreva o relatório').setStyle(TextInputStyle.Paragraph).setValue(currentReport || 'Escreva aqui...').setRequired(true) ));
            await interaction.showModal(modal);
        }

    } catch (error) { // Catch geral para a lógica dos botões
        console.error(`Erro no handleButton (${action}):`, error);
        const errorMessage = `Ocorreu um erro no botão: ${error.message}`.substring(0, 1900);
        if (interaction.replied || interaction.deferred) { await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error); }
        else { await interaction.reply({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(async (replyError) => { console.error("Falha ao responder, tentando followUp:", replyError); await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error); }); }
    }

  } // Fim do handleButton
}; // Fim do module.exports