// utils/playerLootUtils.js

/**
 * Processa a seleção de itens feita por um jogador no menu dropdown.
 * Modifica o state.allDrops e player.items diretamente.
 * @param {object} state - O objeto de state do loot.
 * @param {object} player - O objeto do jogador que selecionou os itens.
 * @param {Array<string>} selectedItemValues - Os valores selecionados no menu (ex: ["ItemA-0", "ItemB-0"]).
 */
function processItemSelection(state, player, selectedItemValues) {
  if (!state || !player || !selectedItemValues) {
      console.error("[ERRO processItemSelection] State, player ou selectedItemValues inválidos.");
      return; 
  }
  if (!state.allDrops) state.allDrops = []; 
  
  // 1. Devolve os itens que o jogador TINHA ANTES para a pilha principal
  if (player.items && player.items.length > 0) {
      /*
      for (const oldItem of player.items) {
          if (oldItem && oldItem.name && oldItem.amount > 0) {
              const drop = state.allDrops.find(d => d.name === oldItem.name);
              if (drop) {
                drop.amount = (drop.amount || 0) + oldItem.amount; 
              } else {
                // Adiciona de volta se não existia mais (preservando todas as propriedades)
                state.allDrops.push({ ...oldItem });
              }
          }
      }*/
  }
  player.items = []; // Limpa a lista de itens do jogador

  // 2. Conta quantos de CADA item foram selecionados AGORA
  const countMap = new Map();
  const originalItemMap = new Map(); // Armazena o objeto de item original
  for (const value of selectedItemValues) {
      const lastHyphenIndex = value.lastIndexOf('-');
      if (lastHyphenIndex === -1) continue; 

      // +++ CORREÇÃO: Parseia o novo formato "Nome|Flag-Indice" +++
      const itemString = value.substring(0, lastHyphenIndex); // Ex: "Potion of Healing|true"
      const lastPipeIndex = itemString.lastIndexOf('|');
      if (lastPipeIndex === -1) {
          console.warn(`[AVISO processItemSelection] Valor em formato antigo: ${value}`);
          continue; 
       }

      const itemName = itemString.substring(0, lastPipeIndex); // "Potion of Healing"
      const isPredefined = itemString.substring(lastPipeIndex + 1) === 'true'; // true
      const key = `${itemName}|${isPredefined}`; // "Potion of Healing|true"
      
      countMap.set(key, (countMap.get(key) || 0) + 1); // Usa a chave composta
      if (!originalItemMap.has(key)) {
          const drop = state.allDrops.find(d => d.name === itemName && d.isPredefined === isPredefined); // Encontra o item exato
          if (drop) originalItemMap.set(key, drop);
      }
  }

  // 3. Transfere os itens selecionados da pilha principal para o jogador
  //const pickedItems = []; 
  for (const [key, amountToPick] of countMap.entries()) { // Itera pela chave composta
      const originalDrop = originalItemMap.get(key);
      if (originalDrop) {
          player.items.push({
              name: originalDrop.name,
              validationName: originalDrop.validationName, 
              amount: amountToPick, 
              isPredefined: originalDrop.isPredefined,
              isMisc: originalDrop.isMisc
          }); 
      }
  }
}

/**
 * Processa a devolução de itens por um jogador.
 */
function processItemReturn(state, player) {
  if (!state || !player || !player.items || player.items.length === 0) {
    return ""; 
  }

  const returnedItemsList = []; 
  for (const item of player.items) {
    if (item && item.name && item.amount > 0) {
      // (A lógica de devolução para state.allDrops não é mais necessária, pois nunca saiu)
    }
  }
  player.items = []; 
  return "Itens devolvidos.";
}

/**
 * Processa a seleção de itens (MODO PAGINADO - > 25 itens)
 * Esta função ATUALIZA (adiciona/remove) o inventário do jogador (player.items).
 * @param {object} state - O objeto de state do loot.
 * @param {object} player - O objeto do jogador.
 * @param {Array<string>} selectedValuesForPage - Os valores selecionados (ex: ["ItemA-0", "ItemB-0"]).
 * @param {number} page - A página atual que foi submetida.
 */
function processPaginatedSelection(state, player, selectedValuesForPage, page) {
    if (!state || !player) return;
    if (!state.allDrops) state.allDrops = []; 
    if (!player.items) player.items = []; // Garante que o "carrinho" do jogador exista

    const ITEMS_PER_PAGE = 24; // Deve ser o mesmo valor do 'lootSelectMenuManager.js'

    // 1. Gera a lista de todas as *unidades* de itens disponíveis na mesa
    const allItemUnits = [];
    state.allDrops.forEach(itemType => {
        for (let i = 0; i < itemType.amount; i++) {
            allItemUnits.push({ ...itemType, amount: 1, unitIndex: i });
        }
    });

    // 2. Itera pelos itens QUE ESTAVAM NESTA PÁGINA
    const startIndex = page * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const itemsOnThisPage = allItemUnits.slice(startIndex, endIndex);
    const selectedSet = new Set(selectedValuesForPage || []);

    // Opção de Devolução (se selecionada)
    if (selectedSet.has('__DEVOLVER_PAGINA__')) {
        selectedSet.clear(); // Ignora todas as outras seleções se "Devolver" foi clicado
    }

    itemsOnThisPage.forEach((itemOnPage) => {
        const uniqueValue = `${itemOnPage.name}|${itemOnPage.isPredefined ? 'true' : 'false'}-${itemOnPage.unitIndex}`;
        const playerItemIndex = player.items.findIndex(pi => pi.name === itemOnPage.name && pi.unitIndex === itemOnPage.unitIndex);
        const isCurrentlySelectedInCart = playerItemIndex !== -1;
        const isSelectedInMenu = selectedSet.has(uniqueValue);

        // +++ DEBUG: Verifica se o item no carrinho tem 'isPredefined' +++
        // (Adicionado para garantir que a subtração em getAvailableDrops funcione)
        if (isCurrentlySelectedInCart && player.items[playerItemIndex].isPredefined === undefined) {
            console.warn(`[AVISO processPaginatedSelection] Item ${itemOnPage.name} no carrinho não tem flag 'isPredefined'.`);
        }
        if (isSelectedInMenu && !isCurrentlySelectedInCart && itemOnPage.isPredefined === undefined) {
             console.warn(`[AVISO processPaginatedSelection] Item ${itemOnPage.name} sendo adicionado não tem flag 'isPredefined'.`);
        }

        // 3. Lógica de Adicionar ao Carrinho
        if (isSelectedInMenu && !isCurrentlySelectedInCart) {
            // Adiciona ao carrinho (player.items)
            player.items.push(itemOnPage);
            // --- REMOVIDO: Não modifica mais state.allDrops ---
        }
        // 4. Lógica de Remover do Carrinho (Deselecionou)
        else if (!isSelectedInMenu && isCurrentlySelectedInCart) {
            // Remove do carrinho
            player.items.splice(playerItemIndex, 1);
            // --- REMOVIDO: Não modifica mais state.allDrops ---
        }
        // Se (isSelectedInMenu && isCurrentlySelectedInCart) -> Não faz nada (já está correto)
        // Se (!isSelectedInMenu && !isCurrentlySelectedInCart) -> Não faz nada (já está correto)
    });

    // 5. Re-filtra allDrops para remover os que zeraram
    //state.allDrops = state.allDrops.filter(d => d.amount > 0);
    // --- REMOVIDO: Não modifica mais state.allDrops ---
}

/**
 * Calcula os drops disponíveis subtraindo o que está nos carrinhos dos players.
 * @param {object} state - O objeto de state do loot.
 * @returns {Array} - Uma *nova* lista de drops (copiada) com as quantidades atualizadas.
 */
function getAvailableDrops(state) {
    if (!state.allDrops) return [];

    // Cria um mapa de contagem a partir do allDrops original
    const availableDropsMap = new Map();
    state.allDrops.forEach(drop => {
        const key = `${drop.name}|${drop.isPredefined ? 'true' : 'false'}`;
        availableDropsMap.set(key, { ...drop }); // Clona o objeto do drop
    });

    // Subtrai os itens dos carrinhos dos players
    state.players.forEach(player => {
        (player.items || []).forEach(itemInCart => {
            if (itemInCart.isPredefined === undefined) {
                 console.warn(`[AVISO getAvailableDrops] Item ${itemInCart.name} no carrinho do player ${player.tag} não tem flag 'isPredefined'. A contagem pode falhar.`);
            }
            // +++ CORREÇÃO: Usa a chave composta para encontrar o item +++
            const key = `${itemInCart.name}|${itemInCart.isPredefined ? 'true' : 'false'}`;
            const drop = availableDropsMap.get(key);
            if (drop) {
                // Se tem unitIndex, é do modo paginado, contamos como 1.
                // Se não tem, é do modo simples, usamos o item.amount.
                const amountToSubtract = (itemInCart.unitIndex !== undefined) ? 1 : (itemInCart.amount || 0);
                drop.amount -= amountToSubtract;
            }
        });
    });

    // Retorna a lista filtrada
    return Array.from(availableDropsMap.values()).filter(d => d.amount > 0);
}

module.exports = {
    processItemSelection,
    processItemReturn,
    processPaginatedSelection,
    getAvailableDrops
};