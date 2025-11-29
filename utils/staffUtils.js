// utils/staffUtils.js
const { sheets } = require('./google.js'); //
const { batchUpdateInventories } = require('./inventoryManager.js'); //
const { parseItemInput } = require('./itemUtils.js'); //
//const { setValuesInSheet } = require('./google.js'); //
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms)); //

/**
 * (Helper) Pega a data de "hoje" (com offset) e formata como dd/mm/aaaa.
 * @returns {string}
 */
function getTodayDate() {
    const now = new Date();
    const horaOffset = parseInt(process.env.DIFERENCA_HORA) || 0; //
    const localOffsetInMs = now.getTimezoneOffset() * 60 * 1000;
    const utcTime = now.getTime() + localOffsetInMs;
    const targetOffsetInMs = horaOffset * 60 * 60 * 1000;
    const adjustedDate = new Date(utcTime + targetOffsetInMs);

    // Formata para dd/mm/aaaa (sem hora)
    return adjustedDate.toLocaleDateString('pt-BR', {
        day: '2-digit', month: '2-digit', year: '2-digit'
    });
}

/**
 * Busca as estatísticas do servidor nas planilhas.
 * @returns {Promise<object>}
 */
async function fetchServerStats() {
    let playerCount = 0;
    let characterCount = 0;
    let maxLevel = 0;
    let tablesThisWeek = 0;
    
    try {
        // --- 1. Dados da "Personagens" (docSorteio) ---
        await sheets.docSorteio.loadInfo(); //
        const sheetChars = sheets.docSorteio.sheetsByTitle['Personagens']; //
        if (sheetChars) {
            await sheetChars.loadHeaderRow(2); // Header na linha 2
            const rows = await sheetChars.getRows();
            
            const playerNames = new Set(rows.map(r => r.get('Nome')));
            playerCount = playerNames.size;
            characterCount = rows.length;
            maxLevel = Math.max(...rows.map(r => parseInt(r.get('Level')) || 0));

            // --- 2. Mesas da Semana (lógica do /registrar-mesa) ---
            await sheetChars.loadCells('B1');
            const cellB1 = sheetChars.getCellByA1('B1'); //
            const weekOffset = parseInt(cellB1.value) || 0;
            const weekColIndex = 4 + weekOffset; // Coluna E (índice 4) + offset
            
            if (weekColIndex < sheetChars.columnCount) {
                const weekColHeader = sheetChars.headerValues[weekColIndex];
                rows.forEach(r => {
                    tablesThisWeek += parseInt(r.get(weekColHeader)) || 0;
                });
            }
        }
    } catch (e) {
        console.error("[ERRO fetchServerStats]", e.message);
    }
    
    return { playerCount, characterCount, maxLevel, tablesThisWeek };
}

/**
 * Verifica o estado da Caravana Bastião.
 * @returns {Promise<object>}
 */
async function fetchCaravanStatus() {
    try {
        await sheets.docComprasVendas.loadInfo(); //
        const sheet = sheets.docComprasVendas.sheetsByTitle['Caravana Bastião']; //
        if (!sheet) throw new Error("Aba 'Caravana Bastião' não encontrada.");

        await sheet.loadCells('H1:N1');
        const futureDate = sheet.getCellByA1('H1').formattedValue || 'N/D'; //
        const arrivalDate = sheet.getCellByA1('K1').formattedValue || 'N/D';
        const lastDelivery = sheet.getCellByA1('N1').formattedValue || 'N/D';
        const today = getTodayDate();

        if (arrivalDate === today && lastDelivery !== today) {
            return { status: 'READY', text: `A caravana chegou hoje (${arrivalDate})! Clique abaixo para distribuir.` };
        }
        if (arrivalDate === today && lastDelivery === today) {
            return { status: 'DELIVERED', text: `A caravana de hoje (${arrivalDate}) já foi entregue.` };
        }
        
        return { status: 'PENDING', text: `A próxima caravana está prevista para ${futureDate}.` };

    } catch (e) {
        console.error("[ERRO fetchCaravanStatus]", e.message);
        return { status: 'ERROR', text: 'Não foi possível verificar o estado da caravana.' };
    }
}

/**
 * Processa a distribuição dos itens da caravana.
 * @param {import('discord.js').Client} client
 * @returns {Promise<{success: boolean, message: string}>}
 */
async function processCaravanDistribution(client) {
    try {
        await sheets.docComprasVendas.loadInfo(); //
        const sheet = sheets.docComprasVendas.sheetsByTitle['Caravana Bastião']; //
        if (!sheet) throw new Error("Aba 'Caravana Bastião' não encontrada.");

        await sheet.loadHeaderRow(1);
        const rows = await sheet.getRows();
        if (rows.length === 0) {
            return { success: false, message: "A caravana estava vazia. Nada a fazer." };
        }

        const payloadMap = new Map();
        let totalItemsProcessed = 0;

        // 1. Agregar todos os itens para todos os jogadores
        for (const row of rows) {
            const username = row.get('Jogador');
            const characterName = row.get('Personagem');
            const comprasString = row.get('Compras'); // "2x Dagger, 1x Potion"
            
            if (!username || !characterName || !comprasString) continue;

            // Reutiliza o parser de itens
            const items = parseItemInput(comprasString, true); 
            totalItemsProcessed += items.reduce((sum, item) => sum + item.amount, 0);

            const key = `${username}-${characterName}`;
            const payload = payloadMap.get(key) || {
                username: username,
                characterName: characterName,
                changes: { gold: 0, itemsToAdd: [] }
            };

            payload.changes.itemsToAdd.push(...items);
            payloadMap.set(key, payload);
        }

        if (payloadMap.size === 0) {
            return { success: false, message: "Nenhum item válido encontrado na caravana." };
        }
        
        const payloadArray = Array.from(payloadMap.values());

        // 2. Chamar o BatchUpdate
        const success = await batchUpdateInventories(payloadArray, client); //
        if (!success) {
            throw new Error("Falha no batchUpdateInventories. Os inventários podem não ter sido atualizados.");
        }

        // 3. Limpar a planilha (apaga as linhas processadas)
        await sheet.clearRows(); // Limpa todos os dados exceto cabeçalhos
        
        // 4. Salvar a data da entrega em H3
        const today = getTodayDate();
        // +++ CORREÇÃO: Usa o método direto para salvar uma única célula +++
        await sheet.loadCells('H3');
        const cellH3 = sheet.getCellByA1('H3');
        cellH3.value = today;
        await sheet.saveUpdatedCells([cellH3]);

        return { 
            success: true, 
            message: `Caravana distribuída com sucesso! ${totalItemsProcessed} itens foram entregues a ${payloadMap.size} personagens.` 
        };

    } catch (e) {
        console.error("[ERRO processCaravanDistribution]", e.message);
        return { success: false, message: `Ocorreu um erro: ${e.message}` };
    }
}
/*
// (Helper para o setValuesInSheet em H3)
// A função setValuesInSheet não foi feita para células únicas sem critério.
// Esta é uma solução alternativa rápida para o H3.
async function setValuesInSheet(sheet, criteria, valuesToSet, isSingleCellHack = false) {
    if (isSingleCellHack) {
        try {
            const cellA1 = Object.keys(valuesToSet)[0];
            await sheet.loadCells(cellA1);
            const cell = sheet.getCellByA1(cellA1);
            cell.value = valuesToSet[cellA1];
            await sheet.saveUpdatedCells([cell]);
            return true;
        } catch (e) {
             console.error(`[ERRO setValues (Hack)] Falha ao definir ${Object.keys(valuesToSet)[0]}:`, e);
            return false;
        }
    }
    // ... (Aqui iria a sua lógica normal do setValuesInSheet do google.js)
    // Como estamos no utils/staffUtils.js, vamos assumir que o setValuesInSheet normal está no google.js
    // Esta função hacky é *apenas* para este arquivo.
}*/


module.exports = {
    fetchServerStats,
    fetchCaravanStatus,
    processCaravanDistribution
};