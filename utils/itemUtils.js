// utils/itemUtils.js
const itemCategoryCache = new Map();
const itemTypeCache = new Map(); // Cache para "weapon", "armor", "item"

/**
* Pré-carrega o cache de categorias E tipos de itens.
* @param {import('google-spreadsheet').GoogleSpreadsheet} docCraft - Instância da planilha docCraft.
*/
async function preloadItemCategories(docCraft) {
    if (itemCategoryCache.size > 0 && itemTypeCache.size > 0) return; 

    const sheetsToCheck = ['Itens Mundanos', 'Itens', 'Materiais', 'Ervas', 'Poções', 'Misc'];
    try {
        await docCraft.loadInfo();
        console.log("[INFO ItemUtils] Pré-carregando categorias e tipos de itens...");
        
        for (const sheetName of sheetsToCheck) {
            const sheet = docCraft.sheetsByTitle[sheetName];
            if (!sheet) continue;

            await sheet.loadCells('A1:B' + sheet.rowCount); // Carrega Coluna A (Nome) e B (Type)
            
            for (let i = 0; i < sheet.rowCount; i++) {
                const cell = sheet.getCell(i, 0); // Coluna A (Nome)
                if (cell.value) {
                    const lowerName = String(cell.value).trim().toLowerCase();
                    if (!itemCategoryCache.has(lowerName)) {
                        // Salva o NOME DA ABA (ex: "Poções")
                        itemCategoryCache.set(lowerName, sheetName);
                    }
                    
                    // Se for Item Mundano, guarda o Tipo (Coluna B)
                    if (sheetName === 'Itens Mundanos') {
                        const typeCell = sheet.getCell(i, 1); // Coluna B (Type)
                        const typeValue = typeCell.value ? String(typeCell.value).toLowerCase() : 'item';
                        itemTypeCache.set(lowerName, typeValue);
                    }
                }
            }
        }
        console.log(`[INFO ItemUtils] Cache de Categorias (${itemCategoryCache.size}) e Tipos (${itemTypeCache.size}) preenchido.`);
    } catch (error) {
        console.error(`[ERRO preloadItemCategories] Falha ao pré-carregar categorias:`, error);
    }
}

/**
 * Valida uma lista de itens contra a planilha de Craft.
 * @param {Array<object>} itemsToValidate - Array de objetos { name, validationName, amount }.
 * @param {string} sheetName - Nome da aba na planilha Craft (ex: 'Itens', 'Materiais').
 * @param {import('google-spreadsheet').GoogleSpreadsheet} docCraft - Instância da planilha docCraft.
 * @returns {Promise<Array<string>>} - Array com os nomes dos itens não encontrados. Vazio se todos forem válidos.
 */
async function validateItems(itemsToValidate, sheetName, docCraft) {
  try {
    await docCraft.loadInfo(); 
    const sheet = docCraft.sheetsByTitle[sheetName];
    if (!sheet) {
      console.error(`[ERRO validateItems] Aba "${sheetName}" não encontrada na Tabela de Craft.`);
      throw new Error(`Aba "${sheetName}" não encontrada na Tabela de Craft.`);
    }

    await sheet.loadCells('A:A');

    const validItems = new Set();
    for (let i = 0; i < sheet.rowCount; i++) {
      const cell = sheet.getCell(i, 0); 
      if (cell.value) { 
        validItems.add(String(cell.value).trim().toLowerCase()); 
      }
    }

    const notFound = [];
    // Compara usando 'validationName'
    for (const item of itemsToValidate) {
      if (item && item.validationName && !validItems.has(item.validationName.toLowerCase())) {
        notFound.push(item.name); // Mostra o nome completo no erro
      }
    }

    return notFound; 

  } catch (error) {
      console.error(`[ERRO validateItems] Erro ao validar itens na aba "${sheetName}":`, error);
      throw new Error(`Falha ao validar itens na planilha de Craft: ${error.message}`);
  }
}

/**
 * Parseia a string de input como "3x Item A [Detalhe], Item B".
 * @param {string} text - String de entrada do usuário.
 * @returns {Array<object>} - Array de objetos { name: string, validationName: string, amount: number }.
 */
function parseItemInput(text) {
  if (!text) return []; 
  const itemsRaw = text.split(','); 
  const consolidated = new Map(); 

   const regex = /^(?:(\d+)\s*x\s*)?(.+)$/i;

  for (const item of itemsRaw) {
    const trimmedItem = item.trim(); 
    if (!trimmedItem) continue; 

    const match = trimmedItem.match(regex);
    if (!match) {
        console.warn(`[AVISO parseItemInput] Item "${trimmedItem}" ignorado por formato inválido.`);
        continue;
    }

    const amount = parseInt(match[1] || '1', 10);
    const name = match[2].trim(); // Nome completo, ex: "Weapon +1 [Longsword]"
    const validationName = name.split('[')[0].trim(); // Nome de validação, ex: "Weapon +1"

    const lowerName = name.toLowerCase(); 
    const currentEntry = consolidated.get(lowerName);
    const currentAmount = currentEntry ? currentEntry.amount : 0; 

    consolidated.set(lowerName, { 
        name: name, 
        validationName: validationName, 
        amount: currentAmount + amount 
    });
  }
  return Array.from(consolidated.values());
}


/**
 * Parseia uma string de inventário (ex: "2x Item A, Item B") para um Map.
 */
function parseInventoryString(text) {
    const itemMap = new Map();
    if (!text || typeof text !== 'string') return itemMap;

    const itemsRaw = text.split(',');
    const regex = /^(?:(\d+)\s*x\s*)?(.+)$/i; 

    for (const item of itemsRaw) {
        const trimmedItem = item.trim();
        if (!trimmedItem) continue;

        const match = trimmedItem.match(regex);
        if (!match) {
            console.warn(`[AVISO parseInventoryString] Item "${trimmedItem}" ignorado por formato inválido.`);
            continue;
        }

        const amount = parseInt(match[1] || '1', 10);
        const name = match[2].trim();

        const lowerName = name.toLowerCase();
        const currentAmount = itemMap.has(lowerName) ? itemMap.get(lowerName).amount : 0;
        itemMap.set(lowerName, { name: name, amount: currentAmount + amount });
    }
    return itemMap; 
}

/**
 * Formata um Map de inventário de volta para uma string (ex: "1x Item B, 2x Item A").
 */
function formatInventoryString(itemMap) {
    if (!itemMap || itemMap.size === 0) return '';

    const formattedItems = Array.from(itemMap.values())
        .filter(item => item.amount > 0) 
        .sort((a, b) => a.name.localeCompare(b.name)) 
        .map(item => `${item.amount}x ${item.name}`);

    return formattedItems.join(', ');
}

/**
 * (Função Auxiliar) Busca o Tipo (Arma/Armadura) de um item Mundano no cache.
 * @param {string} validationName - O nome limpo (sem colchetes) do item.
 * @returns {string} - "Armas", "Escudos/Armaduras", ou "Itens Mundanos"
 */
function getMundaneCategory(validationName) {
    const type = itemTypeCache.get(validationName.toLowerCase());
    if (type) {
        if (type.includes('weapon')) return 'Armas';
        if (type.includes('armor')) return 'Escudos/Armaduras'; // <<< Corrigido para corresponder ao seu pedido
    }
    return 'Itens Mundanos'; // Padrão
}

/**
 * Encontra a categoria (nome da aba em docCraft) de um item. Usa cache.
 * ATUALIZADO: Retorna o NOME DA COLUNA DO INVENTÁRIO (ex: "Consumíveis Mágicos").
 * @param {string} validationName - Nome limpo do item a procurar (sem colchetes).
 * @param {import('google-spreadsheet').GoogleSpreadsheet} docCraft - Instância da planilha docCraft.
 * @returns {Promise<string|null>} - O nome da coluna do inventário ("Armas", "Itens Mágicos", "Misc", etc.)
 */
async function getItemCategory(validationName, docCraft) {
     const lowerItemName = validationName.toLowerCase();
    
    // 1. Verifica o cache
    if (itemCategoryCache.has(lowerItemName)) {
         const baseCategory = itemCategoryCache.get(lowerItemName); // Ex: "Itens Mundanos", "Poções", "Itens"
         
         // --- MAPEAMENTO (Cache) ---
         if (baseCategory === 'Itens Mundanos') {
             return getMundaneCategory(lowerItemName); // Retorna "Armas", "Escudos/Armaduras", ou "Itens Mundanos"
         }
         if (baseCategory === 'Poções') return 'Consumíveis Mágicos'; // <<< CORREÇÃO
         if (baseCategory === 'Itens') return 'Itens Mágicos'; // <<< CORREÇÃO
         return baseCategory; // Retorna "Materiais", "Ervas", "Misc"
         // --- FIM MAPEAMENTO ---
    }

    // 2. Busca de Fallback (se não estiver no cache)
     console.warn(`[AVISO getItemCategory] Cache de item não encontrado para "${validationName}". Tentando busca de fallback...`);
    const sheetsToCheck = ['Itens Mundanos', 'Itens', 'Materiais', 'Ervas', 'Poções', 'Misc']; 

    try {
        await docCraft.loadInfo(); 

        for (const sheetName of sheetsToCheck) {
            const sheet = docCraft.sheetsByTitle[sheetName];
            if (!sheet) continue; 

            await sheet.loadCells('A1:B' + sheet.rowCount); 
            for (let i = 0; i < sheet.rowCount; i++) { 
                const cell = sheet.getCell(i, 0); 
                if (cell.value && String(cell.value).trim().toLowerCase() === lowerItemName) {
                    itemCategoryCache.set(lowerItemName, sheetName); // Salva a ABA no cache
                    
                     // --- MAPEAMENTO (Fallback) ---
                     if (sheetName === 'Itens Mundanos') {
                         const typeCell = sheet.getCell(i, 1); 
                         const typeValue = typeCell.value ? String(typeCell.value).toLowerCase() : 'item';
                         itemTypeCache.set(lowerItemName, typeValue); 
                         return getMundaneCategory(lowerItemName); // Retorna "Armas", etc.
                     }
                     if (sheetName === 'Poções') return 'Consumíveis Mágicos'; // <<< CORREÇÃO
                     if (sheetName === 'Itens') return 'Itens Mágicos'; // <<< CORREÇÃO
                     return sheetName; // Retorna "Materiais", "Ervas"
                     // --- FIM MAPEAMENTO ---
                }
            }
        }
        
        // Se não encontrou em NENHUMA aba
        itemCategoryCache.set(lowerItemName, 'Misc');
        return 'Misc';
    
    } catch (error) {
         console.error(`[ERRO getItemCategory] Falha ao buscar categoria para "${validationName}":`, error);
        return null; 
     }
}

module.exports = {
  preloadItemCategories,
  validateItems,
  parseItemInput,
  parseInventoryString,  
  formatInventoryString, 
  getItemCategory
};