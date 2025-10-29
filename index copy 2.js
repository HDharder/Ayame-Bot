// --- 1. Importação das Bibliotecas ---
require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  Events,
  ButtonBuilder,
  ButtonStyle,
  ActionRowBuilder,
  PermissionsBitField,
  Utils,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlagsBitField,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  roleMention, // Para menção de cargo
  userMention  // Para menção de usuário
} = require('discord.js');
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');

// --- 2. Configuração das Credenciais ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SORTEIO_SHEET_ID = process.env.SORTEIO_SHEET_ID;
const CONTROLE_SHEET_ID = process.env.CONTROLE_SHEET_ID;
const credenciais = require('./credentials.json');

const serviceAccountAuth = new JWT({
  email: credenciais.client_email,
  key: credenciais.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const docSorteio = new GoogleSpreadsheet(SORTEIO_SHEET_ID, serviceAccountAuth);
const docControle = new GoogleSpreadsheet(CONTROLE_SHEET_ID, serviceAccountAuth);

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessageReactions
]});

const pendingRegistrations = new Map();

// --- 3. Lógica Principal do Sorteio (Refatorada) ---
async function fetchPlayerLevels(playerNames) {
  await docSorteio.loadInfo();
  const sheetPrimario = docSorteio.sheetsByTitle['Primários'];
  const sheetSecundario = docSorteio.sheetsByTitle['Secundários'];
  if (!sheetPrimario || !sheetSecundario) {
    throw new Error("Abas 'Primários' ou 'Secundários' não encontradas na planilha de Sorteio.");
  }
  const playerLevelMap = new Map();
  const playerNamesSet = new Set(playerNames.map(n => n.toLowerCase()));
  const headerRowIndex = 2; // Assume headers na linha 2
  await sheetPrimario.loadHeaderRow(headerRowIndex);
  const rowsPrimario = await sheetPrimario.getRows();
  for (const row of rowsPrimario) {
    const nome = row.get(sheetPrimario.headerValues[0])?.toLowerCase(); // Coluna A ('Nome')
    const levelStr = row.get(sheetPrimario.headerValues[3]); // Coluna D ('Level')
    if (playerNamesSet.has(nome)) {
      const nivel = parseInt(levelStr);
      if (!isNaN(nivel)) {
        if (!playerLevelMap.has(nome)) playerLevelMap.set(nome, new Set());
        playerLevelMap.get(nome).add(nivel);
      }
    }
  }
  await sheetSecundario.loadHeaderRow(headerRowIndex);
  const rowsSecundario = await sheetSecundario.getRows();
  for (const row of rowsSecundario) {
    const nome = row.get(sheetSecundario.headerValues[0])?.toLowerCase(); // Coluna A ('Nome')
    const personagem = row.get(sheetSecundario.headerValues[1]); // Coluna B ('Personagem')
    const levelStr = row.get(sheetSecundario.headerValues[3]); // Coluna D ('Level')
    if (playerNamesSet.has(nome) && personagem) {
      const nivel = parseInt(levelStr);
      if (!isNaN(nivel)) {
        if (!playerLevelMap.has(nome)) playerLevelMap.set(nome, new Set());
        playerLevelMap.get(nome).add(nivel);
      }
    }
  }
  return playerLevelMap;
}
async function executarLogicaSorteio(nomesInscritos, levelFilter = []) {
  let nomesInscritosSet = new Set(nomesInscritos.map(n => n.toLowerCase()));
  const listaCompletaJogadores = await carregarDadosPlanilha();
  const mapaJogadoresPrioridade = new Map(listaCompletaJogadores.map(j => [j.nome.toLowerCase(), j]));
  let jogadoresElegiveis = [];
  if (levelFilter.length > 0) {
    const levelFilterSet = new Set(levelFilter);
    const playerLevelMap = await fetchPlayerLevels(nomesInscritos);
    for (const nomeInscrito of nomesInscritosSet) {
      const playerLevels = playerLevelMap.get(nomeInscrito);
      if (playerLevels) {
        const hasMatch = [...playerLevels].some(level => levelFilterSet.has(level));
        if (hasMatch && mapaJogadoresPrioridade.has(nomeInscrito)) {
          jogadoresElegiveis.push(mapaJogadoresPrioridade.get(nomeInscrito));
        }
      }
    }
  } else {
    for (const nomeInscrito of nomesInscritosSet) {
      if (mapaJogadoresPrioridade.has(nomeInscrito)) {
        jogadoresElegiveis.push(mapaJogadoresPrioridade.get(nomeInscrito));
      }
    }
  }
  if (jogadoresElegiveis.length === 0) {
    if (levelFilter.length > 0) {
      throw new Error('Nenhum dos jogadores inscritos possui personagens nos níveis solicitados OU não foram encontrados nas abas Primário/Secundário.');
    } else {
      throw new Error('Nenhum dos jogadores inscritos foi encontrado na planilha de prioridade. Verifique os nomes.');
    }
  }
  const listaOrdenada = ordenarPorPrioridade(jogadoresElegiveis);
  const listaSorteada = realizarSorteio(listaOrdenada);
  let inscritosFormatado = `\`\`\`${nomesInscritos.join(' ')}\`\`\``;
  if (nomesInscritos.length === 0) inscritosFormatado = "Nenhum";
  let filtroFormatado = levelFilter.length > 0 ? `**Filtro de Nível:** ${levelFilter.join(', ')}\n\n` : '';
  let resposta = `**Inscritos para este sorteio:**\n${inscritosFormatado}\n${filtroFormatado}🎉 **Resultado Final do Sorteio** 🎉\n\n`;
  let mencoes = '';
  listaSorteada.forEach((jogador, index) => {
    resposta += `${index + 1}. **${jogador.nome}** (Critério: ${jogador.prioridade.descricao})\n`;
    mencoes += `@${jogador.nome}\n`;
  });
  return { resposta, mencoes };
}
async function carregarDadosPlanilha() {
  await docSorteio.loadInfo();
  const sheet = docSorteio.sheetsByTitle['Mesas Jogadas (Total)'];
  if (!sheet) {
    throw new Error("Aba 'Mesas Jogadas (Total)' não foi encontrada!");
  }
  await sheet.loadCells();

  const dataInicioPlanilha = new Date(Date.UTC(2025, 8, 1));
  const hoje = new Date();
  const hojeUTC = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
  const diaDaSemana = hojeUTC.getUTCDay();
  const diasParaSubtrair = (diaDaSemana === 0) ? 6 : diaDaSemana - 1;
  const ultimaSegunda = new Date(hojeUTC);
  ultimaSegunda.setUTCDate(hojeUTC.getUTCDate() - diasParaSubtrair);
  const diffTime = ultimaSegunda.getTime() - dataInicioPlanilha.getTime();
  const semanasPassadas = Math.floor(diffTime / (1000 * 60 * 60 * 24 * 7));
  const indiceAtual = 1 + semanasPassadas;

  const maxColumnIndex = sheet.columnCount - 1;
  const indiceAtualReal = Math.min(indiceAtual, maxColumnIndex);
  if (indiceAtual > maxColumnIndex) {
      console.warn(`[AVISO] Índice da coluna atual (${indiceAtual}) parece estar fora dos limites da planilha 'Mesas Jogadas (Total)'. Usando a última coluna existente (${maxColumnIndex}) para leitura.`);
  }

  let colunaAtualLetra = 'A';
  if (indiceAtualReal >= 0) {
      colunaAtualLetra = sheet.getCell(0, indiceAtualReal).a1Address.replace(/[0-9]/g, '');
  }

  const jogadores = [];
  for (let i = 1; i < sheet.rowCount; i++) {
    const nomeCell = sheet.getCell(i, 0);
    const nome = nomeCell.value;
    if (!nome || String(nome).toLowerCase() === 'nome' || String(nome).toLowerCase() === 'média') continue;
    let indiceUltimoJogo = -1;
    const limiteLeitura = indiceAtualReal;
    for (let j = 1; j <= limiteLeitura; j++) {
      const cellValue = sheet.getCell(i, j)?.value;
      if (parseInt(cellValue) > 0) {
        indiceUltimoJogo = j;
      }
    }
    let semanasSemJogar = 1000;
    if (indiceUltimoJogo !== -1) {
      semanasSemJogar = indiceAtualReal - indiceUltimoJogo;
    }
    jogadores.push({
      nome: String(nome),
      jogosEstaSemana: parseInt(sheet.getCell(i, indiceAtualReal)?.value) || 0,
      semanasSemJogar: semanasSemJogar
    });
  }
  return jogadores;
}
function calcularPrioridade(jogador) {
    if (jogador.semanasSemJogar >= 1000) return { score: 1, descricao: 'Nunca jogou' };
    if (jogador.semanasSemJogar >= 2) return { score: 2, descricao: `Está há ${jogador.semanasSemJogar} semanas sem jogar` };
    if (jogador.jogosEstaSemana === 0) return { score: 5, descricao: 'Não jogou esta semana' };
    return { score: 6 + jogador.jogosEstaSemana, descricao: `Jogou ${jogador.jogosEstaSemana} vez(es) esta semana` };
}
function ordenarPorPrioridade(jogadores) {
    return jogadores.map(j => ({ ...j, prioridade: calcularPrioridade(j) }))
                    .sort((a, b) => {
                        if (a.prioridade.score === b.prioridade.score) return a.nome.localeCompare(b.nome);
                        return a.prioridade.score - b.prioridade.score;
                    });
}
function realizarSorteio(jogadoresOrdenados) {
    const resultadoFinal = []; const grupos = {};
    jogadoresOrdenados.forEach(jogador => {
        const score = jogador.prioridade.score;
        if (!grupos[score]) grupos[score] = [];
        grupos[score].push(jogador);
    });
    Object.keys(grupos).sort((a,b) => a - b).forEach(score => {
        const grupo = grupos[score];
        for (let i = grupo.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [grupo[i], grupo[j]] = [grupo[j], grupo[i]];
        }
        resultadoFinal.push(...grupo);
    });
    return resultadoFinal;
}

// --- 4. Registro dos Comandos do Discord ---
const comandos = [
  new SlashCommandBuilder()
    .setName('sortear')
    .setDescription('Realiza o sorteio de vagas do RPG.')
    .addStringOption(option =>
      option.setName('inscritos')
        .setDescription('A lista de jogadores inscritos (separados por espaço ou linha).')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
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
    // ===============================================
    // NOVA OPÇÃO ADICIONADA
    // ===============================================
    .addBooleanOption(option => 
      option.setName('mencionar_jogadores')
        .setDescription('Mencionar o cargo @Jogadores (True) ou jogadores por nível (False)? (Padrão: False)')
        .setRequired(false)
    ),
  new SlashCommandBuilder() // Comando adicionado de volta
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
    )
];
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

async function lookupUsernames(inputs) {
    if (!inputs || inputs.length === 0) return [];
    await docSorteio.loadInfo();
    const sheetPlayerId = docSorteio.sheetsByTitle['Player ID'];
    if (!sheetPlayerId) {
        console.warn("[AVISO] Aba 'Player ID' não encontrada. Retornando inputs originais.");
        return inputs.map(item => item.trim());
    }
    await sheetPlayerId.loadHeaderRow();
    await sheetPlayerId.loadCells('A:B');
    const rows = await sheetPlayerId.getRows();
    const idToTagMap = new Map();
    rows.forEach(row => {
        const id = row.get('ID');
        const tag = row.get('Tag');
        if (id && tag) {
            idToTagMap.set(String(id).trim(), String(tag).trim());
        }
    });
    const resolvedNames = [];
    const mentionRegex = /^<@!?(\d+)>$/;
    for (const item of inputs) {
        const match = item.match(mentionRegex);
        if (match) {
            const userId = match[1];
            const foundTag = idToTagMap.get(userId);
            if (foundTag) {
                resolvedNames.push(foundTag);
            } else {
                console.warn(`[AVISO] lookupUsernames: ID ${userId} (de ${item}) não encontrado na aba 'Player ID'. Pulando este jogador.`);
            }
        } else {
            resolvedNames.push(item.trim());
        }
    }
    return resolvedNames;
}

// ===============================================
// NOVA FUNÇÃO: lookupIds
// ===============================================
/**
 * Converte tags/usernames para Discord IDs usando a aba "Player ID".
 * @param {string[]} tags - Array de tags/usernames.
 * @returns {Promise<string[]>} - Array de Discord User IDs encontrados.
 */
async function lookupIds(tags) {
    if (!tags || tags.length === 0) return [];
    // console.log("[DEBUG] lookupIds: Tags recebidas:", tags);
    await docSorteio.loadInfo(); // Garante que foi carregado
    const sheetPlayerId = docSorteio.sheetsByTitle['Player ID'];
    if (!sheetPlayerId) {
        console.warn("[AVISO] Aba 'Player ID' não encontrada para buscar IDs. Retornando vazio.");
        return [];
    }
    await sheetPlayerId.loadHeaderRow(); // Linha 1
    await sheetPlayerId.loadCells('A:B'); // Garante que colunas A e B estão carregadas
    const rows = await sheetPlayerId.getRows();

    const tagToIdMap = new Map();
    rows.forEach(row => {
        const id = row.get('ID');
        const tag = row.get('Tag');
        if (id && tag) {
            tagToIdMap.set(String(tag).trim().toLowerCase(), String(id).trim()); // Chave é tag minúscula
        }
    });
    // console.log("[DEBUG] lookupIds: Mapa Tag->ID criado:", tagToIdMap);

    const resolvedIds = [];
    const tagsLower = tags.map(t => t.toLowerCase());

    for (const tagLower of tagsLower) {
        const foundId = tagToIdMap.get(tagLower);
        if (foundId) {
            // console.log(`[DEBUG] lookupIds: Tag ${tagLower} resolvida para ID ${foundId}`);
            resolvedIds.push(foundId);
        } else {
            console.warn(`[AVISO] lookupIds: Tag ${tagLower} não encontrada na aba 'Player ID'.`);
        }
    }
    // console.log("[DEBUG] lookupIds: IDs resolvidos:", resolvedIds);
    return resolvedIds;
}
// ===============================================


// --- 5. O Bot Fica Online e Ouve os Comandos ---
// ===============================================
// parsearAnuncioMesa ATUALIZADA
// ===============================================
async function parsearAnuncioMesa(guild, niveisString, dataHoraString, duracao) {
  // 1. Carregar Mapa de Cargos
  await docSorteio.loadInfo();
  const sheetPlayerId = docSorteio.sheetsByTitle['Player ID'];
  const roleNameToIdMap = new Map();
  if (sheetPlayerId) {
      try {
        await sheetPlayerId.loadHeaderRow(); // Linha 1
        await sheetPlayerId.loadCells('C:D');
        const rows = await sheetPlayerId.getRows();
        rows.forEach(row => {
            const roleId = row.get('ID_Cargos');
            const roleName = row.get('Cargos');
            if (roleId && roleName) {
                roleNameToIdMap.set(String(roleName).trim().toLowerCase(), String(roleId).trim());
            }
        });
      } catch (e) {
         console.error("[ERRO] Falha ao carregar IDs de cargos:", e.message);
      }
  } else {
      console.warn("[AVISO] Aba 'Player ID' não encontrada para buscar IDs de cargos.");
  }

  // 2. Buscar Menção "Jogadores"
  const jogadoresRoleNameLower = 'jogadores';
  const jogadoresRoleId = roleNameToIdMap.get(jogadoresRoleNameLower);
  // console.log(`[DEBUG BUSCA CARGO] Buscando por '${jogadoresRoleNameLower}'. ID encontrado no mapa: ${jogadoresRoleId}`);
  const mencaoJogadores = jogadoresRoleId ? roleMention(jogadoresRoleId) : `(Cargo @${jogadoresRoleNameLower} não encontrado)`;

  // 3. Processar Níveis
  const mencoesNiveis = niveisString.split(',')
    .map(n => n.trim())
    .map(num => {
        const roleName = `Nível ${num.padStart(2, '0')}`;
        const roleId = roleNameToIdMap.get(roleName.toLowerCase());
        return roleId ? roleMention(roleId) : null;
    })
    .filter(Boolean).join(', ');

  // 4. Processar Data/Hora
  const [dataPart, horaPart] = dataHoraString.split(' ');
  const [dia, mes, ano] = dataPart.split('/');
  const [hora, min] = horaPart.split(':');
  let timestamp = null;
  if (dia && mes && ano && hora && min) {
      try {
          const dataMesa = new Date(`20${ano}`, mes - 1, dia, hora, min);
          if (!isNaN(dataMesa)) {
             timestamp = Math.floor(dataMesa.getTime() / 1000);
          }
      } catch (dateError) {
          console.error("Erro ao processar data/hora:", dateError);
      }
  }
  const timestampString = timestamp ? `<t:${timestamp}:F> (<t:${timestamp}:R>)` : '(Data/Hora inválida)';

  // 5. Montar o Anúncio COMPLETO
  const anuncio = [
    `**Data:** ${timestampString}`,
    `**Tier:** ${mencaoJogadores} (${mencoesNiveis || 'Nenhum nível correspondente encontrado'})`,
    `**Previsão de duração:** ${duracao}`
  ].join('\n');

  // Retorna o texto BASE (sem tier) e o texto FINAL (com tier)
  const anuncioBase = [
    `**Data:** ${timestampString}`,
    `**Previsão de duração:** ${duracao}`
  ].join('\n');
  
  const finalTierString = `**Tier:** ${mencaoJogadores} (${mencoesNiveis || 'Nenhum nível correspondente'})`;

  return { anuncioBase, finalTierString, mencaoJogadoresCargo: mencaoJogadores };
}
// ===============================================

client.once(Events.ClientReady, async (bot) => {
  console.log(`Bot ${bot.user.tag} está online!`);
  try {
    console.log('Registrando comandos (/) ...');
    await rest.put(
      Routes.applicationCommands(bot.user.id),
      { body: comandos }, // Envia a lista atualizada com /registrar-mesa
    );
    console.log('Comandos registrados com sucesso!');
  } catch (error) {
    console.error("Erro ao registrar comandos:", error);
  }
});

client.on(Events.InteractionCreate, async interaction => {

  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;
    if (commandName === 'sortear') {
      try {
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
    }

    // ===============================================
    // Handler /abrir-mesa ATUALIZADO para Mention-Edit
    // ===============================================
    if (commandName === 'abrir-mesa') {
      // DEFER EFÊMERO: Responde ao comando apenas para você (privadamente)
      await interaction.deferReply({ flags: [MessageFlagsBitField.Flags.Ephemeral] });
      try {
        if (!interaction.member.roles.cache.some(role => role.name.toLowerCase() === 'narrador')) {
          // Edita a resposta efêmera com o erro
          await interaction.editReply({ content: 'Você precisa ter o cargo "Narrador" para usar este comando.'});
          return;
        }
        const emoteString = interaction.options.getString('emote');
        const niveisString = interaction.options.getString('niveis');
        const dataHoraString = interaction.options.getString('data_hora');
        const duracao = interaction.options.getString('duracao');
        const mencionarJogadores = interaction.options.getBoolean('mencionar_jogadores') ?? false;

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

        // Pega o texto base, o texto final do tier, e a menção @Jogadores
        const { anuncioBase, finalTierString, mencaoJogadoresCargo } = await parsearAnuncioMesa(interaction.guild, niveisString, dataHoraString, duracao);

        let initialContent = "";
        const mestreMention = `**Mesa mestre:** ${interaction.user}`;
        const finalContent = `${mestreMention}\n${anuncioBase}\n${finalTierString}`; // Conteúdo final

        if (mencionarJogadores) {
            // Menciona o CARGO @Jogadores inicialmente
            initialContent = `${mestreMention}\n${anuncioBase}\n${mencaoJogadoresCargo}`;
        } else {
            // Menciona JOGADORES INDIVIDUALMENTE por nível
            const todosPlayerTags = [];
            const sheetPlayerId = docSorteio.sheetsByTitle['Player ID']; // Já carregado
            if(sheetPlayerId) {
                const rows = await sheetPlayerId.getRows(); // Assume já carregado
                rows.forEach(row => { if(row.get('Tag')) todosPlayerTags.push(row.get('Tag')); });
            }
            const levelsToFilter = niveisString.split(',').map(n => parseInt(n.trim())).filter(Number.isInteger);
            const playerLevelMap = await fetchPlayerLevels(todosPlayerTags); // Busca níveis de TODOS
            const filteredPlayerTags = [];
            playerLevelMap.forEach((levels, tag) => {
                const hasMatch = [...levels].some(level => levelsToFilter.includes(level));
                if (hasMatch) {
                    filteredPlayerTags.push(tag);
                }
            });
            const filteredPlayerIds = await lookupIds(filteredPlayerTags); // Converte tags filtradas para IDs
            const playerMentions = filteredPlayerIds.map(id => userMention(id)).join(' ') || '(Nenhum jogador encontrado nos níveis especificados)';
            initialContent = `${mestreMention}\n${anuncioBase}\n${playerMentions}`;
        }

        // Cria os botões
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

        // MUDANÇA: Envia o anúncio como uma MENSAGEM NOVA (channel.send)
        const mensagemAnuncio = await interaction.channel.send({
            content: initialContent,
            components: [row]
            // allowedMentions: { parse: ['users', 'roles'] } // Habilita pings
        });

        // Pausa RÁPIDA antes de editar
        await new Promise(resolve => setTimeout(resolve, 500)); // 0.5 segundo

        // EDITA a mensagem para o conteúdo FINAL
        await mensagemAnuncio.edit({
             content: finalContent,
             components: [row]
             // allowedMentions: { parse: [] } // Desabilita pings na edição
        });

        // Reage à mensagem final editada
        await mensagemAnuncio.react(emoteString).catch(reactError => {
          console.error("Falha ao reagir:", reactError);
          interaction.followUp({ content: 'Aviso: Não consegui usar esse emote para reagir.', flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
        });

        // Atualiza a planilha de Controle (como antes)
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
          'Registrar Mesa': 'Não',
          'Mesa Finalizada': 'Não'
        };
        await sheetHistorico.addRow(dadosParaAdicionar);

        // MUDANÇA: Confirma o comando efêmero
        await interaction.editReply({ content: 'Anúncio de mesa criado com sucesso!', components: [] });
        
      } catch (error) {
        console.error("Erro no comando /abrir-mesa:", error);
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: `Ocorreu um erro ao abrir a mesa: ${error.message}`, components: [] }).catch(console.error);
        }
        // O 'else' não é mais necessário, pois o 'deferReply' garante 'deferred'
      }
    }

    if (commandName === 'registrar-mesa') {
      try {
        await interaction.deferReply({ flags: [MessageFlagsBitField.Flags.Ephemeral] }); // Defer Ephemeral

        const isNarrador = interaction.member.roles.cache.some(role => role.name.toLowerCase() === 'narrador');
        const isStaff = interaction.member.roles.cache.some(role => role.name.toLowerCase() === 'staff');
        if (!isNarrador && !isStaff) {
            await interaction.editReply('Você precisa ser Narrador ou Staff para usar este comando.');
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
        await docControle.loadInfo();
        const sheetHistorico = docControle.sheetsByTitle['Historico'];
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
        pendingRegistrations.set(interaction.id, { primarios, secundarios });
        const rowComponent = new ActionRowBuilder().addComponents(selectMenu);
        await interaction.editReply({
            content: 'Selecione abaixo qual das suas mesas você deseja registrar:',
            components: [rowComponent],
            flags: [] // Remove o ephemeral
        });
      } catch (error) {
        console.error("Erro no comando /registrar-mesa:", error);
         if (interaction.deferred || interaction.replied) {
             await interaction.editReply({ content: `Ocorreu um erro: ${error.message}`, components: [] }).catch(console.error);
         } else {
             await interaction.reply({ content: `Ocorreu um erro: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
         }
      }
    }
  }

  // --- Manipulador de Botões ---
  if (interaction.isButton()) {
    try {

      const [action, mestreIdOrMessageId, emoteId] = interaction.customId.split('|');

      if (action !== 'show_sort_modal') {
        // A verificação de permissão agora usa o mestreId que passamos
        const mestreId = mestreIdOrMessageId;
        const isMestre = (interaction.user.id === mestreId);
        const isStaff = interaction.member.roles.cache.some(role => role.name.toLowerCase() === 'staff');

        if (!isMestre && !isStaff) {
          // Como não demos defer, temos que usar .reply() aqui
          await interaction.reply({ content: 'Você não tem permissão para usar este botão.', flags: [MessageFlagsBitField.Flags.Ephemeral] });
          return;
        }
      }

      if (action === 'fechar_inscricao') {
        // ADICIONADO: Defer específico para esta ação
        await interaction.deferUpdate();

        const disabledRow = ActionRowBuilder.from(interaction.message.components[0]);
        disabledRow.components.forEach(comp => comp.setDisabled(true));
        await interaction.message.edit({ components: [disabledRow] });
        const message = await interaction.message.fetch();
        const reacao = message.reactions.cache.get(emoteId);
        if (!reacao) {
          await interaction.followUp({ content: 'Erro: Não encontrei a reação do anúncio. Ninguém se inscreveu?', flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
          return;
        }
        const usuarios = await reacao.users.fetch();
        const inscritos = usuarios.filter(user => !user.bot).map(user => user.username);
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
        // Usa followUp PÚBLICO
        await interaction.followUp({
          content: `Inscrições fechadas!\n\n**Inscritos:**\n${inscritosFormatado}\n\nClique abaixo para definir os níveis e efetuar o sorteio.`,
          components: [row]
        });
      }
      else if (action === 'cancelar_mesa') {
        // ADICIONADO: Defer específico para esta ação
        await interaction.deferUpdate();

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
      }
      else if (action === 'editar_mesa') {
        // REMOVIDO o deferUpdate()
        const modal = new ModalBuilder()
          .setCustomId(`modal_editar|${interaction.message.id}`)
          .setTitle('Editar Anúncio da Mesa');
        const niveisInput = new TextInputBuilder()
          .setCustomId('niveis_input')
          .setLabel("Novos Níveis (Ex: 1,2,3)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const dataHoraInput = new TextInputBuilder()
          .setCustomId('data_hora_input')
          .setLabel("Nova Data e Hora (DD/MM/AA HH:MM)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const duracaoInput = new TextInputBuilder()
          .setCustomId('duracao_input')
          .setLabel("Nova Duração (Ex: 3h a 4h)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true);
        const firstRow = new ActionRowBuilder().addComponents(niveisInput);
        const secondRow = new ActionRowBuilder().addComponents(dataHoraInput);
        const thirdRow = new ActionRowBuilder().addComponents(duracaoInput);
        modal.addComponents(firstRow, secondRow, thirdRow);
        await interaction.showModal(modal); // showModal AGORA funciona pois é a primeira resposta
      }
      else if (action === 'show_sort_modal') {
        // REMOVIDO o deferUpdate()
        // O ID aqui é o interaction.message.id, não o mestreId.
        // O nome 'mestreIdOrMessageId' cobre os dois casos.

        const idDaMensagemDoBotao = interaction.message.id;

        const modal = new ModalBuilder()
          .setCustomId(`level_sort_modal|${idDaMensagemDoBotao}`) // Usando o ID da mensagem
          .setTitle('Filtrar Sorteio por Nível');
        const niveisInput = new TextInputBuilder()
          .setCustomId('niveis_input')
          .setLabel("Níveis (Ex: 2,3,4)")
          .setPlaceholder("Deixe em branco para sortear todos os inscritos")
          .setStyle(TextInputStyle.Short)
          .setRequired(false);
        const row = new ActionRowBuilder().addComponents(niveisInput);
        modal.addComponents(row);
        await interaction.showModal(modal); // showModal AGORA funciona pois é a primeira resposta
      }
    } catch (error) {
      console.error("Erro no manipulador de botões:", error);
      // Bloco CATCH mais seguro, que verifica se já respondemos
      if (interaction.replied || interaction.deferred) {
          await interaction.followUp({ content: `Ocorreu um erro no botão: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      } else {
          await interaction.reply({ content: `Ocorreu um erro no botão: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      }
    }
  }

  // --- Manipulador de Submissão de Modal ---
  if (interaction.isModalSubmit()) {
    try {
      const [action, originalMessageId] = interaction.customId.split('|');
      if (action === 'modal_editar') {
        await interaction.deferReply({ flags: [MessageFlagsBitField.Flags.Ephemeral] }); // Defer ephemeral para confirmação
        const niveisString = interaction.fields.getTextInputValue('niveis_input');
        const dataHoraString = interaction.fields.getTextInputValue('data_hora_input');
        const duracao = interaction.fields.getTextInputValue('duracao_input');
        const [dataPart, horaPart] = dataHoraString.split(' ');
        await docControle.loadInfo();
        const sheetHistorico = docControle.sheetsByTitle['Historico'];
        await sheetHistorico.loadHeaderRow();
        const rows = await sheetHistorico.getRows();
        const row = rows.find(r => r.get('ID da Mensagem') === originalMessageId);
        if (row) {
          row.set('Data', dataPart);
          row.set('Horário', horaPart);
          row.set('Tier', "'" + niveisString);
          await row.save();
        }
        const message = await interaction.channel.messages.fetch(originalMessageId);
        const mestreUser = message.interaction ? message.interaction.user : interaction.user;
        
        // Chama a função que AGORA inclui o Tier
        const { anuncioBase, finalTierString } = await parsearAnuncioMesa(interaction.guild, niveisString, dataHoraString, duracao);
        const anuncioCompleto = `**Mesa mestre:** ${mestreUser}\n${anuncioBase}\n${finalTierString}`; // Monta com o Tier atualizado

        await message.edit({ content: anuncioCompleto });
        await interaction.editReply({ content: 'Mesa atualizada no Discord e na planilha!'}); // Edita a resposta ephemeral
      }
      if (action === 'level_sort_modal') {
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
        const { resposta, mencoes } = await executarLogicaSorteio(nomesInscritos, levelFilter);
        await interaction.editReply(resposta); // Edita a resposta pública
        await interaction.followUp({ content: mencoes, allowedMentions: { users: [] } }); // Envia menções
        if (originalMessage.components.length > 0 && originalMessage.components[0].components.length > 0) {
            const buttonToDisable = originalMessage.components[0].components.find(c => c.customId === 'show_sort_modal');
            if (buttonToDisable) {
                const disabledButton = ButtonBuilder.from(buttonToDisable).setDisabled(true);
                 const updatedComponents = originalMessage.components[0].components.map(c => c.customId === 'show_sort_modal' ? disabledButton : c);
                 const updatedRow = new ActionRowBuilder().addComponents(updatedComponents);
                 await originalMessage.edit({ components: [updatedRow] });
            } else {
                 console.warn(`[AVISO] Botão 'show_sort_modal' não encontrado na mensagem ${originalMessageId} para desabilitar.`);
            }
        } else {
            console.warn(`[AVISO] Não foi possível desabilitar o botão na mensagem ${originalMessageId}. Componentes não encontrados.`);
        }
      }
    } catch (error) {
      console.error("Erro no manipulador de modal:", error);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: `Ocorreu um erro ao processar o formulário: ${error.message}`, components: [] }).catch(console.error);
      } else {
        await interaction.reply({ content: `Ocorreu um erro ao processar o formulário: ${error.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
      }
    }
  }

  // --- Manipulador de Select Menu ---
  if (interaction.isStringSelectMenu()) {
    try {
      const [action, originalInteractionId] = interaction.customId.split('|');
      if (action === 'registrar_mesa_select') {
        await interaction.deferUpdate(); // Atualiza a mensagem original (pública)

        const playersData = pendingRegistrations.get(originalInteractionId);
        if (!playersData) {
          await interaction.editReply({ content: 'Não foi possível encontrar os dados dos jogadores. Tente usar o comando novamente.', components: []});
          return;
        }
        pendingRegistrations.delete(originalInteractionId);
        const { primarios, secundarios } = playersData;
        const todosJogadores = [...primarios, ...secundarios];
        const selectedMessageId = interaction.values[0];

        await docSorteio.loadInfo();
        const sheetPrimarioChars = docSorteio.sheetsByTitle['Primários'];
        const sheetSecundarioChars = docSorteio.sheetsByTitle['Secundários'];
        const sheetPrimariosJogos = docSorteio.sheetsByTitle['Primários'];
        const sheetSecundariosJogos = docSorteio.sheetsByTitle['Secundários'];
        if (!sheetPrimarioChars || !sheetSecundarioChars || !sheetPrimariosJogos || !sheetSecundariosJogos) {
            throw new Error("Não foi possível encontrar as abas 'Primários' ou 'Secundários' na planilha de Sorteio.");
        }

        // --- Atualização do Histórico (Busca Chars) ---
        await sheetPrimarioChars.loadHeaderRow(2);
        await sheetSecundarioChars.loadHeaderRow(2);
        const primarioRows = await sheetPrimarioChars.getRows();
        const secundarioRows = await sheetSecundarioChars.getRows();
        const charNameMap = new Map();
        primarioRows.forEach(row => {
          const nome = row.get('Nome')?.toLowerCase();
          const char = row.get('Personagem');
          if (nome && char) charNameMap.set(nome, char);
        });
        secundarioRows.forEach(row => {
          const nome = row.get('Nome')?.toLowerCase();
          const char = row.get('Personagem');
          if (nome && char && secundarios.map(s=>s.toLowerCase()).includes(nome)) {
               charNameMap.set(nome, char);
          }
        });
         primarioRows.forEach(row => {
             const nome = row.get('Nome')?.toLowerCase();
             const char = row.get('Personagem');
             // Atualiza apenas se não foi definido pelo secundário
             if (nome && char && primarios.map(p=>p.toLowerCase()).includes(nome) && !charNameMap.has(nome)) {
                 charNameMap.set(nome, char);
             }
        });

        await docControle.loadInfo();
        const sheetHistorico = docControle.sheetsByTitle['Historico'];
        await sheetHistorico.loadHeaderRow();
        const rowsHistorico = await sheetHistorico.getRows();
        const rowToUpdate = rowsHistorico.find(r => r.get('ID da Mensagem') === selectedMessageId);
        if (!rowToUpdate) {
            await interaction.editReply({ content: 'Erro: Não encontrei a linha correspondente a esta mesa no histórico.', components: []});
            return;
        }
        let playerIndex = 0;
        todosJogadores.forEach(playerName => {
          if (playerIndex < 6) {
            const charName = charNameMap.get(playerName.toLowerCase()) || 'Personagem não encontrado';
            const headerName = sheetHistorico.headerValues[5 + playerIndex]; // Colunas F-K
            rowToUpdate.set(headerName, `${playerName} - ${charName}`);
            playerIndex++;
          }
        });
        for (let i = playerIndex; i < 6; i++) {
            const headerName = sheetHistorico.headerValues[5 + i];
            rowToUpdate.set(headerName, '');
        }
        rowToUpdate.set('Registrar Mesa', 'Sim'); // Coluna L
        await rowToUpdate.save();

        // --- Atualização Mesas Jogadas ---
        await sheetHistorico.loadCells('W1');
        const cellW1 = sheetHistorico.getCellByA1('W1');
        const weekOffset = parseInt(cellW1.value);
        if (isNaN(weekOffset)) {
            throw new Error("Valor na célula W1 da aba 'Historico' não é um número válido.");
        }
        // ===============================================
        // CORREÇÃO: Índice da coluna alvo é 3 + offset
        // ===============================================
        const targetColIndex = 3 + weekOffset; // Col D (idx 3) + offset W1
        console.log(`[DEBUG] Select Menu: Offset W1=${weekOffset}, Índice da coluna alvo=${targetColIndex}`);

        // ==================================================================
        // Função incrementarContagem
        // ==================================================================
        async function incrementarContagem(sheet, playerNames, targetColumnIndex) {
            console.log(`[DEBUG] Iniciando incrementarContagem para ${sheet?.title} com ${playerNames.length} jogadores na coluna ${targetColumnIndex}.`);
            await docSorteio.loadInfo();
            const currentSheet = docSorteio.sheetsByTitle[sheet.title];
            if (!currentSheet || playerNames.length === 0) {
                console.warn(`[AVISO] Aba ${sheet?.title} inválida ou lista de jogadores vazia. Pulando incremento.`);
                return;
            }

            try {
                 if (targetColumnIndex < 0 || targetColumnIndex >= currentSheet.columnCount) {
                     console.warn(`[AVISO] Índice da coluna alvo (${targetColumnIndex}) fora dos limites (0-${currentSheet.columnCount - 1}) da aba ${currentSheet.title}. Pulando incremento.`);
                     return;
                 }
                console.log(`[DEBUG] Carregando Linhas 1 e 2 (até ZZ) para ${currentSheet.title}`);
                await currentSheet.loadCells('A1:ZZ2');
                console.log(`[DEBUG] Linhas 1 e 2 carregadas para ${currentSheet.title}.`);

                let colunaAlvoLetra;
                try {
                     colunaAlvoLetra = currentSheet.getCell(0, targetColumnIndex).a1Address.replace(/[0-9]/g, '');
                     console.log(`[DEBUG] Letra da coluna alvo: ${colunaAlvoLetra}`);
                } catch(e) {
                     console.error(`[ERRO] Falha ao obter letra da coluna ${targetColumnIndex} em ${currentSheet.title}`, e);
                     throw new Error(`Falha ao obter letra da coluna ${targetColumnIndex} em ${currentSheet.title}.`);
                }
                 await currentSheet.loadHeaderRow(2);
                 console.log(`[DEBUG] Cabeçalhos lidos para ${currentSheet.title}:`, currentSheet.headerValues);
                const maxRow = Math.max(3, currentSheet.rowCount);
                const rangeToLoad = `A3:${colunaAlvoLetra}${maxRow}`;
                console.log(`[DEBUG] Carregando range de dados ${rangeToLoad} para ${currentSheet.title}`);
                await currentSheet.loadCells(rangeToLoad);
                console.log(`[DEBUG] Células de dados carregadas para ${currentSheet.title}.`);
                const playerSet = new Set(playerNames.map(p => p.toLowerCase()));
                const cellsToUpdate = [];
                for (let rowIndex = 2; rowIndex < maxRow; rowIndex++) {
                     const nomeCell = currentSheet.getCell(rowIndex, 0);
                     const nomePlanilha = nomeCell.value?.toLowerCase();
                     if (nomePlanilha && playerSet.has(nomePlanilha)) {
                        console.log(`[DEBUG] Encontrado jogador ${nomePlanilha} na linha ${rowIndex + 1}.`);
                        const cellContagem = currentSheet.getCell(rowIndex, targetColumnIndex);
                        console.log(`[DEBUG] Célula ${cellContagem.a1Address}, Valor atual: ${cellContagem.value}`);
                        // CORREÇÃO: Atribuição explícita
                        const currentValue = parseInt(cellContagem.value) || 0;
                        const newValue = currentValue + 1;
                        cellContagem.value = newValue; // Atribui o novo valor ao objeto cell
                        console.log(`[DEBUG] Célula ${cellContagem.a1Address}, Novo valor: ${newValue}`);
                        cellsToUpdate.push(cellContagem); // Adiciona o objeto cell modificado
                     }
                }
                if (cellsToUpdate.length > 0) {
                     console.log(`[DEBUG] Salvando ${cellsToUpdate.length} células atualizadas para ${currentSheet.title}.`);
                     await currentSheet.saveUpdatedCells(cellsToUpdate);
                     console.log(`Contagem incrementada para ${cellsToUpdate.length} jogadores na aba ${currentSheet.title}`);
                } else {
                     console.log(`Nenhum jogador encontrado ou nenhuma célula para atualizar na aba ${currentSheet.title}`);
                }
            } catch (incrementError) {
                console.error(`[ERRO] Falha crítica ao incrementar contagem na aba ${sheet?.title}:`, incrementError);
                if(interaction && (interaction.replied || interaction.deferred || interaction.isRepliable())) {
                   await interaction.followUp({ content: `Aviso: Falha CRÍTICA ao atualizar a contagem de mesas na aba ${sheet?.title}. Verifique os logs do terminal. Erro: ${incrementError.message}`, flags: [MessageFlagsBitField.Flags.Ephemeral] }).catch(console.error);
                } else {
                   console.error("Não foi possível enviar followUp de erro para o Discord (interação pode ter expirado).");
                }
                throw incrementError;
            }
        }

        // Chama a função
        await incrementarContagem(sheetPrimariosJogos, primarios, targetColIndex);
        await incrementarContagem(sheetSecundariosJogos, secundarios, targetColIndex);

        // --- Finalização ---
        let jogadoresRegistradosString = todosJogadores.map(playerName => {
            const charName = charNameMap.get(playerName.toLowerCase()) || 'Personagem não encontrado';
            return `${playerName} - ${charName}`;
        }).join('\n');
        const jogadoresRegistradosCodeBlock = `\`\`\`\n${jogadoresRegistradosString}\n\`\`\``;
        // Edita a mensagem ORIGINAL com a confirmação
        await interaction.editReply({
            content: `Mesa registrada com sucesso! Jogadores adicionados ao histórico e contagem de mesas atualizada.\n\n**Jogadores Registrados:**\n${jogadoresRegistradosCodeBlock}`,
            components: [] // Remove o select menu
        });

      }
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

}); // Fim do client.on('interactionCreate')

client.login(DISCORD_TOKEN);