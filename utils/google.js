// --- 1. Importação das Bibliotecas ---
require('dotenv').config();
const { JWT } = require('google-auth-library');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { roleMention, userMention } = require('discord.js'); // Para parsearAnuncioMesa

// --- 2. Configuração das Credenciais ---
const SORTEIO_SHEET_ID = process.env.SORTEIO_SHEET_ID;
const CONTROLE_SHEET_ID = process.env.CONTROLE_SHEET_ID;
const TABELA_CRAFT_ID = process.env.TABELA_CRAFT_ID;
const INVENTARIO_SHEET_ID =
    process.env.INVENTARIO_SHEET_ID ||
    "1j819p3VCgRpUz3rNX0lg24M5bS9jNKG-mXQ3usxLGfo";
const COMPRAS_VENDAS_ID = process.env.COMPRAS_VENDAS_ID;

let credenciais;
try {
    credenciais = require("../credentials.json");
    console.log("[INFO Google] Credenciais carregadas a partir de credentials.json.");
} catch (error) {
     console.error("[ERRO Google] Falha ao carregar o ficheiro credentials.json.", error.message);
     console.error("[ERRO Google] Certifique-se de que o ficheiro credentials.json está na raiz do projeto.");
     process.exit(1); // Para o bot se não conseguir carregar credenciais
}

const serviceAccountAuth = new JWT({
    email: credenciais.client_email,
    key: credenciais.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const docSorteio = new GoogleSpreadsheet(SORTEIO_SHEET_ID, serviceAccountAuth);
const docControle = new GoogleSpreadsheet(CONTROLE_SHEET_ID, serviceAccountAuth);
const docCraft = new GoogleSpreadsheet(TABELA_CRAFT_ID, serviceAccountAuth);
const docInventario = new GoogleSpreadsheet(INVENTARIO_SHEET_ID, serviceAccountAuth);
const docComprasVendas = new GoogleSpreadsheet(COMPRAS_VENDAS_ID, serviceAccountAuth);


// --- 3. Lógica Principal do Sorteio (Refatorada) ---
// (Esta função ainda usa 'Primários'/'Secundários' como no seu ficheiro)
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
    
    if (playerNamesSet.has(nome)) {
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
  let nomesInscritosSet = new Set(nomesInscritos.map((n) => n.toLowerCase()));
  const listaCompletaJogadores = await carregarDadosPlanilha();
  const mapaJogadoresPrioridade = new Map(
      listaCompletaJogadores.map((j) => [j.nome.toLowerCase(), j]),
  );
  let jogadoresElegiveis = [];
  if (levelFilter.length > 0) {
      const levelFilterSet = new Set(levelFilter);
      const playerLevelMap = await fetchPlayerLevels(nomesInscritos);
      for (const nomeInscrito of nomesInscritosSet) {
          const playerLevels = playerLevelMap.get(nomeInscrito);
          if (playerLevels) {
              const hasMatch = [...playerLevels].some((level) =>
                  levelFilterSet.has(level),
              );
              if (hasMatch && mapaJogadoresPrioridade.has(nomeInscrito)) {
                  jogadoresElegiveis.push(
                      mapaJogadoresPrioridade.get(nomeInscrito),
                  );
              }
          }
      }
  } else {
      for (const nomeInscrito of nomesInscritosSet) {
          if (mapaJogadoresPrioridade.has(nomeInscrito)) {
              jogadoresElegiveis.push(
                  mapaJogadoresPrioridade.get(nomeInscrito),
              );
          }
      }
  }
  if (jogadoresElegiveis.length === 0) {
      if (levelFilter.length > 0) {
          throw new Error(
              "Nenhum dos jogadores inscritos possui personagens nos níveis solicitados OU não foram encontrados na aba Personagens.",
          );
      } else {
          throw new Error(
              "Nenhum dos jogadores inscritos foi encontrado na planilha de prioridade. Verifique os nomes.",
          );
      }
  }
  const listaOrdenada = ordenarPorPrioridade(jogadoresElegiveis);
  const listaSorteada = realizarSorteio(listaOrdenada);
  let inscritosFormatado = `\`\`\`${nomesInscritos.join(" ")}\`\`\``;
  if (nomesInscritos.length === 0) inscritosFormatado = "Nenhum";
  let filtroFormatado =
      levelFilter.length > 0
          ? `**Filtro de Nível:** ${levelFilter.join(", ")}\n\n`
          : "";
  let resposta = `**Inscritos para este sorteio:**\n${inscritosFormatado}\n${filtroFormatado}🎉 **Resultado Final do Sorteio** 🎉\n\n`;
  let mencoes = "";
  listaSorteada.forEach((jogador, index) => {
      resposta += `${index + 1}. **${jogador.nome}** (Critério: ${jogador.prioridade.descricao})\n`;
      mencoes += `@${jogador.nome}\n`;
  });
  return { resposta, mencoes };
}

async function carregarDadosPlanilha() {
    await docSorteio.loadInfo();
    const sheet = docSorteio.sheetsByTitle["Mesas Jogadas (Total)"];
    if (!sheet) {
        throw new Error("Aba 'Mesas Jogadas (Total)' não foi encontrada!");
    }
    await sheet.loadCells();
    const dataInicioPlanilha = new Date(Date.UTC(2025, 8, 1)); // Assuming September 1st, 2025
    const hoje = new Date();
    const hojeUTC = new Date(Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()));
    const diaDaSemana = hojeUTC.getUTCDay(); // 0 = Sunday, 1 = Monday, ...
    const diasParaSubtrair = diaDaSemana === 0 ? 6 : diaDaSemana - 1; // Days to get to the previous Monday
    const ultimaSegunda = new Date(hojeUTC);
    ultimaSegunda.setUTCDate(hojeUTC.getUTCDate() - diasParaSubtrair);
    const diffTime = ultimaSegunda.getTime() - dataInicioPlanilha.getTime();
    const semanasPassadas = Math.floor(diffTime / (1000 * 60 * 60 * 24 * 7));
    const indiceAtual = 1 + semanasPassadas; // Column B is index 1, C is 2...
    const maxColumnIndex = sheet.columnCount - 1;
    const indiceAtualReal = Math.min(indiceAtual, maxColumnIndex);
    if (indiceAtual > maxColumnIndex) {
        console.warn(`[AVISO] Índice da coluna atual (${indiceAtual}) parece estar fora dos limites da planilha 'Mesas Jogadas (Total)'. Usando a última coluna existente (${maxColumnIndex}) para leitura.`);
    }
    let colunaAtualLetra = "A";
    if (indiceAtualReal >= 0) {
        const headerRange = `A1:${getColLetter(sheet.columnCount - 1)}1`; // Use getColLetter
        await sheet.loadCells(headerRange);
        colunaAtualLetra = getColLetter(indiceAtualReal); // Use getColLetter
    }
    const dataRange = `A2:${colunaAtualLetra}${sheet.rowCount}`;
    await sheet.loadCells(dataRange);
    const jogadores = [];
    for (let i = 1; i < sheet.rowCount; i++) {
        const nomeCell = sheet.getCell(i, 0); // Column A (Name)
        const nome = nomeCell.value;
        if (!nome || String(nome).toLowerCase() === "nome" || String(nome).toLowerCase() === "média") continue;
        let indiceUltimoJogo = -1;
        const limiteLeitura = indiceAtualReal;
        for (let j = 1; j <= limiteLeitura; j++) { // Start from column B (index 1)
            const cellValue = sheet.getCell(i, j)?.value;
            if (parseInt(cellValue) > 0) {
                indiceUltimoJogo = j;
            }
        }
        let semanasSemJogar = 1000; // Represents "never played"
        if (indiceUltimoJogo !== -1) {
            semanasSemJogar = indiceAtualReal - indiceUltimoJogo;
        }
        jogadores.push({
            nome: String(nome),
            jogosEstaSemana: parseInt(sheet.getCell(i, indiceAtualReal)?.value) || 0,
            semanasSemJogar: semanasSemJogar,
        });
    }
    return jogadores;
}
function calcularPrioridade(jogador) {
    if (jogador.semanasSemJogar >= 1000) return { score: 1, descricao: "Nunca jogou" };
    if (jogador.semanasSemJogar >= 2) return { score: 2, descricao: `Está há ${jogador.semanasSemJogar} semanas sem jogar` };
    if (jogador.jogosEstaSemana === 0) return { score: 5, descricao: "Não jogou esta semana" };
    return { score: 6 + jogador.jogosEstaSemana, descricao: `Jogou ${jogador.jogosEstaSemana} vez(es) esta semana` };
}
function ordenarPorPrioridade(jogadores) {
    return jogadores
        .map((j) => ({ ...j, prioridade: calcularPrioridade(j) }))
        .sort((a, b) => {
            if (a.prioridade.score === b.prioridade.score)
                return a.nome.localeCompare(b.nome);
            return a.prioridade.score - b.prioridade.score;
        });
}
function realizarSorteio(jogadoresOrdenados) {
    const resultadoFinal = [];
    const grupos = {};
    jogadoresOrdenados.forEach((jogador) => {
        const score = jogador.prioridade.score;
        if (!grupos[score]) grupos[score] = [];
        grupos[score].push(jogador);
    });
    Object.keys(grupos)
        .sort((a, b) => a - b)
        .forEach((score) => {
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
    try { 
        await docSorteio.loadInfo();
        const sheetPlayerId = docSorteio.sheetsByTitle["Player ID"];
        if (!sheetPlayerId) {
            console.warn("[AVISO] Aba 'Player ID' não encontrada. Retornando inputs originais.");
            return inputs.map((item) => item.trim());
        }
        await sheetPlayerId.loadHeaderRow();
        await sheetPlayerId.loadCells("A:B"); 
        const rows = await sheetPlayerId.getRows();
        const idToTagMap = new Map();
        rows.forEach((row) => {
            const id = row.get("ID");
            const tag = row.get("Tag");
            if (id && tag) {
                idToTagMap.set(String(id).trim(), String(tag).trim());
            }
        });
        const resolvedNames = [];
        const mentionRegex = /^<@!?(\d+)>$/;
        for (const item of inputs) {
            const trimmedItem = item.trim(); 
            const match = trimmedItem.match(mentionRegex);
            if (match) {
                const userId = match[1];
                const foundTag = idToTagMap.get(userId);
                if (foundTag) {
                    resolvedNames.push(foundTag);
                } else {
                    console.warn(`[AVISO] lookupUsernames: ID ${userId} (de ${trimmedItem}) não encontrado na aba 'Player ID'. Usando a menção original como fallback.`);
                    resolvedNames.push(trimmedItem); 
                }
            } else {
                resolvedNames.push(trimmedItem); 
            }
        }
        return resolvedNames;
    } catch (error) {
        console.error("[ERRO] Falha em lookupUsernames:", error);
        return inputs.map((item) => item.trim()); 
    }
}

async function lookupIds(tags) {
    if (!tags || tags.length === 0) return [];
    await docSorteio.loadInfo(); 
    const sheetPlayerId = docSorteio.sheetsByTitle['Player ID'];
    if (!sheetPlayerId) {
        console.warn("[AVISO] Aba 'Player ID' não encontrada para buscar IDs. Retornando vazio.");
        return [];
    }
    await sheetPlayerId.loadHeaderRow(); 
    await sheetPlayerId.loadCells('A:B'); 
    const rows = await sheetPlayerId.getRows();

    const tagToIdMap = new Map();
    rows.forEach(row => {
        const id = row.get('ID');
        const tag = row.get('Tag');
        if (id && tag) {
            tagToIdMap.set(String(tag).trim().toLowerCase(), String(id).trim()); 
        }
    });
    const resolvedIds = [];
    const tagsLower = tags.map(t => String(t).trim().toLowerCase()); 

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
  const sheetPlayerId = docSorteio.sheetsByTitle["Player ID"];
  const roleNameToIdMap = new Map();
  if (sheetPlayerId) {
      try {
        await sheetPlayerId.loadHeaderRow(); 
        await sheetPlayerId.loadCells("C:D");
        const rows = await sheetPlayerId.getRows();
        rows.forEach((row) => {
            const roleId = row.get("ID_Cargos");
            const roleName = row.get("Cargos");
            if (roleId && roleName) {
                roleNameToIdMap.set(
                    String(roleName).trim().toLowerCase(),
                    String(roleId).trim(),
                );
            }
        });
      } catch (e) {
         console.error("[ERRO] Falha ao carregar IDs de cargos:", e.message);
      }
  } else {
      console.warn("[AVISO] Aba 'Player ID' não encontrada para buscar IDs de cargos.");
  }

  // 2. Buscar Menção "Jogadores"
  const jogadoresRoleNameLower = "jogadores";
  const jogadoresRoleId = roleNameToIdMap.get(jogadoresRoleNameLower);
  const mencaoJogadores = jogadoresRoleId
      ? roleMention(jogadoresRoleId)
      : `(Cargo @${jogadoresRoleNameLower} não encontrado)`;

  // 3. Processar Níveis
  const niveisArray = (niveisString || '').split(','); 
  const mencoesNiveis = niveisArray
      .map((n) => n.trim())
      .map((num) => {
          const roleName = `Nível ${num.padStart(2, "0")}`;
          const roleId = roleNameToIdMap.get(roleName.toLowerCase());
          return roleId ? roleMention(roleId) : null;
      })
      .filter(Boolean)
      .join(", ");

  // 4. Processar Data/Hora
  const [dataPart, horaPart] = dataHoraString.split(" ");
  const [dia, mes, ano] = dataPart.split("/");
  const [hora, min] = horaPart.split(":");
  let timestamp = null;
  if (dia && mes && ano && hora && min) {
      try {
          const dataMesa = new Date(`20${ano}`, mes - 1, dia, hora, min);
          if (!isNaN(dataMesa)) {
             // <<< CORREÇÃO: Usa a variável .env DIFERENCA_HORA >>>
             const horaOffset = parseInt(process.env.DIFERENCA_HORA) || 0;
             const offsetInSeconds = horaOffset * 60 * 60;
             timestamp = Math.floor(dataMesa.getTime() / 1000) + offsetInSeconds;
          }
      } catch (dateError) {
          console.error("Erro ao processar data/hora:", dateError);
      }
  }
  const timestampString = timestamp
      ? `<t:${timestamp}:F> (<t:${timestamp}:R>)`
      : "(Data/Hora inválida)";

  // 5. Montar o Anúncio COMPLETO
  const anuncioBase = [
      `**Data:** ${timestampString}`,
      `**Previsão de duração:** ${duracao}`,
  ].join("\n");
  
  const finalTierString = `**Tier:** ${mencoesNiveis || "Nenhum nível correspondente encontrado"}`;

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
    const currentSheet = sheet; 
    if (!currentSheet || typeof currentSheet.title !== 'string') {
        console.error("[ERRO incrementarContagem] Objeto 'sheet' inválido.");
        return false;
    }
    if (playerNames.length === 0) {
        console.warn(`[AVISO incrementarContagem] Lista de jogadores vazia. Pulando incremento para ${currentSheet.title}.`);
        return true; 
    }

    try {
        // <<< CORREÇÃO: Linha removida >>>
        // await currentSheet.loadInfo(); // <<< ESTA LINHA CAUSA O ERRO
        
        if (targetColumnIndex < 0 || targetColumnIndex >= currentSheet.columnCount) {
            console.warn(`[AVISO incrementarContagem] Índice da coluna alvo (${targetColumnIndex}) fora dos limites (0-${currentSheet.columnCount - 1}) da aba ${currentSheet.title}. Pulando incremento.`);
            return false; 
        }
        console.log(`[DEBUG incrementarContagem] Carregando Linhas 1 e 2 (até ZZ) para ${currentSheet.title}`);
        await currentSheet.loadCells('A1:ZZ2'); 
        console.log(`[DEBUG incrementarContagem] Linhas 1 e 2 carregadas para ${currentSheet.title}.`);

        let colunaAlvoLetra;
        try {
            colunaAlvoLetra = currentSheet.getCell(0, targetColumnIndex).a1Address.replace(/[0-9]/g, '');
            console.log(`[DEBUG incrementarContagem] Letra da coluna alvo: ${colunaAlvoLetra}`);
        } catch(e) {
            console.error(`[ERRO incrementarContagem] Falha ao obter letra da coluna ${targetColumnIndex} em ${currentSheet.title}`, e);
            return false; 
        }

        const headerRowIndex = (currentSheet.title === 'Personagens') ? 2 : 1;
        await currentSheet.loadHeaderRow(headerRowIndex);
        console.log(`[DEBUG incrementarContagem] Cabeçalhos lidos (linha ${headerRowIndex}) para ${currentSheet.title}:`, currentSheet.headerValues);

        const typeColHeader = 'Prim/Sec/Terc';
        const typeColIndex = currentSheet.headerValues.indexOf(typeColHeader);
        if (characterType && typeColIndex === -1) { 
            console.error(`[ERRO incrementarContagem] Coluna "${typeColHeader}" não encontrada na aba "${currentSheet.title}", mas characterType foi especificado.`);
            return false;
        }

        const startDataRowIndex = headerRowIndex; 
        const maxRow = Math.max(startDataRowIndex + 1, currentSheet.rowCount); 
        const nomeColIndex = 0; // Coluna A

        const colsToLoad = [nomeColIndex, targetColumnIndex]; 
        if (characterType && typeColIndex !== -1) {
            colsToLoad.push(typeColIndex); 
        }
        
        const minLoadCol = Math.min(...colsToLoad);
        const maxLoadCol = Math.max(...colsToLoad);
        const minLoadColLetter = getColLetter(minLoadCol); 
        const maxLoadColLetter = getColLetter(maxLoadCol);

        const rangeToLoad = `${minLoadColLetter}${startDataRowIndex + 1}:${maxLoadColLetter}${maxRow}`; 
        console.log(`[DEBUG incrementarContagem] Carregando range de dados ${rangeToLoad} para ${currentSheet.title}`);
        await currentSheet.loadCells(rangeToLoad);
        console.log(`[DEBUG incrementarContagem] Células de dados carregadas para ${currentSheet.title}.`);

        const playerSet = new Set(playerNames.map(p => String(p).toLowerCase())); 
        const cellsToUpdate = [];

        for (let rowIndex = startDataRowIndex; rowIndex < maxRow; rowIndex++) { 
            const nomeCell = currentSheet.getCell(rowIndex, nomeColIndex); 
            const nomePlanilha = nomeCell.value ? String(nomeCell.value).trim().toLowerCase() : null; 

            if (nomePlanilha && playerSet.has(nomePlanilha)) {
                let typeMatch = true; 
                if (characterType && typeColIndex !== -1) {
                     const typeCell = currentSheet.getCell(rowIndex, typeColIndex);
                     const typeValue = typeCell.value ? String(typeCell.value).trim() : '';
                     typeMatch = (typeValue === characterType); 
                }
                
                if (typeMatch) {
                    console.log(`[DEBUG incrementarContagem] Encontrado jogador ${nomePlanilha} na linha ${rowIndex + 1}${characterType ? ` com tipo ${characterType}` : ''}.`);
                    const cellContagem = currentSheet.getCell(rowIndex, targetColumnIndex);
                    console.log(`[DEBUG incrementarContagem] Célula ${cellContagem.a1Address}, Valor atual: ${cellContagem.value}`);

                    const currentValue = parseInt(cellContagem.value) || 0; 
                    const newValue = currentValue + 1;
                    cellContagem.value = newValue; 
                    console.log(`[DEBUG incrementarContagem] Célula ${cellContagem.a1Address}, Novo valor: ${newValue}`);
                    cellsToUpdate.push(cellContagem); 
                }
            }
        }

        if (cellsToUpdate.length > 0) {
            console.log(`[DEBUG incrementarContagem] Salvando ${cellsToUpdate.length} células atualizadas para ${currentSheet.title}.`);
            await currentSheet.saveUpdatedCells(cellsToUpdate);
            console.log(`Contagem incrementada para ${cellsToUpdate.length} jogadores na aba ${currentSheet.title}`);
             return true; 
        } else {
            console.log(`Nenhum jogador encontrado ou nenhuma célula para atualizar na aba ${currentSheet.title}`);
             return true; 
        }
    } catch (incrementError) {
        console.error(`[ERRO incrementarContagem] Falha crítica ao incrementar contagem na aba ${sheet?.title}:`, incrementError);
        return false; 
    }
}


// ===============================================
// NOVAS FUNÇÕES: Gerenciamento de Tokens
// ===============================================
async function getPlayerTokenCount(playerTag) {
    if (!playerTag) return 0;
    try {
        await docSorteio.loadInfo(); 
        const sheetTokens = docSorteio.sheetsByTitle['Tokens'];
        const sheetPersonagens = docSorteio.sheetsByTitle['Personagens'];
        if (!sheetTokens || !sheetPersonagens) {
            console.error("[ERRO getPlayerTokenCount] Aba 'Tokens' ou 'Personagens' não encontrada na planilha de Sorteio.");
            return 0;
        }
        
        await sheetTokens.loadHeaderRow(1); 
        await sheetPersonagens.loadHeaderRow(2); 
        const rowsTokens = await sheetTokens.getRows();
        const rowsPersonagens = await sheetPersonagens.getRows();

        const playerRowPersonagens = rowsPersonagens.find(row => {
            const tagValue = row.get('Nome'); 
            return tagValue && String(tagValue).trim().toLowerCase() === playerTag.trim().toLowerCase();
        });

        if (!playerRowPersonagens) {
            console.warn(`[AVISO getPlayerTokenCount] Tag "${playerTag}" não encontrada na aba 'Personagens'. Não é possível buscar tokens.`);
            return 0;
        }

        const resolvedTag = playerRowPersonagens.get('Nome'); 
        if (!resolvedTag) {
             console.warn(`[AVISO getPlayerTokenCount] Tag resolvida vazia encontrada para ${playerTag} em 'Personagens'.`);
             return 0;
        }
        const playerRowTokens = rowsTokens.find(row => { 
            const tagValue = row.get('Nome');
            return tagValue && String(tagValue).trim().toLowerCase() === String(resolvedTag).trim().toLowerCase();
        });
        if (playerRowTokens) { 
            const tokenValue = playerRowTokens.get('Saldo'); 
            const tokenCount = parseInt(tokenValue);
            return !isNaN(tokenCount) ? tokenCount : 0; 
        } else {
            console.warn(`[AVISO getPlayerTokenCount] Tag "${resolvedTag}" (resolvida de ${playerTag}) não encontrada na aba 'Tokens'.`);
            return 0; 
        }
    } catch (error) {
        console.error(`[ERRO getPlayerTokenCount] Falha ao buscar tokens para ${playerTag}:`, error);
        return 0; 
    }
}

async function spendPlayerTokens(playerTag, amountToSpend) {
    if (!playerTag || typeof amountToSpend !== "number" || amountToSpend <= 0)
        return false;
    try {
        await docSorteio.loadInfo();
        const sheetTokens = docSorteio.sheetsByTitle["Tokens"];
        if (!sheetTokens) {
            console.error("[ERRO spendPlayerTokens] Aba 'Tokens' não encontrada.");
            return false;
        }
        await sheetTokens.loadHeaderRow(1); 
        const nameHeader = "Nome"; 
        const doubleUpHeader = "Double Up"; 
        const nameColIndex = sheetTokens.headerValues.indexOf(nameHeader);
        const doubleUpColIndex = sheetTokens.headerValues.indexOf(doubleUpHeader);

        if (nameColIndex === -1 || doubleUpColIndex === -1) {
            console.error(`[ERRO spendPlayerTokens] Colunas "${nameHeader}" ou "${doubleUpHeader}" não encontradas na aba 'Tokens'.`);
            return false;
        }
        await sheetTokens.loadCells({
            startRowIndex: 1, 
            endRowIndex: sheetTokens.rowCount,
            startColumnIndex: Math.min(nameColIndex, doubleUpColIndex),
            endColumnIndex: Math.max(nameColIndex, doubleUpColIndex) + 1,
        });
        for (let rowIndex = 1; rowIndex < sheetTokens.rowCount; rowIndex++) {
            const nameCell = sheetTokens.getCell(rowIndex, nameColIndex);
            const nameValue = nameCell.value;
            if (nameValue && String(nameValue).trim().toLowerCase() === playerTag.trim().toLowerCase()) {
                const targetCell = sheetTokens.getCell(rowIndex, doubleUpColIndex);
                const currentSpent = parseInt(targetCell.value) || 0; 
                const newSpent = currentSpent + amountToSpend; 
                targetCell.value = newSpent; 
                await sheetTokens.saveUpdatedCells([targetCell]);
                console.log(`[INFO spendPlayerTokens] Tokens gastos atualizados para ${playerTag}: ${newSpent}`);
                return true; 
            }
        }
        console.warn(`[AVISO spendPlayerTokens] Tag "${playerTag}" não encontrada para gastar tokens.`);
        return false;
    } catch (error) {
        console.error(`[ERRO spendPlayerTokens] Falha ao gastar tokens para ${playerTag}:`, error);
        return false;
    }
}

async function incrementarMesasMestradas(mestreUsername) {
    if (!mestreUsername) return false;
    try {
        await docSorteio.loadInfo();
        const sheetTokens = docSorteio.sheetsByTitle["Tokens"];
        if (!sheetTokens) {
            console.error("[ERRO incrementarMesasMestradas] Aba 'Tokens' não encontrada.");
            return false;
        }
        await sheetTokens.loadHeaderRow(1); 
        const nameHeader = "Nome"; 
        const mesasHeader = "Mesas Mestradas"; 
        const nameColIndex = sheetTokens.headerValues.indexOf(nameHeader);
        const mesasColIndex = sheetTokens.headerValues.indexOf(mesasHeader);
        if (nameColIndex === -1 || mesasColIndex === -1) {
            console.error(`[ERRO incrementarMesasMestradas] Colunas "${nameHeader}" ou "${mesasHeader}" não encontradas na aba 'Tokens'.`);
            return false;
        }
        await sheetTokens.loadCells({
            startRowIndex: 1, 
            endRowIndex: sheetTokens.rowCount,
            startColumnIndex: Math.min(nameColIndex, mesasColIndex),
            endColumnIndex: Math.max(nameColIndex, mesasColIndex) + 1,
        });
        for (let rowIndex = 1; rowIndex < sheetTokens.rowCount; rowIndex++) {
            const nameCell = sheetTokens.getCell(rowIndex, nameColIndex);
            if (nameCell.value && String(nameCell.value).trim().toLowerCase() === mestreUsername.trim().toLowerCase()) {
                const targetCell = sheetTokens.getCell(rowIndex, mesasColIndex);
                const currentValue = parseInt(targetCell.value) || 0; 
                targetCell.value = currentValue + 1; 
                await sheetTokens.saveUpdatedCells([targetCell]); 
                console.log(`[INFO incrementarMesasMestradas] Contagem de mesas mestradas atualizada para ${mestreUsername}: ${targetCell.value}`);
                return true; 
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

function getColLetter(index) {
    let letter = "";
    let n = index;
    while (n >= 0) {
        letter = String.fromCharCode((n % 26) + 65) + letter;
        n = Math.floor(n / 26) - 1;
    }
    return letter;
}

async function getValuesFromSheet(sheet, criteria, returnColumns, offset = null) {
    const results = [];
    try {
        await sheet.loadHeaderRow(1); 
        const rows = await sheet.getRows(); 
        for (const row of rows) {
            let isMatch = true;
            for (const key in criteria) {
                const rowValue = row.get(key);
                if (!(rowValue !== undefined && rowValue !== null && String(rowValue).trim().toLowerCase() == String(criteria[key]).trim().toLowerCase())) {
                    isMatch = false; break;
                }
            }
            if (isMatch) {
                const rowResult = {};
                for (const colHeader of returnColumns) {
                    rowResult[colHeader] = row.get(colHeader);
                }
                if (offset?.column && typeof offset.rows === "number") {
                    const offsetColIndex = sheet.headerValues.indexOf(offset.column);
                    if (offsetColIndex !== -1) {
                        const targetRowIndex = row.rowIndex + offset.rows;
                        if (targetRowIndex > 1 && targetRowIndex <= sheet.rowCount) {
                            const offsetColLetter = getColLetter(offsetColIndex);
                            const offsetCellA1 = `${offsetColLetter}${targetRowIndex}`;
                            try {
                                await sheet.loadCells(offsetCellA1);
                                rowResult["_offsetValue"] = sheet.getCellByA1(offsetCellA1).value;
                            } catch (offsetError) {
                                console.error(`[ERRO getValuesFromSheet] Falha ao carregar/ler célula de offset ${offsetCellA1}:`, offsetError);
                                rowResult["_offsetValue"] = null;
                            }
                        } else { rowResult["_offsetValue"] = null; }
                    } else { console.warn(`[AVISO getValuesFromSheet] Coluna de offset "${offset.column}" não encontrada.`); rowResult["_offsetValue"] = null; }
                }
                results.push(rowResult);
            }
        }
    } catch (error) { console.error(`[ERRO getValuesFromSheet] Falha ao buscar valores:`, error); }
    return results;
}

async function setValuesInSheet(sheet, criteria, valuesToSet) {
    try {
        await sheet.loadHeaderRow(1);
        const allHeaders = [...Object.keys(criteria), ...Object.keys(valuesToSet)];
        const colIndices = {}; const colsToLoadIndices = [];
        for (const header of allHeaders) {
            const index = sheet.headerValues.indexOf(header);
            if (index === -1) { console.error(`[ERRO setValuesInSheet] Coluna "${header}" não encontrada na aba "${sheet.title}".`); return false; }
            colIndices[header] = index; colsToLoadIndices.push(index);
        }
        if (colsToLoadIndices.length === 0) return true;
        const minCol = Math.min(...colsToLoadIndices); const maxCol = Math.max(...colsToLoadIndices);
        await sheet.loadCells({ startRowIndex: 1, endRowIndex: sheet.rowCount, startColumnIndex: minCol, endColumnIndex: maxCol + 1 });
        let rowFound = false; const cellsToSave = [];
        for (let rowIndex = 1; rowIndex < sheet.rowCount; rowIndex++) {
            let isMatch = true;
            for (const header in criteria) {
                const cellValue = sheet.getCell(rowIndex, colIndices[header]).value;
                if (!(cellValue !== undefined && cellValue !== null && String(cellValue).trim().toLowerCase() == String(criteria[header]).trim().toLowerCase())) { isMatch = false; break; }
            }
            if (isMatch) {
                rowFound = true;
                for (const header in valuesToSet) {
                    const targetCell = sheet.getCell(rowIndex, colIndices[header]);
                    const newValue = valuesToSet[header];
                    const valueToSet = (newValue === "" || newValue === undefined || newValue === null) ? null : newValue;
                    if (String(targetCell.value) !== String(valueToSet)) { targetCell.value = valueToSet; cellsToSave.push(targetCell); }
                }
                break;
            }
        }
        if (!rowFound) { console.warn(`[AVISO setValuesInSheet] Nenhuma linha encontrada para os critérios na aba "${sheet.title}".`); return false; }
        if (cellsToSave.length > 0) { await sheet.saveUpdatedCells(cellsToSave); console.log(`[INFO setValuesInSheet] ${cellsToSave.length} célula(s) atualizada(s) para os critérios na aba "${sheet.title}".`); }
        else { console.log(`[INFO setValuesInSheet] Nenhum valor precisou ser alterado para os critérios na aba "${sheet.title}".`); }
        return true;
    } catch (error) { console.error(`[ERRO setValuesInSheet] Falha ao definir valores:`, error); return false; }
}

async function clearValuesInSheet(sheet, criteria, columnsToClear) {
    const valuesToSetNull = columnsToClear.reduce((acc, header) => { acc[header] = null; return acc; }, {});
    return await setValuesInSheet(sheet, criteria, valuesToSetNull);
}


// +++ FIM DAS FUNÇÕES GENÉRICAS +++

async function preloadInventoryEmbedData() {
    try {
        console.log("[INFO Google] Pré-carregando dados para embeds de inventário...");
        await docSorteio.loadInfo();
        const sheetTokens = docSorteio.sheetsByTitle["Tokens"];
        await sheetTokens.loadHeaderRow(1); const rowsTokens = await sheetTokens.getRows();
        const tokenDataMap = new Map(rowsTokens.map((r) => [String(r.get("Nome")).trim().toLowerCase(), parseInt(r.get("Saldo")) || 0]));
        const sheetChars = docSorteio.sheetsByTitle["Personagens"];
        await sheetChars.loadHeaderRow(2); const rowsChars = await sheetChars.getRows();
        const charDataMap = new Map(rowsChars.map((r) => { const key = `${String(r.get("Nome")).trim().toLowerCase()}-${String(r.get("Personagem")).trim().toLowerCase()}`; return [key, { level: parseInt(r.get("Level")) || 1, mesas: parseInt(r.get("Mesas Jogadas")) || 0 }]; }));
        const sheetXP = docSorteio.sheetsByTitle["Player ID"];
        await sheetXP.loadHeaderRow(1); const nivelColIndex = sheetXP.headerValues.indexOf("Nível"); const totalColIndex = sheetXP.headerValues.indexOf("Total");
        if (nivelColIndex === -1 || totalColIndex === -1) throw new Error("Colunas 'Nível' ou 'Total' não encontradas em Player ID.");
        await sheetXP.loadCells({ startRowIndex: 1, endRowIndex: sheetXP.rowCount, startColumnIndex: Math.min(nivelColIndex, totalColIndex), endColumnIndex: Math.max(nivelColIndex, totalColIndex) + 1 });
        const xpDataMap = new Map(); xpDataMap.set(1, 0);
        for (let i = 1; i < sheetXP.rowCount; i++) {
            const nivelCell = sheetXP.getCell(i, nivelColIndex); const level = parseInt(nivelCell.value);
            if (!isNaN(level) && level > 1) {
                if (i - 1 >= 1) { const totalCellPrevious = sheetXP.getCell(i - 1, totalColIndex); const mesasParaUpar = parseInt(totalCellPrevious.value) || 0; xpDataMap.set(level, mesasParaUpar); }
                else { xpDataMap.set(level, 0); console.warn(`[preloadInventoryEmbedData] Estado inesperado para level ${level} na linha ${i + 1}.`); }
            }
        }
        console.log("[INFO Google] Dados de embed pré-carregados."); return { tokenDataMap, charDataMap, xpDataMap };
    } catch (e) { console.error("[ERRO preloadInventoryEmbedData] Falha ao carregar dados de embed:", e); return null; }
}
function getPlayerTokenCountFromData(playerTag, tokenDataMap) {
    if (!playerTag || !tokenDataMap) return 0;
    return tokenDataMap.get(String(playerTag).trim().toLowerCase()) || 0;
}

// --- 6. EXPORTAÇÕES ---
module.exports = {
  docSorteio,
  docControle,
  docInventario,
  docCraft,
  docComprasVendas,
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
  incrementarMesasMestradas,
  preloadInventoryEmbedData,
  getPlayerTokenCountFromData,
  getValuesFromSheet,
  setValuesInSheet,
  clearValuesInSheet
};