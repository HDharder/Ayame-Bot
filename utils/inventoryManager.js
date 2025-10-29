// utils/inventoryManager.js
const { docInventario, docCraft, getValuesFromSheet, setValuesInSheet } = require('./google.js');
const itemUtils = require('./itemUtils.js');
// Importa buildInventoryEmbed e as novas funções de pré-carregamento
const { buildInventoryEmbed } = require('./inventarioUtils.js');
const { preloadInventoryEmbedData } = require('./google.js');
const { preloadItemCategories } = require('./itemUtils.js');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms)); // Helper delay function

/**
 * Atualiza EM LOTE os inventários de múltiplos personagens na planilha e no Discord.
 * @param {Array<object>} allPlayerChanges - Array de objetos de alteração.
 * Formato: [{ username, characterName, changes: { gold, itemsToAdd } }]
 * @param {import('discord.js').Client} client - O cliente Discord para atualizar as mensagens.
 * @returns {Promise<boolean>} - True se a atualização da PLANILHA foi bem-sucedida.
 */
async function batchUpdateInventories(allPlayerChanges, client) {
    if (!allPlayerChanges || allPlayerChanges.length === 0) return true;

    let sheetUpdateSuccess = true;
    const rowsToSave = [];
    const discordMessagesToUpdate = [];

    try {
        // 1. PRÉ-CARREGAR TUDO (APENAS LEITURAS)
        // Carrega dados para construir embeds (Tokens, Níveis, XP)
        const embedData = await preloadInventoryEmbedData();
        if (!embedData) {
            console.error("[ERRO BatchUpdate] Falha no preloadInventoryEmbedData. Abortando atualização de inventários.");
            return false; // Aborta se não conseguiu carregar dados essenciais
        }
        // Carrega todas as categorias de itens para o cache
        await preloadItemCategories(docCraft);
        
        // Carrega a planilha de Inventário UMA VEZ
        await docInventario.loadInfo();
        const sheet = docInventario.sheetsByTitle['Inventário'];
        if (!sheet) throw new Error("Aba 'Inventário' não encontrada.");
        
        // Pega todas as linhas da planilha UMA VEZ
        await sheet.loadHeaderRow(1); // Garante headers
        const allRows = await sheet.getRows();
        
        // Cria um Map para acesso rápido às linhas
        const playerRowMap = new Map();
        for (const row of allRows) {
            const key = `${String(row.get('JOGADOR')).trim().toLowerCase()}-${String(row.get('PERSONAGEM')).trim().toLowerCase()}`;
            playerRowMap.set(key, row);
        }

        console.log(`[INFO BatchUpdate] Map de inventário criado com ${playerRowMap.size} registos.`);

        // 2. PROCESSAR ALTERAÇÕES (EM MEMÓRIA)
        for (const playerChange of allPlayerChanges) {
            const { username, characterName, changes } = playerChange;
            const { gold = 0, itemsToAdd = [] } = changes;
            
            const rowKey = `${username.trim().toLowerCase()}-${characterName.trim().toLowerCase()}`;
            const row = playerRowMap.get(rowKey);

            // Se não encontrou a linha do jogador na planilha, regista o erro e pula
            if (!row) {
                console.error(`[ERRO BatchUpdate] Não foi possível encontrar a linha "Inventário" para ${username} - ${characterName}. Pulando...`);
                sheetUpdateSuccess = false; // Marca falha parcial
                continue;
            }

            let rowChanged = false;

            // --- Processa Gold (em memória) ---
            if (gold !== 0) {
                const currentTotal = parseFloat(row.get('Total')) || 0;
                const newTotal = parseFloat((currentTotal + gold).toFixed(2));
                row.set('Total', newTotal); // Atualiza o objeto 'row'
            }

            // --- Processa Itens (em memória) ---
            const itemChangesByCat = new Map();
            for (const item of itemsToAdd) {
                // Usa o cache (síncrono, pois já pré-carregamos)
                const category = await itemUtils.getItemCategory(item.name, docCraft); 
                if (!category) {
                    console.error(`[ERRO BatchUpdate] Categoria não encontrada no cache para "${item.name}". Pulando item.`);
                    sheetUpdateSuccess = false;
                    continue;
                }
                if (!itemChangesByCat.has(category)) itemChangesByCat.set(category, new Map());
                const catMap = itemChangesByCat.get(category);
                const lowerName = item.name.toLowerCase();
                catMap.set(lowerName, (catMap.get(lowerName) || 0) + item.amount);
            }

            for (const [category, changesMap] of itemChangesByCat.entries()) {
                const currentString = row.get(category) || '';
                const currentItemMap = itemUtils.parseInventoryString(currentString);
                
                for (const [lowerName, amountToAdd] of changesMap.entries()) {
                    const currentData = currentItemMap.get(lowerName);
                    const currentAmount = currentData ? currentData.amount : 0;
                    const newAmount = currentAmount + amountToAdd;
                    
                    // Encontra o nome original (preservando maiúsculas/minúsculas)
                    const originalName = itemsToAdd.find(i => i.name.toLowerCase() === lowerName)?.name || lowerName;
                    
                    if (newAmount > 0) {
                        currentItemMap.set(lowerName, { name: originalName, amount: newAmount });
                    }
                }
                
                const newString = itemUtils.formatInventoryString(currentItemMap);
                row.set(category, newString); // Atualiza o objeto 'row'
            }
            
            // Adiciona a linha modificada ao lote para salvar
            if (rowChanged) {
                rowsToSave.push(row); // Adiciona o objeto Row modificado
            }

            // --- Prepara atualização do Discord ---
            const channelId = row.get('Inv ID');
            const msgId = row.get('Msg ID');
            
            if (channelId && msgId && embedData) {
                // Reconstrói o embed USANDO OS DADOS PRÉ-CARREGADOS
                const newEmbed = await buildInventoryEmbed(row, embedData); 
                discordMessagesToUpdate.push({ channelId, msgId, newEmbed, charName: characterName });
            }
        }

        // 3. SALVAR NA PLANILHA (UMA CHAMADA DE API)
        if (rowsToSave.length > 0) {
            console.log(`[INFO BatchUpdate] Salvando ${rowsToSave.length} linhas de inventário atualizadas...`);
            for (const rowToSave of rowsToSave) {
                try {
                    await rowToSave.save(); // <<< Chama .save() para cada Row modificada
                    console.log(`[INFO BatchUpdate] Linha para ${rowToSave.get('JOGADOR')} - ${rowToSave.get('PERSONAGEM')} salva.`);
                    await delay(1000); // <<< Espera 1 segundo entre cada save
                } catch (saveError) {
                    console.error(`[ERRO BatchUpdate] Falha ao salvar linha para ${rowToSave.get('JOGADOR')} - ${rowToSave.get('PERSONAGEM')}:`, saveError);
                    sheetUpdateSuccess = false; // Marca falha se UM save falhar
                    // Continua tentando salvar as outras linhas
                }
            }
            if(sheetUpdateSuccess) console.log("[INFO BatchUpdate] Todas as linhas foram processadas para salvar.");
            else console.warn("[WARN BatchUpdate] Falha ao salvar uma ou mais linhas.");
        } else {
            console.log("[INFO BatchUpdate] Nenhuma linha precisou ser salva.");
        }

        // 4. ATUALIZAR MENSAGENS NO DISCORD (Várias chamadas, mas para o Discord)
        if (discordMessagesToUpdate.length > 0) {
            console.log(`[INFO BatchUpdate] Atualizando ${discordMessagesToUpdate.length} mensagens no Discord...`);
            for (const update of discordMessagesToUpdate) {
                try {
                    const channel = await client.channels.fetch(update.channelId);
                    if (channel && channel.isTextBased()) {
                        const message = await channel.messages.fetch(update.msgId);
                        await message.edit({ embeds: [update.newEmbed] });
                        console.log(`[INFO BatchUpdate] Mensagem ${update.msgId} atualizada para ${update.charName}.`);
                    }
                } catch (e) {
                    if (e.code !== 10003 && e.code !== 10008) { // Ignora msg/canal não encontrado
                        console.error(`[ERRO BatchUpdate] Falha ao atualizar msg Discord ${update.msgId} para ${update.charName}:`, e);
                    }
                }
            }
        }

        return sheetUpdateSuccess; // Retorna true se a escrita na planilha deu certo

    } catch (error) {
        console.error(`[ERRO BatchUpdate] Falha GERAL ao atualizar inventários:`, error);
        return false; // Retorna false em caso de erro grave
    }
}


module.exports = {
    batchUpdateInventories // Exporta a nova função em lote
};