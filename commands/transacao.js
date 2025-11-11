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
const { findUserCharacters, getChannelOwner } = require('../utils/inventarioUtils.js'); //
const {
    validateMarketChannel,
    validateMesaCheck,
    handleServicos,
    handlePlayerShop,
    buildPaginatedShopMenu, // <<< ATUALIZADO
    processCompra,
    buildSellSelectMenu, // <<< IMPORTA A NOVA FUNÇÃO
    processVenda,
    openRollBrecha,
    postP2PConfirmation, // + NOVO
    handleP2PConfirmation //
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
        'transacao_cancelar_modal', // <<< NOVO (Cancelar)
        'p2p_trade_accept', // + NOVO (P2P)
        'p2p_trade_decline' // + NOVO (P2P)
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
        'transacao_cancelar_confirm',     // <<< NOVO (Cancelar)
        'transacao_venda_modal' // + NOVO (P2P Modal de Preço)
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
        } else {
            // Se não há sub-loja, o nome da loja é a string inteira
            tipoDeLojaLimpo = tipoDeLoja;
        }
        // +++ FIM DA NOVA LÓGICA DE PARSE +++

        const hasMesaCheck = tipoDeLoja.includes('*');
        const hasEstoque = tipoDeLoja.includes('[Estoque]');
        const isCaravana = tipoDeLoja.includes('[Caravana]');
        const price_adjust = tipoDeLoja.includes('[Players]');
        
        // Extrai o CD de Persuasão
        const persuasionMatch = tipoDeLoja.match(/\{(\d+)\}/);
        const persuasionCD = persuasionMatch ? parseInt(persuasionMatch[1], 10) : null;
        
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
            //tipoDeLojaLimpo: tipoDeLojaLimpo, // Agora está limpo
            tipoDeLojaLimpo: tipoDeLojaLimpo.replace(/[\*\[\{\(\)\]\d]/g, '').trim(),
            subLojaNome: subLojaNome,
            hasMesaCheck: hasMesaCheck,
            hasEstoque: hasEstoque,
            isCaravana: isCaravana,
            persuasionCD: persuasionCD,
            character: null, // Será preenchido no (Passo 4)
            selectedItems: [], // Para o fluxo de Compra
            // +++ ADICIONADO: Salva os personagens no state +++
            characters: [],
            shopMessageId: null,
            itemsToSell: [], // Para o fluxo de Venda
            shopFilter: [], // <<< NOVO (Filtro)
            sellFilter: [],  // <<< NOVO (Filtro)
            price_adjust: price_adjust, // + NOVO (P2P)
            buyerInfo: null // + NOVO (P2P)
        };

        // +++ NOVO: Se for P2P, busca o dono do canal (Comprador) +++
        if (price_adjust) {
            const buyerInfo = await getChannelOwner(interaction.channel.id);
            if (!buyerInfo || !buyerInfo.owner || !buyerInfo.characterRow) {
                await interaction.editReply({ content: 'Este canal de [Players] não parece estar vinculado a um inventário válido. Não consigo identificar o comprador.', components: [] });
                return;
            }
            // Verifica se o jogador está tentando transacionar consigo mesmo
            if (buyerInfo.owner.trim().toLowerCase() === interaction.user.username.trim().toLowerCase()) {
                 await interaction.editReply({ content: 'Você não pode iniciar uma transação no seu próprio canal de inventário. Use `/gasto` para gerir seus itens.', components: [] });
                return;
            }
            state.buyerInfo = buyerInfo; // Salva os dados do comprador
        }

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

        // +++ NOVO: Verifica se o Vendedor e o Comprador são da mesma conta +++
        if (state.price_adjust && state.buyerInfo) {
            const sellerUsername = characters[0].get('JOGADOR'); // Pega o nome do Jogador (dono dos personagens)
            if (sellerUsername.trim().toLowerCase() === state.buyerInfo.characterRow.get('JOGADOR').trim().toLowerCase()) {
                await interaction.editReply({ content: 'Erro: Você não pode realizar transações entre personagens da mesma conta.', components: [] });
                return;
            }
        }

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
                ephemeral: false // Define como público
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

        /*/ +++ NOVO: Abre a brecha de rolagem ANTES de enviar o menu +++
        if (state.persuasionCD && !state.persuasionAttempted) {
            await openRollBrecha(interaction, state, interaction.id);
        }*/

        // 5. Direciona para Compra, Venda ou Escolha
        // +++ CORREÇÃO: Remove o 'ephemeral' (flags: []) para tornar a resposta PÚBLICA +++
        if (possibilidades === 'compra') {
            state.activeMenu = 'compra'; // <<< GUARDA O MENU ATIVO
            // +++ MUDANÇA: Chama a nova função de paginação, começando na página 0 +++
            const { content, components } = await buildPaginatedShopMenu(state, 0); //
            const shopMessage = await interaction.editReply({ content: content, components: components, ephemeral: false });
            state.shopMessageId = shopMessage.id; // <<< ATUALIZAÇÃO: Salva o ID da mensagem        
        } else if (possibilidades === 'venda') {
            state.activeMenu = 'venda'; // <<< GUARDA O MENU ATIVO
            const { content, components } = await buildSellSelectMenu(state, 0, state.price_adjust);
            const shopMessage = await interaction.editReply({ content: content, components: components, ephemeral: false });
            state.shopMessageId = shopMessage.id; // <<< ATUALIZAÇÃO: Salva o ID da mensagem
        } else if (possibilidades === 'compra e venda') {
            const buttons = new ActionRowBuilder()
                .addComponents(
                    new ButtonBuilder().setCustomId(`transacao_compra|${state.interactionId}`).setLabel('Comprar').setStyle(ButtonStyle.Success).setDisabled(state.price_adjust), // Desabilita compra em P2P
                    new ButtonBuilder().setCustomId(`transacao_venda|${state.interactionId}`).setLabel('Vender').setStyle(ButtonStyle.Primary)
                );
            await interaction.editReply({
                content: `Você deseja comprar ou vender nesta loja?`,
                components: [buttons],
                flags: [] // A escolha é pública
            });
            state.shopMessageId = (await interaction.fetchReply()).id; // Salva o ID da mensagem (dos botões)
         }

        // +++ NOVO: Abre a brecha de rolagem DEPOIS de a mensagem da loja existir +++
        if (state.persuasionCD && !state.persuasionAttempted && state.shopMessageId && possibilidades !== 'compra e venda') {
            await openRollBrecha(interaction, state, state.shopMessageId);
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
            // Edita a mensagem PÚBLICA de seleção de char para "A carregar..."
            await interaction.update({ content: 'Carregando personagem...', components: [] });
            
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

            // +++ NOVO: Verifica P2P (Mesma Conta) após seleção de char +++
            if (state.price_adjust && state.buyerInfo) {
                if (state.character.row.get('JOGADOR').trim().toLowerCase() === state.buyerInfo.characterRow.get('JOGADOR').trim().toLowerCase()) {
                    await interaction.editReply({ content: 'Erro: Você não pode realizar transações entre personagens da mesma conta.', components: [] });
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
        /*if (!state || interaction.user.id !== state.ownerId) {
            await interaction.reply({ content: 'Esta interação expirou ou não pertence a você.', ephemeral: true });
            return;*/
        // +++ INÍCIO DA REESTRUTURAÇÃO +++
        // 1. Verifica primeiro os botões P2P, que têm uma lógica de permissão diferente
        if (action === 'p2p_trade_accept' || action === 'p2p_trade_decline') {
            
            // Este state é DIFERENTE. É o state da *proposta pendente*.
            // Usamos interaction.message.id porque o 'interactionId' do customId é o ID da mensagem
            const p2p_state_wrapper = interaction.client.pendingP2PTrades.get(interactionId);
            const p2p_state = p2p_state_wrapper?.data;

            if (!p2p_state) {
                await interaction.reply({ content: 'Esta proposta de transação expirou.', ephemeral: true });
                await interaction.message.edit({ content: interaction.message.content + "\n\n**PROPOSTA EXPIRADA**", components: [] }).catch(()=>{});
                return;
            }

            // Verifica se quem clicou é o COMPRADOR
            if (interaction.user.id !== p2p_state.buyer.id) {
                await interaction.reply({ content: 'Apenas o comprador pode aceitar ou recusar esta proposta.', ephemeral: true });
                return;
            }

            // Remove o state pendente
            interaction.client.pendingP2PTrades.delete(interaction.message.id);

            // (Importa o utils aqui dentro para evitar dependência circular)
            const { handleP2PConfirmation } = require('../utils/transacaoUtils.js');

            if (action === 'p2p_trade_decline') {
                await interaction.deferUpdate();
                await interaction.editReply({ 
                    content: interaction.message.content + `\n\n**PROPOSTA RECUSADA** por ${interaction.user}.`, 
                    components: [] 
                });
            } else {
                // (action === 'p2p_trade_accept')
                // Responde à interação PRIMEIRO
                await interaction.update({ 
                    content: interaction.message.content + "\n\n**PROCESSANDO TRANSAÇÃO...** ⏳", 
                    components: [] 
                });
                // Chama a lógica pesada de verificação e transferência
                // A função agora retorna a mensagem de resultado
                const resultMessage = await handleP2PConfirmation(interaction, p2p_state);
                // Edita a mensagem UMA ÚLTIMA vez com o resultado final
                await interaction.editReply({ content: resultMessage, components: [] });
            }
            return; // << FIM DA LÓGICA P2P
        }

        // --- Botão 'Comprar' (após 'compra e venda') ---
        if (action === 'transacao_compra') {
            state.activeMenu = 'compra'; // <<< GUARDA O MENU ATIVO

            // +++ MUDANÇA: Atualiza a mensagem *antes* de carregar os dados +++
            // +++ CORREÇÃO: Remove o 'fetchReply' e usa o 'interaction.message.id' +++
            const shopMessage = await interaction.update({ content: 'Carregando a loja... ⏳', components: [], fetchReply: true });
            state.shopMessageId = interaction.message.id; // Salva o ID da mensagem da loja

            // +++ MUDANÇA: Chama a nova função de paginação, começando na página 0 +++
            const { content, components } = await buildPaginatedShopMenu(state, 0); //
            await interaction.editReply({ content: content, components: components });

            // +++ CORREÇÃO: Abre a brecha AGORA +++
            if (state.persuasionCD && !state.persuasionAttempted) {
                await openRollBrecha(interaction, state, state.shopMessageId);
            }

        // --- Botão 'Vender' (após 'compra e venda') ---
        } else if (action === 'transacao_venda') {
            state.activeMenu = 'venda'; // <<< GUARDA O MENU ATIVO

            // +++ MUDANÇA: Atualiza a mensagem *antes* de carregar os dados +++
            await interaction.update({ content: 'Carregando seu inventário para venda... ⏳', components: [] });
            state.shopMessageId = interaction.message.id;

            const { content, components } = await buildSellSelectMenu(state, 0, state.price_adjust);
            await interaction.editReply({ content: content, components: components });

            // +++ CORREÇÃO: Abre a brecha AGORA +++
            if (state.persuasionCD && !state.persuasionAttempted) {
                await openRollBrecha(interaction, state, state.shopMessageId);
            }

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
            
            // Atualiza a mensagem
            await interaction.update({ content: content, components: components });

        // +++ NOVO: Lógica dos Botões de Paginação (Venda) +++
        } else if (action === 'transacao_venda_prev' || action === 'transacao_venda_next') {
            const page = parseInt(customIdParts[2]) || 0;
            const newPage = (action === 'transacao_venda_next') ? page + 1 : page - 1;

            // Reconstrói o menu de venda na nova página
            const { content, components } = await buildSellSelectMenu(state, newPage, state.price_adjust);
            await interaction.update({ content: content, components: components });

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

            // +++ MUDANÇA: Verifica se é P2P ou Venda Normal +++
            if (state.price_adjust) {
                // --- FLUXO P2P ---
                // 1. Calcula o preço total sugerido
                let totalSuggestedPrice = 0;
                for (const item of state.itemsToSell) {
                    // Extrai o preço da descrição (ex: "Sugestão: 1.25 PO")
                    const priceMatch = item.description.match(/Sugestão: ([\d\.]+)/);
                    if (priceMatch) {
                        totalSuggestedPrice += parseFloat(priceMatch[1]);
                    }
                }

                // 2. Mostra o modal de definição de preço
                const modal = new ModalBuilder()
                    .setCustomId(`transacao_venda_modal|${interactionId}`) // O novo modal
                    .setTitle('Definir Preço da Venda P2P');
                
                const priceInput = new TextInputBuilder()
                    .setCustomId('p2p_price_input')
                    .setLabel("Preço Total da Venda (em PO)")
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder("Ex: 150.75")
                    .setValue(totalSuggestedPrice.toFixed(2)) // Preenche com a sugestão
                    .setRequired(true);

                modal.addComponents(new ActionRowBuilder().addComponents(priceInput));
                await interaction.showModal(modal);

            } else {
                // --- FLUXO VENDA NORMAL ---
                await processVenda(interaction, state);
                interaction.client.pendingLoots.delete(interactionId);
            }

        
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
                const { content, components } = await buildSellSelectMenu(state, 0, state.price_adjust);
                await interaction.editReply({ content: content, components: components });
            }

            // +++ NOVO: Lógica do Modal de Preço P2P +++
        } else if (action === 'transacao_venda_modal') {
            await interaction.deferUpdate(); // Confirma o modal de preço
            const finalPrice = interaction.fields.getTextInputValue('p2p_price_input').replace(',', '.');
            
            if (isNaN(parseFloat(finalPrice)) || parseFloat(finalPrice) < 0) {
                await interaction.followUp({ content: 'Valor inválido. Insira apenas números (ex: 150 ou 25.50).', ephemeral: true });
                return;
            }

            state.proposedPrice = parseFloat(finalPrice); // Salva o preço no state

            // Chama a função que posta a mensagem de confirmação "Sim/Não"
            await postP2PConfirmation(interaction, state);

            // +++ REQUERIMENTO 1: Apaga a mensagem da loja (menu de seleção) +++
            try {
                if (state.shopMessageId) {
                    await interaction.channel.messages.delete(state.shopMessageId);
                }
            } catch (e) {
                console.warn(`[WARN transacao P2P] Falha ao apagar msg da loja (seleção de itens): ${e.message}`);
            }
            
            // Limpa o state original do /transacao
            interaction.client.pendingLoots.delete(interactionId);
            
            // Confirma ao VENDEDOR que a proposta foi enviada
            // await interaction.followUp({ content: 'Proposta de transação enviada ao comprador!', ephemeral: true });


            // +++ NOVO: Lógica do Modal de Confirmação de Cancelamento +++
        } else if (action === 'transacao_cancelar_confirm') {
            await interaction.deferUpdate(); // Confirma o modal

            try {
                // Pega o ID da mensagem da loja (que já guardámos)
                const msgId = state.shopMessageId || interaction.message.id; // O ID da mensagem do botão
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