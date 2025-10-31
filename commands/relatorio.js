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
  handleRelatorioFinalization // <<< Usaremos uma nova função unificada
} = require('../utils/relatorioUtils.js');

// Mapa para guardar estados pendentes deste comando
// interaction.client.pendingRelatorios = new Map(); (inicializado no index.js)

module.exports = {

  // 1. DEFINIÇÃO DO COMANDO
  data: new SlashCommandBuilder()
    .setName('relatorio')
    .setDescription('Cria manualmente o log de finalização de uma mesa registrada.')
    .addNumberOption(option => option.setName('gold_total').setDescription('Opcional: Gold TOTAL rolado. Deixe VAZIO para rolar automaticamente.').setRequired(false))
    .addStringOption(option => option.setName('nome_mesa').setDescription('Opcional: Nome da mesa para o log.').setRequired(false))
    .addUserOption(option => option.setName('mestre').setDescription('Opcional (Staff): Mestre da mesa, se não for você.').setRequired(false))
    .addBooleanOption(option => option.setName('drop_itens').setDescription('Houve drop de Itens? (Habilita input)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_materiais').setDescription('Houve drop de Materiais? (Habilita input)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_ervas').setDescription('Houve drop de Ervas? (Habilita input)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_pocoes').setDescription('Houve drop de Poções? (Habilita input)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_misc').setDescription('Houve drop de Itens "Misc"? (Sem validação)').setRequired(false))
    .addBooleanOption(option => option.setName('ignorar_loot').setDescription('Ignorar cálculo/registro de Gold? (Default: False)').setRequired(false))
    .addStringOption(option => option.setName('criterio').setDescription('Opcional: Texto do critério da rolagem de gold.').setRequired(false)),

  // 2. QUAIS INTERAÇÕES ESTE ARQUIVO GERENCIA
  selects: ['relatorio_select_mesa'],
  modals: [
    'modal_relatorio_item',
    'modal_relatorio_material',
    'modal_relatorio_erva',
    'modal_relatorio_pocao',
    'modal_relatorio_misc',
    'modal_relatorio_gold',
    'modal_relatorio' 
  ],
  buttons: [
    'relatorio_add_item', 
    'relatorio_add_material',
    'relatorio_add_erva',
    'relatorio_add_pocao',
    'relatorio_add_misc', // <<< CORREÇÃO 1
    'relatorio_add_gold', // <<< CORREÇÃO 1
    'relatorio_next_player', 
    'escrever_relatorio' 
  ],

  // 3. EXECUÇÃO DO COMANDO PRINCIPAL (/relatorio)
  async execute(interaction) {
    // Verifica permissão (Mestre ou Staff)
    const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.NARRADOR, AuthLevels.STAFF] });
    if (!hasAuth) {
      return;
    }
    await interaction.deferReply();

    try {
        const isStaff = interaction.member.roles.cache.some(role => 
            (process.env.ROLE_ID_STAFF || '').split(',').includes(role.id)
        );

        const mentionedMestre = interaction.options.getUser('mestre');
        if (mentionedMestre && !isStaff) {
          await interaction.editReply({ 
              content: 'Você precisa ser Staff para usar a opção `mestre`.', 
              flags: [MessageFlagsBitField.Flags.Ephemeral] 
          });
          return;
        }
        const options = {
          nomeMesa: interaction.options.getString('nome_mesa') || '',
          mestreMencaoId: mentionedMestre ? mentionedMestre.id : null, 
          dropItens: interaction.options.getBoolean('drop_itens') ?? false,
          dropMateriais: interaction.options.getBoolean('drop_materiais') ?? false,
          dropErvas: interaction.options.getBoolean('drop_ervas') ?? false,
          dropPocoes: interaction.options.getBoolean('drop_pocoes') ?? false,
          dropMisc: interaction.options.getBoolean('drop_misc') ?? false, 
          naoRolarLoot: interaction.options.getBoolean('ignorar_loot') ?? false, 
          goldTotal: interaction.options.getNumber('gold_total'),
          criterio: interaction.options.getString('criterio') || null,
        };
        
        const mesasAbertas = await findEligibleTablesForRelatorio(interaction.user.id, interaction.user.username, isStaff, docControle);
        if (mesasAbertas.length === 0) {
          const msg = isStaff ? 'Nenhuma mesa registrada encontrada pendente de finalização.' : 'Você não possui mesas registradas pendentes de finalização.';
          await interaction.editReply(msg);
          return;
        }

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

        if (!interaction.client.pendingRelatorios) { interaction.client.pendingRelatorios = new Map(); }
        interaction.client.pendingRelatorios.set(interaction.id, {
          step: 'select_mesa', options: options, interactionId: interaction.id,
          mestreId: interaction.user.id, 
          isStaffExecutor: isStaff 
        });

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

    if (action === 'relatorio_select_mesa') {
      try {
          await interaction.deferUpdate(); 
          const state = interaction.client.pendingRelatorios.get(originalInteractionId);
          if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] }))) {
            return;
          }
          const selectedMessageId = interaction.values[0]; 

          await docControle.loadInfo();
          const sheetHistorico = docControle.sheetsByTitle['Historico'];
          if (!sheetHistorico) throw new Error("Aba 'Historico' não encontrada.");
          await sheetHistorico.loadHeaderRow(1);
          const rows = await sheetHistorico.getRows();
          const mesaRow = rows.find(r => r.get('ID da Mensagem') === selectedMessageId);
          if (!mesaRow) { throw new Error('Linha da mesa selecionada não encontrada.'); }

          // Extrai jogadores da linha (F-K)
          const playerInfos = []; 
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
                  playerInfos.push({ tag, char, level, originalColIndex: i }); 
              }
          }
          if (playerInfos.length === 0) { throw new Error('Nenhum jogador encontrado na linha da mesa.'); }

          const playerTags = playerInfos.map(p => p.tag); 
          const playerIds = await lookupIds(playerTags); 
          const tagToIdMap = new Map(); 
          playerTags.forEach((tag, index) => { 
              tagToIdMap.set(tag.toLowerCase(), playerIds[index] ? String(playerIds[index]) : null);
          });

          state.players = playerInfos.map(pInfo => ({ 
              tag: pInfo.tag,
              char: pInfo.char,
              level: pInfo.level,
              id: tagToIdMap.get(pInfo.tag.toLowerCase()) || null, 
              originalColIndex: pInfo.originalColIndex, 
              items: [], 
              itemsData: {}, 
              extraGold: 0 
          }));

          state.step = 'input_player_drops'; 
          state.selectedMessageId = selectedMessageId; 
          state.currentPlayerIndex = 0; 

          const needsDropInput = state.options.dropItens || state.options.dropMateriais || state.options.dropErvas || state.options.dropPocoes || state.options.dropMisc;
          
          if (needsDropInput || !state.options.naoRolarLoot) { 
              const currentPlayer = state.players[0]; 
              const playerIdentifier = `${currentPlayer.tag} (${currentPlayer.char} - Nv ${currentPlayer.level})`;
              const dropButtons = [];
              if (state.options.dropItens) { dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_item|${originalInteractionId}|0`).setLabel('Itens').setStyle(ButtonStyle.Secondary)); } 
              if (state.options.dropMateriais) { dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_material|${originalInteractionId}|0`).setLabel('Materiais').setStyle(ButtonStyle.Secondary)); } 
              if (state.options.dropErvas) { dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_erva|${originalInteractionId}|0`).setLabel('Ervas').setStyle(ButtonStyle.Secondary)); } 
              if (state.options.dropPocoes) { dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_pocao|${originalInteractionId}|0`).setLabel('Poções').setStyle(ButtonStyle.Secondary)); } 
              if (state.options.dropMisc) { dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_misc|${originalInteractionId}|0`).setLabel('Misc').setStyle(ButtonStyle.Secondary)); } 
              if (!state.options.naoRolarLoot) {
                dropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_gold|${originalInteractionId}|0`).setLabel('Gold Extra').setStyle(ButtonStyle.Secondary));
              }
              
              const nextButtonLabel = state.players.length > 1 ? 'Próximo Jogador' : 'Finalizar Drops'; 
              
              // <<< CORREÇÃO 2: Suporte para Múltiplas Linhas de Botões >>>
              const row1 = new ActionRowBuilder().addComponents(dropButtons.slice(0, 5)); 
              const row2Components = dropButtons.slice(5); 
              row2Components.push(new ButtonBuilder().setCustomId(`relatorio_next_player|${originalInteractionId}|0`).setLabel(nextButtonLabel).setStyle(ButtonStyle.Success));
              const row2 = new ActionRowBuilder().addComponents(row2Components);

              await interaction.editReply({ 
                  content: `**Adicionando Drops para:** ${playerIdentifier}\n\nUse os botões para adicionar os drops que este jogador recebeu. Clique no botão verde quando terminar para este jogador.`,
                  components: [row1, row2] // <<< CORREÇÃO 2
              });
              const dropInputMsg = await interaction.fetchReply(); 
              state.dropInputMessageId = dropInputMsg.id; 

          } else {
              // --- Pula direto para a finalização (sem drops E ignorando loot) ---
              await interaction.editReply({ content: "Mesa selecionada. Gerando relatório final...", components: [] }); 
              
              await handleRelatorioFinalization(state, docControle, interaction.client); 

              interaction.client.pendingRelatorios.delete(originalInteractionId); 
              await interaction.followUp({ content: 'Relatório gerado e mesa finalizada com sucesso (sem drops inputados)!', flags: [MessageFlagsBitField.Flags.Ephemeral] }); 
          }

      } catch (error) {
          console.error("Erro no handleSelect (relatorio_select_mesa):", error);
          const errorMessage = `Erro ao processar seleção de mesa: ${error.message}`.substring(0,1900);
          if (interaction.replied || interaction.deferred) { await interaction.editReply({ content: errorMessage, components: [] }).catch(console.error); }
          else { await interaction.reply({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error); }
      }
    } // Fim if relatorio_select_mesa
  }, // Fim handleSelect

  // 5. GERENCIADOR DE MODAIS
  async handleModal(interaction) {
    const [action, originalInteractionOrMessageId, playerIndexStr] = interaction.customId.split('|'); 

    // --- Modal de Registro de Drops POR JOGADOR ---
    if (action.startsWith('modal_relatorio_') && action !== 'modal_relatorio_gold' && action !== 'modal_relatorio') { 
      const originalInteractionId = originalInteractionOrMessageId;
      const playerIndex = parseInt(playerIndexStr); 

      await interaction.deferUpdate(); 
      const state = interaction.client.pendingRelatorios.get(originalInteractionId);
      
      if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] })) || isNaN(playerIndex) || playerIndex >= state.players.length || playerIndex < 0) { 
        await interaction.followUp({ content: 'Formulário inválido/expirado ou jogador não encontrado.', flags: [MessageFlagsBitField.Flags.Ephemeral] }); 
        return;
      }
      const input = interaction.fields.getTextInputValue('drop_input'); 
      if (!input || input.trim() === '') {
          await interaction.followUp({ content: 'Nenhum item foi digitado.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
          return;
      }

      const items = parseItemInput(input); 
      let sheetName = ''; let itemTypeKey = ''; 
      let skipValidation = false; 

      if (action === 'modal_relatorio_item') { sheetName = 'Itens'; itemTypeKey = 'itens'; } 
      else if (action === 'modal_relatorio_material') { sheetName = 'Materiais'; itemTypeKey = 'materiais'; } 
      else if (action === 'modal_relatorio_erva') { sheetName = 'Ervas'; itemTypeKey = 'ervas'; } 
      else if (action === 'modal_relatorio_pocao') { sheetName = 'Poções'; itemTypeKey = 'pocoes'; } 
      else if (action === 'modal_relatorio_misc') { sheetName = 'Misc'; itemTypeKey = 'misc'; skipValidation = true; } 
      else { await interaction.followUp({ content: 'Tipo de modal desconhecido.', flags: [MessageFlagsBitField.Flags.Ephemeral] }); return; } 

      try {
        if (!skipValidation) { 
            const notFound = await validateItems(items, sheetName, docCraft); 
            if (notFound.length > 0) { 
              await interaction.followUp({ content: `**Erro:** Itens não encontrados em "${sheetName}":\n\`\`\`${notFound.join('\n')}\`\`\`\nCorrija e tente adicionar novamente.`, flags: [MessageFlagsBitField.Flags.Ephemeral] }); 
              return;
            }
        }

        const currentPlayer = state.players[playerIndex]; 
        if (!currentPlayer.itemsData) currentPlayer.itemsData = {}; 
        currentPlayer.itemsData[itemTypeKey] = items; 

        if (!state.dropInputMessageId) { throw new Error("ID da mensagem de input não encontrado."); } 
        const dropInputMsg = await interaction.channel.messages.fetch(state.dropInputMessageId); 
        if (!dropInputMsg) { throw new Error("Mensagem de input não encontrada."); } 

        // Remonta a string de drops
        let currentDropsString = "**Drops Adicionados para este jogador:**\n"; 
        let playerHasDrops = false; 
        const dropTypes = { itens:'Itens', materiais:'Materiais', ervas:'Ervas', pocoes:'Poções', misc:'Misc'}; 
        for(const key in dropTypes) { 
            if (currentPlayer.itemsData && currentPlayer.itemsData[key] && currentPlayer.itemsData[key].length > 0) { 
                playerHasDrops = true; 
                currentDropsString += `${dropTypes[key]}: \`${currentPlayer.itemsData[key].map(i => `${i.amount}x ${i.name}`).join(', ')}\`\n`; 
            }
        }
        if (currentPlayer.extraGold && currentPlayer.extraGold > 0) { 
            currentDropsString += `Gold Extra: \`${currentPlayer.extraGold.toFixed(2)} PO\`\n`; 
            playerHasDrops = true; 
        }
        if (!playerHasDrops) currentDropsString += "Nenhum"; 

        const contentBase = dropInputMsg.content.split('\n\n**Drops Adicionados para este jogador:**')[0]; 

        await dropInputMsg.edit({ 
            content: `${contentBase}\n\n${currentDropsString}`,
            components: dropInputMsg.components 
        });
        //await interaction.followUp({ content: `${sheetName} adicionados para ${currentPlayer.tag}!`, flags: [MessageFlagsBitField.Flags.Ephemeral] }); 

      } catch (e) {
        console.error("Erro ao processar modal de drop de relatório:", e);
        const errorMessage = `Erro ao processar ${sheetName}: ${e.message}`.substring(0,1900);
        await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      }
    } // Fim if modal_relatorio_

    // +++ Modal de Gold Extra +++
    else if (action === 'modal_relatorio_gold') { 
      const originalInteractionId = originalInteractionOrMessageId;
      const playerIndex = parseInt(playerIndexStr); 

      await interaction.deferUpdate(); 
      const state = interaction.client.pendingRelatorios.get(originalInteractionId);
      if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] })) || isNaN(playerIndex) || playerIndex >= state.players.length || playerIndex < 0) {
        await interaction.followUp({ content: 'Formulário inválido/expirado ou jogador não encontrado.', flags: [MessageFlagsBitField.Flags.Ephemeral] }); 
        return;
      }

      const input = interaction.fields.getTextInputValue('gold_input'); 
      const goldAmount = parseFloat(input.replace(',', '.')); 

      if (isNaN(goldAmount) || goldAmount < 0) { 
          await interaction.followUp({ content: `Valor inválido: "${input}". Por favor, insira apenas números (ex: 150 ou 50.25).`, flags: [MessageFlagsBitField.Flags.Ephemeral] });
          return;
      }

      const currentPlayer = state.players[playerIndex]; 
      currentPlayer.extraGold = goldAmount; 

      if (!state.dropInputMessageId) { throw new Error("ID da mensagem de input não encontrado."); } 
      const dropInputMsg = await interaction.channel.messages.fetch(state.dropInputMessageId); 
      if (!dropInputMsg) { throw new Error("Mensagem de input não encontrada."); } 

      // Remonta a string de drops
      let currentDropsString = "**Drops Adicionados para este jogador:**\n"; 
      let playerHasDrops = false; 
      const dropTypes = { itens:'Itens', materiais:'Materiais', ervas:'Ervas', pocoes:'Poções', misc:'Misc'}; 
      for(const key in dropTypes) { 
          if (currentPlayer.itemsData && currentPlayer.itemsData[key] && currentPlayer.itemsData[key].length > 0) { 
              playerHasDrops = true; 
              currentDropsString += `${dropTypes[key]}: \`${currentPlayer.itemsData[key].map(i => `${i.amount}x ${i.name}`).join(', ')}\`\n`; 
          }
      }
      if (currentPlayer.extraGold && currentPlayer.extraGold > 0) { 
          currentDropsString += `Gold Extra: \`${currentPlayer.extraGold.toFixed(2)} PO\`\n`; 
          playerHasDrops = true; 
      }
      if (!playerHasDrops) currentDropsString += "Nenhum"; 

      const contentBase = dropInputMsg.content.split('\n\n**Drops Adicionados para este jogador:**')[0]; 

      await dropInputMsg.edit({ 
          content: `${contentBase}\n\n${currentDropsString}`,
          components: dropInputMsg.components 
      });
      //await interaction.followUp({ content: `Gold extra de ${goldAmount.toFixed(2)} PO adicionado para ${currentPlayer.tag}!`, flags: [MessageFlagsBitField.Flags.Ephemeral] }); 
    }

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
        
      // <<< CORREÇÃO 0: Adiciona o catch que estava faltando >>>
      } catch (e) { 
          console.error("Erro ao salvar relatório (modal_relatorio):", e);
          const errorMessage = `Ocorreu um erro ao salvar o relatório: ${e.message}`.substring(0,1900);
          await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      }
    } // Fim if modal_relatorio
  }, // Fim handleModal

  // 6. GERENCIADOR DE BOTÕES
  async handleButton(interaction) {
    const customIdParts = interaction.customId.split('|'); 
    const action = customIdParts[0]; 
    const originalInteractionId = customIdParts[1]; 
    const playerIndexStr = customIdParts[2]; 
    const logMessageId = customIdParts[2]; 

    let state;
    if (action.startsWith('relatorio_')) { 
        state = interaction.client.pendingRelatorios.get(originalInteractionId); 
        if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] }))) { 
            return;
        }
    } else if (action === 'escrever_relatorio') { 
        // Lógica específica abaixo
    } else {
        console.log(`[INFO relatorio.js] Ignorando botão com ação não relacionada: ${action}`); 
        return;
    }


    try {
        // --- Botões para ABRIR MODAL de drops por jogador ---
        if (action.startsWith('relatorio_add_')) { 
          const playerIndex = parseInt(playerIndexStr); 
          if (isNaN(playerIndex) || playerIndex !== state.currentPlayerIndex) { 
              await interaction.reply({ content: 'Botão inválido ou fora de ordem.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
              return;
          }

          let modal; let itemType = ''; 
          if (action === 'relatorio_add_item') { itemType = 'item'; modal = new ModalBuilder().setCustomId(`modal_relatorio_${itemType}|${originalInteractionId}|${playerIndex}`).setTitle(`Adicionar Itens para ${state.players[playerIndex].tag}`); } 
          else if (action === 'relatorio_add_material') { itemType = 'material'; modal = new ModalBuilder().setCustomId(`modal_relatorio_${itemType}|${originalInteractionId}|${playerIndex}`).setTitle(`Adicionar Materiais para ${state.players[playerIndex].tag}`); } 
          else if (action === 'relatorio_add_erva') { itemType = 'erva'; modal = new ModalBuilder().setCustomId(`modal_relatorio_${itemType}|${originalInteractionId}|${playerIndex}`).setTitle(`Adicionar Ervas para ${state.players[playerIndex].tag}`); } 
          else if (action === 'relatorio_add_pocao') { itemType = 'pocao'; modal = new ModalBuilder().setCustomId(`modal_relatorio_${itemType}|${originalInteractionId}|${playerIndex}`).setTitle(`Adicionar Poções para ${state.players[playerIndex].tag}`); } // <<< CORREÇÃO 
          else if (action === 'relatorio_add_misc') { itemType = 'misc'; modal = new ModalBuilder().setCustomId(`modal_relatorio_${itemType}|${originalInteractionId}|${playerIndex}`).setTitle(`Adicionar Misc para ${state.players[playerIndex].tag}`); } 
          else if (action === 'relatorio_add_gold') { 
            modal = new ModalBuilder().setCustomId(`modal_relatorio_gold|${originalInteractionId}|${playerIndex}`).setTitle(`Gold Extra para ${state.players[playerIndex].tag}`); 
            modal.addComponents(new ActionRowBuilder().addComponents( 
              new TextInputBuilder().setCustomId('gold_input').setLabel("Valor (Ex: 150 ou 50.25)").setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('0') 
            ));
          }

          // <<< CORREÇÃO 3: Não adiciona 'drop_input' ao modal de gold >>>
          if (modal && action !== 'relatorio_add_gold') { 
              modal.addComponents(new ActionRowBuilder().addComponents( 
                new TextInputBuilder().setCustomId('drop_input').setLabel(`Itens/Materiais/Etc (Ex: Item A, 3x Item B)`).setStyle(TextInputStyle.Paragraph).setRequired(true) 
              ));
          }
          
          if (modal) { 
            await interaction.showModal(modal); 
          } else {
              await interaction.reply({ content: 'Tipo de drop inválido.', flags: [MessageFlagsBitField.Flags.Ephemeral] }); 
          }
        } // Fim relatorio_add_

        // --- Botão Próximo Jogador / Finalizar Drops ---
        else if (action === 'relatorio_next_player') { 
            const playerIndex = parseInt(playerIndexStr); 
            if (isNaN(playerIndex) || playerIndex !== state.currentPlayerIndex) { 
                await interaction.reply({ content: 'Botão inválido ou fora de ordem.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
                return;
            }
            await interaction.deferUpdate(); 

            state.currentPlayerIndex++; 

            if (state.currentPlayerIndex < state.players.length) { 
                // --- Prepara para o PRÓXIMO jogador ---
                const nextPlayer = state.players[state.currentPlayerIndex]; 
                const nextPlayerIndex = state.currentPlayerIndex; 
                const nextPlayerIdentifier = `${nextPlayer.tag} (${nextPlayer.char} - Nv ${nextPlayer.level})`; 

                const nextDropButtons = []; 
                if (state.options.dropItens) { nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_item|${originalInteractionId}|${nextPlayerIndex}`).setLabel('Itens').setStyle(ButtonStyle.Secondary)); } 
                if (state.options.dropMateriais) { nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_material|${originalInteractionId}|${nextPlayerIndex}`).setLabel('Materiais').setStyle(ButtonStyle.Secondary)); } 
                if (state.options.dropErvas) { nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_erva|${originalInteractionId}|${nextPlayerIndex}`).setLabel('Ervas').setStyle(ButtonStyle.Secondary)); } 
                if (state.options.dropPocoes) { nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_pocao|${originalInteractionId}|${nextPlayerIndex}`).setLabel('Poções').setStyle(ButtonStyle.Secondary)); } 
                if (state.options.dropMisc) { nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_misc|${originalInteractionId}|${nextPlayerIndex}`).setLabel('Misc').setStyle(ButtonStyle.Secondary)); } 
                if (!state.options.naoRolarLoot) {
                  nextDropButtons.push(new ButtonBuilder().setCustomId(`relatorio_add_gold|${originalInteractionId}|${nextPlayerIndex}`).setLabel('Gold Extra').setStyle(ButtonStyle.Secondary)); 
                }
                
                const nextButtonLabel = (nextPlayerIndex === state.players.length - 1) ? 'Finalizar Drops' : 'Próximo Jogador'; 
                
                // <<< CORREÇÃO 2: Lógica de múltiplas linhas para 'nextDropButtons' >>>
                const nextRow1 = new ActionRowBuilder().addComponents(nextDropButtons.slice(0, 5));
                const nextRow2Components = nextDropButtons.slice(5);
                nextRow2Components.push(new ButtonBuilder().setCustomId(`relatorio_next_player|${originalInteractionId}|${nextPlayerIndex}`).setLabel(nextButtonLabel).setStyle(ButtonStyle.Success));
                const nextRow2 = new ActionRowBuilder().addComponents(nextRow2Components);

                await interaction.editReply({ 
                    content: `**Adicionando Drops para:** ${nextPlayerIdentifier}\n\nUse os botões para adicionar os drops que este jogador recebeu. Clique no botão verde quando terminar para este jogador.\n\n**Drops Adicionados para este jogador:**\nNenhum`, 
                    components: [nextRow1, nextRow2] // <<< CORREÇÃO 2
                });

            } else {
                // --- FINALIZAÇÃO: Todos os jogadores processados ---
                await interaction.editReply({ content: "Todos os drops inputados. Gerando relatório final...", components: [] }); 

                await handleRelatorioFinalization(state, docControle, interaction.client); 

                interaction.client.pendingRelatorios.delete(originalInteractionId); 
                await interaction.followUp({ content: 'Relatório gerado e mesa finalizada com sucesso!', flags: [MessageFlagsBitField.Flags.Ephemeral] }); 
            }
        }

        // --- Botão de ESCREVER RELATÓRIO (Reutilizado do loot.js) ---
        else if (action === 'escrever_relatorio') { 
            const [_, mestreId] = interaction.customId.split('|'); 
            if (!(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [mestreId] }))) { 
              return;
            }

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