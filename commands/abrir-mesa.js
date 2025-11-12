const {
  SlashCommandBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlagsBitField,
  userMention
} = require('discord.js');

// Importamos a lógica necessária do Google
const {
  docSorteio,
  docControle,
  parsearAnuncioMesa,
  fetchPlayerLevels,
  lookupIds
} = require('../utils/google.js');

// +++ IMPORTA O NOVO UTILITÁRIO DE AUTENTICAÇÃO +++
const { checkAuth, AuthLevels } = require('../utils/auth.js');

const { registerReactionListener, removeReactionListener } = require('../utils/reactionManager.js');

module.exports = {

  // 1. DEFINIÇÃO DO COMANDO (Sem alterações)
  data: new SlashCommandBuilder()
    .setName('abrir-mesa')
    .setDescription('Cria um anúncio de mesa com inscrições via reação.')
    .addStringOption(option =>
      option.setName('emote')
        .setDescription('O emote que os jogadores devem usar para se inscrever.')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('niveis')
        .setDescription('Os níveis da mesa, separados por vírgula. Ex: 1,2,3')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('data_hora')
        .setDescription('Data e hora da mesa. Formato: DD/MM/AA HH:MM')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('duracao')
        .setDescription('A previsão de duração da mesa. Ex: 2h a 3h')
        .setRequired(true)
    )
    .addBooleanOption(option => 
      option.setName('mencionar_jogadores')
        .setDescription('Mencionar o cargo @Jogadores (True) ou jogadores por nível (False)? (Padrão: False)')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('nome_da_mesa')
        .setDescription('Opcional: O nome/título da sua mesa.')
        .setRequired(false)
    )
    .addStringOption(option =>
      option.setName('observacoes')
        .setDescription('Opcional: Informações adicionais, regras da casa, etc.')
        .setRequired(false)
    ),
    
  // 2. QUAIS INTERAÇÕES ESTE ARQUIVO GERENCIA (Sem alterações)
  buttons: ['fechar_inscricao', 'editar_mesa', 'cancelar_mesa'],
  modals: ['modal_editar'],
  reactions: ['abrir-mesa'],

  // 3. EXECUÇÃO DO COMANDO PRINCIPAL (/abrir-mesa) (ATUALIZADO)
  async execute(interaction) {
     await interaction.deferReply({ flags: [MessageFlagsBitField.Flags.Ephemeral] });
      try {
        // +++ USA O NOVO CHECKER +++
        const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.NARRADOR, AuthLevels.STAFF] });
        if (!hasAuth) {
          return;
        }
        const emoteString = interaction.options.getString('emote');
        const niveisString = interaction.options.getString('niveis');
        const dataHoraString = interaction.options.getString('data_hora');
        const duracao = interaction.options.getString('duracao');
        const mencionarJogadores = interaction.options.getBoolean('mencionar_jogadores') ?? false;
        
        const nomeMesa = interaction.options.getString('nome_da_mesa') ?? '';
        const observacoes = interaction.options.getString('observacoes') ?? '';

        const nomeMesaFormatado = nomeMesa ? `**${nomeMesa}**\n` : '';
        const observacoesFormatado = observacoes ? `\n\n**Observações:**\n${observacoes}` : '';

        let emoteId;
        const emoteAnimado = /<a:.*:(\d+)>/.exec(emoteString);
        const emoteEstatico = /<:.*:(\d+)>/.exec(emoteString);
        const emoteUnicode = /\p{Emoji}/u.exec(emoteString);
        if (emoteAnimado) emoteId = emoteAnimado[1];
        else if (emoteEstatico) emoteId = emoteEstatico[1];
        else if (emoteUnicode) emoteId = emoteUnicode[0];
        else {
         await interaction.editReply({ content: 'Não consegui identificar esse emote.'});
          return;
        }

        const { anuncioBase, finalTierString, mencaoJogadoresCargo } = await parsearAnuncioMesa(interaction.guild, niveisString, dataHoraString, duracao);

        let initialContent = "";
        const mestreMention = `**Mesa mestre:** ${interaction.user}`;
        
        const finalContent = `${nomeMesaFormatado}${mestreMention}\n${anuncioBase}\n${finalTierString}${observacoesFormatado}`; 

        if (mencionarJogadores) {
            initialContent = `${nomeMesaFormatado}${mestreMention}\n${anuncioBase}\n${mencaoJogadoresCargo}${observacoesFormatado}`;
        } else {
            const todosPlayerTags = [];
            const sheetPlayerId = docSorteio.sheetsByTitle['Player ID']; 
            if(sheetPlayerId) {
                const rows = await sheetPlayerId.getRows(); 
                rows.forEach(row => { if(row.get('Tag')) todosPlayerTags.push(row.get('Tag')); });
            }
            const levelsToFilter = niveisString.split(',').map(n => parseInt(n.trim())).filter(Number.isInteger);
            const playerLevelMap = await fetchPlayerLevels(todosPlayerTags);
            const filteredPlayerTags = [];
            playerLevelMap.forEach((levels, tag) => {
                const hasMatch = [...levels].some(level => levelsToFilter.includes(level));
                if (hasMatch) {
                    filteredPlayerTags.push(tag);
                }
            });
            const filteredPlayerIds = await lookupIds(filteredPlayerTags);
            const playerMentions = filteredPlayerIds.map(id => userMention(id)).join(' ') || '(Nenhum jogador encontrado nos níveis especificados)';
            initialContent = `${nomeMesaFormatado}${mestreMention}\n${anuncioBase}\n${playerMentions}${observacoesFormatado}`;
        }

        const fecharBotao = new ButtonBuilder()
         .setCustomId(`fechar_inscricao|${interaction.user.id}|${emoteId}`)
          .setLabel('Fechar inscrição')
          .setStyle(ButtonStyle.Danger);
        const editarBotao = new ButtonBuilder()
         .setCustomId(`editar_mesa|${interaction.user.id}`)
          .setLabel('Editar Mesa')
          .setStyle(ButtonStyle.Primary);
        const cancelarBotao = new ButtonBuilder()
         .setCustomId(`cancelar_mesa|${interaction.user.id}`)
          .setLabel('Cancelar Mesa')
          .setStyle(ButtonStyle.Secondary);
        const row = new ActionRowBuilder().addComponents(fecharBotao, editarBotao, cancelarBotao);

       const mensagemAnuncio = await interaction.channel.send({
           content: initialContent,
           components: [row]
       });

        await new Promise(resolve => setTimeout(resolve, 500)); 

        await mensagemAnuncio.edit({
             content: finalContent,
             components: [row]
        });

        await mensagemAnuncio.react(emoteString).catch(reactError => {
          console.error("Falha ao reagir:", reactError);
          interaction.followUp({ content: 'Aviso: Não consegui usar esse emote para reagir.', flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
        });
        // await mensagemAnuncio.react('❌').catch(console.error);

        // ===============================================
        // ATUALIZAÇÃO DA PLANILHA (SEM "DURAÇÃO")
        // ===============================================
        const [dataPart, horaPart] = dataHoraString.split(' ');
        await docControle.loadInfo();
        const sheetHistorico = docControle.sheetsByTitle['Historico'];
        await sheetHistorico.loadHeaderRow();
        const dadosParaAdicionar = {
          'ID da Mensagem': mensagemAnuncio.id,
          'Data': dataPart,
          'Horário': horaPart,
          'Narrador': interaction.user.username,
          'Tier': "'" + niveisString,
          // 'Duração': duracao, // <-- Removido
          'Registrar Mesa': 'Não',
          'Mesa Finalizada': 'Não',
          'Nome da Mesa': nomeMesa || '',
          'Observações': observacoes || ''
        };
        await sheetHistorico.addRow(dadosParaAdicionar);
        // ===============================================

        // <<< REGISTRA OS OUVINTES DE REAÇÃO >>>
        const mestreId = interaction.user.id;
        // 1. Ouvinte para Fechar Inscrição (com o emote da mesa)
        /*registerReactionListener(interaction.client, mensagemAnuncio.id, {
            commandName: 'abrir-mesa', // Nome deste comando (data.name)
            emojiIdentifier: emoteId, // O emote de inscrição (ID ou Unicode)
            allowedUsers: [mestreId], // Apenas o mestre pode acionar
            extraData: { action: 'fechar_inscricao', emoteId: emoteId } // Dados que o handleReaction irá receber
        });*/

        // 2. Ouvinte para Cancelar Mesa (com o X)
        /*registerReactionListener(interaction.client, mensagemAnuncio.id, {
            commandName: 'abrir-mesa',
            emojiIdentifier: '❌', // O emoji de cancelar
            allowedUsers: [mestreId], // Apenas o mestre
            extraData: { action: 'cancelar_mesa' }
        });*/
        // (Não adicionamos o ✏️ pois não podemos abrir um Modal)

        // 3. NOVO: Ouvinte para Reativar Botões (com 📋)
        registerReactionListener(interaction.client, mensagemAnuncio.id, {
            commandName: 'abrir-mesa',
            emojiIdentifier: '📋', // O emoji de clipboard
            allowedUsers: [mestreId], // Apenas o mestre
            extraData: { action: 'reabrir_botoes' }
        });

       await interaction.editReply({ content: 'Anúncio de mesa criado com sucesso!', components: [] });

      } catch (error) {
        console.error("Erro no comando /abrir-mesa:", error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: `Ocorreu um erro ao abrir a mesa: ${error.message}`, components: [] }).catch(console.error);
         }
      }
  },

  // 4. GERENCIADOR DE BOTÕES (deste comando) (ATUALIZADO)
  async handleButton(interaction) {
      const [action, mestreId, emoteId] = interaction.customId.split('|');

      // +++ USA O NOVO CHECKER +++
      // O index.js só enviará botões deste arquivo (fechar, editar, cancelar).
      // Todos eles exigem ser o Mestre ou Staff.
      const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF], allowedUsers: [mestreId] });
      if (!hasAuth) {
        return;
      }
      
      try {
          if (action === 'fechar_inscricao') {
            await interaction.deferUpdate();

            // +++ INÍCIO DA CORREÇÃO (BUG) +++
            // [1] Busca a reação e os inscritos ANTES de editar a mensagem
            const message = await interaction.message.fetch();
            const reacao = message.reactions.cache.get(emoteId);

            const disabledRow = ActionRowBuilder.from(interaction.message.components[0]);
            disabledRow.components.forEach(comp => comp.setDisabled(true));
            
            if (!reacao) {
              await interaction.followUp({ content: 'Erro: Não encontrei a reação do anúncio. Ninguém se inscreveu?', flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
              return;
            }
            const usuarios = await reacao.users.fetch();
            const inscritos = usuarios.filter(user => !user.bot).map(user => user.username);

            // [2] AGORA edita a mensagem (desabilita os botões)
            await interaction.message.edit({ components: [disabledRow] });
            // +++ FIM DA CORREÇÃO (BUG) +++

            if (inscritos.length === 0) {
               await interaction.followUp({ content: 'Sorteio cancelado: Ninguém se inscreveu.', flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
               return;
            }
            let inscritosFormatado = `\`\`\`${inscritos.join(' ')}\`\`\``;
            const sortButton = new ButtonBuilder()
              .setCustomId('show_sort_modal')
              .setLabel('Efetuar Sorteio')
              .setStyle(ButtonStyle.Success);
            const row = new ActionRowBuilder().addComponents(sortButton);
            await interaction.followUp({
              content: `Inscrições fechadas!\n\n**Inscritos:**\n${inscritosFormatado}\n\nClique abaixo para definir os níveis e efetuar o sorteio.`,
              components: [row]
            });
            removeReactionListener(interaction.client, interaction.message.id);
          }
          else if (action === 'cancelar_mesa') {
            await interaction.deferUpdate();
            // ... (Lógica de cancelar mesa - sem alteração)
            await docControle.loadInfo();
            const sheetHistorico = docControle.sheetsByTitle['Historico'];
            await sheetHistorico.loadHeaderRow();
            const rows = await sheetHistorico.getRows();
            const row = rows.find(r => r.get('ID da Mensagem') === interaction.message.id);
            if (row) {
              await row.delete();
            }
            await interaction.message.delete();
            await interaction.followUp({ content: 'Mesa cancelada e removida do histórico.', flags: [MessageFlagsBitField.Flags.Ephemeral] });

            removeReactionListener(interaction.client, interaction.message.id);
          }
          else if (action === 'editar_mesa') {
            // ===============================================
            // BUSCAR DADOS ATUAIS (PLANILHA E MENSAGEM)
            // ===============================================
            
            // 1. Buscar da Planilha (Níveis, Data, Hora)
            await docControle.loadInfo();
            const sheetHistorico = docControle.sheetsByTitle['Historico'];
            await sheetHistorico.loadHeaderRow();
            const rows = await sheetHistorico.getRows();
            const row = rows.find(r => r.get('ID da Mensagem') === interaction.message.id);

            let currentNiveis = '';
            let currentDataHora = '';

            if (row) {
                currentNiveis = row.get('Tier')?.replace(/'/g, '') || ''; // Remove o '
                const data = row.get('Data') || '';
                const hora = row.get('Horário') || '';
                currentDataHora = (data && hora) ? `${data} ${hora}` : '';
            }
            
            // 2. Buscar da Mensagem (Nome, Duração, Observações)
            const currentContent = interaction.message.content;
            
            const nomeMesaMatch = currentContent.match(/^\*\*(.*?)\*\*\n\*\*Mesa mestre:\*\*/);
            const currentNomeMesa = nomeMesaMatch ? nomeMesaMatch[1] : '';

            // Regex ATUALIZADO para buscar a Duração
            const duracaoMatch = currentContent.match(/\*\*Previsão de duração:\*\* (.*)/);
            const currentDuracao = duracaoMatch ? duracaoMatch[1] : '';
            
            const observacoesMatch = currentContent.match(/\n\n\*\*Observações:\*\*\n([\s\S]+)$/);
            const currentObservacoes = observacoesMatch ? observacoesMatch[1] : '';
            // ===============================================
            
            const modal = new ModalBuilder()
              .setCustomId(`modal_editar|${interaction.message.id}`)
              .setTitle('Editar Anúncio da Mesa');
              
            // ===============================================
            // CAMPOS DO MODAL ATUALIZADOS COM .setValue()
            // ===============================================
            const nomeMesaInput = new TextInputBuilder()
              .setCustomId('nome_da_mesa_input')
              .setLabel("Nome da Mesa (Opcional)")
              .setStyle(TextInputStyle.Short)
              .setRequired(false)
              .setValue(currentNomeMesa); // Pré-preenche

            const niveisInput = new TextInputBuilder()
              .setCustomId('niveis_input')
              .setLabel("Novos Níveis (Ex: 1,2,3)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(currentNiveis); // Pré-preenche

            const dataHoraInput = new TextInputBuilder()
              .setCustomId('data_hora_input')
              .setLabel("Nova Data e Hora (DD/MM/AA HH:MM)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(currentDataHora); // Pré-preenche

            const duracaoInput = new TextInputBuilder()
              .setCustomId('duracao_input')
              .setLabel("Nova Duração (Ex: 3h a 4h)")
              .setStyle(TextInputStyle.Short)
              .setRequired(true)
              .setValue(currentDuracao); // Pré-preenche (agora da mensagem)

            const observacoesInput = new TextInputBuilder()
              .setCustomId('observacoes_input')
              .setLabel("Observações (Opcional)")
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(false)
              .setValue(currentObservacoes); // Pré-preenche

            const firstRow = new ActionRowBuilder().addComponents(nomeMesaInput);
            const secondRow = new ActionRowBuilder().addComponents(niveisInput);
            const thirdRow = new ActionRowBuilder().addComponents(dataHoraInput);
            const fourthRow = new ActionRowBuilder().addComponents(duracaoInput);
            const fifthRow = new ActionRowBuilder().addComponents(observacoesInput);
            
            modal.addComponents(firstRow, secondRow, thirdRow, fourthRow, fifthRow);
            // ===============================================
            
            await interaction.showModal(modal); // Sem deferUpdate
          }
      } catch (error) {
          console.error("Erro no manipulador de botões (abrir-mesa):", error);
          if (interaction.replied || interaction.deferred) {
              await interaction.followUp({ content: `Ocorreu um erro no botão: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
          } else {
              await interaction.reply({ content: `Ocorreu um erro no botão: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
          }
      }
  },

  // 5. GERENCIADOR DE MODAIS (deste comando) (ATUALIZADO)
  async handleModal(interaction) {
    const [action, originalMessageId] = interaction.customId.split('|');

    if (action === 'modal_editar') {
      try {
        await interaction.deferReply({ flags: [MessageFlagsBitField.Flags.Ephemeral] });
        
        // ===============================================
        // PEGAR TODOS OS VALORES DO MODAL
        // ===============================================
        const nomeMesa = interaction.fields.getTextInputValue('nome_da_mesa_input') ?? '';
        const niveisString = interaction.fields.getTextInputValue('niveis_input');
        const dataHoraString = interaction.fields.getTextInputValue('data_hora_input');
        const duracao = interaction.fields.getTextInputValue('duracao_input'); 
        const observacoes = interaction.fields.getTextInputValue('observacoes_input') ?? '';
        // ===============================================

        const [dataPart, horaPart] = dataHoraString.split(' ');
        
        await docControle.loadInfo();
        const sheetHistorico = docControle.sheetsByTitle['Historico'];
        await sheetHistorico.loadHeaderRow();
        const rows = await sheetHistorico.getRows();
        const row = rows.find(r => r.get('ID da Mensagem') === originalMessageId);
        
        // ===============================================
        // ATUALIZAR A PLANILHA (SEM "DURAÇÃO")
        // ===============================================
        if (row) {
          row.set('Data', dataPart);
          row.set('Horário', horaPart);
          row.set('Tier', "'" + niveisString);
          // row.set('Duração', duracao); // <-- Removido
          row.set('Nome da Mesa', nomeMesa || '');
          row.set('Observações', observacoes || '');
          await row.save();
        }
        // ===============================================
        
        const message = await interaction.channel.messages.fetch(originalMessageId);
        const mestreUser = message.mentions.users.first() || (message.interaction ? message.interaction.user : interaction.user);
        
        // A 'duracao' vinda do formulário é passada aqui
        const { anuncioBase, finalTierString } = await parsearAnuncioMesa(interaction.guild, niveisString, dataHoraString, duracao);
        
        // ===============================================
        // REMONTAR O ANÚNCIO COMPLETO
        // ===============================================
        const nomeMesaFormatado = nomeMesa ? `**${nomeMesa}**\n` : '';
        const observacoesFormatado = observacoes ? `\n\n**Observações:**\n${observacoes}` : '';
        const anuncioCompleto = `${nomeMesaFormatado}**Mesa mestre:** ${mestreUser}\n${anuncioBase}\n${finalTierString}${observacoesFormatado}`;
        // ===============================================

        await message.edit({ content: anuncioCompleto });
        await interaction.editReply({ content: 'Mesa atualizada no Discord e na planilha!'});
      } catch (error) {
        console.error("Erro no manipulador de modal (modal_editar):", error);
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: `Ocorreu um erro ao processar o formulário: ${error.message}`, components: [] }).catch(console.error);
        } else {
          await interaction.reply({ content: `Ocorreu um erro ao processar o formulário: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
        }
      }
    }
  },

  // ===============================================
  // 5. NOVO: GERENCIADOR DE REAÇÕES
  // ===============================================
  /**
   * Chamado pelo index.js quando uma reação monitorada é adicionada.
   * @param {import('discord.js').MessageReaction} reaction - O objeto da reação.
   * @param {import('discord.js').User} user - O usuário (Mestre) que reagiu.
   * @param {object} listener - O objeto do ouvinte que foi salvo (com .extraData).
   */
  async handleReaction(reaction, user, listener) {
    const { action } = listener.extraData;
    const { message } = reaction; // A mensagem que sofreu a reação
    const client = reaction.client; // O cliente (bot)

    try {
      // --- AÇÃO: Fechar Inscrição (via Reação) ---
      if (action === 'fechar_inscricao') {
        const { emoteId } = listener.extraData; // Pega o emoteId dos dados extras

        // +++ INÍCIO DA CORREÇÃO (BUG) +++
        // [1] Pega os inscritos ANTES de remover as reações
        const usuarios = await reaction.users.fetch();
        const inscritos = usuarios.filter(u => !u.bot).map(u => u.username);
        // +++ FIM DA CORREÇÃO (BUG) +++

        // 1. Remove listeners (para evitar duplo clique) e desabilita botões
        removeReactionListener(client, message.id);
        const disabledRow = ActionRowBuilder.from(message.components[0]);
        disabledRow.components.forEach(comp => comp.setDisabled(true));
        await message.edit({ components: [disabledRow] });
        await message.reactions.removeAll().catch(() => {}); // Limpa todas as reações
        
        if (inscritos.length === 0) {
           await message.channel.send({ content: 'Sorteio cancelado: Ninguém se inscreveu.' });
           return;
        }

        // 3. Envia mensagem pública de sorteio (Lógica duplicada do handleButton)
        let inscritosFormatado = `\`\`\`${inscritos.join(' ')}\`\`\``;
        const sortButton = new ButtonBuilder()
          .setCustomId('show_sort_modal')
          .setLabel('Efetuar Sorteio')
          .setStyle(ButtonStyle.Success);
        const row = new ActionRowBuilder().addComponents(sortButton);
        await message.channel.send({
          content: `Inscrições fechadas!\n\n**Inscritos:**\n${inscritosFormatado}\n\nClique abaixo para definir os níveis e efetuar o sorteio.`,
          components: [row]
        });
      }

      // --- AÇÃO: Cancelar Mesa (via Reação) ---
      else if (action === 'cancelar_mesa') {
        // 1. Remove ouvintes
        removeReactionListener(client, message.id);

        // 2. Atualiza Planilha (Lógica duplicada do handleButton)
        await docControle.loadInfo();
        const sheetHistorico = docControle.sheetsByTitle['Historico'];
        await sheetHistorico.loadHeaderRow();
        const rows = await sheetHistorico.getRows();
        const row = rows.find(r => r.get('ID da Mensagem') === message.id);
        if (row) {
          await row.delete();
        }

        // 3. Apaga a mensagem da mesa
        await message.delete();
        // (Não podemos enviar 'followUp' efêmero de confirmação aqui)
      

      // --- AÇÃO: Reabrir Botões (via 📋) ---
      } else if (action === 'reabrir_botoes') {
          await reaction.users.remove(user.id).catch(() => {});
          const currentComponents = message.components;
          if (!currentComponents || currentComponents.length === 0) return;
          const enabledButtons = currentComponents[0].components.map(comp => 
              ButtonBuilder.from(comp).setDisabled(false)
          );
          const enabledRow = new ActionRowBuilder().addComponents(enabledButtons);
          await message.edit({ components: [enabledRow] });
      }
      // +++ FIM DAS NOVAS AÇÕES +++

    } catch (error) {
        console.error(`[ERRO handleReaction] Falha ao processar reação '${action}' para msg ${message.id}:`, error);
        // Tenta enviar uma mensagem pública de erro
        await message.channel.send({ content: `Ocorreu um erro ao processar a reação ${reaction.emoji.name}.` }).catch(() => {});
    }
  }

};