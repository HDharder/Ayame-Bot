// utils/relatorioInventoryUpdater.js
const { docInventario, docCraft, getValuesFromSheet, setValuesInSheet } = require('./google.js');
const { parseInventoryString, formatInventoryString, getItemCategory } = require('./itemUtils.js'); // Reutilizamos os parsers de string
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Ponto de entrada chamado pelo /relatorio.
 * Processa todos os jogadores e atualiza o inventário um por um.
 * @param {Array<object>} allPlayerChanges - Array vindo do state.
 * Formato: [{ username, characterName, changes: { gold, itemsToAdd: [{ name, validationName, amount }] } }]
 */
async function updateInventoryFromRelatorio(allPlayerChanges) {
    let allUpdatesSuccess = true;
    
    // Processa um jogador de cada vez para evitar sobrecarga de API
    for (const playerChange of allPlayerChanges) {
        try {
            const { username, characterName, changes } = playerChange;
            const { gold, itemsToAdd } = changes;

            console.log(`[RelatorioUpdater] Processando: ${username} - ${characterName}`);

            await docInventario.loadInfo();
            const sheet = docInventario.sheetsByTitle['Inventário'];
            if (!sheet) throw new Error("Aba 'Inventário' não encontrada.");
            
            // 1. Critério para encontrar a linha do jogador
            const criteria = { 'JOGADOR': username, 'PERSONAGEM': characterName };

            // 2. Atualizar Gold
            if (gold !== 0) {
                const goldResult = await getValuesFromSheet(sheet, criteria, ['Total']);
                const currentTotalStr = (goldResult.length > 0) ? goldResult[0]['Total'] : '0';
                const currentTotal = parseFloat(currentTotalStr) || 0;
                const newTotal = parseFloat((currentTotal + gold).toFixed(2));
                
                const goldSuccess = await setValuesInSheet(sheet, criteria, { 'Total': newTotal });
                if (!goldSuccess) allUpdatesSuccess = false;
                console.log(`[RelatorioUpdater] Gold atualizado para ${characterName}: ${newTotal}`);
            }

            // 3. Processar Itens
            if (itemsToAdd.length > 0) {
                // Agrupa os novos itens por categoria REAL (Armas, Pocoes, etc.)
                const itemsByCategory = new Map();
                for (const item of itemsToAdd) {
                    // item.validationName é o nome limpo (ex: "Arma +1")
                    // item.name é o nome completo (ex: "Arma +1 [Espada Longa]")
                    const category = await getItemCategory(item.validationName, docCraft);
                    if (!category) {
                        console.warn(`[RelatorioUpdater] Categoria não encontrada para: ${item.validationName}`);
                        continue;
                    }
                    if (!itemsByCategory.has(category)) itemsByCategory.set(category, []);
                    itemsByCategory.get(category).push(item); // Adiciona o objeto { name, validationName, amount }
                }

                // Atualiza cada categoria na planilha
                for (const [category, newItems] of itemsByCategory.entries()) {
                    // Pega a string atual (ex: "1x Espada Curta")
                    const categoryResult = await getValuesFromSheet(sheet, criteria, [category]);
                    const currentString = (categoryResult.length > 0 && categoryResult[0][category]) ? categoryResult[0][category] : '';
                    
                    // Converte string para Map (ex: "espada curta" -> { name: "Espada Curta", amount: 1 })
                    const itemMap = parseInventoryString(currentString);

                    // Adiciona os novos itens ao Map
                    for (const item of newItems) {
                        // Salva usando o NOME COMPLETO (item.name)
                        const lowerName = item.name.toLowerCase();
                        const currentAmount = itemMap.has(lowerName) ? itemMap.get(lowerName).amount : 0;
                        itemMap.set(lowerName, { name: item.name, amount: currentAmount + item.amount });
                    }

                    // Converte o Map de volta para string (ex: "1x Espada Curta, 1x Arma +1 [Espada Longa]")
                    const newString = formatInventoryString(itemMap);
                    
                    // Salva a nova string na planilha
                    const itemSuccess = await setValuesInSheet(sheet, criteria, { [category]: newString });
                    if (!itemSuccess) allUpdatesSuccess = false;
                }
                console.log(`[RelatorioUpdater] Itens atualizados para ${characterName} em ${[...itemsByCategory.keys()].join(', ')}`);
            }
            
            // Delay para evitar limite de escrita da API
            await delay(1000); 

        } catch (error) {
            console.error(`[ERRO RelatorioUpdater] Falha ao atualizar inventário para ${playerChange.characterName}:`, error);
            allUpdatesSuccess = false;
            // Continua para o próximo jogador
        }
    }
    
    return allUpdatesSuccess;
}

module.exports = {
    updateInventoryFromRelatorio
};