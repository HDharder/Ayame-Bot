// utils/inventarioUtils.js
const { EmbedBuilder, codeBlock } = require('discord.js');

// MUDANÇA 1: Importamos o módulo inteiro 'google' em vez de destrutar 'sheets' agora.
// Isso evita que 'sheets' seja undefined se houver dependência circular.
const google = require('./google.js'); 

/**
 * Busca todas as linhas de personagem de um jogador na aba "Inventário".
 * @param {string} username - Username do jogador (ex: hdharder).
 * @returns {Promise<Array<import('google-spreadsheet').GoogleSpreadsheetRow>>}
 */
async function findUserCharacters(username) {
    if (!username) return [];
    try {
        // MUDANÇA 2: Acessamos google.sheets aqui dentro.
        // CORREÇÃO: Corrigido o typo 'docInventaio' para 'docInventario'
        await google.sheets.docInventario.loadInfo();
        const sheet = google.sheets.docInventario.sheetsByTitle['Inventário'];
        if (!sheet) throw new Error("Aba 'Inventário' não encontrada.");
        await sheet.loadHeaderRow(1);
        const rows = await sheet.getRows();
        
        // Filtra todas as linhas que pertencem ao username (ignorando maiúsculas/minúsculas)
        const userRows = rows.filter(row => {
            const rowPlayer = row.get('JOGADOR');
            return rowPlayer && String(rowPlayer).trim().toLowerCase() === username.trim().toLowerCase();
        });
        return userRows;
    } catch (e) {
        console.error(`[ERRO findUserCharacters] Falha ao buscar personagens para ${username}:`, e);
        return [];
    }
}

/**
 * Encontra o dono e a linha correspondente de um canal de inventário.
 * @param {string} channelId - ID do canal do Discord.
 * @returns {Promise<{owner: string, characterRow: import('google-spreadsheet').GoogleSpreadsheetRow}|null>} - O username do dono e a linha da planilha, ou null.
 */
async function getChannelOwner(channelId) {
    if (!channelId) return null;
    try {
        // CORREÇÃO: Corrigido o typo 'docInventaio' para 'docInventario' e usado google.sheets
        await google.sheets.docInventario.loadInfo();
        const sheet = google.sheets.docInventario.sheetsByTitle['Inventário'];
        if (!sheet) throw new Error("Aba 'Inventário' não encontrada.");
        await sheet.loadHeaderRow(1);
        
        // Precisamos das linhas (getRows) para retornar o objeto 'row'
        const rows = await sheet.getRows();

        // Carrega as colunas "JOGADOR" e "Inv ID"
        const playerColIndex = sheet.headerValues.indexOf('JOGADOR');
        const invIdColIndex = sheet.headerValues.indexOf('Inv ID');
        if (playerColIndex === -1 || invIdColIndex === -1) {
            console.warn("[AVISO getChannelOwner] Colunas 'JOGADOR' ou 'Inv ID' não encontradas.");
            return null; // Não é um erro fatal, talvez a coluna não exista ainda
        }
        // Carrega APENAS a coluna 'Inv ID' para otimização
        await sheet.loadCells({
            startRowIndex: 1, endRowIndex: sheet.rowCount,
            startColumnIndex: invIdColIndex,
            endColumnIndex: invIdColIndex + 1
        });

        // Itera pelas linhas que já temos de getRows
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            // Usa getCell apenas para ler o valor carregado
            const invIdCell = sheet.getCell(i + 1, invIdColIndex); // i + 1 porque getCell é 0-based nas linhas de dados
            if (invIdCell.value === channelId) {
                const owner = row.get('JOGADOR'); // Pega o nome do objeto row
                return { owner, characterRow: row }; // Retorna o nome e a linha inteira
            }
        }

        return null; // Canal não encontrado/registrado
    } catch (e) {
        console.error(`[ERRO getChannelOwner] Falha ao verificar dono do canal ${channelId}:`, e);
        return null;
    }
}

/**
 * Tenta apagar uma mensagem antiga de forma segura.
 * @param {import('discord.js').Client} client - O cliente Discord.
 * @param {string} oldChannelId - O ID do canal onde a mensagem estava.
 * @param {string} oldMessageId - O ID da mensagem a apagar.
 */
async function deleteOldMessage(client, oldChannelId, oldMessageId) {
    if (!oldChannelId || !oldMessageId) return;
    try {
        const channel = await client.channels.fetch(oldChannelId);
        if (channel && channel.isTextBased()) {
            const message = await channel.messages.fetch(oldMessageId);
            await message.delete();
            console.log(`[INFO deleteOldMessage] Mensagem antiga ${oldMessageId} apagada do canal ${oldChannelId}.`);
        }
    } catch (error) {
        // Ignora erro se a mensagem ou canal já não existir (10003, 10008)
        if (error.code !== 10003 && error.code !== 10008) {
            console.error(`[ERRO deleteOldMessage] Falha ao apagar msg ${oldMessageId} no canal ${oldChannelId}:`, error);
        }
    }
}

/**
 * Registra um canal para um personagem.
 */
async function registerChannel(selectedCharacterRow, allPlayerCharacters, channelId, messageId, client) {
    try {
        const username = selectedCharacterRow.get('JOGADOR'); //
        const selectedCharName = selectedCharacterRow.get('PERSONAGEM');

        // CORREÇÃO: google.sheets.docInventario
        await google.sheets.docInventario.loadInfo(); 
        const sheet = google.sheets.docInventario.sheetsByTitle['Inventário']; 
        if (!sheet) throw new Error("Aba 'Inventário' não encontrada em registerChannel.");
        
        const playerRows = allPlayerCharacters; 

        const messagesToDelete = []; 

        // Itera pelas linhas do jogador
        for (const row of playerRows) {
            const currentCharName = row.get('PERSONAGEM');
            const criteria = { 'JOGADOR': username, 'PERSONAGEM': currentCharName }; 
            
            // CORREÇÃO: google.getValuesFromSheet
            const oldValuesResult = await google.getValuesFromSheet(sheet, criteria, ['Inv ID', 'Msg ID']);
            const oldValues = oldValuesResult.length > 0 ? oldValuesResult[0] : { 'Inv ID': null, 'Msg ID': null };
            const oldChannelId = oldValues['Inv ID'];
            const oldMessageId = oldValues['Msg ID'];

            // Verifica se é a linha do personagem selecionado
            if (currentCharName === selectedCharName) {
                let channelChanged = false;
                const valuesToUpdate = {}; 
                if (oldChannelId !== channelId) {
                    valuesToUpdate['Inv ID'] = channelId;
                    channelChanged = true;
                    if (oldChannelId && oldMessageId) {
                         messagesToDelete.push({ channelId: oldChannelId, messageId: oldMessageId });
                    }
                }
                if (oldMessageId !== messageId) {
                    if(oldMessageId && !channelChanged) { 
                         messagesToDelete.push({ channelId: channelId, messageId: oldMessageId });
                    }
                    valuesToUpdate['Msg ID'] = messageId;
                }
                if (Object.keys(valuesToUpdate).length > 0) {
                    // CORREÇÃO: google.setValuesInSheet
                    await google.setValuesInSheet(sheet, criteria, valuesToUpdate);
                }
            } else { // Outra linha do mesmo jogador
                if (oldChannelId === channelId) {
                    console.log(`[INFO registerChannel] Canal ${channelId} estava com ${currentCharName}, limpando registo antigo.`);
                    const columnsToClear = [];
                    if (oldChannelId) columnsToClear.push('Inv ID');
                    if (oldMessageId) columnsToClear.push('Msg ID');
                    if (columnsToClear.length > 0) {
                        // CORREÇÃO: google.clearValuesInSheet
                        await google.clearValuesInSheet(sheet, criteria, columnsToClear);
                    }
                    if (oldChannelId && oldMessageId) {
                        messagesToDelete.push({ channelId: oldChannelId, messageId: oldMessageId });
                    }
                }
            }
        }

        const uniqueMessagesToDelete = [...new Map(messagesToDelete.map(item => [`${item.channelId}-${item.messageId}`, item])).values()];
        for (const msg of uniqueMessagesToDelete) {
            await deleteOldMessage(client, msg.channelId, msg.messageId); 
        }

        console.log(`[INFO registerChannel] Canal ${channelId} / Msg ${messageId} registrado para ${username}.`);
    } catch (e) {
        console.error(`[ERRO registerChannel] Falha ao registrar canal:`, e);
    }
}

/**
 * (Modo Lento) Calcula Nível e Q.Mesas (ex: "5 / 2").
 */
async function getLevelProgress(characterRow) {
    try {
        const charName = characterRow.get('PERSONAGEM');
        const username = characterRow.get('JOGADOR');

        // CORREÇÃO: google.sheets.docSorteio
        await google.sheets.docSorteio.loadInfo();
        const charSheet = google.sheets.docSorteio.sheetsByTitle['Personagens'];
        const xpSheet = google.sheets.docSorteio.sheetsByTitle['Player ID'];
        if (!charSheet || !xpSheet) throw new Error(`Abas Personagens ou Player ID não encontradas.`);

        await charSheet.loadHeaderRow(2);
        const charRows = await charSheet.getRows();
        const charRow = charRows.find(r =>
            r.get('Nome') && r.get('Personagem') &&
            String(r.get('Nome')).trim().toLowerCase() === username.trim().toLowerCase() &&
            String(r.get('Personagem')).trim().toLowerCase() === charName.trim().toLowerCase()
        );
        
        if (!charRow) {
            throw new Error(`Personagem ${charName} (Jogador: ${username}) não foi encontrado na aba 'Personagens'.`);
        }

        const level = parseInt(charRow.get('Level'));
        const totalMesas = parseInt(charRow.get('Mesas Jogadas'));

        if (isNaN(level) || isNaN(totalMesas)) {
            throw new Error(`'Level' ou 'Mesas Jogadas' é inválido na aba 'Personagens'.`);
        }
        
        await xpSheet.loadHeaderRow(1);
        
        const nivelColIndex = xpSheet.headerValues.indexOf('Nível');
        const totalColIndex = xpSheet.headerValues.indexOf('Total');
        if (nivelColIndex === -1 || totalColIndex === -1) throw new Error("Colunas 'Nível' ou 'Total' não encontradas em Player ID.");

        await xpSheet.loadCells({
            startRowIndex: 1, endRowIndex: xpSheet.rowCount,
            startColumnIndex: Math.min(nivelColIndex, totalColIndex), 
            endColumnIndex: Math.max(nivelColIndex, totalColIndex) + 1
        });

        let mesasParaUpar = 0;
        if (level === 1) {
            mesasParaUpar = 0; 
        } else {
            for (let i = 1; i < xpSheet.rowCount; i++) {
                const nivelCell = xpSheet.getCell(i, nivelColIndex);
                if (nivelCell.value == level) { 
                    const mesasCell = xpSheet.getCell(i - 1, totalColIndex); 
                    mesasParaUpar = parseInt(mesasCell.value) || 0;
                    break;
                }
            }
        }
        
        const mesasNoNivel = totalMesas - mesasParaUpar;
        return `${level} / ${mesasNoNivel}`;

    } catch (e) {
        console.error(`[ERRO getLevelProgress] Falha ao calcular Nível/Q.Mesas para ${characterRow.get('PERSONAGEM')}:`, e);
        return "Nível ? / ?";
    }
}

/**
 * (Modo Rápido) Calcula Nível e Q.Mesas (ex: "5 / 2").
 */
function getLevelProgressFromData(characterRow, embedData) {
    try {
        const charName = characterRow.get('PERSONAGEM');
        const username = characterRow.get('JOGADOR');
        const { charDataMap, xpDataMap } = embedData;

        if (!charDataMap || !xpDataMap) {
            throw new Error("Dados de embed (charDataMap, xpDataMap) não fornecidos.");
        }

        const charKey = `${username.trim().toLowerCase()}-${charName.trim().toLowerCase()}`;
        const charData = charDataMap.get(charKey);

        if (!charData) {
            throw new Error(`Personagem ${charName} (Jogador: ${username}) não foi encontrado no charDataMap.`);
        }

        const level = charData.level;
        const totalMesas = charData.mesas;
        const mesasParaUpar = xpDataMap.get(level) || 0;
        
        const mesasNoNivel = totalMesas - mesasParaUpar;
        return `${level} / ${mesasNoNivel}`;

    } catch (e) {
        console.error(`[ERRO getLevelProgressFromData] Falha ao calcular Nível/Q.Mesas para ${characterRow.get('PERSONAGEM')}:`, e);
        return "Nível ? / ?";
    }
}

/**
 * Constrói o Embed principal do inventário.
 */
async function buildInventoryEmbed(characterRow, embedData = null) {
    const username = characterRow.get('JOGADOR');
    const charName = characterRow.get('PERSONAGEM');
    
    let tokenCount;
    let levelProgress;

    if (embedData) {
        // CORREÇÃO: google.getPlayerTokenCountFromData
        tokenCount = google.getPlayerTokenCountFromData(username, embedData.tokenDataMap);
        levelProgress = getLevelProgressFromData(characterRow, embedData);
    } else {
        console.warn(`[AVISO buildInventoryEmbed] Executando em modo de fallback (lento) para ${charName}.`);
        const [tokens, progress] = await Promise.all([
            // CORREÇÃO: google.getPlayerTokenCount
            google.getPlayerTokenCount(username), 
            getLevelProgress(characterRow)
        ]);
        tokenCount = tokens;
        levelProgress = progress;
    }

    const totalGold = parseFloat(characterRow.get('Total')) || 0;
    const gp = Math.floor(totalGold);
    const pp = Math.floor((totalGold * 10) % 10);
    const pc = Math.floor((totalGold * 100) % 10);
    const goldString = `${gp} GP | ${pp} PP | ${pc} PC`;

    const embed = new EmbedBuilder()
        .setTitle(charName)
        .setDescription(levelProgress)
        .setColor(0xDAA520) 
        .addFields(
            { name: "Gold", value: goldString, inline: true },
            { name: "Tokens", value: `${tokenCount} 🎟️`, inline: true }
        )
        .setTimestamp()
        .setFooter({ text: `Inventário de ${username}` });

    const itemFields = [
        { name: "Itens Mundanos", value: characterRow.get('Itens Mundanos') },
        { name: "Armas", value: characterRow.get('Armas') },
        { name: "Armaduras e Escudos", value: characterRow.get('Escudos/Armaduras') },
        { name: "Consumíveis Mágicos", value: characterRow.get('Consumíveis Mágicos') },
        { name: "Itens Mágicos", value: characterRow.get('Itens Mágicos') },
        { name: "Materiais", value: characterRow.get('Materiais') },
        { name: "Ervas", value: characterRow.get('Ervas') },
        { name: "Misc", value: characterRow.get('Misc') }
    ];

    for (const field of itemFields) {
        const content = field.value;
        if (content && String(content).trim() !== '' && String(content).trim() !== '0') {
            embed.addFields({
                name: field.name,
                value: codeBlock(String(content).trim())
            });
        }
    }
    
    return embed;
}

module.exports = {
    findUserCharacters,
    getChannelOwner,
    registerChannel,
    buildInventoryEmbed,
    getLevelProgress,
    getLevelProgressFromData,
    deleteOldMessage
};