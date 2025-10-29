const {
  SlashCommandBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlagsBitField,
  ButtonBuilder: DiscordButtonBuilder, // Alias para evitar conflito
} = require('discord.js');

// Importamos a lógica específica do Google
const { executarLogicaSorteio } = require('../utils/google.js');

// +++ IMPORTA O NOVO UTILITÁRIO DE AUTENTICAÇÃO +++
const { checkAuth, AuthLevels } = require('../utils/auth.js');

module.exports = {
  
  // 1. DEFINIÇÃO DO COMANDO
  data: new SlashCommandBuilder()
    .setName('sortear')
    .setDescription('Realiza o sorteio de vagas do RPG.')
    .addStringOption(option =>
      option.setName('inscritos')
        .setDescription('A lista de jogadores inscritos (separados por espaço ou linha).')
        .setRequired(true)
    ),

  // 2. QUAIS INTERAÇÕES ESTE ARQUIVO GERENCIA
  buttons: ['show_sort_modal'],
  modals: ['level_sort_modal'],

  // 3. EXECUÇÃO DO COMANDO PRINCIPAL (/sortear)
  async execute(interaction) {
    try {

      // +++ ADICIONA O NOVO CHECKER +++
      const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.NARRADOR, AuthLevels.STAFF] });
      if (!hasAuth) {
        return;
      }

      await interaction.deferReply(); // Público
      const inscritosTexto = interaction.options.getString('inscritos');
      const nomesInscritos = inscritosTexto.replace(/\n/g, ' ').split(/\s+/).filter(Boolean);
      if (nomesInscritos.length === 0) {
        await interaction.editReply('Nenhum nome de inscrito válido foi fornecido.');
        return;
      }
      const inscritosFormatado = `\`\`\`${nomesInscritos.join(' ')}\`\`\``;
      const sortButton = new ButtonBuilder()
        .setCustomId('show_sort_modal')
        .setLabel('Efetuar Sorteio')
        .setStyle(ButtonStyle.Success);
      const row = new ActionRowBuilder().addComponents(sortButton);
      await interaction.editReply({
        content: `**Inscritos para Sorteio:**\n${inscritosFormatado}\n\nClique abaixo para definir os níveis e efetuar o sorteio.`,
        components: [row]
      });
    } catch (error) {
      console.error("Erro no comando /sortear:", error);
      try {
          await interaction.editReply({ content: `Ocorreu um erro: ${error.message}` });
      } catch (editError) {
          console.error("Erro ao tentar editar a resposta de erro:", editError);
          await interaction.followUp({ content: `Ocorreu um erro: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      }
    }
  },

  // 4. GERENCIADOR DE BOTÕES (deste comando)
  async handleButton(interaction) {
    const [action] = interaction.customId.split('|');

    if (action === 'show_sort_modal') {
      try {
        // AÇÃO CORRIGIDA: 
        const idDaMensagemDoBotao = interaction.message.id; 

        const modal = new ModalBuilder()
         .setCustomId(`level_sort_modal|${idDaMensagemDoBotao}`) // Correto
         .setTitle('Filtrar Sorteio por Nível');
        const niveisInput = new TextInputBuilder()
          .setCustomId('niveis_input')
          .setLabel("Níveis (Ex: 2,3,4)")
          .setPlaceholder("Deixe em branco para sortear todos os inscritos")
          .setStyle(TextInputStyle.Short)
          .setRequired(false);
        const row = new ActionRowBuilder().addComponents(niveisInput);
        modal.addComponents(row);
        await interaction.showModal(modal); // showModal é a primeira resposta
      } catch (error) {
         console.error("Erro no botão show_sort_modal:", error);
         if (interaction.replied || interaction.deferred) {
             await interaction.followUp({ content: `Ocorreu um erro no botão: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
         } else {
             await interaction.reply({ content: `Ocorreu um erro no botão: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
         }
      }
    }
  },

  // 5. GERENCIADOR DE MODAIS (deste comando)
  async handleModal(interaction) {
    const [action, originalMessageId] = interaction.customId.split('|');

    if (action === 'level_sort_modal') {
      try {
        await interaction.deferReply(); // Defer público para a resposta do sorteio
        const originalMessage = await interaction.channel.messages.fetch(originalMessageId);
        if (!originalMessage) {
            throw new Error('Não consegui encontrar a mensagem original do sorteio.');
        }
        const messageContent = originalMessage.content;
        const match = /```(.*?)```/.exec(messageContent);
        if (!match || !match[1]) {
          throw new Error('Não foi possível encontrar a lista de inscritos na mensagem original.');
        }
        const nomesInscritos = match[1].split(' ');
        const niveisString = interaction.fields.getTextInputValue('niveis_input');
        let levelFilter = [];
        if (niveisString) {
          levelFilter = niveisString.split(',')
            .map(n => parseInt(n.trim()))
            .filter(Number.isInteger);
        }
        
        // Chama a lógica importada
        const { resposta, mencoes } = await executarLogicaSorteio(nomesInscritos, levelFilter);
        
        await interaction.editReply(resposta); // Edita a resposta pública
        await interaction.followUp({ content: mencoes, allowedMentions: { users: [] } }); // Envia menções
        
        if (originalMessage.components.length > 0 && originalMessage.components[0].components.length > 0) {
            const buttonToDisable = originalMessage.components[0].components.find(c => c.customId === 'show_sort_modal');
            if (buttonToDisable) {
                // Tive que usar 'DiscordButtonBuilder' por causa de um conflito de nome
                const disabledButton = DiscordButtonBuilder.from(buttonToDisable).setDisabled(true);
                 const updatedComponents = originalMessage.components[0].components.map(c => c.customId === 'show_sort_modal' ? disabledButton : c);
                 const updatedRow = new ActionRowBuilder().addComponents(updatedComponents);
                 await originalMessage.edit({ components: [updatedRow] });
            } else {
                 console.warn(`[AVISO] Botão 'show_sort_modal' não encontrado na mensagem ${originalMessageId} para desabilitar.`);
            }
        } else {
            console.warn(`[AVISO] Não foi possível desabilitar o botão na mensagem ${originalMessageId}. Componentes não encontrados.`);
        }
      } catch (error) {
        console.error("Erro no manipulador de modal (level_sort_modal):", error);
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: `Ocorreu um erro ao processar o formulário: ${error.message}`, components: [] }).catch(console.error);
        } else {
          await interaction.reply({ content: `Ocorreu um erro ao processar o formulário: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
        }
      }
    }
  }
};