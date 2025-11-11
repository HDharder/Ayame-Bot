// utils/inventoryManager.js
const { docInventario, docCraft, getValuesFromSheet, setValuesInSheet } = require('./google.js');
const itemUtils = require('./itemUtils.js');
const { buildInventoryEmbed } = require('./inventarioUtils.js');
const { preloadInventoryEmbedData } = require('./google.js');
const { preloadItemCategories } = require('./itemUtils.js');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms)); 

/**
 * Atualiza EM LOTE os inventários...
 * @param {Array<object>} allPlayerChanges - Formato: [{ username, characterName, changes: { gold, itemsToAdd } }]
 * 'itemsToAdd' agora é: [{ name: "W+1 [LS]", validationName: "W+1", amount: 1 }]
 */
async function batchUpdateInventories(allPlayerChanges, client) {
    if (!allPlayerChanges || allPlayerChanges.length === 0) return true;

    let sheetUpdateSuccess = true;
    const rowsToSave = []; 
    const discordMessagesToUpdate = [];

    try {
        // 1. PRÉ-CARREGAR TUDO
        const embedData = client.inventoryEmbedData; 
        if (!embedData) {
            // Se o cache estiver vazio (o bot acabou de ligar ou falhou), ele aborta.
            console.error("[ERRO BatchUpdate] O cache 'client.inventoryEmbedData' está nulo. Abortando atualização.");
            return false;
        }
        await preloadItemCategories(docCraft);
        
        await docInventario.loadInfo();
        const sheet = docInventario.sheetsByTitle['Inventário'];
        if (!sheet) throw new Error("Aba 'Inventário' não encontrada.");
        await sheet.loadHeaderRow(1); 
        const allRows = await sheet.getRows();
        
        const playerRowMap = new Map();
        for (const row of allRows) {
            const key = `${String(row.get('JOGADOR')).trim().toLowerCase()}-${String(row.get('PERSONAGEM')).trim().toLowerCase()}`;
            playerRowMap.set(key, row);
        }
        console.log(`[INFO BatchUpdate] Map de inventário criado com ${playerRowMap.size} registos.`);

        // 2. PROCESSAR ALTERAÇÕES
        for (const playerChange of allPlayerChanges) {
            const { username, characterName, changes } = playerChange;
            const { gold = 0, itemsToAdd = [] } = changes;
            
            const rowKey = `${username.trim().toLowerCase()}-${characterName.trim().toLowerCase()}`;
            const row = playerRowMap.get(rowKey); 

            if (!row) {
                 console.error(`[ERRO BatchUpdate] Não foi possível encontrar a linha "Inventário" para ${username} - ${characterName}. Pulando...`);
                 sheetUpdateSuccess = false; 
                 continue;
            }
            let rowChanged = false; 

            // --- Processa Gold ---
            if (gold !== 0) {
                const currentTotal = parseFloat(row.get('Total')) || 0;
                const newTotal = parseFloat((currentTotal + gold).toFixed(2));
                row.set('Total', newTotal); 
                rowChanged = true; 
            }

            // --- Processa Itens ---
            const itemChangesByCat = new Map(); // Map<CategoriaFinal, Array<ItemObject>>
            for (const item of itemsToAdd) {
                // <<< CORRIGIDO: Usa item.validationName para buscar a categoria >>>
                const category = await itemUtils.getItemCategory(item.validationName, docCraft); 
                if (!category) {
                    console.error(`[ERRO BatchUpdate] Categoria não encontrada no cache para "${item.validationName}". Pulando item.`);
                    sheetUpdateSuccess = false;
                    continue;
                }
                if (!itemChangesByCat.has(category)) itemChangesByCat.set(category, []);
                // <<< CORRIGIDO: Salva o item completo (com nome, validationName, amount) >>>
                itemChangesByCat.get(category).push(item);
            }

            for (const [category, newItems] of itemChangesByCat.entries()) {
                const currentString = row.get(category) || '';
                const currentItemMap = itemUtils.parseInventoryString(currentString); // Map<lowerName, {name, amount}>
                
                let categoryChanged = false;
                for (const item of newItems) {
                    // <<< CORRIGIDO: Usa item.name (o nome completo) para salvar >>>
                    const lowerName = item.name.toLowerCase();
                    const currentData = currentItemMap.get(lowerName);
                    const currentAmount = currentData ? currentData.amount : 0;
                    const newAmount = currentAmount + item.amount;
                    
                    if (newAmount > 0) {
                        currentItemMap.set(lowerName, { name: item.name, amount: newAmount });
                    }
                    categoryChanged = true;
                }
                
                if (categoryChanged) {
                    const newString = itemUtils.formatInventoryString(currentItemMap);
                    if (currentString !== newString) {
                         row.set(category, newString); 
                         rowChanged = true; 
                    }
                }
            }
            
            if (rowChanged) {
                 rowsToSave.push(row); 
            }

            // --- Prepara atualização do Discord ---
            const channelId = row.get('Inv ID');
            const msgId = row.get('Msg ID');
            
            if (channelId && msgId && embedData) {
                const newEmbed = await buildInventoryEmbed(row, embedData); 
                discordMessagesToUpdate.push({ channelId, msgId, newEmbed, charName: characterName });
            }
        }

        // 3. SALVAR NA PLANILHA
        if (rowsToSave.length > 0) {
            console.log(`[INFO BatchUpdate] Salvando ${rowsToSave.length} linhas de inventário atualizadas...`);
             for (const rowToSave of rowsToSave) {
                  try {
                      await rowToSave.save(); 
                      console.log(`[INFO BatchUpdate] Linha para ${rowToSave.get('JOGADOR')} - ${rowToSave.get('PERSONAGEM')} salva.`);
                      await delay(1000); 
                  } catch (saveError) {
                       console.error(`[ERRO BatchUpdate] Falha ao salvar linha para ${rowToSave.get('JOGADOR')} - ${rowToSave.get('PERSONAGEM')}:`, saveError);
                       sheetUpdateSuccess = false; 
                  }
             }
              if(sheetUpdateSuccess) console.log("[INFO BatchUpdate] Todas as linhas foram processadas para salvar.");
              else console.warn("[WARN BatchUpdate] Falha ao salvar uma ou mais linhas.");
         } else {
             console.log("[INFO BatchUpdate] Nenhuma linha precisou ser salva.");
        }

        // 4. ATUALIZAR MENSAGENS NO DISCORD
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

        return sheetUpdateSuccess; 

    } catch (error) {
        console.error(`[ERRO BatchUpdate] Falha GERAL ao atualizar inventários:`, error);
        return false; 
    }
}

/**
 * Remove EM LOTE itens e gold dos inventários.
 * @param {Array<object>} allPlayerChanges - Formato: [{ username, characterName, changes: { gold, itemsToRemove } }]
 * 'itemsToRemove' agora é: [{ name: "W+1 [LS]", validationName: "W+1", amount: 1 }]
 */
async function batchRemoveInventories(allPlayerChanges, client) {
    if (!allPlayerChanges || allPlayerChanges.length === 0) return true;

    let sheetUpdateSuccess = true;
    const rowsToSave = []; 
    const discordMessagesToUpdate = []; // Mensagens do Discord a serem atualizadas

    try {
        // 1. PRÉ-CARREGAR TUDO
        // (Reutiliza os dados de embed e categorias)
        const embedData = await preloadInventoryEmbedData(); //
         if (!embedData) {
             console.error("[ERRO BatchRemove] Falha no preloadInventoryEmbedData. Abortando remoção de inventários.");
             return false; 
         }
        await preloadItemCategories(docCraft); //
        
        await docInventario.loadInfo();
        const sheet = docInventario.sheetsByTitle['Inventário'];
        if (!sheet) throw new Error("Aba 'Inventário' não encontrada.");
        await sheet.loadHeaderRow(1); 
        const allRows = await sheet.getRows();
        
        // Mapeia todas as linhas por "jogador-personagem" para acesso rápido
        const playerRowMap = new Map();
        for (const row of allRows) {
            const key = `${String(row.get('JOGADOR')).trim().toLowerCase()}-${String(row.get('PERSONAGEM')).trim().toLowerCase()}`;
            playerRowMap.set(key, row);
        }
        console.log(`[INFO BatchRemove] Map de inventário criado com ${playerRowMap.size} registos.`);

        // 2. PROCESSAR ALTERAÇÕES (REMOÇÃO)
        for (const playerChange of allPlayerChanges) {
            const { username, characterName, changes } = playerChange;
            // Renomeia 'itemsToAdd' para 'itemsToRemove' para clareza
            const { gold = 0, itemsToRemove = [] } = changes;
            
            const rowKey = `${username.trim().toLowerCase()}-${characterName.trim().toLowerCase()}`;
            const row = playerRowMap.get(rowKey); 

            if (!row) {
                 console.error(`[ERRO BatchRemove] Não foi possível encontrar a linha "Inventário" para ${username} - ${characterName}. Pulando...`);
                 sheetUpdateSuccess = false; 
                 continue;
            }
            let rowChanged = false; // Flag para salvar a linha

            // --- Processa Gold (Subtração) ---
            if (gold !== 0) {
                const currentTotal = parseFloat(row.get('Total')) || 0;
                const newTotalRaw = parseFloat((currentTotal - gold).toFixed(2));
                const newTotal = Math.max(0, newTotalRaw); // Garante que o gold não fique negativo
                
                if (currentTotal !== newTotal) {
                    row.set('Total', newTotal); 
                    rowChanged = true; 
                }
            }

            // --- Processa Itens (Subtração) ---
            const itemChangesByCat = new Map(); // Map<CategoriaFinal, Array<ItemObject>>
            for (const item of itemsToRemove) {
                const category = await itemUtils.getItemCategory(item.validationName, docCraft); //
                if (!category) {
                    console.error(`[ERRO BatchRemove] Categoria não encontrada no cache para "${item.validationName}". Pulando remoção de item.`);
                    sheetUpdateSuccess = false;
                    continue;
                }
                if (!itemChangesByCat.has(category)) itemChangesByCat.set(category, []);
                itemChangesByCat.get(category).push(item);
            }

            for (const [category, itemsToRemoveFromCat] of itemChangesByCat.entries()) {
                const currentString = row.get(category) || '';
                const currentItemMap = itemUtils.parseInventoryString(currentString); //
                
                let categoryChanged = false;
                for (const item of itemsToRemoveFromCat) {
                    const lowerName = item.name.toLowerCase();
                    const currentData = currentItemMap.get(lowerName);
                    const currentAmount = currentData ? currentData.amount : 0;
                    
                    if (currentAmount === 0) {
                        // O jogador nem tinha este item, loga um aviso mas não falha
                        console.warn(`[AVISO BatchRemove] ${username} tentou remover ${item.amount}x "${item.name}", mas já tinha 0.`);
                        continue;
                    }
                    
                    const newAmount = currentAmount - item.amount;
                    
                    if (newAmount > 0) {
                        currentItemMap.set(lowerName, { name: item.name, amount: newAmount });
                    } else {
                        currentItemMap.delete(lowerName); // Remove o item do map se a contagem for 0 ou negativa
                    }
                    categoryChanged = true;
                }
                
                if (categoryChanged) {
                    const newString = itemUtils.formatInventoryString(currentItemMap); //
                    if (currentString !== newString) {
                         row.set(category, newString); 
                         rowChanged = true; 
                    }
                }
            }
            
            if (rowChanged) {
                 rowsToSave.push(row); // Adiciona a linha modificada para ser salva
            }

            // --- Prepara atualização do Discord ---
            const channelId = row.get('Inv ID');
            const msgId = row.get('Msg ID');
            
            // Se o canal estiver registrado E os dados do embed foram carregados
            if (channelId && msgId && embedData) {
                // Reconstrói o embed com os dados da 'row' (que acabamos de modificar)
                const newEmbed = await buildInventoryEmbed(row, embedData); //
                discordMessagesToUpdate.push({ channelId, msgId, newEmbed, charName: characterName });
            }
        }

        // 3. SALVAR NA PLANILHA (com delay)
        if (rowsToSave.length > 0) {
            console.log(`[INFO BatchRemove] Salvando ${rowsToSave.length} linhas de inventário (remoção)...`);
             for (const rowToSave of rowsToSave) {
                  try {
                      await rowToSave.save(); 
                      console.log(`[INFO BatchRemove] Linha para ${rowToSave.get('JOGADOR')} - ${rowToSave.get('PERSONAGEM')} salva.`);
                      await delay(1000); // Delay de 1 segundo entre CADA save
                  } catch (saveError) {
                       console.error(`[ERRO BatchRemove] Falha ao salvar linha para ${rowToSave.get('JOGADOR')} - ${rowToSave.get('PERSONAGEM')}:`, saveError);
                       sheetUpdateSuccess = false; // Marca falha, mas continua
                  }
             }
              if(sheetUpdateSuccess) console.log("[INFO BatchRemove] Todas as linhas foram processadas para salvar.");
              else console.warn("[WARN BatchRemove] Falha ao salvar uma ou mais linhas.");
         } else {
             console.log("[INFO BatchRemove] Nenhuma linha precisou ser salva.");
        }

        // 4. ATUALIZAR MENSAGENS NO DISCORD (sem delay)
        if (discordMessagesToUpdate.length > 0) {
            console.log(`[INFO BatchRemove] Atualizando ${discordMessagesToUpdate.length} mensagens no Discord...`);
            for (const update of discordMessagesToUpdate) {
                try {
                    const channel = await client.channels.fetch(update.channelId);
                    if (channel && channel.isTextBased()) {
                        const message = await channel.messages.fetch(update.msgId);
                        await message.edit({ embeds: [update.newEmbed] });
                        console.log(`[INFO BatchRemove] Mensagem ${update.msgId} atualizada para ${update.charName}.`);
                    }
                } catch (e) {
                    // Ignora erros de "Mensagem não encontrada" (10008) ou "Canal não encontrado" (10003)
                    if (e.code !== 10003 && e.code !== 10008) { 
                        console.error(`[ERRO BatchRemove] Falha ao atualizar msg Discord ${update.msgId} para ${update.charName}:`, e);
                    }
                }
            }
        }

        return sheetUpdateSuccess; 

    } catch (error) {
        console.error(`[ERRO BatchRemove] Falha GERAL ao remover itens/gold dos inventários:`, error);
        return false; 
    }
}


module.exports = {
    batchUpdateInventories,
    batchRemoveInventories
};