// --- 1. Importação das Bibliotecas ---
require('dotenv').config();
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { roleMention, userMention } = require('discord.js'); // Para parsearAnuncioMesa

// --- 2. Configuração das Credenciais ---
// <<< Tenta carregar credenciais da Secret ou do ficheiro >>>
let credenciais;
try {
  if (process.env.GOOGLE_CREDENTIALS) {
    credenciais = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    console.log("[INFO Google] Credenciais carregadas a partir das Secrets.");
  } else {
    credenciais = require('../credentials.json');
    console.log("[INFO Google] Credenciais carregadas a partir de credentials.json.");
  }
} catch (error) {
  console.error("[ERRO Google] Falha ao carregar/parsear credenciais:", error);
  process.exit(1); // Para o bot se não conseguir carregar credenciais
}

const serviceAccountAuth = new JWT({
  email: credenciais.client_email,
  key: credenciais.private_key,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const SORTEIO_SHEET_ID = process.env.SORTEIO_SHEET_ID;
const CONTROLE_SHEET_ID = process.env.CONTROLE_SHEET_ID;
const TABELA_CRAFT_ID = process.env.TABELA_CRAFT_ID;
const INVENTARIO_SHEET_ID = process.env.INVENTARIO_SHEET_ID || '1j819p3VCgRpUz3rNX0lg24M5bS9jNKG-mXQ3usxLGfo';

const docSorteio = new GoogleSpreadsheet(SORTEIO_SHEET_ID, serviceAccountAuth);
const docControle = new GoogleSpreadsheet(CONTROLE_SHEET_ID, serviceAccountAuth);
const docCraft = new GoogleSpreadsheet(TABELA_CRAFT_ID, serviceAccountAuth);
const docInventario = new GoogleSpreadsheet(INVENTARIO_SHEET_ID, serviceAccountAuth);


// --- 3. Lógica Principal do Sorteio (Refatorada) ---
async function fetchPlayerLevels(playerNames) {
  await docSorteio.loadInfo();
  // <<< ALTERAÇÃO: Usa "Personagens" >>>
  const sheetPersonagens = docSorteio.sheetsByTitle['Personagens'];
  if (!sheetPersonagens) {
    throw new Error("Aba 'Personagens' não encontrada na planilha de Sorteio.");
  }
  const playerLevelMap = new Map();
  const playerNamesSet = new Set(playerNames.map(n => n.toLowerCase()));
  const headerRowIndex = 2; // Assume headers na linha 2
  await sheetPersonagens.loadHeaderRow(headerRowIndex);
  const rows = await sheetPersonagens.getRows();
  
  for (const row of rows) {
    const nome = row.get('Nome')?.toLowerCase(); // Coluna A ('Nome')
    const levelStr = row.get('Level'); // Coluna D ('Level')
    const tipo = row.get('Prim/Sec/Terc'); // Coluna C
    
    // Inclui apenas se o nome estiver na lista de inscritos
    if (playerNamesSet.has(nome)) {
      const nivel = parseInt(levelStr);
      if (!isNaN(nivel)) {
        if (!playerLevelMap.has(nome)) playerLevelMap.set(nome, new Set());
        // Adiciona o nível ao Set do jogador
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
      throw new Error('Nenhum dos jogadores inscritos possui personagens nos níveis solicitados OU não foram encontrados na aba Personagens.');
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
      const headerRange = `A1:${sheet.getCell(0, sheet.columnCount - 1).a1Address.replace(/[0-9]/g, '')}1`;
      await sheet.loadCells(headerRange);
      colunaAtualLetra = sheet.getCell(0, indiceAtualReal).a1Address.replace(/[0-9]/g, '');
  }

  const dataRange = `A2:${colunaAtualLetra}${sheet.rowCount}`;
  await sheet.loadCells(dataRange);

  const jogadores = [];
  for (let i = 1; i < sheet.rowCount; i++) {
    const nomeCell = sheet.getCell(i, 0); // Coluna A (Nome)
    const nome = nomeCell.value;
    if (!nome || String(nome).toLowerCase() === 'nome' || String(nome).toLowerCase() === 'média') continue;
    
    let indiceUltimoJogo = -1;
    const limiteLeitura = indiceAtualReal;
    
    for (let j = 1; j <= limiteLeitura; j++) {
      const cellValue = sheet.getCell(i, j)?.value; // Colunas B, C, D... (Semanas)
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

// --- 4. Funções de Busca (Lookups) ---
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

async function lookupIds(tags) {
    if (!tags || tags.length === 0) return [];
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
    const resolvedIds = [];
    const tagsLower = tags.map(t => t.toLowerCase());

    for (const tagLower of tagsLower) {
        const foundId = tagToIdMap.get(tagLower);
        if (foundId) {
            resolvedIds.push(foundId);
        } else {
            console.warn(`[AVISO] lookupIds: Tag ${tagLower} não encontrada na aba 'Player ID'.`);
        }
    }
    return resolvedIds;
}

// --- 5. Funções Específicas de Comandos ---
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
             // <<< CORREÇÃO: Subtrai 5 horas (em segundos) >>>
             const fiveHoursInSeconds = 5 * 60 * 60; 
             timestamp = Math.floor(dataMesa.getTime() / 1000) - fiveHoursInSeconds; 
          }
      } catch (dateError) {
          console.error("Erro ao processar data/hora:", dateError);
      }
  }
  const timestampString = timestamp ? `<t:${timestamp}:F> (<t:${timestamp}:R>)` : '(Data/Hora inválida)';

  // 5. Montar o Anúncio COMPLETO
  const anuncioBase = [
    `**Data:** ${timestampString}`,
    `**Previsão de duração:** ${duracao}`
  ].join('\n');
  
  const finalTierString = `**Tier:** ${mencaoJogadores} (${mencoesNiveis || 'Nenhum nível correspondente encontrado'})`;

  return { anuncioBase, finalTierString, mencaoJogadoresCargo: mencaoJogadores };
}

/**
 * Incrementa a contagem de mesas jogadas para uma lista de jogadores em uma coluna específica,
 * opcionalmente filtrando pelo tipo de personagem.
 * @param {import('google-spreadsheet').GoogleSpreadsheetWorksheet} sheet - A aba onde a contagem será incrementada (espera-se 'Personagens').
 * @param {string[]} playerNames - Array com as tags dos jogadores (Nome#1234).
 * @param {number} targetColumnIndex - O índice 0-based da coluna da semana a ser incrementada.
 * @param {string|null} [characterType=null] - O tipo de personagem ('1' ou '2') a incrementar. Se null, incrementa todas as linhas do jogador.
 * @returns {Promise<boolean>} - True se a operação foi bem-sucedida (ou não precisou fazer nada), False se ocorreu um erro.
 */
async function incrementarContagem(sheet, playerNames, targetColumnIndex, characterType = null) {
    console.log(`[DEBUG] Iniciando incrementarContagem para ${sheet?.title} com ${playerNames.length} jogadores na coluna ${targetColumnIndex}${characterType ? ` (Tipo: ${characterType})` : ''}.`);
    // Validação inicial
    const currentSheet = sheet; // <<< CORREÇÃO: Usa a 'sheet' passada diretamente
    if (!currentSheet || typeof currentSheet.title !== 'string') {
        console.error("[ERRO incrementarContagem] Objeto 'sheet' inválido.");
        return false;
    }
    if (playerNames.length === 0) {
        console.warn(`[AVISO incrementarContagem] Lista de jogadores vazia. Pulando incremento para ${currentSheet.title}.`);
        return true; // Nada a fazer, considera sucesso
    }

    try {
        await currentSheet.loadInfo(); // Garante que rowCount e columnCount estão carregados
        if (targetColumnIndex < 0 || targetColumnIndex >= currentSheet.columnCount) {
            console.warn(`[AVISO incrementarContagem] Índice da coluna alvo (${targetColumnIndex}) fora dos limites (0-${currentSheet.columnCount - 1}) da aba ${currentSheet.title}. Pulando incremento.`);
            return false; // <<< Retorna false se inválido
        }
        console.log(`[DEBUG incrementarContagem] Carregando Linhas 1 e 2 (até ZZ) para ${currentSheet.title}`);
        await currentSheet.loadCells('A1:ZZ2'); // Carrega uma faixa ampla para garantir leitura do header da coluna alvo
        console.log(`[DEBUG incrementarContagem] Linhas 1 e 2 carregadas para ${currentSheet.title}.`);

        let colunaAlvoLetra;
        try {
            colunaAlvoLetra = currentSheet.getCell(0, targetColumnIndex).a1Address.replace(/[0-9]/g, '');
            console.log(`[DEBUG incrementarContagem] Letra da coluna alvo: ${colunaAlvoLetra}`);
        } catch(e) {
            console.error(`[ERRO incrementarContagem] Falha ao obter letra da coluna ${targetColumnIndex} em ${currentSheet.title}`, e);
            return false; // <<< Retorna false em caso de erro
        }

        // Assume cabeçalho na linha 2 para 'Personagens'
        const headerRowIndex = (currentSheet.title === 'Personagens') ? 2 : 1; 
        await currentSheet.loadHeaderRow(headerRowIndex);
        console.log(`[DEBUG incrementarContagem] Cabeçalhos lidos (linha ${headerRowIndex}) para ${currentSheet.title}:`, currentSheet.headerValues);
        
        // <<< CORREÇÃO: Variáveis definidas ANTES de usar >>>
        const typeColHeader = 'Prim/Sec/Terc';
        const typeColIndex = currentSheet.headerValues.indexOf(typeColHeader);
        if (characterType && typeColIndex === -1) { // Só é erro se characterType foi especificado
            console.error(`[ERRO incrementarContagem] Coluna "${typeColHeader}" não encontrada na aba "${currentSheet.title}", mas characterType foi especificado.`);
            return false;
        }
        
        const startDataRowIndex = headerRowIndex; // <<< Definido AQUI (Ex: 2)
        const maxRow = Math.max(startDataRowIndex + 1, currentSheet.rowCount); // <<< Definido AQUI
        const nomeColIndex = 0; // Coluna A <<< Definido AQUI

        const colsToLoad = [nomeColIndex, targetColumnIndex]; // <<< Agora funciona
        if (characterType && typeColIndex !== -1) {
            colsToLoad.push(typeColIndex); // Adiciona a coluna de tipo se for filtrar
        }
        
        const minLoadCol = Math.min(...colsToLoad);
        const maxLoadCol = Math.max(...colsToLoad);
        const minLoadColLetter = getColLetter(minLoadCol); // Requer a função getColLetter
        const maxLoadColLetter = getColLetter(maxLoadCol);

        const rangeToLoad = `${minLoadColLetter}${startDataRowIndex + 1}:${maxLoadColLetter}${maxRow}`; // <<< Agora funciona (Ex: A3:N1000)
        console.log(`[DEBUG incrementarContagem] Carregando range de dados ${rangeToLoad} para ${currentSheet.title}`);
        await currentSheet.loadCells(rangeToLoad);
        console.log(`[DEBUG incrementarContagem] Células de dados carregadas para ${currentSheet.title}.`);
        
        const playerSet = new Set(playerNames.map(p => String(p).toLowerCase())); // Garante que são strings
        const cellsToUpdate = [];
        
        // Itera pelas linhas de DADOS (a partir de startDataRowIndex)
        for (let rowIndex = startDataRowIndex; rowIndex < maxRow; rowIndex++) { // <<< Agora funciona
            const nomeCell = currentSheet.getCell(rowIndex, nomeColIndex); // <<< Agora funciona
            const nomePlanilha = nomeCell.value ? String(nomeCell.value).trim().toLowerCase() : null; // Converte para string antes de trim/toLowerCase

            if (nomePlanilha && playerSet.has(nomePlanilha)) {
                // <<< ADICIONADO: Verifica o tipo do personagem >>>
                let typeMatch = true; // Assume que corresponde por padrão (se characterType for null)
                if (characterType && typeColIndex !== -1) {
                     const typeCell = currentSheet.getCell(rowIndex, typeColIndex);
                     const typeValue = typeCell.value ? String(typeCell.value).trim() : '';
                     typeMatch = (typeValue === characterType); // Verifica se o tipo na planilha é o requisitado
                }
                // <<< FIM ADIÇÃO >>>
                
                // Só incrementa se o nome E o tipo corresponderem (ou se tipo não for especificado)
                if (typeMatch) {
                    console.log(`[DEBUG incrementarContagem] Encontrado jogador ${nomePlanilha} na linha ${rowIndex + 1}${characterType ? ` com tipo ${characterType}` : ''}.`);
                    const cellContagem = currentSheet.getCell(rowIndex, targetColumnIndex);
                    console.log(`[DEBUG incrementarContagem] Célula ${cellContagem.a1Address}, Valor atual: ${cellContagem.value}`);
                    
                    const currentValue = parseInt(cellContagem.value) || 0; // Lê o valor
                    const newValue = currentValue + 1;
                    cellContagem.value = newValue; // Atribui o novo valor ao objeto cell
                    console.log(`[DEBUG incrementarContagem] Célula ${cellContagem.a1Address}, Novo valor: ${newValue}`);
                    cellsToUpdate.push(cellContagem); // Adiciona o objeto cell modificado
                }
            }
        }
        
        if (cellsToUpdate.length > 0) {
            console.log(`[DEBUG incrementarContagem] Salvando ${cellsToUpdate.length} células atualizadas para ${currentSheet.title}.`);
            await currentSheet.saveUpdatedCells(cellsToUpdate);
            console.log(`Contagem incrementada para ${cellsToUpdate.length} jogadores na aba ${currentSheet.title}`);
             return true; // <<< ADICIONA RETORNO TRUE APÓS SALVAR
        } else {
            console.log(`Nenhum jogador encontrado ou nenhuma célula para atualizar na aba ${currentSheet.title}`);
             return true; // <<< ADICIONA RETORNO TRUE SE NADA PRECISOU SER FEITO
        }
    } catch (incrementError) {
        console.error(`[ERRO incrementarContagem] Falha crítica ao incrementar contagem na aba ${sheet?.title}:`, incrementError);
        return false; // <<< RETORNA FALSE EM CASO DE ERRO
    }
}


// ===============================================
// NOVAS FUNÇÕES: Gerenciamento de Tokens
// ===============================================
/**
 * Busca a contagem atual de tokens de um jogador.
 * ATUALIZADO: Busca a linha primeiro em "Personagens" para resolver a tag, depois busca em "Tokens".
 * @param {string} playerTag - A tag Discord do jogador (Nome#1234).
 * @returns {Promise<number>} - A quantidade de tokens (Coluna K). Retorna 0 se não encontrado ou erro.
 */
async function getPlayerTokenCount(playerTag) {
    if (!playerTag) return 0;
    try {
        await docSorteio.loadInfo(); // Garante que a planilha SORTEIO_SHEET_ID está carregada
        const sheetTokens = docSorteio.sheetsByTitle['Tokens'];
        // <<< ALTERAÇÃO: Usa "Personagens" >>>
        const sheetPersonagens = docSorteio.sheetsByTitle['Personagens'];
        if (!sheetTokens || !sheetPersonagens) {
            console.error("[ERRO getPlayerTokenCount] Aba 'Tokens' ou 'Personagens' não encontrada na planilha de Sorteio.");
            return 0;
        }
        
        await sheetTokens.loadHeaderRow(1); // Assume header na linha 1
        await sheetPersonagens.loadHeaderRow(2); // Assume header na linha 2 para Personagens
        // getRows() busca os valores formatados (resultados das fórmulas)
        const rowsTokens = await sheetTokens.getRows();
        const rowsPersonagens = await sheetPersonagens.getRows();

        // 1. Encontra a linha correspondente na aba "Personagens"
        // Compara ignorando maiúsculas/minúsculas e espaços
        const playerRowPersonagens = rowsPersonagens.find(row => {
            const tagValue = row.get('Nome'); // 'Nome' é o header da Coluna A
            return tagValue && String(tagValue).trim().toLowerCase() === playerTag.trim().toLowerCase();
        });

        // Se não encontrar o jogador em Personagens, não tem como buscar em Tokens pela tag resolvida
        if (!playerRowPersonagens) {
            console.warn(`[AVISO getPlayerTokenCount] Tag "${playerTag}" não encontrada na aba 'Personagens'. Não é possível buscar tokens.`);
            return 0;
        }

        // 2. Pega a tag RESOLVIDA (valor exibido) da aba Personagens
        const resolvedTag = playerRowPersonagens.get('Nome'); // Pega o valor da célula encontrada
        if (!resolvedTag) {
             console.warn(`[AVISO getPlayerTokenCount] Tag resolvida vazia encontrada para ${playerTag} em 'Personagens'.`);
             return 0;
        }

        // 3. AGORA busca a tag resolvida na aba "Tokens"
        const playerRowTokens = rowsTokens.find(row => { 
            const tagValue = row.get('Nome');
            return tagValue && String(tagValue).trim().toLowerCase() === String(resolvedTag).trim().toLowerCase();
        });

        // Se encontrou a linha correspondente em Tokens
        if (playerRowTokens) { 
            const tokenValue = playerRowTokens.get('Saldo'); 
            const tokenCount = parseInt(tokenValue);
            return !isNaN(tokenCount) ? tokenCount : 0; // Retorna o número ou 0 se inválido
        } else {
            console.warn(`[AVISO getPlayerTokenCount] Tag "${resolvedTag}" (resolvida de ${playerTag}) não encontrada na aba 'Tokens'.`);
            return 0; // Retorna 0 se não encontrar a tag
        }
    } catch (error) {
        console.error(`[ERRO getPlayerTokenCount] Falha ao buscar tokens para ${playerTag}:`, error);
        return 0; // Retorna 0 em caso de erro
    }
}

/**
 * Incrementa a coluna 'Double Up' para um jogador.
 * @param {string} playerTag - A tag Discord do jogador (Nome#1234).
 * @param {number} amountToSpend - A quantidade a somar na coluna 'Double Up' (neste caso, 1).
 * ATUALIZADO: Usa o método de loop de células (baseado em incrementarContagem) para salvar
 * APENAS uma célula e preservar fórmulas.
 * @returns {Promise<boolean>} - True se a atualização foi bem-sucedida, False caso contrário.
 */
async function spendPlayerTokens(playerTag, amountToSpend) {
    if (!playerTag || typeof amountToSpend !== 'number' || amountToSpend <= 0) return false;
    try {
        await docSorteio.loadInfo();
        const sheetTokens = docSorteio.sheetsByTitle['Tokens'];
        if (!sheetTokens) {
            console.error("[ERRO spendPlayerTokens] Aba 'Tokens' não encontrada.");
            return false;
        }
        
        await sheetTokens.loadHeaderRow(1); // Assume header na linha 1

        // Define os cabeçalhos que vamos procurar
        const nameHeader = 'Nome'; // Coluna para encontrar o jogador
        const doubleUpHeader = 'Double Up'; // Coluna para incrementar

        // Encontra os índices das colunas (0-based)
        const nameColIndex = sheetTokens.headerValues.indexOf(nameHeader);
        const doubleUpColIndex = sheetTokens.headerValues.indexOf(doubleUpHeader);

        if (nameColIndex === -1 || doubleUpColIndex === -1) {
            console.error(`[ERRO spendPlayerTokens] Colunas "${nameHeader}" ou "${doubleUpHeader}" não encontradas na aba 'Tokens'.`);
            return false;
        }

        // Carrega *apenas* as colunas de Nome e Double Up
        // (Isto é mais eficiente do que carregar a planilha inteira)
        await sheetTokens.loadCells({
            startRowIndex: 1, // Começa da linha 2 (índice 1), pois 0 é o header
            endRowIndex: sheetTokens.rowCount,
            startColumnIndex: Math.min(nameColIndex, doubleUpColIndex),
            endColumnIndex: Math.max(nameColIndex, doubleUpColIndex) + 1
        });
        
        // Itera pelas linhas (começando do índice 1, pois 0 é o header)
        for (let rowIndex = 1; rowIndex < sheetTokens.rowCount; rowIndex++) {
            const nameCell = sheetTokens.getCell(rowIndex, nameColIndex);
            const nameValue = nameCell.value;

            // Compara a tag do jogador
            if (nameValue && String(nameValue).trim().toLowerCase() === playerTag.trim().toLowerCase()) {
                
                // Encontramos o jogador. Agora pega a célula "Double Up"
                const targetCell = sheetTokens.getCell(rowIndex, doubleUpColIndex);
                
                const currentSpent = parseInt(targetCell.value) || 0; // Lê o valor
                const newSpent = currentSpent + amountToSpend; // Calcula
                
                targetCell.value = newSpent; // Define o novo valor
                
                // Salva *apenas* esta célula
                await sheetTokens.saveUpdatedCells([targetCell]);
                
                console.log(`[INFO spendPlayerTokens] Tokens gastos atualizados para ${playerTag}: ${newSpent}`);
                return true; // Encontrou e salvou, pode sair da função
            }
        }

        // Se o loop terminar sem encontrar o jogador
        console.warn(`[AVISO spendPlayerTokens] Tag "${playerTag}" não encontrada para gastar tokens.`);
        return false;

    } catch (error) {
        console.error(`[ERRO spendPlayerTokens] Falha ao gastar tokens para ${playerTag}:`, error);
        return false;
    }
}

/**
 * Incrementa a coluna 'Mesas Mestradas' para um mestre (jogador).
 * @param {string} mestreUsername - O username do mestre (Nome, sem #).
 * @returns {Promise<boolean>} - True se a atualização foi bem-sucedida, False caso contrário.
 */
async function incrementarMesasMestradas(mestreUsername) {
    if (!mestreUsername) return false;
    try {
        await docSorteio.loadInfo();
        const sheetTokens = docSorteio.sheetsByTitle['Tokens'];
        if (!sheetTokens) {
            console.error("[ERRO incrementarMesasMestradas] Aba 'Tokens' não encontrada.");
            return false;
        }
        
        await sheetTokens.loadHeaderRow(1); // Assume header na linha 1

        // Define os cabeçalhos que vamos procurar
        const nameHeader = 'Nome'; // Coluna para encontrar o mestre
        const mesasHeader = 'Mesas Mestradas'; // Coluna para incrementar

        // Encontra os índices das colunas (0-based)
        const nameColIndex = sheetTokens.headerValues.indexOf(nameHeader);
        const mesasColIndex = sheetTokens.headerValues.indexOf(mesasHeader);

        if (nameColIndex === -1 || mesasColIndex === -1) {
            console.error(`[ERRO incrementarMesasMestradas] Colunas "${nameHeader}" ou "${mesasHeader}" não encontradas na aba 'Tokens'.`);
            return false;
        }

        // Carrega *apenas* as colunas de Nome e Mesas Mestradas
        await sheetTokens.loadCells({
            startRowIndex: 1, // Começa da linha 2 (índice 1)
            endRowIndex: sheetTokens.rowCount,
            startColumnIndex: Math.min(nameColIndex, mesasColIndex),
            endColumnIndex: Math.max(nameColIndex, mesasColIndex) + 1
        });
        
        // Itera pelas linhas (começando do índice 1, pois 0 é o header)
        for (let rowIndex = 1; rowIndex < sheetTokens.rowCount; rowIndex++) {
            const nameCell = sheetTokens.getCell(rowIndex, nameColIndex);
            if (nameCell.value && String(nameCell.value).trim().toLowerCase() === mestreUsername.trim().toLowerCase()) {
                const targetCell = sheetTokens.getCell(rowIndex, mesasColIndex);
                const currentValue = parseInt(targetCell.value) || 0; // Lê o valor
                targetCell.value = currentValue + 1; // Incrementa
                await sheetTokens.saveUpdatedCells([targetCell]); // Salva *apenas* esta célula
                console.log(`[INFO incrementarMesasMestradas] Contagem de mesas mestradas atualizada para ${mestreUsername}: ${targetCell.value}`);
                return true; // Encontrou e salvou
            }
        }
        console.warn(`[AVISO incrementarMesasMestradas] Username "${mestreUsername}" não encontrado na aba 'Tokens'.`);
        return false;
    } catch (error) {
        console.error(`[ERRO incrementarMesasMestradas] Falha ao incrementar mesas para ${mestreUsername}:`, error);
        return false;
    }
}

// +++ FUNÇÕES GENÉRICAS DE MANIPULAÇÃO DE PLANILHA +++

/**
 * (Auxiliar) Converte um índice de coluna (0-based) para a letra A1 (A, B, ..., Z, AA, ...).
 * @param {number} index - O índice da coluna (0-based).
 * @returns {string} - A letra da coluna em notação A1.
 */
function getColLetter(index) {
    let letter = '';
    let n = index;
    while (n >= 0) {
        letter = String.fromCharCode(n % 26 + 65) + letter;
        n = Math.floor(n / 26) - 1;
    }
    return letter;
}

/**
 * Busca valores de uma ou mais colunas, encontrando a(s) linha(s) baseada em critérios JSON.
 * @param {import('google-spreadsheet').GoogleSpreadsheetWorksheet} sheet - O objeto da aba da planilha.
 * @param {object} criteria - Objeto JSON com { HeaderColunaBusca: valorBusca, ... }.
 * @param {string[]} returnColumns - Array com os cabeçalhos das colunas a retornar.
 * @param {object} [offset] - (Opcional) Objeto { column: HeaderColunaOffset, rows: numeroLinhasOffset }.
 * @returns {Promise<Array<object>>} - Array de objetos, cada um representando uma linha encontrada,
 * com chaves sendo os `returnColumns` e seus valores. Inclui `_offsetValue` se offset for pedido. Retorna array vazio se nada for encontrado.
 */
async function getValuesFromSheet(sheet, criteria, returnColumns, offset = null) {
    const results = [];
    try {
        await sheet.loadHeaderRow(1); // Garante headers carregados
        const rows = await sheet.getRows(); // Pega todas as linhas

        for (const row of rows) {
            let isMatch = true;
            // Verifica todos os critérios passados
            for (const key in criteria) {
                const rowValue = row.get(key);
                // Comparação flexível (string vs number), case-insensitive, trim
                if (!(rowValue !== undefined && rowValue !== null && String(rowValue).trim().toLowerCase() == String(criteria[key]).trim().toLowerCase())) {
                    isMatch = false;
                    break; // Se um critério falha, para de verificar esta linha
                }
            }

            // Se a linha corresponde a todos os critérios
            if (isMatch) {
                const rowResult = {};
                // Pega os valores das colunas de retorno
                for (const colHeader of returnColumns) {
                    rowResult[colHeader] = row.get(colHeader);
                }

                // Processa o offset, se houver
                if (offset && offset.column && typeof offset.rows === 'number') {
                    const offsetColIndex = sheet.headerValues.indexOf(offset.column);
                    if (offsetColIndex !== -1) {
                        const targetRowIndex = row.rowIndex + offset.rows; // Aplica offset ao rowIndex 1-based
                        // Garante que a linha alvo está dentro dos limites da planilha (e não é o header)
                        if (targetRowIndex > 1 && targetRowIndex <= sheet.rowCount) {
                            const offsetColLetter = getColLetter(offsetColIndex);
                            const offsetCellA1 = `${offsetColLetter}${targetRowIndex}`;
                            try {
                                await sheet.loadCells(offsetCellA1); // Carrega a célula do offset
                                rowResult['_offsetValue'] = sheet.getCellByA1(offsetCellA1).value; // Adiciona ao resultado
                            } catch (offsetError) {
                                console.error(`[ERRO getValuesFromSheet] Falha ao carregar/ler célula de offset ${offsetCellA1}:`, offsetError);
                                rowResult['_offsetValue'] = null; // Indica erro no offset
                            }
                        } else {
                             rowResult['_offsetValue'] = null; // Offset resultou em linha inválida
                        }
                    } else {
                         console.warn(`[AVISO getValuesFromSheet] Coluna de offset "${offset.column}" não encontrada.`);
                         rowResult['_offsetValue'] = null; // Coluna de offset não encontrada
                    }
                }
                results.push(rowResult); // Adiciona o resultado desta linha ao array
            }
        }
    } catch (error) {
        console.error(`[ERRO getValuesFromSheet] Falha ao buscar valores:`, error);
        // Retorna array vazio em caso de erro
    }
    if (results.length === 0) {
        // console.log(`[INFO getValuesFromSheet] Nenhuma linha encontrada para os critérios na aba '${sheet.title}'.`);
    }
    return results; // Retorna o array de resultados (pode estar vazio)
}

/**
 * Define um conjunto de valores numa linha específica, encontrada por critérios JSON.
 * Atualiza APENAS a primeira linha encontrada que corresponda aos critérios.
 * Usa o método de célula única para preservar fórmulas.
 * @param {import('google-spreadsheet').GoogleSpreadsheetWorksheet} sheet - O objeto da aba da planilha.
 * @param {object} criteria - Objeto JSON com { HeaderColunaBusca: valorBusca, ... } para encontrar a linha.
 * @param {object} valuesToSet - Objeto JSON com { HeaderColunaAlvo: novoValor, ... }.
 * @returns {Promise<boolean>} - True se conseguiu alterar, False caso contrário.
 */
async function setValuesInSheet(sheet, criteria, valuesToSet) {
    try {
        await sheet.loadHeaderRow(1); // Garante headers
        // Encontra os índices de todas as colunas envolvidas (busca e alvo)
        const allHeaders = [...Object.keys(criteria), ...Object.keys(valuesToSet)];
        const colIndices = {};
        const colsToLoadIndices = [];
        for (const header of allHeaders) {
            const index = sheet.headerValues.indexOf(header);
            if (index === -1) {
                console.error(`[ERRO setValuesInSheet] Coluna "${header}" não encontrada na aba "${sheet.title}".`);
                return false;
            }
            colIndices[header] = index;
            colsToLoadIndices.push(index);
        }
        if (colsToLoadIndices.length === 0) return true; // Nada a fazer

        // Carrega apenas as colunas necessárias
        const minCol = Math.min(...colsToLoadIndices);
        const maxCol = Math.max(...colsToLoadIndices);
        await sheet.loadCells({
            startRowIndex: 1, endRowIndex: sheet.rowCount,
            startColumnIndex: minCol, endColumnIndex: maxCol + 1
        });

        let rowFound = false;
        const cellsToSave = [];

        // Itera pelas linhas
        for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {
            let isMatch = true;
            // Verifica critérios
            for (const header in criteria) {
                const cellValue = sheet.getCell(rowIndex, colIndices[header]).value;
                if (!(cellValue !== undefined && cellValue !== null && String(cellValue).trim().toLowerCase() == String(criteria[header]).trim().toLowerCase())) {
                    isMatch = false;
                    break;
                }
            }

            // Se encontrou a linha
            if (isMatch) {
                rowFound = true;
                // Prepara as células para salvar
                for (const header in valuesToSet) {
                    const targetCell = sheet.getCell(rowIndex, colIndices[header]);
                    const newValue = valuesToSet[header];
                    const valueToSet = (newValue === '' || newValue === undefined || newValue === null) ? null : newValue; // Limpa com null
                    
                    // Só adiciona para salvar se o valor mudou
                    if (String(targetCell.value) !== String(valueToSet)) {
                        targetCell.value = valueToSet;
                        cellsToSave.push(targetCell);
                    }
                }
                break; // Para na primeira linha encontrada
            }
        }

        // Se não encontrou a linha
        if (!rowFound) {
            console.warn(`[AVISO setValuesInSheet] Nenhuma linha encontrada para os critérios na aba "${sheet.title}".`);
            return false;
        }

        // Salva as células alteradas
        if (cellsToSave.length > 0) {
            await sheet.saveUpdatedCells(cellsToSave);
            console.log(`[INFO setValuesInSheet] ${cellsToSave.length} célula(s) atualizada(s) para os critérios na aba "${sheet.title}".`);
        } else {
            console.log(`[INFO setValuesInSheet] Nenhum valor precisou ser alterado para os critérios na aba "${sheet.title}".`);
        }
        return true; // Encontrou a linha e tentou/não precisou salvar

    } catch (error) {
        console.error(`[ERRO setValuesInSheet] Falha ao definir valores:`, error);
        return false;
    }
}

/**
 * Limpa (define como vazio) o valor numa célula específica, encontrando a linha baseada em um ou dois critérios.
 * É um atalho para setValueInSheet(..., '').
 * @param {import('google-spreadsheet').GoogleSpreadsheetWorksheet} sheet - O objeto da aba da planilha.
 * @param {object} criteria - Objeto JSON com { HeaderColunaBusca: valorBusca, ... } para encontrar a linha.
 * @param {string[]} columnsToClear - Array com os cabeçalhos das colunas a limpar.
 * @returns {Promise<boolean>} - True se conseguiu alterar, False caso contrário.
 */
async function clearValuesInSheet(sheet, criteria, columnsToClear) {
    // Cria o objeto { Header: null, Header2: null, ... }
    const valuesToSetNull = columnsToClear.reduce((acc, header) => {
        acc[header] = null;
        return acc;
    }, {});
    // Chama setValueInSheet com newValue = null (que será convertido para vazio pela API)
    return await setValuesInSheet(sheet, criteria, valuesToSetNull);
}

// +++ FIM DAS FUNÇÕES GENÉRICAS +++

/**
* Pré-carrega todos os dados necessários para construir embeds de inventário.
* @returns {Promise<object>} - Objeto contendo os dados pré-carregados.
*/
async function preloadInventoryEmbedData() {
    try {
        console.log("[INFO Google] Pré-carregando dados para embeds de inventário...");
        await docSorteio.loadInfo();

        // 1. Carregar Tokens (Aba Tokens)
        const sheetTokens = docSorteio.sheetsByTitle['Tokens'];
        await sheetTokens.loadHeaderRow(1);
        const rowsTokens = await sheetTokens.getRows();
        const tokenDataMap = new Map(rowsTokens.map(r => [String(r.get('Nome')).trim().toLowerCase(), parseInt(r.get('Saldo')) || 0]));


        // 2. Carregar Níveis/Mesas (Aba Personagens)
        const sheetChars = docSorteio.sheetsByTitle['Personagens'];
        await sheetChars.loadHeaderRow(2);
        const rowsChars = await sheetChars.getRows();
        const charDataMap = new Map(rowsChars.map(r => {
            const key = `${String(r.get('Nome')).trim().toLowerCase()}-${String(r.get('Personagem')).trim().toLowerCase()}`;
            return [key, { level: parseInt(r.get('Level')) || 1, mesas: parseInt(r.get('Mesas Jogadas')) || 0 }];
        }));

        // 3. Carregar XP (Aba Player ID)
        const sheetXP = docSorteio.sheetsByTitle['Player ID'];
        await sheetXP.loadHeaderRow(1);
        const nivelColIndex = sheetXP.headerValues.indexOf('Nível');
        const totalColIndex = sheetXP.headerValues.indexOf('Total');
        if (nivelColIndex === -1 || totalColIndex === -1) {
            throw new Error("Colunas 'Nível' ou 'Total' não encontradas em Player ID.");
        }

        // Carrega as colunas Nível e Total a partir da linha 2
        await sheetXP.loadCells({
            startRowIndex: 1, // Linha 2 (índice 1)
            endRowIndex: sheetXP.rowCount,
            startColumnIndex: Math.min(nivelColIndex, totalColIndex),
            endColumnIndex: Math.max(nivelColIndex, totalColIndex) + 1
        });
        const xpDataMap = new Map();
        xpDataMap.set(1, 0); // Nível 1 sempre começa com 0 mesas para upar
 
        // Itera pelas linhas carregadas (a partir do índice 1, que é a linha 2 da planilha)
        for (let i = 1; i < sheetXP.rowCount; i++) {
            const nivelCell = sheetXP.getCell(i, nivelColIndex); // Pega célula do nível na linha atual
            const level = parseInt(nivelCell.value);

            // Se for um nível válido maior que 1
            if (!isNaN(level) && level > 1) {
                // Pega a célula 'Total' da linha ANTERIOR (i-1)
                // Garante que i-1 >= 1 (ou seja, não é a linha do header)
                if (i - 1 >= 1) {
                    const totalCellPrevious = sheetXP.getCell(i - 1, totalColIndex);
                    const mesasParaUpar = parseInt(totalCellPrevious.value) || 0;
                    xpDataMap.set(level, mesasParaUpar);
                } else {
                    // Caso de segurança: nível > 1 na primeira linha de dados? Improvável.
                    xpDataMap.set(level, 0);
                    console.warn(`[preloadInventoryEmbedData] Estado inesperado para level ${level} na linha ${i + 1}.`);
                }
            }
        }

        console.log("[INFO Google] Dados de embed pré-carregados.");
        return { tokenDataMap, charDataMap, xpDataMap };

    } catch (e) {
        console.error("[ERRO preloadInventoryEmbedData] Falha ao carregar dados de embed:", e);
        return null; // Retorna nulo em caso de falha
    }
}

/**
* Busca a contagem de tokens de um Map pré-carregado.
* @param {string} playerTag - A tag Discord do jogador (Nome#1234).
* @param {Map<string, number>} tokenDataMap - O Map de tokens pré-carregado.
* @returns {number} - A quantidade de tokens.
*/
function getPlayerTokenCountFromData(playerTag, tokenDataMap) {
    if (!playerTag || !tokenDataMap) return 0;
    return tokenDataMap.get(String(playerTag).trim().toLowerCase()) || 0;
}

// --- 6. EXPORTAÇÕES ---
// Exportamos tudo para que o index.js e os comandos possam usar
module.exports = {
  docSorteio,
  docControle,
  docInventario,
  docCraft,
  getPlayerTokenCount,
  spendPlayerTokens,
  fetchPlayerLevels,
  executarLogicaSorteio,
  carregarDadosPlanilha,
  calcularPrioridade,
  ordenarPorPrioridade,
  realizarSorteio,
  lookupUsernames,
  lookupIds,
  parsearAnuncioMesa,
  incrementarContagem,
  incrementarMesasMestradas, // +++ EXPORTA A NOVA FUNÇÃO
  preloadInventoryEmbedData, // +++ EXPORTA O PRELOADER
  getPlayerTokenCountFromData,
  getValuesFromSheet,         // +++ EXPORTA FUNÇÃO GENÉRICA
  setValuesInSheet,           // +++ EXPORTA FUNÇÃO GENÉRICA
  clearValuesInSheet          // +++ EXPORTA FUNÇÃO GENÉRICA
};