// utils/modalUtils.js
const { ModalBuilder, TextInputBuilder, TextInputStyle, ActionRowBuilder } = require('discord.js');

const MAX_MODAL_ITEMS = 5;

/**
 * Constrói um modal dinâmico para input de quantidade.
 * @param {string} baseCustomId - O ID base para o modal (ex: 'transacao_compra_modal|stateId')
 * @param {Array<object>} items - Array de objetos de item selecionados. 
 * Espera { value: 'id_do_item', label: 'Nome do Item' }
 * @returns {ModalBuilder|null} - O ModalBuilder, ou null se houverem muitos itens.
 */
function buildDynamicQuantityModal(baseCustomId, items) {
    if (items.length > MAX_MODAL_ITEMS) {
        console.error(`[modalUtils] Tentativa de criar modal com ${items.length} itens. Limite é ${MAX_MODAL_ITEMS}.`);
        return null;
    }

    const modal = new ModalBuilder()
        .setCustomId(baseCustomId)
        .setTitle('Definir Quantidades');

    items.forEach((item, index) => {
        // O customId do input será o 'value' do item (ex: 'potion_of_healing')
        // Usamos o label para o utilizador saber o que está a preencher.
        const textInput = new TextInputBuilder()
            .setCustomId(item.value)
            .setLabel(item.label.substring(0, 45)) // Limite de 45 caracteres do Label
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Digite a quantidade (ex: 1)')
            .setRequired(true);
        
        modal.addComponents(new ActionRowBuilder().addComponents(textInput));
    });

    return modal;
}

module.exports = {
    buildDynamicQuantityModal,
    MAX_MODAL_ITEMS
};