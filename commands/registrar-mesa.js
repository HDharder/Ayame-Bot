const {
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  MessageFlagsBitField
} = require('discord.js');

// Importamos a lógica necessária do Google
const {
  sheets,
  lookupUsernames,
  incrementarContagem, // Mantém a importação
  getValuesFromSheet // <<< ADICIONA a nova função (embora não a usemos diretamente aqui na refatoração final)
} = require('../utils/google.js');

// +++ IMPORTA O NOVO UTILITÁRIO DE AUTENTICAÇÃO +++
const { checkAuth, AuthLevels } = require('../utils/auth.js');

module.exports = {

  // 1. DEFINIÇÃO DO COMANDO (Sem alterações)
  data: new SlashCommandBuilder()
    .setName('registrar-mesa')
    .setDescription('Registra os jogadores sorteados em uma mesa no histórico.')
    .addStringOption(option =>
        option.setName('primario')
            .setDescription('Jogadores com personagem PRIMÁRIO (@Menção ou tag).')
            .setRequired(false)
    )
    .addStringOption(option =>
        option.setName('secundario')
            .setDescription('Jogadores com personagem SECUNDÁRIO (@Menção ou tag).')
            .setRequired(false)
    ),

  // 2. QUAIS INTERAÇÕES ESTE ARQUIVO GERENCIA (Sem alterações)
  selects: ['registrar_mesa_select'], // Este comando usa um Select Menu

  // 3. EXECUÇÃO DO COMANDO PRINCIPAL (/registrar-mesa) (Sem alterações)
  async execute(interaction) {
    try {
      // MUDANÇA: Defer público. A resposta "Bot está pensando..."
      // será visível para todos, e a mensagem final também.
      await interaction.deferReply(); 

      // +++ USA O NOVO CHECKER +++
      const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.NARRADOR, AuthLevels.STAFF] });
      if (!hasAuth) {
        return;
      }
      const primariosInput = interaction.options.getString('primario') || '';
      const secundariosInput = interaction.options.getString('secundario') || '';
      const primariosRaw = primariosInput.replace(/,/g, '').split(/\s+/).filter(Boolean);
      const secundariosRaw = secundariosInput.replace(/,/g, '').split(/\s+/).filter(Boolean);

      const primarios = await lookupUsernames(primariosRaw);
      const secundarios = await lookupUsernames(secundariosRaw);

      const todosJogadores = [...primarios, ...secundarios];
      if (todosJogadores.length === 0) {
          await interaction.editReply('Nenhum jogador válido (menção encontrada ou tag direta) foi informado.');
          return;
      }
      await sheets.docControle.loadInfo();
      const sheetHistorico = sheets.docControle.sheetsByTitle['Historico'];
      await sheetHistorico.loadHeaderRow();
      const rows = await sheetHistorico.getRows();
      const mesasAbertas = rows.filter(row =>
          row.get('Narrador') === interaction.user.username &&
          row.get('Registrar Mesa') === 'Não'
      );
      if (mesasAbertas.length === 0) {
          await interaction.editReply('Você não possui mesas pendentes de registro no histórico.');
          return;
      }
      const selectMenu = new StringSelectMenuBuilder()
          .setCustomId(`registrar_mesa_select|${interaction.id}`)
          .setPlaceholder('Selecione a mesa para registrar os jogadores');
      mesasAbertas.slice(0, 25).forEach(row => {
          const data = row.get('Data');
          const horario = row.get('Horário');
          const tier = row.get('Tier');
          const messageId = row.get('ID da Mensagem');
          const label = `Mesa ${data} ${horario} (Tier ${tier?.replace(/'/,'')})`;
          selectMenu.addOptions(
              new StringSelectMenuOptionBuilder()
                  .setLabel(label.length > 100 ? label.substring(0, 97) + '...' : label)
                  .setValue(messageId)
          );
      });
      
      // Usamos o 'pendingRegistrations' do 'client'
      interaction.client.pendingRegistrations.set(interaction.id, { primarios, secundarios });
      
      const rowComponent = new ActionRowBuilder().addComponents(selectMenu);
      await interaction.editReply({
          content: 'Selecione abaixo qual das suas mesas você deseja registrar:',
          components: [rowComponent]
          // A flag 'flags: []' foi removida pois não é mais necessária
      });
    } catch (error) {
      console.error("Erro no comando /registrar-mesa:", error);
       if (interaction.deferred || interaction.replied) {
           // A resposta de erro agora também será pública
           await interaction.editReply({ content: `Ocorreu um erro: ${error.message}`, components: [] }).catch(console.error);
       } else {
           // Fallback, caso o defer falhe
           await interaction.reply({ content: `Ocorreu um erro: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
       }
    }
  },

  // 4. GERENCIADOR DE SELECT MENUS (deste comando) (ATUALIZADO)
  async handleSelect(interaction) {
    const [action, originalInteractionId] = interaction.customId.split('|');
    
    if (action === 'registrar_mesa_select') {
      try {
        await interaction.deferUpdate(); 

        const playersData = interaction.client.pendingRegistrations.get(originalInteractionId);
        if (!playersData) {
          await interaction.editReply({ content: 'Não foi possível encontrar os dados dos jogadores. Tente usar o comando novamente.', components: []});
          return;
        }
        interaction.client.pendingRegistrations.delete(originalInteractionId);
        
        const { primarios, secundarios } = playersData;
        const todosJogadores = [...primarios, ...secundarios];
        const selectedMessageId = interaction.values[0];

        await sheets.docSorteio.loadInfo();
        // <<< USA A NOVA ABA UNIFICADA >>>
        const sheetPersonagens = sheets.docSorteio.sheetsByTitle['Personagens'];

        if (!sheetPersonagens) {
            throw new Error("Não foi possível encontrar a aba 'Personagens' na planilha de Sorteio.");
        }

        // --- Busca dados da aba "Personagens" UMA VEZ ---
        await sheetPersonagens.loadHeaderRow(2); // Assume header na linha 2
        const allCharRows = await sheetPersonagens.getRows();
        const playerInfoMap = new Map(); // Chave: "taglower-tipo" (tipo 1 ou 2), Valor: { char, level }

        allCharRows.forEach(row => {
            const nome = row.get('Nome')?.trim().toLowerCase();
            const char = row.get('Personagem')?.trim();
            const level = parseInt(row.get('Level'));
            const tipo = row.get('Prim/Sec/Terc')?.trim(); // Pega o valor 1 ou 2

            if (nome && char && !isNaN(level) && (tipo === '1' || tipo === '2')) {
                const key = `${nome}-${tipo}`;
                playerInfoMap.set(key, { char: char, level: level });
            }
        });
        // --- Fim da busca de dados ---

        await sheets.docControle.loadInfo();
        const sheetHistorico = sheets.docControle.sheetsByTitle['Historico'];
        // Assume que o cabeçalho está na LINHA 1
        await sheetHistorico.loadHeaderRow(1); 
        const rowsHistorico = await sheetHistorico.getRows();
        
        // ===============================================
        // INÍCIO DA LÓGICA CORRIGIDA PARA HISTÓRICO
        // ===============================================

        // 1. Encontrar o índice da linha no array (base 0)
        const rowIndexInArray = rowsHistorico.findIndex(r => r.get('ID da Mensagem') === selectedMessageId);
        
        if (rowIndexInArray === -1) {
            await interaction.editReply({ content: 'Erro: Não encontrei a linha correspondente a esta mesa no histórico.', components: []});
            return;
        }

        // 2. Calcular os índices da planilha
        const sheetRowIndex_1_based = rowIndexInArray + 2; // +1 (0-based) +1 (header)
        const sheetRowIndex_0_based = rowIndexInArray + 1; // 0-based index (para getCell)

        // 3. Carregamos o range de células que vamos editar (F até L)
        const rowRange = `F${sheetRowIndex_1_based}:L${sheetRowIndex_1_based}`;
        await sheetHistorico.loadCells(rowRange);

        const cellsToUpdate = [];

        // 4. Loop para definir os jogadores (Colunas F a K, índice 5 a 10)
        let playerIndex = 0;
        todosJogadores.forEach(playerName => {
          if (playerIndex < 6) {
            // <<< LÓGICA ATUALIZADA PARA BUSCAR NO MAP >>>
            let playerInfo = null;
            const playerNameLower = playerName.toLowerCase();
            let tipoChar = '0'; // Tipo padrão inválido

            // Verifica se o jogador estava na lista de primários ou secundários
            if (primarios.map(p => p.toLowerCase()).includes(playerNameLower)) {
                tipoChar = '1';
                playerInfo = playerInfoMap.get(`${playerNameLower}-1`);
            } else if (secundarios.map(s => s.toLowerCase()).includes(playerNameLower)) {
                tipoChar = '2';
                playerInfo = playerInfoMap.get(`${playerNameLower}-2`);
            }
            // <<< FIM DA LÓGICA ATUALIZADA >>>
            
            let cellValue = '';

            if (playerInfo) {
                // Formato: "Tag - Personagem - Nível"
                cellValue = `${playerName} - ${playerInfo.char} - ${playerInfo.level}`;
            } else {
                // Fallback atualizado
                cellValue = `${playerName} - Char (Tipo ${tipoChar}) não encontrado`;
                console.warn(`[AVISO Registrar Mesa] Não foi possível encontrar char tipo ${tipoChar} para ${playerName} na aba 'Personagens'.`);
            }
            // Usamos o índice 0-based para getCell
            const cell = sheetHistorico.getCell(sheetRowIndex_0_based, 5 + playerIndex); // 5=F, 6=G, etc.
            cell.value = cellValue; // <<< Define o valor com o novo formato
            cellsToUpdate.push(cell);
            playerIndex++;
          }
        });

        // 5. Loop para limpar as células restantes
        for (let i = playerIndex; i < 6; i++) {
            const cell = sheetHistorico.getCell(sheetRowIndex_0_based, 5 + i);
            cell.value = '';
            cellsToUpdate.push(cell);
        }

        // 6. Atualizar a coluna "Registrar Mesa" (Coluna L, índice 11)
        const cellRegistrar = sheetHistorico.getCell(sheetRowIndex_0_based, 11); // Coluna L
        cellRegistrar.value = 'Sim';
        cellsToUpdate.push(cellRegistrar);

        // 7. Salvar todas as células alteradas de uma vez
        await sheetHistorico.saveUpdatedCells(cellsToUpdate);

        // ===============================================
        // FIM DA LÓGICA CORRIGIDA
        // ===============================================

        // --- Atualização Mesas Jogadas ---
        await sheetPersonagens.loadCells('B1');
        const cellB1 = sheetPersonagens.getCellByA1('B1');
        const weekOffset = parseInt(cellB1.value); // Lê o valor da B1
        if (isNaN(weekOffset)) {
            throw new Error("Valor na célula B1 da aba 'Personagens' não é um número válido.");
        }
        
        const targetColIndex = 4 + weekOffset; // Col E (idx 4) + offset B1
        console.log(`[DEBUG] Select Menu: Offset B1=${weekOffset}, Índice da coluna alvo=${targetColIndex}`);

        // Chama a função importada, passando a aba "Personagens"
        // Chama UMA VEZ com todos os jogadores e a sheet correta
        //await incrementarContagem(sheetPersonagens, todosJogadores, targetColIndex);
        let countSuccess = true; // Flag para rastrear sucesso
        if (primarios.length > 0) {
            const successPrim = await incrementarContagem(sheetPersonagens, primarios, targetColIndex, '1'); // Passa '1' para primário
            if (!successPrim) countSuccess = false;
        }
        if (secundarios.length > 0) {
            const successSec = await incrementarContagem(sheetPersonagens, secundarios, targetColIndex, '2'); // Passa '2' para secundário
            if (!successSec) countSuccess = false;
        }

        // Opcional: Adicionar um aviso se alguma contagem falhar
        if (!countSuccess) {
             console.warn("[AVISO Registrar Mesa] Falha ao incrementar a contagem de mesas para um ou mais jogadores/tipos.");
             // Poderia adicionar um aviso na resposta ao usuário também
        }

        // --- Finalização ---
        let jogadoresRegistradosString = todosJogadores.map(playerName => {
            // <<< LÓGICA ATUALIZADA PARA BUSCAR NO MAP (igual ao passo 4) >>>
            let playerInfo = null;
            const playerNameLower = playerName.toLowerCase();
            let tipoChar = '0';
            if (primarios.map(p => p.toLowerCase()).includes(playerNameLower)) {
                tipoChar = '1';
                playerInfo = playerInfoMap.get(`${playerNameLower}-1`);
            } else if (secundarios.map(s => s.toLowerCase()).includes(playerNameLower)) {
                tipoChar = '2';
                playerInfo = playerInfoMap.get(`${playerNameLower}-2`);
            }
            // <<< FIM DA LÓGICA ATUALIZADA >>>

            if (playerInfo) {
                return `${playerName} - ${playerInfo.char} - ${playerInfo.level}`; // <<< Inclui nível
            } else {
                 return `${playerName} - Char (Tipo ${tipoChar}) não encontrado`;
            }
        }).join('\n');
        const jogadoresRegistradosCodeBlock = `\`\`\`\n${jogadoresRegistradosString}\n\`\`\``;
        
        await interaction.editReply({
            content: `Mesa registrada com sucesso! Jogadores adicionados ao histórico e contagem de mesas atualizada.\n\n**Jogadores Registrados:**\n${jogadoresRegistradosCodeBlock}`,
            components: [] // Remove o select menu
        });

      } catch (error) {
        console.error("[ERRO NO SELECT MENU HANDLER]:", error);
        try {
            if (interaction.message) {
                await interaction.editReply({ content: `Ocorreu um erro ao registrar a mesa: ${error.message}`, components: [] }).catch(console.error);
            } else {
                await interaction.followUp({ content: `Ocorreu um erro ao registrar a mesa: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
            }
        } catch (editError) {
           console.error("Falha ao editar a mensagem original com erro:", editError);
            await interaction.followUp({ content: `Ocorreu um erro ao registrar a mesa: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
        }
      }
    }
  }
};