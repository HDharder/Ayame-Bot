// Funções para validar e parsear strings de itens

const itemCategoryCache = new Map();

/**
* Pré-carrega o cache de categorias de itens de todas as abas relevantes.
* @param {import('google-spreadsheet').GoogleSpreadsheet} docCraft - Instância da planilha docCraft.
*/
async function preloadItemCategories(docCraft) {
    if (itemCategoryCache.size > 0) return; // Já carregado

    const sheetsToCheck = ['Itens Mundanos', 'Itens', 'Materiais', 'Ervas', 'Poções', 'Misc'];
    try {
        await docCraft.loadInfo();
        console.log("[INFO ItemUtils] Pré-carregando categorias de itens...");
        for (const sheetName of sheetsToCheck) {
            const sheet = docCraft.sheetsByTitle[sheetName];
            if (!sheet) continue;

            await sheet.loadCells('A1:A' + sheet.rowCount);
            for (let i = 0; i < sheet.rowCount; i++) {
                const cell = sheet.getCell(i, 0);
                if (cell.value) {
                    const lowerName = String(cell.value).trim().toLowerCase();
                    if (!itemCategoryCache.has(lowerName)) {
                        itemCategoryCache.set(lowerName, sheetName);
                    }
                }
            }
        }
        console.log(`[INFO ItemUtils] Cache de categorias preenchido com ${itemCategoryCache.size} itens.`);
    } catch (error) {
        console.error(`[ERRO preloadItemCategories] Falha ao pré-carregar categorias:`, error);
    }
}

/**
 * Valida uma lista de itens contra a planilha de Craft.
 * @param {Array<object>} itemsToValidate - Array de objetos { name: string, amount: number }.
 * @param {string} sheetName - Nome da aba na planilha Craft (ex: 'Itens', 'Materiais').
 * @param {GoogleSpreadsheet} docCraft - Instância da planilha docCraft.
 * @returns {Promise<Array<string>>} - Array com os nomes dos itens não encontrados. Vazio se todos forem válidos.
 */
async function validateItems(itemsToValidate, sheetName, docCraft) {
  try {
    await docCraft.loadInfo(); // Garante que as informações da planilha (abas) estão carregadas
    const sheet = docCraft.sheetsByTitle[sheetName];
    if (!sheet) {
      console.error(`[ERRO validateItems] Aba "${sheetName}" não encontrada na Tabela de Craft.`);
      throw new Error(`Aba "${sheetName}" não encontrada na Tabela de Craft.`);
    }

    // Carrega apenas a coluna A (onde estão os nomes dos itens)
    await sheet.loadCells('A:A');

    // Cria um Set com todos os nomes de itens válidos (em minúsculas para comparação)
    const validItems = new Set();
    // Itera pelas linhas da coluna A carregada
    for (let i = 0; i < sheet.rowCount; i++) {
      const cell = sheet.getCell(i, 0); // Pega a célula na coluna A (índice 0)
      if (cell.value) { // Se a célula não estiver vazia
        validItems.add(String(cell.value).trim().toLowerCase()); // Adiciona ao Set
      }
    }

    // Compara os itens a validar com os itens válidos
    const notFound = [];
    for (const item of itemsToValidate) {
      if (item && item.name && !validItems.has(item.name.toLowerCase())) {
        notFound.push(item.name); // Adiciona à lista se não for encontrado
      }
    }

    return notFound; // Retorna a lista de itens não encontrados

  } catch (error) {
      console.error(`[ERRO validateItems] Erro ao validar itens na aba "${sheetName}":`, error);
      // Relança o erro para que a função chamadora saiba que algo deu errado
      throw new Error(`Falha ao validar itens na planilha de Craft: ${error.message}`);
  }
}

/**
 * Parseia a string de input como "3x Item A, Item B, 2 x Item C".
 * Consolida itens repetidos.
 * @param {string} text - String de entrada do usuário.
 * @returns {Array<object>} - Array de objetos { name: string, amount: number }.
 */
function parseItemInput(text) {
  if (!text) return []; // Retorna array vazio se a entrada for nula ou vazia

  const itemsRaw = text.split(','); // Separa por vírgula
  const consolidated = new Map(); // Usado para agrupar itens com mesmo nome

  // Regex para capturar "Nx Nome do Item" ou apenas "Nome do Item"
  // ^               - Início da string
  // (?:(\d+)\s*x\s*)? - Grupo opcional para quantidade (ex: "3x ")
  //   (\d+)         - Captura um ou mais dígitos (a quantidade N)
  //   \s*x\s* - O "x" com espaços opcionais
  // (.+)            - Captura o restante como nome do item (pelo menos um caractere)
  // $               - Fim da string
  // i               - Ignora maiúsculas/minúsculas no "x"
  const regex = /^(?:(\d+)\s*x\s*)?(.+)$/i;

  for (const item of itemsRaw) {
    const trimmedItem = item.trim(); // Remove espaços extras
    if (!trimmedItem) continue; // Pula se for vazio após trim

    const match = trimmedItem.match(regex);
    // Se não corresponder ao formato esperado, pula este item
    if (!match) {
        console.warn(`[AVISO parseItemInput] Item "${trimmedItem}" ignorado por formato inválido.`);
        continue;
    }

    // Extrai quantidade (padrão 1 se não especificado) e nome
    const amount = parseInt(match[1] || '1', 10);
    const name = match[2].trim(); // Pega o nome capturado

    // Agrupa pelo nome em minúsculas para evitar duplicatas (Ex: "potion" e "Potion")
    const lowerName = name.toLowerCase();
    const currentEntry = consolidated.get(lowerName); // Pega entrada existente, se houver
    const currentAmount = currentEntry ? currentEntry.amount : 0; // Pega quantidade atual ou 0

    // Atualiza o Map com o nome original (preserva capitalização) e a soma das quantidades
    consolidated.set(lowerName, { name: name, amount: currentAmount + amount });
  }

  // Converte o Map de volta para um array de objetos
  return Array.from(consolidated.values());
}

// +++ NOVAS FUNÇÕES ADICIONADAS +++

/**
 * Parseia uma string de inventário (ex: "2x Item A, Item B") para um Map.
 * @param {string} text - A string da célula da planilha.
 * @returns {Map<string, {name: string, amount: number}>} - Map onde a chave é o nome do item em minúsculas e o valor é { nomeOriginal, quantidade }.
 */
function parseInventoryString(text) {
    const itemMap = new Map();
    if (!text || typeof text !== 'string') return itemMap;

    const itemsRaw = text.split(',');
    const regex = /^(?:(\d+)\s*x\s*)?(.+)$/i; // Mesmo regex do parseItemInput

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

        // Guarda no Map, somando se já existir (case-insensitive na chave, mas preserva nome original)
        const lowerName = name.toLowerCase();
        const currentAmount = itemMap.has(lowerName) ? itemMap.get(lowerName).amount : 0;
        itemMap.set(lowerName, { name: name, amount: currentAmount + amount });
    }
    return itemMap; // Retorna o Map { lowerName -> { name, amount } }
}

/**
 * Formata um Map de inventário de volta para uma string (ex: "1x Item B, 2x Item A").
 * Ordena os itens alfabeticamente.
 * @param {Map<string, {name: string, amount: number}>} itemMap - O Map gerado por parseInventoryString.
 * @returns {string} - A string formatada para a célula da planilha.
 */
function formatInventoryString(itemMap) {
    if (!itemMap || itemMap.size === 0) return '';

    // Converte para array, ordena pelo nome original e formata
    const formattedItems = Array.from(itemMap.values())
        .filter(item => item.amount > 0) // Remove itens com quantidade zero ou negativa
        .sort((a, b) => a.name.localeCompare(b.name)) // Ordena alfabeticamente
        .map(item => `${item.amount}x ${item.name}`);

    return formattedItems.join(', ');
}

/**
 * Encontra a categoria (nome da aba em docCraft) de um item. Usa cache.
 * @param {string} itemName - Nome do item a procurar.
 * @param {import('google-spreadsheet').GoogleSpreadsheet} docCraft - Instância da planilha docCraft.
 * @returns {Promise<string|null>} - O nome da aba ('Itens Mundanos', 'Itens', 'Materiais', 'Ervas', 'Poções', 'Misc') ou null em caso de erro.
 */
async function getItemCategory(itemName, docCraft) {
    const lowerItemName = itemName.toLowerCase();

    // === CORREÇÃO: Retorna o valor do cache se ele existir ===
    if (itemCategoryCache.has(lowerItemName)) {
        return itemCategoryCache.get(lowerItemName);
    }
    // Se o cache está vazio, tenta carregar este item (fallback)
    // Mas o ideal é chamar preloadItemCategories() primeiro
    // (A verificação acima foi movida para ser a primeira coisa na função)
    // Esta lógica agora só corre se o item NÃO ESTIVER no cache
    console.warn(`[AVISO getItemCategory] Cache de item não encontrado para "${itemName}". Tentando busca de fallback...`);
    const sheetsToCheck = ['Itens Mundanos', 'Itens', 'Materiais', 'Ervas', 'Poções', 'Misc']; // Adiciona Misc à busca
    

    //const sheetsToCheck = ['Itens Mundanos', 'Itens', 'Materiais', 'Ervas', 'Poções']; // Adicione outras abas se necessário

    try {
        await docCraft.loadInfo(); // Garante que as abas estão carregadas

        for (const sheetName of sheetsToCheck) {
            const sheet = docCraft.sheetsByTitle[sheetName];
            if (!sheet) continue; // Pula se a aba não existir

            // Carrega apenas a coluna A (Nomes) - Otimização
            await sheet.loadCells('A1:A' + sheet.rowCount); // Carrega a coluna A inteira
            for (let i = 0; i < sheet.rowCount; i++) { // Itera pelas linhas carregadas
                const cell = sheet.getCell(i, 0); // Índice 0 para coluna A
                if (cell.value && String(cell.value).trim().toLowerCase() === lowerItemName) {
                    itemCategoryCache.set(lowerItemName, sheetName); // Guarda no cache
                    return sheetName; // Encontrou! Retorna o nome da aba
                }
            }
        }

        // Se não encontrou em nenhuma aba verificada, assume 'Misc'
        itemCategoryCache.set(lowerItemName, 'Misc');
        return 'Misc';
    

    } catch (error) {
        console.error(`[ERRO getItemCategory] Falha ao buscar categoria para "${itemName}":`, error);
        return null; // Retorna null em caso de erro na busca
    }
}

// +++ FIM DAS NOVAS FUNÇÕES +++

module.exports = {
  preloadItemCategories,
  validateItems,
  parseItemInput,
  parseInventoryString,  // <<< Exporta
  formatInventoryString, // <<< Exporta
  getItemCategory
};