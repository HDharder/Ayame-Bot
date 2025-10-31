// commands/loot.js (Refatorado - Completo)
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
// calculateGold e getPlayerLevels são usados dentro das funções de lootUtils agora
// const { getPlayerLevels, calculateGold } = require('../utils/lootLogic.js');
// Importações de Lógica - Utilitários de Itens
const { validateItems, parseItemInput } = require('../utils/itemUtils.js');
// Importações de Lógica - Utilitários de Seleção/Devolução de Player
const { processItemSelection, processItemReturn } = require('../utils/playerLootUtils.js');
// Importações de Lógica - Utilitários Gerais E LÓGICA DE BOTÕES do Comando Loot
const {
  findEligibleTables,
  formatPlayerList,         // Usado em handleSelect e handleButton(devolver)
  formatDropsList,          // Usado em handleSelect e handleModal
  buildLootMessageContent,  // Usado em handleSelect e handleButton(devolver)
  handleLootCalculation,    // << Lógica do botão calcular
  handlePegarLootClick,     // << Lógica do botão pegar_loot
  handleEncerrarMesaClick   // << Lógica do botão encerrar_mesa
  // updateHistoricoSheet e sendLogMessage são chamados DENTRO de handleEncerrarMesaClick
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
    .addBooleanOption(option => option.setName('loot_previsto').setDescription('Opcional: A mesa teve loot previsto? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_mundanos').setDescription('Opcional: A mesa teve drop de Itens Mundanos? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_itens').setDescription('Opcional: A mesa teve drop de Itens Mágicos? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_materiais').setDescription('Opcional: A mesa teve drop de Materiais? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_ervas').setDescription('Opcional: A mesa teve drop de Ervas? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('drop_de_pocoes').setDescription('Opcional: A mesa teve drop de Poções? (Default: False)').setRequired(false))
    .addBooleanOption(option => option.setName('nao_rolar_loot').setDescription('Opcional: Ignorar a rolagem de gold para esta mesa? (Default: False)').setRequired(false)),

  // 2. QUAIS INTERAÇÕES ESTE ARQUIVO GERENCIA
  selects: ['loot_select_mesa', 'loot_item_select'],
  modals: [
    'modal_loot_mundanos',
    'modal_loot_itens',
    'modal_loot_materiais',
    'modal_loot_ervas',
    'modal_loot_pocoes',
    'modal_relatorio'
  ],
  buttons: [
    'loot_add_mundanos',
    'loot_add_itens',
    'loot_add_materiais',
    'loot_add_ervas',
    'loot_add_pocoes',
    'loot_calcular',
    'pegar_loot',
    'toggle_double_gold', // <<< ADICIONADO
    'finalizar_loot',
    'devolver_loot',
    'encerrar_mesa',
    'escrever_relatorio'
  ],

  // 3. EXECUÇÃO DO COMANDO PRINCIPAL (/loot)
  async execute(interaction) {
    // Verifica permissão
    const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.NARRADOR, AuthLevels.STAFF] });
    if (!hasAuth) {
      return;
    }
    // Defer público
    await interaction.deferReply();

    try {
        // Coleta opções do comando
        const options = {
          nomeMesa: interaction.options.getString('nome') || '',
          lootPrevisto: interaction.options.getBoolean('loot_previsto') ?? false,
          dropMundanos: interaction.options.getBoolean('drop_de_mundanos') ?? false,
          dropItens: interaction.options.getBoolean('drop_de_itens') ?? false,
          dropMateriais: interaction.options.getBoolean('drop_de_materiais') ?? false,
          dropErvas: interaction.options.getBoolean('drop_de_ervas') ?? false,
          dropPocoes: interaction.options.getBoolean('drop_de_pocoes') ?? false,
          naoRolarLoot: interaction.options.getBoolean('nao_rolar_loot') ?? false,
        };

        // Chama função utilitária para buscar mesas elegíveis
        const mesasAbertas = await findEligibleTables(interaction.user.username, docControle);

        // Se não houver mesas, informa e encerra
        if (mesasAbertas.length === 0) {
          await interaction.editReply('Você não possui mesas registradas que estejam pendentes de finalização. Já usou o `/registrar-mesa` ?');
          return;
        }

        // Cria o Select Menu para escolher a mesa
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`loot_select_mesa|${interaction.id}`)
            .setPlaceholder('Selecione a mesa para registrar o loot');

        // Adiciona as mesas encontradas como opções
        mesasAbertas.slice(0, 25).forEach(row => { // Limita a 25 opções
            const data = row.get('Data') || '??/??/??';
            const horario = row.get('Horário') || '??:??';
            const tier = row.get('Tier')?.replace(/'/,'') || '?';
            const nomeMesa = row.get('Nome da Mesa') || '';
            const messageId = row.get('ID da Mensagem');
            // Garante que messageId exista para ser usado como valor
            if (!messageId) {
                console.warn(`[AVISO /loot execute] Mesa encontrada sem ID da Mensagem na linha ${row.rowIndex}. Pulando.`);
                return; // Pula esta linha se não tiver ID
            }
            let label = `Mesa ${data} ${horario} (Tier ${tier})`;
            if (nomeMesa) label = `${nomeMesa} (${data} ${horario})`;
            // Garante que o label não exceda 100 caracteres
            const finalLabel = label.length > 100 ? label.substring(0, 97) + '...' : label;
            selectMenu.addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel(finalLabel)
                    .setValue(messageId) // Usa ID da mensagem como valor
            );
        });
        // Se após filtrar, nenhuma opção válida foi adicionada
         if (selectMenu.options.length === 0) {
            await interaction.editReply('Não encontrei mesas válidas (com ID) para listar.');
            return;
        }

        // Inicializa o Map de Loots pendentes no client se não existir
        if (!interaction.client.pendingLoots) {
          interaction.client.pendingLoots = new Map();
        }

        // Armazena o estado inicial do processo de loot
        interaction.client.pendingLoots.set(interaction.id, {
          step: 'select_mesa',
          options: options,
          interactionId: interaction.id,
          mestreId: interaction.user.id
        });

        // Cria a fileira com o menu e edita a resposta
        const rowComponent = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.editReply({
            content: 'Selecione abaixo qual das suas mesas você deseja registrar o loot:',
            components: [rowComponent],
        });

    } catch (error) { // Captura erros durante a execução inicial
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
    const [action, originalInteractionOrMessageId] = interaction.customId.split('|');

    // --- Seleção da Mesa ---
    if (action === 'loot_select_mesa') {
      const originalInteractionId = originalInteractionOrMessageId;
      try {
          await interaction.deferUpdate(); // Confirma o clique
          const state = interaction.client.pendingLoots.get(originalInteractionId);
          // Verifica state e permissão
          if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] }))) {
            // A mensagem de erro já foi enviada pelo checkAuth
            return;
          }
          const selectedMessageId = interaction.values[0]; // ID da mensagem da mesa no histórico

          // Atualiza o state
          state.step = 'input_drops';
          state.selectedMessageId = selectedMessageId;
          state.drops = { mundanos: [], itens: [], materiais: [], ervas: [], pocoes: [] }; // Inicializa drops

          // Cria os botões de adicionar drops e calcular
          const buttons = [];
          if (state.options.dropMundanos) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_mundanos|${originalInteractionId}`).setLabel('Adicionar Mundanos').setStyle(ButtonStyle.Secondary)); }
          if (state.options.dropItens) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_itens|${originalInteractionId}`).setLabel('Adicionar Itens').setStyle(ButtonStyle.Secondary)); }
          if (state.options.dropMateriais) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_materiais|${originalInteractionId}`).setLabel('Adicionar Materiais').setStyle(ButtonStyle.Secondary)); }
          if (state.options.dropErvas) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_ervas|${originalInteractionId}`).setLabel('Adicionar Ervas').setStyle(ButtonStyle.Secondary)); }
          if (state.options.dropPocoes) { buttons.push(new ButtonBuilder().setCustomId(`loot_add_pocoes|${originalInteractionId}`).setLabel('Adicionar Poções').setStyle(ButtonStyle.Secondary)); }
          // Botão Calcular sempre presente
          buttons.push(new ButtonBuilder()
              .setCustomId(`loot_calcular|${originalInteractionId}`)
              .setLabel(buttons.length > 0 ? 'Finalizar Drops e Calcular Loot' : 'Calcular Loot de Gold')
              .setStyle(ButtonStyle.Success));

          // Garante que não exceda 5 botões por fileira
          const row = new ActionRowBuilder().addComponents(buttons.slice(0, 5)); // Pega os primeiros 5 botões

          // Edita a resposta pública para mostrar os botões
          await interaction.editReply({
            content: 'Mesa selecionada. Adicione os drops usando os botões abaixo e depois clique no botão verde para calcular.',
            components: [row] // Adiciona a fileira de botões
          });

          // Pega o ID da mensagem que acabamos de editar (a que tem os botões) e salva no state
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
      const lootMessageId = originalInteractionOrMessageId; // ID da mensagem PÚBLICA de loot
      await interaction.deferUpdate(); // Confirma seleção imediatamente

      try {
          const state = interaction.client.pendingLoots.get(lootMessageId);
          // Verifica state e se o jogador existe
          if (!state) { console.warn(`[AVISO Loot Select Item] State não encontrado para ${lootMessageId}.`); return; }
          const player = state.players.find(p => p.id === interaction.user.id);
          if (!player) { console.warn(`[AVISO Loot Select Item] Usuário ${interaction.user.id} não encontrado em loot ${lootMessageId}.`); return; }

          const selectedItemValues = interaction.values || []; // Valores selecionados (ex: "Item-0")

          // Chama a função utilitária para processar a seleção (atualiza state.allDrops e player.items)
          processItemSelection(state, player, selectedItemValues); // << De playerLootUtils

          // Atualiza a mensagem pública principal
          const lootMessage = await interaction.channel.messages.fetch(lootMessageId);
          if (!lootMessage) { throw new Error("Mensagem pública de loot não encontrada para editar."); }

          // Chama funções utilitárias para formatar as strings atualizadas
          const playersString = formatPlayerList(state.players, true, true); // Inclui itens e nível << De lootUtils
          const dropsString = formatDropsList(state.allDrops); // << De lootUtils
          // Chama função utilitária para construir o conteúdo completo
          const newMessageContent = buildLootMessageContent(state, playersString, dropsString); // << De lootUtils

          // Edita a mensagem pública (mantendo os botões "Pegar Loot", "Encerrar Mesa")
          await lootMessage.edit({ content: newMessageContent, components: lootMessage.components });

      } catch (error) {
          console.error("Erro no handleSelect (loot_item_select):", error);
          // Tenta informar o usuário com followUp, pois deferUpdate já foi usado
          interaction.followUp({ content: `Ocorreu um erro ao processar sua seleção: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(e => {}); // Usa catch vazio para suprimir erros se followUp falhar
      }
    } // Fim else if loot_item_select
  }, // Fim handleSelect

  // 5. GERENCIADOR DE MODAIS
  async handleModal(interaction) {
    // Extrai ação e ID (originalInteractionId ou logMessageId)
    const [action, originalInteractionOrMessageId] = interaction.customId.split('|');

    // --- Modal de Registro de Drops ---
    if (action.startsWith('modal_loot_')) {
      const originalInteractionId = originalInteractionOrMessageId;
      await interaction.deferUpdate(); // Confirma recebimento do modal
      const state = interaction.client.pendingLoots.get(originalInteractionId);
      // Verifica state e permissão
      if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] }))) {
        return;
      }
      const input = interaction.fields.getTextInputValue('loot_input');
      // Verifica se algo foi digitado
      if (!input || input.trim() === '') {
          await interaction.followUp({ content: 'Nenhum item foi digitado.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
          return;
      }

      // Chama função de itemUtils para parsear a string
      const items = parseItemInput(input);
      let sheetName = ''; // Nome da aba na planilha Craft
      let dropType = ''; // Chave no state.drops (itens, materiais, etc.)
      // Determina sheetName e dropType baseado na ação do modal
      if (action === 'modal_loot_mundanos') { sheetName = 'Itens Mundanos'; dropType = 'mundanos'; }
      else if (action === 'modal_loot_itens') { sheetName = 'Itens'; dropType = 'itens'; }
      else if (action === 'modal_loot_materiais') { sheetName = 'Materiais'; dropType = 'materiais'; }
      else if (action === 'modal_loot_ervas') { sheetName = 'Ervas'; dropType = 'ervas'; }
      else if (action === 'modal_loot_pocoes') { sheetName = 'Poções'; dropType = 'pocoes'; }
      else {
          console.warn("Modal de loot desconhecido:", action); // Segurança
          await interaction.followUp({ content: 'Tipo de modal desconhecido.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
          return;
      }

      try {
        // Chama função de itemUtils para validar os itens contra a planilha docCraft
        const notFound = await validateItems(items, sheetName, docCraft);
        // Se algum item não foi encontrado, informa o usuário e interrompe
        if (notFound.length > 0) {
          await interaction.followUp({
            content: `**Erro:** Itens não encontrados em "${sheetName}":\n\`\`\`${notFound.join('\n')}\`\`\`\nCorrija e tente adicionar novamente.`,
            flags: [MessageFlagsBitField.Flags.Ephemeral]
          });
          return;
        }

        // Se a validação passou, atualiza o state com os drops
        state.drops[dropType] = items;

        // Busca a mensagem que contém os botões "Adicionar..."
        if (!state.dropsMessageId) { throw new Error("ID da mensagem de drops não encontrado no estado."); }
        const dropsMessage = await interaction.channel.messages.fetch(state.dropsMessageId);
        if (!dropsMessage) { throw new Error("Mensagem de drops não encontrada para editar."); }

        // Remonta a string de drops adicionados para atualizar a mensagem
        let contentBase = dropsMessage.content.split('\n\n**Drops Adicionados:**')[0]; // Pega a parte antes da lista
        const currentComponents = dropsMessage.components; // Mantém os botões existentes
        let dropsDisplayString = "**Drops Adicionados:**\n";
        let hasAnyDrops = false;
        // Itera sobre todos os tipos de drop no state
        const dropTypes = ['mundanos', 'itens', 'materiais', 'ervas', 'pocoes'];
        dropTypes.forEach(dtype => {
            // Verifica se o array de drops para este tipo existe e tem itens
            if (state.drops[dtype] && Array.isArray(state.drops[dtype]) && state.drops[dtype].length > 0) {
                hasAnyDrops = true;
                // Formata "Tipo: `Nx Item, My Item`"
                const itemsString = state.drops[dtype]
                    .filter(i => i && i.name && typeof i.amount === 'number' && i.amount > 0) // Filtra inválidos
                    .map(i => `${i.amount}x ${i.name}`)
                    .join(', ');
                if (itemsString) { // Adiciona só se tiver itens válidos formatados
                    // Formata o nome "mundanos" para "Mundanos"
                    let label = dtype.charAt(0).toUpperCase() + dtype.slice(1);
                    if (dtype === 'mundanos') {
                        label = 'Itens Mundanos'; // Ou apenas 'Mundanos'
                    }
                    dropsDisplayString += `${label}: \`${itemsString}\`\n`;
                }
            }
        });
        if (!hasAnyDrops) dropsDisplayString += "Nenhum"; // Se nenhum drop foi adicionado

        // Edita a mensagem dos botões com a lista atualizada
        await dropsMessage.edit({
          content: `${contentBase}\n\n${dropsDisplayString}`,
          components: currentComponents
        });
        // Confirma para o usuário
        await interaction.followUp({ content: `${sheetName} adicionados/atualizados com sucesso!`, flags: [MessageFlagsBitField.Flags.Ephemeral] });

      } catch (e) {
        console.error("Erro ao validar/processar itens do modal:", e);
        const errorMessage = `Ocorreu um erro ao processar os itens: ${e.message}`.substring(0,1900);
        await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      }
    } // Fim if modal_loot_

    // --- Modal de Relatório (Final) ---
    if (action === 'modal_relatorio') {
      const logMessageId = originalInteractionOrMessageId; // ID da mensagem no canal de log
      try {
        await interaction.deferUpdate(); // Confirma recebimento do modal
        // Busca a mensagem de log
        const logMessage = await interaction.channel.messages.fetch(logMessageId);
        if (!logMessage) {
            await interaction.followUp({ content: 'Mensagem de log não encontrada.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
            return;
        }
        // Pega o texto do relatório
        const relatorioText = interaction.fields.getTextInputValue('relatorio_input');
        // Pega o conteúdo original antes da seção "Relatório"
        const originalContent = logMessage.content.split('\nRelatório')[0];
        // Monta o novo conteúdo com o relatório formatado
        const newContent = `${originalContent}\nRelatório\n\`\`\`\n${relatorioText}\n\`\`\``;
        // Edita a mensagem de log (o botão "Escrever Relatório" permanece)
        await logMessage.edit({ content: newContent });
        // (Opcional) Confirmação efêmera
        // await interaction.followUp({ content: 'Relatório salvo!', flags: [MessageFlagsBitField.Flags.Ephemeral] });

      } catch (e) {
        console.error("Erro ao salvar relatório:", e);
        const errorMessage = `Ocorreu um erro ao salvar o relatório: ${e.message}`.substring(0,1900);
        await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      }
    } // Fim if modal_relatorio
  }, // Fim handleModal

  // 6. GERENCIADOR DE BOTÕES
  async handleButton(interaction) {
    // Extrai ação e ID
    const customIdParts = interaction.customId.split('|');
    const action = customIdParts[0];
    const id = customIdParts[1]; // originalInteractionId ou lootMessageId
    const playerIdForAction = customIdParts[2]; // Para finalizar/devolver

    let state;
    let lootMessageId = null;
    let originalInteractionId = null;

    // Recupera state baseado na ação
    // Bloco if/else if para determinar qual ID usar e buscar o state
    if (action.startsWith('loot_add_') || action === 'loot_calcular') {
        originalInteractionId = id;
        state = interaction.client.pendingLoots.get(originalInteractionId);
        // Verifica se state existe e pertence ao mestre
        if (!state || !(await checkAuth(interaction, { allowedUsers: [state.mestreId] }))) {
            return;
        }
    // Adiciona toggle_double_gold à lista de ações que usam lootMessageId
    } else if (['pegar_loot', 'finalizar_loot', 'devolver_loot', 'encerrar_mesa', 'toggle_double_gold'].includes(action)) {
        lootMessageId = id; // ID é da mensagem principal de loot
        state = interaction.client.pendingLoots.get(lootMessageId);
        // Verifica se state existe (permissão é verificada depois)
        if (!state) {
            // Se state não existe, tenta editar a mensagem para remover botões
            if (interaction.message) {
                await interaction.message.edit({content: interaction.message.content + "\n\n*(Sessão expirada)*", components: []}).catch(()=>{}); // Usa catch vazio para suprimir erro se msg não existir
            }
            await interaction.reply({ content: 'Sessão não encontrada/expirada.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
            return; // Interrompe
        }
    } else if (action === 'escrever_relatorio') {
        // Não precisa do state global aqui, IDs estão no customId
    } else {
        // Ação desconhecida
        console.warn("Ação de botão desconhecida:", action, interaction.customId);
        await interaction.reply({content: "Botão inválido.", flags: [MessageFlagsBitField.Flags.Ephemeral]});
        return; // Interrompe
    }


    // --- Roteamento para Funções Específicas ---

    try {
        // --- Botões para ABRIR MODAL de drops ---
        if (action.startsWith('loot_add_')) {
          // Lógica de criar e mostrar modal permanece aqui
          originalInteractionId = id; // Garante que temos o ID correto
          let modal; // Variável para o modal
          // Cria o ModalBuilder apropriado
          if (action === 'loot_add_mundanos') {
              modal = new ModalBuilder().setCustomId(`modal_loot_mundanos|${originalInteractionId}`).setTitle('Adicionar Itens Mundanos');
               modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Itens Mundanos (Ex: 10x Flecha, 2x Tocha)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          } else if (action === 'loot_add_itens') {
              modal = new ModalBuilder().setCustomId(`modal_loot_itens|${originalInteractionId}`).setTitle('Adicionar Itens');
              modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Itens (Ex: Item A, 3x Item B)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          } else if (action === 'loot_add_materiais') {
              modal = new ModalBuilder().setCustomId(`modal_loot_materiais|${originalInteractionId}`).setTitle('Adicionar Materiais');
               modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Materiais (Ex: 3x Material X, Material Y)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          } else if (action === 'loot_add_ervas') {
              modal = new ModalBuilder().setCustomId(`modal_loot_ervas|${originalInteractionId}`).setTitle('Adicionar Ervas');
               modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Ervas (Ex: Erva Z, 2x Erva W)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          } else if (action === 'loot_add_pocoes') {
              modal = new ModalBuilder().setCustomId(`modal_loot_pocoes|${originalInteractionId}`).setTitle('Adicionar Poções');
               modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder().setCustomId('loot_input').setLabel("Poções (Ex: 2x Poção Cura, Poção Força)").setStyle(TextInputStyle.Paragraph).setRequired(true)
              ));
          }
          // Mostra o modal se foi criado
          if (modal) {
            await interaction.showModal(modal); // Mostra o formulário
          } else {
            // Se nenhum modal correspondeu, informa o usuário (embora não devesse acontecer)
            console.warn(`[AVISO handleButton] Ação ${action} não correspondeu a nenhum modal.`);
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: 'Formulário não identificado.', flags: [MessageFlagsBitField.Flags.Ephemeral]});
            }
          }
        }

        // --- Botão para CALCULAR O LOOT ---
        else if (action === 'loot_calcular') {
          // Chama a função de lootUtils que contém toda a lógica
          originalInteractionId = id; // Garante que temos o ID correto
          await handleLootCalculation(interaction, state, originalInteractionId);
        }

        // --- Botão de PEGAR LOOT ---
        else if (action === 'pegar_loot') {
          // Chama a função de lootUtils que contém a lógica
          lootMessageId = id; // Garante que temos o ID correto
          await handlePegarLootClick(interaction, state, lootMessageId);
        }

        // ===============================================
        // NOVO HANDLER: Botão Ativar/Desativar Dobro
        // ===============================================
        else if (action === 'toggle_double_gold') {
          lootMessageId = id; // ID da msg principal
          const playerId = playerIdForAction; // ID do player
          // Verifica permissão (só o jogador dono do botão pode clicar)
          if (!(await checkAuth(interaction, { allowedUsers: [playerId] }))) {
              return;
          }
          await interaction.deferUpdate(); // Confirma o clique

          try { // Adiciona try/catch para a lógica do botão
            const player = state.players.find(p => p.id === playerId);
            if (!player) { throw new Error("Jogador não encontrado ao tentar ativar/desativar dobro."); }

          // Busca tokens ATUAIS
            const currentTokens = await getPlayerTokenCount(player.tag);
            const canAfford = currentTokens >= 4;
            const wantsToActivate = !player.doubleActive; // Se está inativo, quer ativar

          // Verifica se pode ativar (se quiser ativar)
            if (wantsToActivate && !canAfford) {
                await interaction.followUp({ content: `Você não tem tokens suficientes (${currentTokens}) para ativar o dobro.`, flags: [MessageFlagsBitField.Flags.Ephemeral] });
                return;
            }

            // Alterna o estado
            player.doubleActive = !player.doubleActive;

            // --- Atualiza a MENSAGEM PÚBLICA PRINCIPAL ---
            const lootMessage = await interaction.channel.messages.fetch(lootMessageId);
            if (!lootMessage) throw new Error("Mensagem principal de loot não encontrada...");
            // Formata players COM a atualização do (Dobro Ativado)
            const playersString = formatPlayerList(state.players, true, true); // Inclui itens e nível/dobro
            const dropsString = formatDropsList(state.allDrops); // Pega drops atuais
            const newMessageContent = buildLootMessageContent(state, playersString, dropsString);
            await lootMessage.edit({ content: newMessageContent }); // Edita a mensagem principal

            // --- Atualiza a MENSAGEM ONDE O BOTÃO FOI CLICADO ---
            // Recria o botão de Dobro com o novo estado
            const newDoubleLabel = player.doubleActive
                ? `Desativar Dobro (4 de ${currentTokens} 🎟️)`
                : `Ativar Dobro (4 de ${currentTokens} 🎟️)`;
            const newDoubleStyle = player.doubleActive ? ButtonStyle.Danger : ButtonStyle.Primary; // Vermelho para desativar, Azul para ativar
            const updatedDoubleButton = new ButtonBuilder()
                .setCustomId(interaction.customId) // Mantém o mesmo ID
                .setLabel(newDoubleLabel)
                .setStyle(newDoubleStyle)
                .setDisabled(!canAfford && !player.doubleActive); // Desabilita Ativar se não pode pagar

            // ===============================================
            // CORREÇÃO: Encontrar o botão Finalizar pelo ID
            // ===============================================
            let finalizeButtonComponent = null;
            let buttonRowIndex = -1; // Índice da fileira onde os botões estão

            // Procura o botão "finalizar_loot" em todas as fileiras e componentes
            interaction.message.components.forEach((row, rowIndex) => {
                const foundButton = row.components.find(component =>
                    component.type === 2 && // Tipo 2 = Botão
                    component.customId?.startsWith('finalizar_loot') // Procura pelo prefixo
                );
                if (foundButton) {
                    finalizeButtonComponent = foundButton;
                    buttonRowIndex = rowIndex; // Guarda o índice da fileira
                }
            });

              if (!finalizeButtonComponent) {
                  // Log detalhado se não encontrar
                  console.error("[ERRO toggle_double_gold] Botão Finalizar não encontrado na mensagem:", JSON.stringify(interaction.message.components));
                  throw new Error("Botão Finalizar não encontrado para recriar a fileira.");
              }
            // ===============================================

            // Cria a nova fileira de botões atualizada
            // Recria o botão finalizar a partir do componente encontrado
            const updatedButtonRow = new ActionRowBuilder().addComponents(updatedDoubleButton, ButtonBuilder.from(finalizeButtonComponent));

            // Prepara os componentes para editar a mensagem
            const updatedComponents = interaction.message.components.map((row, index) => {
                if (index === buttonRowIndex) {
                    return updatedButtonRow; // Substitui a fileira dos botões
                }
                return ActionRowBuilder.from(row); // Mantém as outras fileiras (ex: select menu)
            });

            // Edita a mensagem onde o botão foi clicado (a pública do pegar_loot)
            await interaction.editReply({
                components: updatedComponents // Envia os componentes atualizados
            });

        } catch (error) { // Catch para a lógica do botão toggle_double_gold
            console.error("Erro no botão toggle_double_gold:", error);
            await interaction.followUp({ content: `Ocorreu um erro ao ${player.doubleActive ? 'desativar' : 'ativar'} o dobro: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
        }

            // Confirmação efêmera (opcional)
            // await interaction.followUp({ content: `Dobro de gold ${player.doubleActive ? 'ATIVADO' : 'DESATIVADO'}!`, flags: [MessageFlagsBitField.Flags.Ephemeral] });

        }
        // ===============================================

        // --- Botão de FINALIZAR SELEÇÃO DE LOOT ---
        else if (action === 'finalizar_loot') {
          lootMessageId = id; // ID da msg principal
          const playerId = playerIdForAction; // ID do player
          // Verifica permissão aqui antes de chamar a função
          if (!(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [playerId] }))) {
            return; // Interrompe
          }
          await interaction.deferUpdate(); // Defer aqui, antes da lógica
          const player = state.players.find(p => p.id === playerId);
          if (!player) { throw new Error("Jogador não encontrado ao finalizar."); }
          // Cria botão devolver
          const devolveButton = new ButtonBuilder().setCustomId(`devolver_loot|${lootMessageId}|${player.id}`).setLabel('Devolver Itens').setStyle(ButtonStyle.Secondary);
          // Formata texto de confirmação
          let pickedText = "Nenhum item pego."; 
          let finalGold = state.goldFinalPerPlayer; // Gold base
          if (player.items && player.items.length > 0) { pickedText = "Itens pegos:\n" + player.items.map(i => `${i.amount}x ${i.name}`).join('\n'); }
          // Ajusta gold final se o dobro estiver ativo
          if (player.doubleActive) {
              finalGold *= 2;
          }
          // Edita a mensagem PÚBLICA (que tinha o select) para confirmação
          await interaction.editReply({
              content: `Seleção finalizada para ${userMention(player.id)} (${player.char}).\n${finalGold.toFixed(2)} PO foram adicionados${player.doubleActive ? ' (Dobro Ativado!)' : ''}.\n\n${pickedText}`,
              components: [new ActionRowBuilder().addComponents(devolveButton)], // Adiciona botão devolver
              allowedMentions: { users: [player.id] } // Menciona o jogador
          });
        }

        // --- Botão de DEVOLVER LOOT ---
        else if (action === 'devolver_loot') {
            lootMessageId = id; // ID da msg principal
            const playerId = playerIdForAction; // ID do player
            // Verifica permissão aqui
            if (!(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [playerId] }))) {
              return; // Interrompe
            }
            await interaction.deferUpdate(); // Defer aqui
            const player = state.players.find(p => p.id === playerId);
            // Se não tem itens, deleta a msg PÚBLICA onde o botão estava e limpa o ID
            if (!player || !player.items || player.items.length === 0) {
                if(interaction.message) {
                    await interaction.message.delete().catch(e => { if (e.code !== 10008) console.error("Erro ao deletar msg devolver_loot vazia:", e); }); // Usa error para erro real
                }
                if (player) {
                    player.doubleActive = false;
                    player.activeMessageId = null; // Limpa ID mesmo se deleção falhar
                }
                return; // Interrompe
            }

            // Chama função de playerLootUtils para devolver itens (atualiza state)
            const returnedItems = processItemReturn(state, player); // Retorna string dos itens
            // ===============================================
            // NOVO: Desativa o dobro ao devolver
            // ===============================================
            player.doubleActive = false;
            // ===============================================

            // Atualiza mensagem principal de loot
            const lootMessage = await interaction.channel.messages.fetch(lootMessageId);
            if (!lootMessage) throw new Error("Mensagem pública de loot não encontrada ao devolver.");
            // Chama lógicas de lootUtils para formatar e construir
            const playersString = formatPlayerList(state.players, true, true); // Inclui itens e nível
            const dropsString = formatDropsList(state.allDrops);
            const newMessageContent = buildLootMessageContent(state, playersString, dropsString);
            await lootMessage.edit({ content: newMessageContent }); // Edita msg principal

            // Deleta a mensagem de confirmação (onde estava o botão devolver)
            if (interaction.message) { await interaction.message.delete().catch(e => { if (e.code !== 10008) console.error("Erro ao deletar msg após devolver loot:", e); }); }
            // Limpa ID ativo do jogador
            player.activeMessageId = null;
        }

        // --- Botão de ENCERRAR MESA ---
        else if (action === 'encerrar_mesa') {
            lootMessageId = id; // ID da msg principal
            // Verifica permissão aqui
            if (!(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [state.mestreId] }))) {
              return; // Interrompe
            }
            await interaction.deferUpdate(); // Defer aqui
            // Chama a função de lootUtils que contém toda a lógica
            await handleEncerrarMesaClick(interaction, state, lootMessageId);
        }

        // --- Botão de ESCREVER RELATÓRIO ---
        else if (action === 'escrever_relatorio') {
            const [_, mestreId, logMessageId] = interaction.customId.split('|');
            // Verifica permissão aqui
            if (!(await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [mestreId] }))) {
              return; // Interrompe
            }
            // Lógica de buscar mensagem e mostrar modal permanece aqui
            const logMessage = await interaction.channel.messages.fetch(logMessageId);
            if (!logMessage) { await interaction.reply({ content: 'Msg de log não encontrada.', flags: [MessageFlagsBitField.Flags.Ephemeral] }); return; }
            let currentReport = ""; const reportMatch = logMessage.content.match(/Relatório\n```\n([\s\S]+?)\n```/); if (reportMatch && reportMatch[1]) { currentReport = reportMatch[1].trim(); if(currentReport === '(Área vazia)') currentReport = '';}
            const modal = new ModalBuilder().setCustomId(`modal_relatorio|${logMessageId}`).setTitle('Relatório da Missão');
            // Adiciona o TextInput dentro de um ActionRow
            modal.addComponents(new ActionRowBuilder().addComponents(
                new TextInputBuilder()
                    .setCustomId('relatorio_input')
                    .setLabel('Escreva o relatório da missão')
                    .setStyle(TextInputStyle.Paragraph)
                    .setValue(currentReport || 'Escreva aqui...')
                    .setRequired(true)
            ));
            await interaction.showModal(modal); // Mostra o formulário
        }

    } catch (error) { // Catch geral para a lógica dos botões
        console.error(`Erro no handleButton (${action}):`, error);
        const errorMessage = `Ocorreu um erro no botão: ${error.message}`.substring(0, 1900);
        // Tenta responder ou seguir, dependendo se já houve defer/reply
        if (interaction.replied || interaction.deferred) {
            await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
        } else {
            // Tenta responder efêmero se nenhuma resposta foi dada ainda
            await interaction.reply({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(async (replyError) => {
                 // Se o reply falhar (talvez interação já expirou), tenta followUp como último recurso
                 console.error("Falha ao responder ao erro do botão, tentando followUp:", replyError);
                 // Adiciona um catch aqui também para o followUp final
                 await interaction.followUp({ content: errorMessage, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(finalError => {
                     console.error("Falha final ao enviar mensagem de erro:", finalError);
                 });
            });
        }
    }

  } // Fim do handleButton
}; // Fim do module.exports