// Funções para processar a seleção e devolução de itens pelos jogadores

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
      return; // Interrompe se algum parâmetro crucial faltar
  }
  if (!state.allDrops) state.allDrops = []; // Garante que allDrops seja um array

  // 1. Devolve os itens que o jogador TINHA ANTES para a pilha principal
  if (player.items && player.items.length > 0) {
      for (const oldItem of player.items) {
          // Garante que o item antigo é válido antes de processar
          if (oldItem && oldItem.name && oldItem.amount > 0) {
              const drop = state.allDrops.find(d => d.name === oldItem.name);
              if (drop) {
                drop.amount = (drop.amount || 0) + oldItem.amount; // Aumenta a quantidade na pilha
              } else {
                // Adiciona de volta se não existia mais
                state.allDrops.push({ name: oldItem.name, amount: oldItem.amount });
              }
          }
      }
  }
  player.items = []; // Limpa a lista de itens do jogador ANTES de adicionar os novos

  // 2. Conta quantos de CADA item foram selecionados AGORA
  const countMap = new Map();
  for (const value of selectedItemValues) {
      // Parse do nome do item (pega tudo antes do último hífen)
      const lastHyphenIndex = value.lastIndexOf('-');
      if (lastHyphenIndex === -1) {
          console.warn(`[AVISO processItemSelection] Valor inválido no select menu: ${value}`);
          continue; // Pula valor inválido
      }
      const itemName = value.substring(0, lastHyphenIndex);

      // Incrementa a contagem para este itemName
      countMap.set(itemName, (countMap.get(itemName) || 0) + 1);
  }

  // 3. Transfere os itens selecionados da pilha principal para o jogador
  const pickedItems = []; // Array para guardar os itens que o jogador REALMENTE pegou
  for (const [itemName, amountToPick] of countMap.entries()) {
      const drop = state.allDrops.find(d => d.name === itemName);
      // Garante que drop e drop.amount existam e sejam válidos
      const currentAmountInDrop = (drop && typeof drop.amount === 'number') ? drop.amount : 0;

      // Verifica se o item existe na pilha e se a quantidade é suficiente
      if (drop && currentAmountInDrop >= amountToPick) {
          drop.amount -= amountToPick; // Diminui a quantidade na pilha
          pickedItems.push({ name: itemName, amount: amountToPick }); // Adiciona aos itens pegos
      } else if (drop && currentAmountInDrop > 0) {
          // Caso raro: jogador selecionou mais do que disponível
          console.warn(`[AVISO processItemSelection] Jogador ${player.tag} tentou pegar ${amountToPick}x ${itemName}, mas só ${currentAmountInDrop} estavam disponíveis.`);
          pickedItems.push({ name: itemName, amount: currentAmountInDrop }); // Pega o que sobrou
          drop.amount = 0; // Zera na pilha
      } else {
           // Segurança extra: Se o item não foi encontrado na pilha ou já estava zerado
           console.warn(`[AVISO processItemSelection] Item selecionado "${itemName}" não encontrado ou zerado em state.allDrops.`);
      }
  }
  player.items = pickedItems; // Define a nova lista de itens do jogador

  // Remove itens da pilha principal se a quantidade chegou a zero
  state.allDrops = state.allDrops.filter(d => d.amount > 0);
}

/**
 * Processa a devolução de itens por um jogador.
 * Modifica o state.allDrops e player.items diretamente.
 * @param {object} state - O objeto de state do loot.
 * @param {object} player - O objeto do jogador que está devolvendo.
 * @returns {string} - String formatada dos itens devolvidos (ex: "2x Item A, 1x Item B"). Vazio se nada foi devolvido.
 */
function processItemReturn(state, player) {
  // Verifica se há state, player e itens para devolver
  if (!state || !player || !player.items || player.items.length === 0) {
    return ""; // Nada a devolver
  }
  if (!state.allDrops) state.allDrops = []; // Garante que allDrops seja um array

  const returnedItemsList = []; // Array para guardar as strings formatadas
  // Itera sobre os itens que o jogador possui
  for (const item of player.items) {
    // Garante que o item é válido antes de processar
    if (item && item.name && item.amount > 0) {
      returnedItemsList.push(`${item.amount}x ${item.name}`); // Guarda para a string de retorno
      // Encontra o item correspondente na pilha principal (state.allDrops)
      const drop = state.allDrops.find(d => d.name === item.name);
      if (drop) {
        drop.amount = (drop.amount || 0) + item.amount; // Aumenta a quantidade na pilha
      } else {
        // Adiciona de volta à pilha se não existia mais
        state.allDrops.push({ name: item.name, amount: item.amount });
      }
    }
  }
  player.items = []; // Limpa a lista de itens do jogador após devolver
  return returnedItemsList.join(', '); // Retorna a string dos itens devolvidos
}

module.exports = {
    processItemSelection,
    processItemReturn
};