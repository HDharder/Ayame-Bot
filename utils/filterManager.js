// utils/filterManager.js
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

/**
 * Constrói um botão de filtro padronizado.
 * @param {string} baseCustomId - A ação base (ex: 'transacao_filtro_compra').
 * @param {number} page - A página atual.
 * @returns {ButtonBuilder}
 */
function buildFilterButton(baseCustomId, page) {
    return new ButtonBuilder()
        .setCustomId(`${baseCustomId}|${page}`)
        .setLabel('Filtrar 🔎')
        .setStyle(ButtonStyle.Primary);
}

/**
 * (NOVA FUNÇÃO) Formata a estrutura de consulta [[]] de volta para uma string legível.
 * Ex: [ ['a', 'b'], ['c'] ] -> "(a, b), c"
 * @param {Array<Array<string>>} parsedQuery - A estrutura da consulta.
 * @returns {string}
 */
function formatFilterToString(parsedQuery) {
    if (!parsedQuery || parsedQuery.length === 0) return '';

    return parsedQuery.map(group => {
        if (group.length > 1) {
            return `(${group.join(', ')})`; // (a, b)
        }
        return group[0]; // c
    }).join(', ');
}

/**
 * Lida com o clique no botão de filtro, mostrando o modal.
 * @param {import('discord.js').ButtonInteraction} interaction - A interação do clique no botão.
 * @param {string} stateId - O ID da interação/estado principal (ex: state.interactionId).
 * @param {Array<string>} currentFilter - O array de palavras-chave do filtro atual.
 */
async function handleFilterButton(interaction, stateId, currentFilter = []) {
    const [actionBase] = interaction.customId.split('|'); // ex: 'transacao_filtro_compra'
    const modalId = `${actionBase}_modal|${stateId}`; // ex: 'transacao_filtro_compra_modal|stateId'

    const modal = new ModalBuilder()
        .setCustomId(modalId)
        .setTitle('Filtrar Itens');
    
    const filterInput = new TextInputBuilder()
        .setCustomId('filtro_input')
        .setLabel('Palavras-chave (separadas por vírgula)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Ex: poção, cura, maior')
        .setValue(formatFilterToString(currentFilter)) // Mostra o filtro atual
        .setRequired(false);

    const row = new ActionRowBuilder().addComponents(filterInput);
    modal.addComponents(row);
    
    await interaction.showModal(modal);
}

/**
 * Processa a submissão do modal de filtro.
 * Converte a string "(a, b), c" na estrutura [ ['a', 'b'], ['c'] ]
 * @param {import('discord.js').ModalSubmitInteraction} interaction - A interação do modal.
 * @returns {Array<Array<string>>} - Um array de grupos "AND".
 */
function handleFilterModal(interaction) {
    const filterString = interaction.fields.getTextInputValue('filtro_input');
    const parsedQuery = []; // O resultado final: [ ['a', 'b'], ['c'] ]
    
    // Regex para encontrar ou (grupos entre parênteses) ou | palavras soltas
    // \(([^)]+)\) -> Captura o conteúdo de um (grupo)
    // ([^,]+) -> Captura qualquer coisa que não seja uma vírgula
    const regex = /\(([^)]+)\)|([^,]+)/g;
    let match;

    while ((match = regex.exec(filterString)) !== null) {
        // Limpa o 'match' de lixo
        const cleanedMatch = match[1] || match[2] || '';
        if (cleanedMatch.trim() === '') continue;

        // Processa o grupo (seja um grupo (a,b) ou um termo solto "c")
        const andGroup = cleanedMatch.split(',')
            .map(kw => kw.trim().toLowerCase())
            .filter(kw => kw.length > 0);

        if (andGroup.length > 0) {
            parsedQuery.push(andGroup);
        }
    }
    
    return parsedQuery;
}

/**
 * Filtra um array de itens com base em palavras-chave.
 * @param {Array<any>} items - O array de itens a filtrar.
 * @param {Array<Array<string>>} parsedQuery - A estrutura de consulta (ex: [ ['a', 'b'], ['c'] ]).
 * @param {Function} propertyAccessor - Uma função que extrai o texto a ser pesquisado (ex: (item) => item.get('Item')).
 * @returns {Array<any>} - O array de itens filtrados.
 */
function applyTextFilter(items, parsedQuery, propertyAccessor) {
    // Se não houver filtro, retorna todos os itens
    if (!parsedQuery || parsedQuery.length === 0) {
        return items;
    }

    return items.filter(item => {
        const textToSearch = propertyAccessor(item);
        if (!textToSearch) return false;
        
        const textLower = textToSearch.toLowerCase();
        
        // Nível Superior: "OR" (Array.some)
        // Retorna true se o item corresponder a *qualquer* um dos grupos
        return parsedQuery.some(andGroup => {
            // Nível Interno: "AND" (Array.every)
            // Retorna true APENAS se o item incluir TODAS as palavras-chave deste grupo
            return andGroup.every(kw => textLower.includes(kw));
        });
    });
}

module.exports = {
    buildFilterButton,
    handleFilterButton,
    handleFilterModal,
    applyTextFilter,
    formatFilterToString
};