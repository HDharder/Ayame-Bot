// utils/lootSelectMenuManager.js
const { ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, ButtonBuilder, ButtonStyle, userMention } = require('discord.js');
//const { formatDropsList } = require('./lootUtils.js'); // Reutilizamos o formatador

const ITEMS_PER_PAGE = 24; // Usamos 24 para deixar 1 espaço para a opção "Devolver"

/**
 * Constrói a mensagem (conteúdo e componentes) para o menu de seleção paginado.
 * @param {object} state - O objeto de state do loot.
 * @param {object} player - O objeto do jogador.
 * @param {string} lootMessageId - ID da mensagem principal de loot.
 * @param {number} page - O número da página (base 0) a ser exibida.
 * @param {number} currentTokens - Tokens atuais do jogador.
 * @param {boolean} canAffordDouble - Se o jogador pode pagar pelo dobro.
 * @returns {object} - { content, components }
 */
function buildPaginatedSelectMenu(state, player, lootMessageId, page, currentTokens, canAffordDouble) {
    
    // 1. Gera a lista de todas as *unidades* de itens disponíveis na mesa
    const allItemUnits = [];
    (state.allDrops || []).forEach(itemType => {
        for (let i = 0; i < itemType.amount; i++) {
            // Guarda o item original (com 'isPredefined', etc.) e seu índice de unidade
            allItemUnits.push({ ...itemType, unitIndex: i });
        }
    });

    // 2. Calcula páginas
    const totalPages = Math.ceil(allItemUnits.length / ITEMS_PER_PAGE);
    const startIndex = page * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const itemsForThisPage = allItemUnits.slice(startIndex, endIndex);

    // 3. Constrói o Menu de Seleção
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`loot_item_select_paginated|${lootMessageId}|${page}`)
        .setPlaceholder(`Itens ${startIndex + 1}-${Math.min(endIndex, allItemUnits.length)} de ${allItemUnits.length} (Pág. ${page + 1}/${totalPages})`)
        .setMinValues(0)
        .setMaxValues(itemsForThisPage.length + 1); // +1 para a opção "Devolver"

    // 4. Adiciona as Opções de Itens
    // Rastreia o que o jogador JÁ TEM no seu "carrinho" (player.items)
    const playerItemMap = new Map();
    if (player.items) {
        player.items.forEach(item => {
            const count = playerItemMap.get(item.name) || 0;
            playerItemMap.set(item.name, count + item.amount);
        });
    }

    itemsForThisPage.forEach((item, index) => {
        const uniqueValue = `${item.name}|${item.isPredefined ? 'true' : 'false'}-${item.unitIndex}`; // Ex: "Poção de Cura-0"
        
        // Verifica se este item específico já foi selecionado pelo jogador
        // (Isso é complexo, então vamos simplificar: pré-seleciona SE o jogador tiver QUALQUER item desse nome)
        // (Para a pré-seleção 100% correta, precisaríamos de IDs únicos por item, mas isso funciona visualmente)
        
        // Vamos usar a lógica de "pré-seleção" que você sugeriu:
        const isSelected = player.items.some(playerItem => 
            playerItem.name === item.name && playerItem.unitIndex === item.unitIndex
        );

        selectMenu.addOptions(
            new StringSelectMenuOptionBuilder()
                .setLabel(`${item.name}${item.isPredefined ? '*' : ''}`)
                .setDescription(`(1 de ${item.amount} na mesa)`)
                .setValue(uniqueValue)
                .setDefault(isSelected) // <<< Pré-seleciona se já estiver no carrinho
        );
    });
    
    // 5. Adiciona a Opção "Devolver Itens desta Página"
    selectMenu.addOptions(
        new StringSelectMenuOptionBuilder()
            .setLabel('>>> DEVOLVER TODOS OS ITENS DESTA PÁGINA <<<')
            .setDescription('Use isto para limpar as seleções *apenas* desta página.')
            .setValue('__DEVOLVER_PAGINA__')
    );

    // 6. Constrói os Botões de Paginação
    const prevButton = new ButtonBuilder()
        .setCustomId(`loot_page_prev|${lootMessageId}|${page}`)
        .setLabel('◀️ Anterior')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0);

    const nextButton = new ButtonBuilder()
        .setCustomId(`loot_page_next|${lootMessageId}|${page}`)
        .setLabel('Próxima ▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page + 1 >= totalPages);

    const finalizeButton = new ButtonBuilder()
        .setCustomId(`finalizar_loot|${lootMessageId}|${player.id}`)
        .setLabel('Finalizar Seleção')
        .setStyle(ButtonStyle.Success);

    // +++ ADICIONADO: Botão de Ativar Dobro +++
    const doubleLabel = player.doubleActive
        ? `Desativar Dobro (4 de ${currentTokens} 🎟️)` 
        : `Ativar Dobro (4 de ${currentTokens} 🎟️)`;
    const doubleStyle = player.doubleActive ? ButtonStyle.Danger : ButtonStyle.Primary; 
    
    const doubleButton = new ButtonBuilder()
        .setCustomId(`toggle_double_gold|${lootMessageId}|${player.id}`)
        .setLabel(doubleLabel)
        .setStyle(doubleStyle)
        // Desabilita se não pode pagar (E não está ativo) OU se a mesa não rola loot
        .setDisabled((!canAffordDouble && !player.doubleActive) || state.options.naoRolarLoot);


    // 7. Monta as Fileiras (Rows)
    const menuRow = new ActionRowBuilder().addComponents(selectMenu);
    // Divide as fileiras de botões
    const paginationRow = new ActionRowBuilder().addComponents(prevButton, nextButton);
    const actionRow = new ActionRowBuilder().addComponents(doubleButton, finalizeButton);
    
    const content = `${userMention(player.id)}, selecione os itens que ${player.char} pegou.\n**Itens na mesa (Pág. ${page + 1}/${totalPages}):**`;
    
    return { content: content, components: [menuRow, paginationRow, actionRow] };
}


module.exports = {
    buildPaginatedSelectMenu
};