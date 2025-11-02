// commands/loot.js
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
  userMention
} = require('discord.js');

// IMPORTA O NOVO UTILITÁRIO DE AUTENTICAÇÃO
const { checkAuth, AuthLevels } = require('../utils/auth.js');

// Importações de Lógica - Google e Cálculo
const { docControle, docCraft, lookupIds, getPlayerTokenCount } = require('../utils/google.js');
// Importações de Lógica - Utilitários de Itens
const { validateItems, parseItemInput } = require('../utils/itemUtils.js');
// Importações de Lógica - Utilitários de Seleção/Devolução de Player
const { processItemSelection, processItemReturn, getAvailableDrops } = require('../utils/playerLootUtils.js');
// Importações de Lógica - Utilitários Gerais E LÓGICA DE BOTÕES
const {
  findEligibleTables,
  formatPlayerList,         
  formatDropsList,          
  buildLootMessageContent,  
  handleLootCalculation,    
  handlePegarLootClick,     
  handleEncerrarMesaClick   
} = require('../utils/lootUtils.js');

module.exports = {

  // 1. DEFINIÇÃO DO COMANDO
  data: new SlashCommandBuilder()
    .setName('loot')
    .setDescription('Inicia o processo de registro de loot de uma mesa finalizada.')
    .addStringOption(option =>
      option.setName('nome')
        .setDescription('Opcional: O nome/título da mesa para o anúncio.')
        .setRequired(false)
    )
    .addBooleanOption(option => option.setName('nao_rolar_loot_com_vantagem').setDescription('Opcional: A rolagem de gold será SEM vantagem? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_mundanos').setDescription('Opcional: A mesa teve drop de Itens Mundanos? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_itens').setDescription('Opcional: A mesa teve drop de Itens Mágicos? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_materiais').setDescription('Opcional: A mesa teve drop de Materiais? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_ervas').setDescription('Opcional: A mesa teve drop de Ervas? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_pocoes').setDescription('Opcional: A mesa teve drop de Poções? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_misc').setDescription('Opcional: A mesa teve drop de Itens "Misc"? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('gold_extra').setDescription('Opcional: A mesa teve drop de Gold Extra? (Habilita input)').setRequired(false))
    .addBooleanOption(option => option.setName('nao_rolar_loot').setDescription('Opcional: Ignorar a rolagem de gold para esta mesa? (Default: False)').setRequired(false)),

  // 2. QUAIS INTERAÇÕES ESTE ARQUIVO GERENCIA
  selects: ['loot_select_mesa', 'loot_item_select', 'loot_item_select_paginated'],
  modals: [
    'modal_loot_mundanos',
    'modal_loot_itens',
    'modal_loot_materiais',
    'modal_loot_ervas',
    'modal_loot_pocoes',
    'modal_loot_misc',
    'modal_loot_gold_extra', // <<< ADICIONADO
    'modal_relatorio'
  ],
  buttons: [
    'loot_add_mundanos',
    'loot_add_itens',
    'loot_add_materiais',
    'loot_add_ervas',
    'loot_add_pocoes',
    'loot_add_misc',
    'loot_add_gold_extra', // <<< ADICIONADO
    'loot_calcular',
    'pegar_loot',
    'toggle_double_gold', 
    'finalizar_loot',
    'devolver_loot',
    'encerrar_mesa',
    'escrever_relatorio',
    'loot_page_prev',
    'loot_page_next'
  ],

  // 3. EXECUÇÃO DO COMANDO PRINCIPAL (/loot)
  async execute(interaction) {
    const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.NARRADOR, AuthLevels.STAFF] });
    if (!hasAuth) {
      return;
    }
    await interaction.deferReply();

    try {
        const options = {
          nomeMesa: interaction.options.getString('nome') || '',
          nao_rolar_loot_com_vantagem: interaction.options.getBoolean('nao_rolar_loot_com_vantagem') ?? false,
          dropMundanos: interaction.options.getBoolean('drop_de_mundanos') ?? false,
          dropItens: interaction.options.getBoolean('drop_de_itens') ?? false,
          dropMateriais: interaction.options.getBoolean('drop_de_materiais') ?? false,
          dropErvas: interaction.options.getBoolean('drop_de_ervas') ?? false,
          dropPocoes: interaction.options.getBoolean('drop_de_pocoes') ?? false,
          dropMisc: interaction.options.getBoolean('drop_de_misc') ?? false,
          goldExtra: interaction.options.getBoolean('gold_extra') ?? false, 
          naoRolarLoot: interaction.options.getBoolean('nao_rolar_loot') ?? false,
        };

        const mesasAbertas = await findEligibleTables(interaction.user.username, docControle);

        if (mesasAbertas.length === 0) {
          await interaction.editReply('Você não possui mesas registradas que estejam pendentes de finalização. Já usou o `/registrar-mesa` ?');
          return;
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`loot_select_mesa|${interaction.id}`)
            .setPlaceholder('Selecione a mesa para registrar o loot');

        mesasAbertas.slice(0, 25).forEach(row => { 
            const data = row.get('Data') || '??/??/??';
            const horario = row.get('Horário') || '??:??';
            const tier = row.get('Tier')?.replace(/'/,'') || '?';
            const nomeMesa = row.get('Nome da Mesa') || '';
            const messageId = row.get('ID da Mensagem');
            if (!messageId) {
                console.warn(`[AVISO /loot execute] Mesa encontrada sem ID da Mensagem na linha ${row.rowIndex}. Pulando.`);
                return; 
            }
            let label = `Mesa ${data} ${horario} (Tier ${tier})`;
            if (nomeMesa) label = `${nomeMesa} (${data} ${horario})`;
            const finalLabel = label.length > 100 ? label.substring(0, 97) + '...' : label;
            selectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(finalLabel)
                    .setValue(messageId) 
            );
        });
         if (selectMenu.options.length === 0) {
            await interaction.editReply('Não encontrei mesas válidas (com ID) para listar.');
            return;
        }

        if (!interaction.client.pendingLoots) {
          interaction.client.pendingLoots = new Map();
        }
        
        interaction.client.pendingLoots.set(interaction.id, {
          step: 'select_mesa',
          options: options,
          interactionId: interaction.id,
          mestreId: interaction.user.id
        });

        const rowComponent = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.editReply({
            content: 'Selecione abaixo qual das suas mesas você deseja registrar o loot:',
            components: [rowComponent],
        });

    } catch (error) { 
        console.error("Erro no comando /loot (execute):", error);
        const errorMessage = `Ocorreu um erro ao iniciar o comando loot: ${error.message}`.substring(0,1900);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: errorMessage, components: [] }).catch(console.error);
        } else {
            await interaction.reply({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
        }
    }
  }, // Fim do execute

  // 4. GERENCIADOR DE SELECT MENUS
  async handleSelect(interaction) {
    //const [action, originalInteractionOrMessageId] = interaction.customId.split('|');
    const [action, originalInteractionOrMessageId, pageStr] = interaction.customId.split('|');

    // --- Seleção da Mesa ---
    if (action === 'loot_select_mesa') {
      const originalInteractionId = originalInteractionOrMessageId;
      try {
          await interaction.deferUpdate(); 
          const state = interaction.client.pendingLoots.get(originalInteractionId);
          if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] }))) {
            return;
          }
          const selectedMessageId = interaction.values[0]; 

          state.step = 'input_drops';
          state.selectedMessageId = selectedMessageId;
          state.drops = { mundanos: [], itens: [], materiais: [], ervas: [], pocoes: [], misc: [], gold_extra: [] }; 

          const buttons = [];
          if (state.options.dropMundanos) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_mundanos|${originalInteractionId}`).setLabel('Adicionar Mundanos').setStyle(ButtonStyle.Secondary)); }
          if (state.options.dropItens) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_itens|${originalInteractionId}`).setLabel('Adicionar Itens').setStyle(ButtonStyle.Secondary)); }
          if (state.options.dropMateriais) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_materiais|${originalInteractionId}`).setLabel('Adicionar Materiais').setStyle(ButtonStyle.Secondary)); }
          if (state.options.dropErvas) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_ervas|${originalInteractionId}`).setLabel('Adicionar Ervas').setStyle(ButtonStyle.Secondary)); }
          if (state.options.dropPocoes) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_pocoes|${originalInteractionId}`).setLabel('Adicionar Poções').setStyle(ButtonStyle.Secondary)); }
          if (state.options.dropMisc) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_misc|${originalInteractionId}`).setLabel('Adicionar Misc').setStyle(ButtonStyle.Secondary)); }
          if (state.options.goldExtra) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_gold_extra|${originalInteractionId}`).setLabel('Adicionar Gold Extra').setStyle(ButtonStyle.Secondary)); }
          
          buttons.push(new ButtonBuilder()
              .setCustomId(`loot_calcular|${originalInteractionId}`)
              .setLabel(buttons.length > 0 ? 'Finalizar Drops e Calcular Loot' : 'Calcular Loot de Gold')
              .setStyle(ButtonStyle.Success));

          const row1 = new ActionRowBuilder().addComponents(buttons.slice(0, 5));
          const row2 = buttons.length > 5 ? new ActionRowBuilder().addComponents(buttons.slice(5)) : null;
          
          const components = [row1];
          if (row2) components.push(row2);

          await interaction.editReply({
            content: 'Mesa selecionada. Adicione os drops (com * no final se forem pré-definidos) e depois clique no botão verde para calcular.',
            components: components 
          });

          const dropsMessage = await interaction.fetchReply();
          state.dropsMessageId = dropsMessage.id;

      } catch (error) {
          console.error("Erro no handleSelect (loot_select_mesa):", error);
          const errorMessage = `Ocorreu um erro ao selecionar a mesa: ${error.message}`.substring(0,1900);
          if (interaction.replied || interaction.deferred) {
              await interaction.editReply({ content: errorMessage, components: [] }).catch(console.error);
          } else {
              await interaction.reply({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
          }
      }
    } // Fim if loot_select_mesa

    // --- Seleção de Itens ---
    else if (action === 'loot_item_select') {
      const lootMessageId = originalInteractionOrMessageId; 
      await interaction.deferUpdate(); 

      try {
          const state = interaction.client.pendingLoots.get(lootMessageId);
          if (!state) { console.warn(`[AVISO Loot Select Item] State não encontrado para ${lootMessageId}.`); return; }
          const player = state.players.find(p => p.id === interaction.user.id);
          if (!player) { console.warn(`[AVISO Loot Select Item] Usuário ${interaction.user.id} não encontrado em loot ${lootMessageId}.`); return; }

          const selectedItemValues = interaction.values || []; 

          processItemSelection(state, player, selectedItemValues); 

          const lootMessage = await interaction.channel.messages.fetch(lootMessageId);
          if (!lootMessage) { throw new Error("Mensagem pública de loot não encontrada para editar."); }

          const playersString = formatPlayerList(state.players, true, true); 
          const dropsString = formatDropsList(getAvailableDrops(state));
          const newMessageContent = buildLootMessageContent(state, playersString, dropsString); 

          await lootMessage.edit({ content: newMessageContent, components: lootMessage.components });

      } catch (error) {
          console.error("Erro no handleSelect (loot_item_select):", error);
          interaction.followUp({ content: `Ocorreu um erro ao processar sua seleção: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(e => {}); 
      }
    } // Fim else if loot_item_select

    // --- Seleção de Itens (Modo Paginado > 25) ---
    else if (action === 'loot_item_select_paginated') {
      const lootMessageId = originalInteractionOrMessageId;
      const page = parseInt(pageStr) || 0;
      await interaction.deferUpdate();
  
      try {
          const state = interaction.client.pendingLoots.get(lootMessageId);
          if (!state) { console.warn(`[AVISO Loot Paginated] State não encontrado para ${lootMessageId}.`); return; }
          const player = state.players.find(p => p.id === interaction.user.id);
          if (!player) { console.warn(`[AVISO Loot Paginated] Usuário ${interaction.user.id} não encontrado em loot ${lootMessageId}.`); return; }
  
          // Importa os novos utilitários
          const { processPaginatedSelection } = require('../utils/playerLootUtils.js');
          const { buildPaginatedSelectMenu } = require('../utils/lootSelectMenuManager.js');
  
          // Chama a nova função de processamento (que atualiza state.allDrops e player.items)
          processPaginatedSelection(state, player, interaction.values, page);
  
          // Atualiza a mensagem principal (para o log de fundo)
          const lootMessage = await interaction.channel.messages.fetch(lootMessageId);
          if (lootMessage) {
              const playersString = formatPlayerList(state.players, true, true); 
              const dropsString = formatDropsList(getAvailableDrops(state));
              const newMessageContent = buildLootMessageContent(state, playersString, dropsString); 
              await lootMessage.edit({ content: newMessageContent, components: lootMessage.components });
          }
  
          // Re-renderiza o menu da página atual (para mostrar os itens selecionados e atualizar os botões)
          // (interaction.message é a mensagem efêmera do "Pegar Loot")
          // +++ ATUALIZADO: Busca tokens para passar para o construtor +++
          const currentTokens = await getPlayerTokenCount(player.tag);
          const canAffordDouble = currentTokens >= 4;
          const { content, components } = buildPaginatedSelectMenu(state, player, lootMessageId, page, currentTokens, canAffordDouble);
          await interaction.editReply({ content: content, components: components });
  
      } catch (error) {
          console.error("Erro no handleSelect (loot_item_select_paginated):", error);
          interaction.followUp({ content: `Ocorreu um erro ao processar sua seleção: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(e => {});
      }
    } // Fim else if loot_item_select_paginated

  }, // Fim handleSelect

  // 5. GERENCIADOR DE MODAIS
  async handleModal(interaction) {
    const [action, originalInteractionOrMessageId] = interaction.customId.split('|');

    // --- Modal de Registro de Drops ---
    if (action.startsWith('modal_loot_')) {
      const originalInteractionId = originalInteractionOrMessageId;
      await interaction.deferUpdate(); 
      const state = interaction.client.pendingLoots.get(originalInteractionId);
      if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] }))) {
        return;
      }
      const input = interaction.fields.getTextInputValue('loot_input');
      if (!input || input.trim() === '') {
          await interaction.followUp({ content: 'Nenhum item foi digitado.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
          return;
      }

      let sheetName = ''; 
      let dropType = ''; 
      let isMisc = false;
      
      if (action === 'modal_loot_mundanos') { sheetName = 'Itens Mundanos'; dropType = 'mundanos'; }
      else if (action === 'modal_loot_itens') { sheetName = 'Itens'; dropType = 'itens'; }
      else if (action === 'modal_loot_materiais') { sheetName = 'Materiais'; dropType = 'materiais'; }
      else if (action === 'modal_loot_ervas') { sheetName = 'Ervas'; dropType = 'ervas'; }
      else if (action === 'modal_loot_pocoes') { sheetName = 'Poções'; dropType = 'pocoes'; }
      else if (action === 'modal_loot_misc') { sheetName = 'Misc'; dropType = 'misc'; isMisc = true; } 
      // +++ BLOCO ADICIONADO: Lógica para o novo Modal de Gold Extra +++
      else if (action === 'modal_loot_gold_extra') {
          dropType = 'gold_extra';
          const items = [];
          // Regex ATUALIZADO: Aceita "100" ou "100.50", com ou sem PO, com ou sem *
          const goldRegex = /(?:(\d+)\s*x\s*)?(\d+(?:[\.,]\d+)?)(?:\s*PO)?(\*?)/gi;
          let match;
          
          while ((match = goldRegex.exec(input)) !== null) {
              const amount = parseInt(match[1] || '1', 10); // Quantidade (ex: 2x)
              const value = parseFloat(match[2].replace(',', '.')); // Valor (ex: 100.50)
              const isPredefined = match[3] === '*'; // Se tem o *
              const itemName = `${value.toFixed(2)} PO`; // <<< CORREÇÃO: Garante "PO" e casas decimais

              // Adiciona ao array de itens
              items.push({
                  name: itemName,
                  validationName: itemName, 
                  amount: amount, 
                  isPredefined: isPredefined, 
                  isMisc: true 
              });
          }
          
          if (items.length === 0) {
              await interaction.followUp({ content: 'Formato inválido. Use `100 PO`, `2x 100*` ou `50.25`.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
              return;
          }
          
          state.drops[dropType] = items;
          sheetName = 'Gold Extra'; 
          isMisc = true; 
      }
      else {
          console.warn("Modal de loot desconhecido:", action);
          await interaction.followUp({ content: 'Tipo de modal desconhecido.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
          return;
      }
      
      let items;
      if (action !== 'modal_loot_gold_extra') {
          items = parseItemInput(input, isMisc); 
      }

      try {
        if (!isMisc) { 
            const notFound = await validateItems(items, sheetName, docCraft);
            if (notFound.length > 0) {
              await interaction.followUp({
                content: `**Erro:** Itens não encontrados em "${sheetName}":\n\`\`\`${notFound.join('\n')}\`\`\`\nCorrija e tente adicionar novamente.`,
                flags: [MessageFlagsBitField.Flags.Ephemeral]
              });
              return;
            }
        }

        if (action !== 'modal_loot_gold_extra') {
            state.drops[dropType] = items;
        }

        if (!state.dropsMessageId) { throw new Error("ID da mensagem de drops não encontrado no estado."); }
        const dropsMessage = await interaction.channel.messages.fetch(state.dropsMessageId);
        if (!dropsMessage) { throw new Error("Mensagem de drops não encontrada para editar."); }

        let contentBase = dropsMessage.content.split('\n\n**Drops Adicionados:**')[0]; 
        const currentComponents = dropsMessage.components; 
        let dropsDisplayString = "**Drops Adicionados:**\n";
        let hasAnyDrops = false;
        
        const dropTypes = ['mundanos', 'itens', 'materiais', 'ervas', 'pocoes', 'misc', 'gold_extra'];
        dropTypes.forEach(dtype => {
            if (state.drops[dtype] && Array.isArray(state.drops[dtype]) && state.drops[dtype].length > 0) {
                hasAnyDrops = true;
                const itemsString = state.drops[dtype]
                    .filter(i => i && i.name && typeof i.amount === 'number' && i.amount > 0) 
                    .map(i => `${i.amount}x ${i.name}${i.isPredefined ? '*' : ''}`) 
                    .join(', ');
                if (itemsString) { 
                    let label = dtype.charAt(0).toUpperCase() + dtype.slice(1);
                    if (dtype === 'mundanos') label = 'Itens Mundanos';
                    if (dtype === 'pocoes') label = 'Poções';
                    if (dtype === 'misc') label = 'Misc';
                    if (dtype === 'gold_extra') label = 'Gold Extra';
                    dropsDisplayString += `${label}: \`${itemsString}\`\n`;
                }
            }
        });
        if (!hasAnyDrops) dropsDisplayString += "Nenhum"; 

        await dropsMessage.edit({
          content: `${contentBase}\n\n${dropsDisplayString}`,
          components: currentComponents
        });
        //await interaction.followUp({ content: `${sheetName} adicionados/atualizados com sucesso!`, flags: [MessageFlagsBitField.Flags.Ephemeral] });

      } catch (e) {
        console.error("Erro ao validar/processar itens do modal:", e);
        const errorMessage = `Ocorreu um erro ao processar os itens: ${e.message}`.substring(0,1900);
        await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      }
    } // Fim if modal_loot_

    // --- Modal de Relatório (Final) ---
    if (action === 'modal_relatorio') {
      const logMessageId = originalInteractionOrMessageId; 
      try {
        await interaction.deferUpdate(); 
        const logMessage = await interaction.channel.messages.fetch(logMessageId);
        if (!logMessage) {
            await interaction.followUp({ content: 'Mensagem de log não encontrada.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
            return;
        }
        const relatorioText = interaction.fields.getTextInputValue('relatorio_input');
        const originalContent = logMessage.content.split('\nRelatório')[0];
        const newContent = `${originalContent}\nRelatório\n\`\`\`\n${relatorioText}\n\`\`\``;
        await logMessage.edit({ content: newContent });
      } catch (e) {
        console.error("Erro ao salvar relatório:", e);
        const errorMessage = `Ocorreu um erro ao salvar o relatório: ${e.message}`.substring(0,1900);
        await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      }
    } // Fim if modal_relatorio
  }, // Fim handleModal

  // 6. GERENCIADOR DE BOTÕES
  async handleButton(interaction) {
    const customIdParts = interaction.customId.split('|');
    const action = customIdParts[0];
    const id = customIdParts[1]; 
    const playerIdForAction = customIdParts[2]; 

    let state;
    let lootMessageId = null;
    let originalInteractionId = null;

    if (action.startsWith('loot_add_') || action === 'loot_calcular') {
        originalInteractionId = id;
        state = interaction.client.pendingLoots.get(originalInteractionId);
        if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] }))) {
            return;
        }
    } else if (['pegar_loot', 'finalizar_loot', 'devolver_loot', 'encerrar_mesa', 'toggle_double_gold'].includes(action)) {
        lootMessageId = id; 
        state = interaction.client.pendingLoots.get(lootMessageId);
        if (!state) {
            if (interaction.message) {
                await interaction.message.edit({content: interaction.message.content + "\n\n*(Sessão expirada)*", components: []}).catch(()=>{}); 
            }
            await interaction.reply({ content: 'Sessão não encontrada/expirada.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
            return; 
        }
    } else if (action === 'escrever_relatorio') {
        // Lógica específica abaixo
    } else if (action === 'loot_page_prev' || action === 'loot_page_next') {
        // Ação válida.
        // Não precisamos definir o 'state' aqui, pois a lógica de paginação
        // (que está dentro do bloco 'try' abaixo) já faz isso.
        // Isto apenas impede que a execução caia no 'else' final.
    } else {
        console.warn("Ação de botão desconhecida:", action, interaction.customId);
        if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate().catch(()=>{});
        return; 
    }

    try {
        // --- Botões para ABRIR MODAL de drops ---
        if (action.startsWith('loot_add_')) {
          originalInteractionId = id; 
          let modal; 
          if (action === 'loot_add_mundanos') {
              modal = new ModalBuilder().setCustomId(`modal_loot_mundanos|${originalInteractionId}`).setTitle('Adicionar Itens Mundanos');
               modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Itens Mundanos (Ex: 10x Flecha*, 2x Tocha)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          } else if (action === 'loot_add_itens') {
              modal = new ModalBuilder().setCustomId(`modal_loot_itens|${originalInteractionId}`).setTitle('Adicionar Itens');
              modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Itens (Ex: Item A, 3x Item B*)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          } else if (action === 'loot_add_materiais') {
              modal = new ModalBuilder().setCustomId(`modal_loot_materiais|${originalInteractionId}`).setTitle('Adicionar Materiais');
               modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Materiais (Ex: 3x Material X, Material Y*)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          } else if (action === 'loot_add_ervas') {
              modal = new ModalBuilder().setCustomId(`modal_loot_ervas|${originalInteractionId}`).setTitle('Adicionar Ervas');
               modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Ervas (Ex: Erva Z, 2x Erva W*)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          } else if (action === 'loot_add_pocoes') {
              modal = new ModalBuilder().setCustomId(`modal_loot_pocoes|${originalInteractionId}`).setTitle('Adicionar Poções');
               modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Poções (Ex: 2x Poção Cura, Poção Força*)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          } else if (action === 'loot_add_misc') { 
              modal = new ModalBuilder().setCustomId(`modal_loot_misc|${originalInteractionId}`).setTitle('Adicionar Itens Misc');
               modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Itens Misc (Ex: 1x Mapa, 1x Chave*)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          // +++ BLOCO ADICIONADO +++
          } else if (action === 'loot_add_gold_extra') {
             modal = new ModalBuilder().setCustomId(`modal_loot_gold_extra|${originalInteractionId}`).setTitle('Adicionar Gold Extra (Drops)');
              modal.addComponents(new ActionRowBuilder().addComponents(
               new TextInputBuilder().setCustomId('loot_input').setLabel("Gold Extra (Ex: 200 PO, 2x 100*, 50)").setStyle(TextInputStyle.Paragraph).setRequired(true)
             ));
          }
          
          if (modal) {
            await interaction.showModal(modal); 
          } else {
            // Este 'else' agora é desnecessário se todos os botões tiverem um modal
            console.warn(`[AVISO handleButton] Ação ${action} não correspondeu a nenhum modal.`);
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: 'Formulário não identificado.', flags: [MessageFlagsBitField.Flags.Ephemeral]});
            }
          }
        }

        // --- Botão para CALCULAR O LOOT ---
        else if (action === 'loot_calcular') {
          originalInteractionId = id; 
          await handleLootCalculation(interaction, state, originalInteractionId);
        }

        // --- Botão de PEGAR LOOT ---
        else if (action === 'pegar_loot') {
          lootMessageId = id; 
          await handlePegarLootClick(interaction, state, lootMessageId);
        }

        // --- Botão Ativar/Desativar Dobro ---
        else if (action === 'toggle_double_gold') {
          lootMessageId = id; 
          const playerId = playerIdForAction; 
          if (!(await checkAuth(interaction, { allowedUsers: [playerId] }))) {
              return;
          }
          await interaction.deferUpdate(); 

          try { 
            const player = state.players.find(p => p.id === playerId);
            if (!player) { throw new Error("Jogador não encontrado ao tentar ativar/desativar dobro."); }

            const currentTokens = await getPlayerTokenCount(player.tag);
            const canAfford = currentTokens >= 4; 
            const wantsToActivate = !player.doubleActive; 

            if (wantsToActivate && !canAfford) {
                await interaction.followUp({ content: `Você não tem tokens suficientes (${currentTokens}) para ativar o dobro.`, flags: [MessageFlagsBitField.Flags.Ephemeral] });
                return;
            }

            player.doubleActive = !player.doubleActive;

            // Atualiza a MENSAGEM PÚBLICA PRINCIPAL
            const lootMessage = await interaction.channel.messages.fetch(lootMessageId);
            if (!lootMessage) throw new Error("Mensagem principal de loot não encontrada...");
            
            const playersString = formatPlayerList(state.players, true, true); 
            const dropsString = formatDropsList(getAvailableDrops(state)); 
            const newMessageContent = buildLootMessageContent(state, playersString, dropsString);
            await lootMessage.edit({ content: newMessageContent }); 

            // Atualiza a MENSAGEM ONDE O BOTÃO FOI CLICADO
            const newDoubleLabel = player.doubleActive
                ? `Desativar Dobro (4 de ${currentTokens} 🎟️)` 
                : `Ativar Dobro (4 de ${currentTokens} 🎟️)`;
            const newDoubleStyle = player.doubleActive ? ButtonStyle.Danger : ButtonStyle.Primary; 
            const updatedDoubleButton = new ButtonBuilder()
                .setCustomId(interaction.customId) 
                .setLabel(newDoubleLabel)
                .setStyle(newDoubleStyle)
                .setDisabled(!canAfford && !player.doubleActive); 

            let finalizeButtonComponent = null;
            let buttonRowIndex = -1; 
            interaction.message.components.forEach((row, rowIndex) => {
                const foundButton = row.components.find(component =>
                    component.type === 2 && 
                    component.customId?.startsWith('finalizar_loot') 
                );
                if (foundButton) {
                    finalizeButtonComponent = foundButton;
                    buttonRowIndex = rowIndex; 
                }
            });
              if (!finalizeButtonComponent) {
                  console.error("[ERRO toggle_double_gold] Botão Finalizar não encontrado na mensagem:", JSON.stringify(interaction.message.components));
                  throw new Error("Botão Finalizar não encontrado para recriar a fileira.");
              }
            
            const updatedButtonRow = new ActionRowBuilder().addComponents(updatedDoubleButton, ButtonBuilder.from(finalizeButtonComponent));
            
            const updatedComponents = interaction.message.components.map((row, index) => {
                if (index === buttonRowIndex) {
                    return updatedButtonRow; 
                }
                return row;
            });

            await interaction.editReply({
                components: updatedComponents 
            });

        } catch (error) { 
            console.error("Erro no botão toggle_double_gold:", error);
            const player = state.players.find(p => p.id === playerId);
            const actionText = (player && player.doubleActive) ? 'desativar' : 'ativar';
            await interaction.followUp({ content: `Ocorreu um erro ao ${actionText} o dobro: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
        }
        }

        // --- Botão de FINALIZAR SELEÇÃO DE LOOT ---
        else if (action === 'finalizar_loot') {
          lootMessageId = id; 
          const playerId = playerIdForAction; 
          if (!(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [playerId] }))) {
            return; 
          }
          await interaction.deferUpdate(); 
          const player = state.players.find(p => p.id === playerId);
          if (!player) { throw new Error("Jogador não encontrado ao finalizar."); }
          
          const devolveButton = new ButtonBuilder().setCustomId(`devolver_loot|${lootMessageId}|${player.id}`).setLabel('Devolver Itens').setStyle(ButtonStyle.Secondary);
          
          let pickedText = "Nenhum item pego."; 
          let finalGold = state.goldFinalPerPlayer; 
          
          // +++ CORREÇÃO BUG 2: Agrega os itens do carrinho (simples ou paginado) +++
          const aggregatedItems = new Map();
          (player.items || []).forEach(item => {
              if (!item || !item.name) return;

              const key = `${item.name}|${item.isPredefined ? 'true' : 'false'}`;
              const existing = aggregatedItems.get(key);
              
              // Se tem unitIndex (paginado) ou se é do modo simples (agora amount: 1), contamos como 1.
              // Se não tem unitIndex (modo simples antigo), usamos item.amount.
              const amountToAdd = (item.unitIndex !== undefined) ? 1 : (item.amount || 0);

              if (existing) {
                  existing.amount += amountToAdd;
              } else {
                  // Armazena uma cópia
                  aggregatedItems.set(key, { ...item, amount: amountToAdd });
              }
          });
          
          let finalItems = Array.from(aggregatedItems.values()); // Usa a lista agregada
          if (player.doubleActive) {
              finalGold *= 2; 
              finalItems = finalItems.map(item => {
                  // Dobra itens E gold extra pré-definidos
                  if (item.isPredefined) { 
                      return { ...item, amount: item.amount * 2 };
                  }
                  return item;
              });
          }

          if (finalItems.length > 0) { 
              pickedText = "Itens pegos:\n" + finalItems.filter(i => i.amount > 0).map(i => { // Filtra os que têm 0
                  // Não mostra "PO" para os itens de gold aqui, o gold total já inclui
                  if (i.name.endsWith(' PO')) return null; 
                  return `${i.amount}x ${i.name}${i.isPredefined ? '*' : ''}`;
              }).filter(Boolean).join('\n'); // Filtra os nulos
              if (pickedText.trim() === "") pickedText = "Nenhum item pego.";
          }
          
          // Adiciona o gold extra pego (que não é "PO base")
          let extraGoldFromItems = 0;
          finalItems.forEach(item => {
              const goldMatch = item.name.match(/^(\d+(?:[\.,]\d+)?)\s*PO$/);
              if (goldMatch) {
                  const goldValue = parseFloat(goldMatch[1].replace(',', '.'));
                  extraGoldFromItems += (goldValue * item.amount); // amount já foi dobrado
              }
          });
          finalGold += extraGoldFromItems; // Soma o gold base + gold extra
          
          await interaction.editReply({
              content: `Seleção finalizada para ${userMention(player.id)} (${player.char}).\n${finalGold.toFixed(2)} PO foram adicionados${player.doubleActive ? ' (Dobro Ativado!)' : ''}.\n\n${pickedText}`,
              components: [new ActionRowBuilder().addComponents(devolveButton)], 
              allowedMentions: { users: [player.id] } 
          });
        }

        // --- Botão de DEVOLVER LOOT ---
        else if (action === 'devolver_loot') {
            lootMessageId = id; 
            const playerId = playerIdForAction; 
            if (!(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [playerId] }))) {
              return; 
            }
            await interaction.deferUpdate(); 
            const player = state.players.find(p => p.id === playerId);
            
            if (!player || !player.items || player.items.length === 0) {
                if(interaction.message) {
                    await interaction.message.delete().catch(e => { if (e.code !== 10008) console.error("Erro ao deletar msg devolver_loot vazia:", e); }); 
                }
                if (player) {
                    player.doubleActive = false; 
                    player.activeMessageId = null; 
                }
                return; 
            }

            processItemReturn(state, player); 
            player.doubleActive = false; 

            const lootMessage = await interaction.channel.messages.fetch(lootMessageId);
            if (!lootMessage) throw new Error("Mensagem pública de loot não encontrada ao devolver.");
            
            const playersString = formatPlayerList(state.players, true, true); 
            const dropsString = formatDropsList(getAvailableDrops(state));
            const newMessageContent = buildLootMessageContent(state, playersString, dropsString);
            await lootMessage.edit({ content: newMessageContent }); 

            if (interaction.message) { await interaction.message.delete().catch(e => { if (e.code !== 10008) console.error("Erro ao deletar msg após devolver loot:", e); }); }
            player.activeMessageId = null;
        }

        // --- Botão de ENCERRAR MESA ---
        else if (action === 'encerrar_mesa') {
            lootMessageId = id; 
            if (!(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [state.mestreId] }))) {
              return; 
            }
            await interaction.deferUpdate(); 
            await handleEncerrarMesaClick(interaction, state, lootMessageId);
        }

        // --- Botão de ESCREVER RELATÓRIO ---
        else if (action === 'escrever_relatorio') {
            const [_, mestreId, logMessageId] = interaction.customId.split('|');
            if (!(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [mestreId] }))) {
              return; 
            }
            const logMessage = await interaction.channel.messages.fetch(logMessageId);
            if (!logMessage) { await interaction.reply({ content: 'Msg de log não encontrada.', flags: [MessageFlagsBitField.Flags.Ephemeral] }); return; }
            let currentReport = ""; const reportMatch = logMessage.content.match(/Relatório\n```\n([\s\S]+?)\n```/); if (reportMatch && reportMatch[1]) { currentReport = reportMatch[1].trim(); if(currentReport === '(Área vazia)') currentReport = '';}
            const modal = new ModalBuilder().setCustomId(`modal_relatorio|${logMessageId}`).setTitle('Relatório da Missão');
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('relatorio_input')
                    .setLabel('Escreva o relatório da missão')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(currentReport || 'Escreva aqui...')
                    .setRequired(true)
            ));
            await interaction.showModal(modal); 
        }

        // +++ NOVO: Botões de Paginação +++
        else if (action === 'loot_page_prev' || action === 'loot_page_next') {
            const [_, lootMessageId, pageStr] = interaction.customId.split('|');
            const page = parseInt(pageStr) || 0;
            const state = interaction.client.pendingLoots.get(lootMessageId);
            
            // Verifica state e permissão (SÓ o jogador que abriu o menu pode paginar)
            if (!state || !state.players.find(p => p.id === interaction.user.id)) {
                await interaction.reply({ content: "Você não pode navegar neste menu.", flags: [MessageFlagsBitField.Flags.Ephemeral] });
                return;
            }
            
            const player = state.players.find(p => p.id === interaction.user.id);
            // Garante que o jogador está a interagir com o menu de loot ativo mais recente dele
            if (player.activeMessageId !== interaction.message.id) {
                  await interaction.reply({ content: "Você tem um menu mais recente ativo em outro lugar.", flags: [MessageFlagsBitField.Flags.Ephemeral] });
                  return;
            }
  
            await interaction.deferUpdate();
  
            const newPage = action === 'loot_page_next' ? page + 1 : page - 1;
            
            // (O require está aqui dentro para evitar dependência circular no topo do ficheiro)
            const { buildPaginatedSelectMenu } = require('../utils/lootSelectMenuManager.js');
            const currentTokens = await getPlayerTokenCount(player.tag);
            const canAffordDouble = currentTokens >= 4;
            const { content, components } = buildPaginatedSelectMenu(state, player, lootMessageId, newPage, currentTokens, canAffordDouble);
            
            await interaction.editReply({ content: content, components: components });
        }

    } catch (error) { // Catch geral para a lógica dos botões
        console.error(`Erro no handleButton (${action}):`, error);
        const errorMessage = `Ocorreu um erro no botão: ${error.message}`.substring(0, 1900);
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
        } else {
            await interaction.reply({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(async (replyError) => {
                 console.error("Falha ao responder ao erro do botão, tentando followUp:", replyError);
                 await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(finalError => {
                     console.error("Falha final ao enviar mensagem de erro:", finalError);
                 });
            });
        }
    }

  } // Fim do handleButton
}; // Fim do module.exports