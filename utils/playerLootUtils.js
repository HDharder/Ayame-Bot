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
      }
  }
  player.items = []; // Limpa a lista de itens do jogador

  // 2. Conta quantos de CADA item foram selecionados AGORA
  const countMap = new Map();
  for (const value of selectedItemValues) {
      const lastHyphenIndex = value.lastIndexOf('-');
      if (lastHyphenIndex === -1) {
          console.warn(`[AVISO processItemSelection] Valor inválido no select menu: ${value}`);
          continue; 
      }
      const itemName = value.substring(0, lastHyphenIndex);
      countMap.set(itemName, (countMap.get(itemName) || 0) + 1);
  }

  // 3. Transfere os itens selecionados da pilha principal para o jogador
  const pickedItems = []; 
  for (const [itemName, amountToPick] of countMap.entries()) {
      const drop = state.allDrops.find(d => d.name === itemName);
      const currentAmountInDrop = (drop && typeof drop.amount === 'number') ? drop.amount : 0;

      if (drop && currentAmountInDrop >= amountToPick) {
          drop.amount -= amountToPick; 
          // <<< CORRIGIDO: Salva o objeto de item completo >>>
          pickedItems.push({ 
              name: itemName, 
              validationName: drop.validationName, 
              amount: amountToPick, 
              isPredefined: drop.isPredefined,
              isMisc: drop.isMisc
          }); 
      } else if (drop && currentAmountInDrop > 0) {
          console.warn(`[AVISO processItemSelection] Jogador ${player.tag} tentou pegar ${amountToPick}x ${itemName}, mas só ${currentAmountInDrop} estavam disponíveis.`);
          // <<< CORRIGIDO: Salva o objeto de item completo >>>
          pickedItems.push({ 
              name: itemName, 
              validationName: drop.validationName, 
              amount: currentAmountInDrop, 
              isPredefined: drop.isPredefined,
              isMisc: drop.isMisc
          });
          drop.amount = 0; 
      } else {
           console.warn(`[AVISO processItemSelection] Item selecionado "${itemName}" não encontrado ou zerado em state.allDrops.`);
      }
  }
  player.items = pickedItems; // Define a nova lista de itens do jogador

  // Remove itens da pilha principal se a quantidade chegou a zero
  state.allDrops = state.allDrops.filter(d => d.amount > 0);
}

/**
 * Processa a devolução de itens por um jogador.
 */
function processItemReturn(state, player) {
  if (!state || !player || !player.items || player.items.length === 0) {
    return ""; 
  }
  if (!state.allDrops) state.allDrops = []; 

  const returnedItemsList = []; 
  for (const item of player.items) {
    if (item && item.name && item.amount > 0) {
      returnedItemsList.push(`${item.amount}x ${item.name}${item.isPredefined ? '*' : ''}`); // Adiciona * de volta
      const drop = state.allDrops.find(d => d.name === item.name);
      if (drop) {
        drop.amount = (drop.amount || 0) + item.amount; 
      } else {
        // <<< CORRIGIDO: Adiciona o objeto completo de volta >>>
        state.allDrops.push({ ...item, amount: item.amount }); 
      }
    }
  }
  player.items = []; 
  return returnedItemsList.join(', '); 
}

module.exports = {
    processItemSelection,
    processItemReturn
};