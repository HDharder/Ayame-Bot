// commands/transacao.js
const { 
    SlashCommandBuilder, 
    MessageFlagsBitField, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle,
    StringSelectMenuBuilder,      // <<< IMPORTAÇÃO CORRIGIDA
    StringSelectMenuOptionBuilder,   // <<< IMPORTAÇÃO CORRIGIDA
    ModalBuilder,                 // <<< ADICIONADO
    TextInputBuilder,             // <<< ADICIONADO
    TextInputStyle
} = require('discord.js');
const { findUserCharacters } = require('../utils/inventarioUtils.js'); //
const {
    validateMarketChannel,
    validateMesaCheck,
    handleServicos,
    handlePlayerShop,
    buildPaginatedShopMenu, // <<< ATUALIZADO
    processCompra,
    buildSellSelectMenu, // <<< IMPORTA A NOVA FUNÇÃO
    processVenda
} = require('../utils/transacaoUtils.js'); //
const { buildDynamicQuantityModal, MAX_MODAL_ITEMS } = require('../utils/modalUtils.js'); //
const { handleFilterButton, handleFilterModal } = require('../utils/filterManager.js'); //

module.exports = {
    data: new SlashCommandBuilder()
        .setName('transacao')
        .setDescription('Realiza uma transação (compra, venda, serviço) neste mercado.'),

    // Quais interações este arquivo gerencia
    buttons: [
        'transacao_compra', 
        'transacao_venda', 
        'transacao_servico', 
        'transacao_compra_finalizar',
        'transacao_page_prev', 
        'transacao_page_next',
        'transacao_venda_prev', // <<< NOVO (Venda)
        'transacao_venda_next', // <<< NOVO (Venda)
        'transacao_venda_finalizar', // <<< NOVO (Venda)
        'transacao_filtro_compra',   // <<< NOVO (Filtro)
        'transacao_filtro_venda',
        'transacao_cancelar_modal'// <<< NOVO (Cancelar)
    ],
    selects: [
        'transacao_char_select', 
        'transacao_compra_select', 
        'transacao_venda_select' // <<< NOVO (Venda)
    ],
    modals: [
        'transacao_compra_modal',
        'transacao_filtro_compra_modal', // <<< NOVO (Filtro)
        'transacao_filtro_venda_modal',
        'transacao_cancelar_confirm'     // <<< NOVO (Cancelar)
    ],

    async execute(interaction) {
        // 1. Valida se o canal é um mercado
        const rules = await validateMarketChannel(interaction); //
        if (!rules) return; // A função de validação já respondeu
        
        // +++ CORREÇÃO: Defer EFÊMERO (privado) primeiro +++
        await interaction.deferReply();

        // 2. Extrai regras da loja
        const { possibilidades, tipoDeLoja } = rules;

        // +++ INÍCIO DA NOVA LÓGICA DE PARSE (Loja e Sub-Loja) +++
        let tipoDeLojaLimpo = tipoDeLoja;
        let subLojaNome = null;

        // Regex para "Nome da Aba (Nome da Sub-Loja)"
        const subLojaMatch = tipoDeLoja.match(/^([^(]+)\s*\(([^)]+)\)/);
        
        if (subLojaMatch) {
            tipoDeLojaLimpo = subLojaMatch[1].trim(); // "Loja"
            subLojaNome = subLojaMatch[2].trim(); // "O Pavilhão das Mil Brasas"
        }
        // +++ FIM DA NOVA LÓGICA DE PARSE +++

        const hasMesaCheck = tipoDeLoja.includes('*');
        const hasEstoque = tipoDeLoja.includes('[Estoque]');
        const isCaravana = tipoDeLoja.includes('[Caravana]');
        // (Ainda não usamos o {CD})

        // 2. Limpa TODOS os outros marcadores ([, *, {) do nome da aba
        // Usa uma regex que encontra o primeiro [, *, ou { e corta
        const specialCharMatch = tipoDeLojaLimpo.match(/[\*\[\{]/); 
        if (subLojaMatch === null && specialCharMatch) { // Só executa se não for uma sub-loja (que já foi limpa)
             tipoDeLojaLimpo = tipoDeLojaLimpo.substring(0, specialCharMatch.index).trim();
        }

        const state = {
            interactionId: interaction.id,
            // +++ ADICIONADO: Salva quem executou o comando +++
            ownerId: interaction.user.id, 
            rules: rules,
            tipoDeLojaLimpo: tipoDeLojaLimpo, // Agora está limpo
            subLojaNome: subLojaNome,
            hasMesaCheck: hasMesaCheck,
            hasEstoque: hasEstoque,
            isCaravana: isCaravana,
            character: null, // Será preenchido no (Passo 4)
            selectedItems: [], // Para o fluxo de Compra
            // +++ ADICIONADO: Salva os personagens no state +++
            characters: [],
            shopMessageId: null,
            itemsToSell: [], // Para o fluxo de Venda
            shopFilter: [], // <<< NOVO (Filtro)
            sellFilter: []  // <<< NOVO (Filtro)
        };
        // Armazena o estado (usaremos o 'pendingLoots' genérico)
        interaction.client.pendingLoots.set(interaction.id, state);

        // 3. Handle 'Serviços' e 'Players' (Placeholders)
        if (possibilidades === 'serviços') {
            return await handleServicos(interaction, state); //
        }
        if (rules.tipoDeLoja.toLowerCase() === 'players') {
            return await handlePlayerShop(interaction, state); //
        }
        
        // 4. Seleção de Personagem
        const characters = await findUserCharacters(interaction.user.username); //
        if (!characters || characters.length === 0) {
            await interaction.editReply({ content: 'Você não possui nenhum personagem registrado na planilha "Inventário" para realizar esta ação.', components: [] });
            interaction.client.pendingLoots.delete(interaction.id);
            return;
        }
        state.characters = characters; // <<< SALVA OS PERSONAGENS NO STATE

        if (characters.length > 1) {
            // Mais de 1 personagem, precisa escolher
            const selectMenu = new StringSelectMenuBuilder()
                .setCustomId(`transacao_char_select|${interaction.id}`)
                .setPlaceholder('Selecione o personagem...');
            
            characters.slice(0, 25).forEach((charRow, index) => {
                const charName = charRow.get('PERSONAGEM') || 'Personagem Sem Nome';
                selectMenu.addOptions(
                    new StringSelectMenuOptionBuilder()
                        .setLabel(charName)
                        // +++ CORREÇÃO: Usa o índice do array (0, 1, 2...) como valor +++
                        .setValue(String(index)) //
                );
            });
            
            await interaction.editReply({
                content: 'Com qual personagem você deseja realizar esta transação?',
                components: [new ActionRowBuilder().addComponents(selectMenu)],
                //flags: [MessageFlagsBitField.Flags.Ephemeral] // A seleção de personagem é efêmera
            });
            // O fluxo continua no handleSelect
            
        } else {
            // Apenas 1 personagem, seleciona automaticamente
            state.character = { row: characters[0], rowIndex: characters[0].rowIndex };
            // Valida a mesa (se necessário)
            if (state.hasMesaCheck) {
                const isInMesa = await validateMesaCheck(interaction.user.username, state.character.row.get('PERSONAGEM')); //
                if (!isInMesa) {
                    await interaction.editReply({ content: `Esta loja só permite compras por personagens que estão **atualmente em uma mesa não finalizada**.\nPersonagem: ${state.character.row.get('PERSONAGEM')}.`, components: [] });
                    interaction.client.pendingLoots.delete(interaction.id);
                    return;
                }
            }
            // Continua para o Passo 5
            await this.continueFlow(interaction, state);
        }
    },

    /**
     * Função auxiliar para continuar o fluxo após a seleção de personagem
     * @param {import('discord.js').Interaction} interaction
     * @param {object} state
     */
    async continueFlow(interaction, state) {
        const { possibilidades } = state.rules;

        // 5. Direciona para Compra, Venda ou Escolha
        // +++ CORREÇÃO: Remove o 'ephemeral' (flags: []) para tornar a resposta PÚBLICA +++
        if (possibilidades === 'compra') {
            // +++ MUDANÇA: Chama a nova função de paginação, começando na página 0 +++
            const { content, components } = await buildPaginatedShopMenu(state, 0); //
            const shopMessage = await interaction.editReply({ content: content, components: components, flags: [] });
            state.shopMessageId = shopMessage.id;
        
        } else if (possibilidades === 'venda') {
            const { content, components } = await buildSellSelectMenu(state, 0); // <<< CHAMA A NOVA FUNÇÃO
            await interaction.editReply({ content: content, components: components, flags: [] });

        } else if (possibilidades === 'compra e venda') {
            const buttons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`transacao_compra|${state.interactionId}`).setLabel('Comprar').setStyle(ButtonStyle.Success),
                    new ButtonBuilder().setCustomId(`transacao_venda|${state.interactionId}`).setLabel('Vender').setStyle(ButtonStyle.Primary)
                );
            await interaction.editReply({
                content: `Você deseja comprar ou vender nesta loja?`,
                components: [buttons],
                flags: [] // A escolha é pública
            });
        }
    },

    async handleSelect(interaction) {
        // +++ MUDANÇA: O customId pode ter 3 partes (ação|id|página) +++
        const customIdParts = interaction.customId.split('|');
        const [action, interactionId] = customIdParts;
        // +++ CORREÇÃO: Lógica de verificação de state simplificada +++
        const state = interaction.client.pendingLoots.get(interactionId);
        
        // Verifica se o state existe e se o ID do usuário que clicou é o mesmo que iniciou o comando
        // +++ CORREÇÃO: Compara o usuário da interação atual com o 'ownerId' salvo no state +++
        if (!state || interaction.user.id !== state.ownerId) {
            await interaction.reply({ content: 'Esta interação expirou ou não pertence a você.', ephemeral: true });
            return;
        }

        // --- SELEÇÃO DE PERSONAGEM ---
        if (action === 'transacao_char_select') {
            await interaction.deferUpdate(); // Remove a seleção de personagem (que era efêmera)
            
            // +++ CORREÇÃO: Busca o personagem do state usando o índice do array +++
            const selectedIndex = parseInt(interaction.values[0]); // "0", "1", etc.
            const selectedRow = state.characters[selectedIndex];
            
            if (!selectedRow) {
                await interaction.followUp({ content: 'Erro ao encontrar seu personagem. Tente novamente.', ephemeral: true });
                return;
            }
            
            state.character = { row: selectedRow, rowIndex: selectedRow.rowIndex }; // Salva a row E o rowIndex real
            
            // Valida a mesa (se necessário)
            if (state.hasMesaCheck) {
                const isInMesa = await validateMesaCheck(interaction.user.username, state.character.row.get('PERSONAGEM')); //
                if (!isInMesa) {
                    await interaction.followUp({ 
                        content: `Esta loja só permite compras por personagens que estão **atualmente em uma mesa não finalizada**.\nPersonagem selecionado: ${state.character.row.get('PERSONAGEM')}.`, 
                        ephemeral: true 
                    });
                    interaction.client.pendingLoots.delete(interaction.id);
                    return;
                }
            }
            
            // +++ CORREÇÃO: Passa a interação ATUAL (a do select menu) +++
            await this.continueFlow(interaction, state);
        }
        
        // --- SELEÇÃO DE ITENS DE COMPRA ---
        if (action === 'transacao_compra_select') {
            // Pega a página do customId (ex: transacao_compra_select|ID_ESTADO|0)
            const page = parseInt(customIdParts[2]) || 0;

            await interaction.deferUpdate(); // Atualiza a mensagem
            
            // Salva os itens selecionados (Nome/Label)
            state.selectedItems = interaction.values.map(value => {
                // Encontra a opção original para pegar o Label (Nome do Item)
                const option = interaction.component.options.find(o => o.value === value);
                return {
                    value: value, // O ID/Nome do item
                    label: option ? option.label : value, // O Nome para o modal
                    page: page // Guarda a página
                };
            });
        }

        // --- SELEÇÃO DE ITENS DE VENDA ---
        if (action === 'transacao_venda_select') {
            const page = parseInt(customIdParts[2]) || 0;
            await interaction.deferUpdate();

            // (Lógica de seleção do /loot, mas para venda)
            // O 'value' é "Nome|Indice"
            const selectedValues = new Set(interaction.values);
            if (!state.itemsToSell) state.itemsToSell = [];

            // 1. Remove itens *desta página* que foram des-selecionados
            state.itemsToSell = state.itemsToSell.filter(item => {
                if (item.page !== page) return true; // Mantém itens de outras páginas
                return selectedValues.has(item.value); // Mantém se ainda estiver selecionado
            });

            // 2. Adiciona itens *desta página* que foram selecionados
            for (const value of selectedValues) {
                if (!state.itemsToSell.some(i => i.value === value)) {
                    const option = interaction.component.options.find(o => o.value === value);
                    // Adiciona um objeto rico em dados
                    state.itemsToSell.push({
                        value: value, // "Nome|Indice"
                        name: option ? option.label : value, // Nome do item
                        description: option ? option.description : 'Preço: 0.00 PO', // "Vender por: X.XX PO"
                        page: page
                    });
                }
            }
            
            // (Opcional: Atualiza o botão finalizar com o total)
            // ...

            // Reconstrói o menu para mostrar a seleção (checkmarks)
            // (Esta parte pode falhar se a seleção não for salva no menu builder)
            // (Vamos pular a reconstrução por enquanto, apenas salvamos no state)
        }

    },
    
    async handleButton(interaction) {
        const customIdParts = interaction.customId.split('|'); // Pega todas as partes
        const [action, interactionId] = customIdParts;
        const state = interaction.client.pendingLoots.get(interactionId);

        // +++ ADICIONADO: Verificação de Dono para botões +++
        // +++ CORREÇÃO: Compara com o 'ownerId' salvo no state +++
        if (!state || interaction.user.id !== state.ownerId) {
            await interaction.reply({ content: 'Esta interação expirou ou não pertence a você.', ephemeral: true });
            return;
        }

        // --- Botão 'Comprar' (após 'compra e venda') ---
        if (action === 'transacao_compra') {
            await interaction.update({ content: 'Carregando a loja... ⏳', components: [] });
            // +++ MUDANÇA: Chama a nova função de paginação, começando na página 0 +++
            const { content, components } = await buildPaginatedShopMenu(state, 0); 
            const shopMessage = await interaction.editReply({ content: content, components: components }); // +++ MUDANÇA: Usa editReply
            state.shopMessageId = shopMessage.id;
        
        // --- Botão 'Vender' (após 'compra e venda') ---
        } else if (action === 'transacao_venda') {
            await interaction.update({ content: 'Carregando seu inventário para venda... ⏳', components: [] });
            const { content, components } = await buildSellSelectMenu(state, 0); // <<< CHAMA A NOVA FUNÇÃO
            const shopMessage = await interaction.editReply({ content: content, components: components });
            state.shopMessageId = shopMessage.id;
        
        // --- Botão 'Definir Quantidades' (Fluxo de Compra) ---
        } else if (action === 'transacao_compra_finalizar') {
            if (!state.selectedItems || state.selectedItems.length === 0) {
                await interaction.reply({ content: 'Você precisa selecionar pelo menos um item antes de definir as quantidades.', ephemeral: true });
                return;
            }
            
            if (state.selectedItems.length > MAX_MODAL_ITEMS) {
                 await interaction.reply({ content: `Erro: Você selecionou mais de ${MAX_MODAL_ITEMS} itens.`, ephemeral: true });
                return;
            }
            
            // Constrói e mostra o modal dinâmico
            const modal = buildDynamicQuantityModal(
                `transacao_compra_modal|${interactionId}`, 
                state.selectedItems
            ); //

            state.shopMessageId = interaction.message.id;
            
            await interaction.showModal(modal);
        
        // +++ NOVO: Lógica dos Botões de Paginação (Compra) +++
        } else if (action === 'transacao_page_prev' || action === 'transacao_page_next') {
            const page = parseInt(customIdParts[2]) || 0;
            const newPage = (action === 'transacao_page_next') ? page + 1 : page - 1;

            // Reconstrói o menu da loja na nova página
            const { content, components } = await buildPaginatedShopMenu(state, newPage); //
            
            // Atualiza a mensagem efêmera com o novo menu
            const shopMessage = await interaction.update({ content: content, components: components });
            state.shopMessageId = shopMessage.id;

        // +++ NOVO: Lógica dos Botões de Paginação (Venda) +++
        } else if (action === 'transacao_venda_prev' || action === 'transacao_venda_next') {
            const page = parseInt(customIdParts[2]) || 0;
            const newPage = (action === 'transacao_venda_next') ? page + 1 : page - 1;

            // Reconstrói o menu de venda na nova página
            const { content, components } = await buildSellSelectMenu(state, newPage); //
            const shopMessage = await interaction.update({ content: content, components: components });
            state.shopMessageId = shopMessage.id;
            
        // +++ NOVO: Lógica dos Botões de Filtro +++
        } else if (action === 'transacao_filtro_compra' || action === 'transacao_filtro_venda') {
            const currentFilter = (action === 'transacao_filtro_compra') ? state.shopFilter : state.sellFilter;
            await handleFilterButton(interaction, state.interactionId, currentFilter);

        // +++ NOVO: Lógica do Botão Cancelar +++
        } else if (action === 'transacao_cancelar_modal') {
            const modal = new ModalBuilder()
                .setCustomId(`transacao_cancelar_confirm|${interactionId}`)
                .setTitle('Cancelar Transação?');
            
            // Um modal precisa de um input, então adicionamos um "falso"
            const confirmationInput = new TextInputBuilder()
                .setCustomId('confirm_input')
                .setLabel("Clique em 'Enviar' para confirmar.")
                .setStyle(TextInputStyle.Short)
                .setValue('Sim') // Preenchemos
                .setRequired(false); // Não é obrigatório

            modal.addComponents(new ActionRowBuilder().addComponents(confirmationInput));
            await interaction.showModal(modal);

        // +++ NOVO: Finalizar Venda +++
        } else if (action === 'transacao_venda_finalizar') {
            if (!state.itemsToSell || state.itemsToSell.length === 0) {
                await interaction.reply({ content: 'Você não selecionou nenhum item para vender.', ephemeral: true });
                return;
            }

            // +++ MUDANÇA: Chama a função de processamento real +++
            await processVenda(interaction, state);
            
            // Limpa o estado
            interaction.client.pendingLoots.delete(interactionId);
        }
    },
    
    async handleModal(interaction) {
        const [action, interactionId] = interaction.customId.split('|');
        const state = interaction.client.pendingLoots.get(interactionId);

        // +++ ADICIONADO: Verificação de Dono para modais +++
        // +++ CORREÇÃO: Compara com o 'ownerId' salvo no state +++
        if (!state || interaction.user.id !== state.ownerId) {
            await interaction.reply({ content: 'Esta interação expirou ou não pertence a você.', ephemeral: true });
            return;
        }
        
        // --- Modal de Quantidade (Fluxo de Compra) ---
        if (action === 'transacao_compra_modal') {
            // Passa a interação do modal e o estado para a função de processamento
            await processCompra(interaction, state); //
            
            // Limpa o estado
            interaction.client.pendingLoots.delete(interactionId);

        // +++ NOVO: Lógica dos Modais de Filtro +++
        } else if (action === 'transacao_filtro_compra_modal' || action === 'transacao_filtro_venda_modal') {
            await interaction.deferUpdate();
            const keywords = handleFilterModal(interaction);
            const isCompra = action === 'transacao_filtro_compra_modal';
            
            
            if (isCompra) {
                state.shopFilter = keywords;
                // Reconstrói o menu da loja (volta para a página 0)
                const { content, components } = await buildPaginatedShopMenu(state, 0); //
                await interaction.editReply({ content: content, components: components });
            } else {
                state.sellFilter = keywords;
                // Reconstrói o menu de venda (volta para a página 0)
                const { content, components } = await buildSellSelectMenu(state, 0); //
                await interaction.editReply({ content: content, components: components });
            }

            // +++ NOVO: Lógica do Modal de Confirmação de Cancelamento +++
        } else if (action === 'transacao_cancelar_confirm') {
            await interaction.deferUpdate(); // Confirma o modal

            try {
                // Pega o ID da mensagem da loja (que já guardámos)
                const msgId = state.shopMessageId;
                if (msgId) {
                    // Apaga a mensagem da loja
                    await interaction.channel.messages.delete(msgId);
                }
            } catch (e) {
                console.warn(`[WARN transacao_cancelar] Falha ao apagar msg da loja: ${e.message}`);
            }

            interaction.client.pendingLoots.delete(interactionId); // Limpa o estado
            // Envia uma confirmação efêmera
            await interaction.followUp({ content: 'Transação cancelada.', ephemeral: true });
        }
    }
};