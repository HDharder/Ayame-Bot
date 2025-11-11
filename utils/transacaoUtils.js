// utils/transacaoUtils.js
const { docSorteio, docControle, docComprasVendas, docInventario, docCraft, getValuesFromSheet, lookupIds, saveRow } = require('./google.js'); // +++ Importa saveRow
const { findUserCharacters, buildInventoryEmbed } = require('./inventarioUtils.js'); //
const { batchUpdateInventories, batchRemoveInventories } = require('./inventoryManager.js'); //
const { parseInventoryString, getItemCategory } = require('./itemUtils.js'); //
const { buildPaginatedSelectMenu } = require('./lootSelectMenuManager.js'); // (Reutilizado para Venda)
const { buildDynamicQuantityModal, MAX_MODAL_ITEMS } = require('./modalUtils.js'); // (O novo modal)
const {
    StringSelectMenuBuilder,
    StringSelectMenuOptionBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    userMention
} = require('discord.js');

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// <<< NOVO: Importa o filterManager >>>
const { 
    buildFilterButton, 
    applyTextFilter,
    formatFilterToString
} = require('./filterManager.js'); 
// (Os 'handlers' do filtro ficam no commands/transacao.js)


/*const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms)); //

// Cache para as regras do mercado (para não ler a planilha 'Player ID' a toda a hora)
const marketRulesCache = new Map();*/

/**
 * (NOVA FUNÇÃO) Gera uma string de data/hora formatada (dd/mm/aa hh:mm)
 * aplicando o offset do .env (DIFERENCA_HORA).
 * @returns {string}
 */
function getFormattedTimestamp() {
    const now = new Date();
    // Puxa o offset (ex: -3, -4) do .env
    const horaOffset = parseInt(process.env.DIFERENCA_HORA) || 0; 
    
    // 1. Converte a hora local do servidor para UTC
    const localOffsetInMs = now.getTimezoneOffset() * 60 * 1000;
    const utcTime = now.getTime() + localOffsetInMs;
    
    // 2. Aplica o offset desejado (ex: -4 horas)
    const targetOffsetInMs = horaOffset * 60 * 60 * 1000;
    const adjustedDate = new Date(utcTime + targetOffsetInMs);

    // 3. Formata para dd/mm/aa hh:mm
    const dia = String(adjustedDate.getDate()).padStart(2, '0');
    const mes = String(adjustedDate.getMonth() + 1).padStart(2, '0'); // getMonth() é 0-indexed
    const ano = String(adjustedDate.getFullYear()).slice(-2);
    const hora = String(adjustedDate.getHours()).padStart(2, '0');
    const min = String(adjustedDate.getMinutes()).padStart(2, '0');

    return `${dia}/${mes}/${ano} ${hora}:${min}`;
}

/**
 * Busca as regras de um mercado (canal) e armazena em cache.
 * @param {string} channelId - O ID do canal ou do canal pai (fórum).
 * @returns {Promise<object|null>} - O objeto de regras ou null.
 */
async function getMarketRules(channelId) {
    /*if (marketRulesCache.has(channelId)) {
        return marketRulesCache.get(channelId);
    }*/
    
    await docSorteio.loadInfo(); //
    const sheet = docSorteio.sheetsByTitle['Player ID']; //
    if (!sheet) throw new Error("Aba 'Player ID' não encontrada.");

    await sheet.loadHeaderRow(1);
    const rows = await sheet.getRows();

    for (const row of rows) {
        const idMercado = row.get('ID do mercado');
        if (idMercado === channelId) {
            const rule = {
                id: idMercado,
                possibilidades: row.get('possibilidades')?.toLowerCase() || '',
                tipoDeLoja: row.get('tipo de loja') || '', // Mantém o case original para `*`, `[]`, `{}`
                tipoMercado: row.get('Tipo_Mercado')?.toLowerCase() || 'text',
                validSell: row.get('Valid_sell') || ''
            };
            //marketRulesCache.set(channelId, rule);
            return rule;
        }
    }
    
    //marketRulesCache.set(channelId, null); // Cache 'null' para não procurar de novo
    return null;
}

/**
 * Valida o canal da interação, verificando se é um mercado válido.
 * @param {import('discord.js').Interaction} interaction
 * @returns {Promise<object|null>} - As regras do mercado, ou null se inválido.
 */
async function validateMarketChannel(interaction) {
    const channel = interaction.channel;
    
    // Tenta o ID do canal (para 'text')
    let rules = await getMarketRules(channel.id);
    
    // Se falhar e for um Fórum (ou Post de Fórum), tenta o 'parentId'
    if (!rules && channel.parentId) {
        rules = await getMarketRules(channel.parentId);
    }
    
    if (!rules) {
        await interaction.reply({ content: 'Este comando não pode ser usado neste canal.', ephemeral: true });
        return null;
    }

    // Validação de Tipo (ex: 'forum', 'text')
    if (rules.tipoMercado === 'forum' && !channel.isThread()) {
        await interaction.reply({ content: 'Este comando só pode ser usado dentro de um post do fórum.', ephemeral: true });
        return null;
    }
    if (rules.tipoMercado === 'category' && channel.parentId !== rules.id) {
         await interaction.reply({ content: 'Este comando só pode ser usado dentro da categoria designada.', ephemeral: true });
        return null;
    }
    
    return rules;
}

/**
 * Verifica se o jogador está numa mesa ativa (regra '*')
 * @param {string} username - Username do jogador.
 * @param {string} charName - Nome do personagem.
 * @returns {Promise<boolean>}
 */
async function validateMesaCheck(username, charName) {
    await docControle.loadInfo(); //
    const sheet = docControle.sheetsByTitle['Historico']; //
    if (!sheet) throw new Error("Aba 'Historico' não encontrada.");
    
    await sheet.loadHeaderRow(1);
    const rows = await sheet.getRows();

    for (const row of rows) {
        // Apenas verifica mesas que AINDA NÃO foram finalizadas
        const mesaFinalizada = row.get('Mesa Finalizada') || 'Não'; //
        if (mesaFinalizada.trim().toLowerCase() === 'sim') {
            continue;
        }

        // Procura o personagem nas colunas F-K (índices 5-10)
        for (let i = 5; i <= 10; i++) {
            const cellData = row._rawData[i];
            if (!cellData || String(cellData).trim() === '') continue;

            const cellString = String(cellData);
            const parts = cellString.split(' - ');
            
            if (parts.length >= 3) {
                const tag = parts[0].trim();
                const char = parts.slice(1, -1).join(' - ').trim();
                
                // Compara jogador E personagem
                if (tag.toLowerCase() === username.toLowerCase() && char.toLowerCase() === charName.toLowerCase()) {
                    return true; // Encontrou em mesa ativa!
                }
            }
        }
    }
    
    return false; // Não encontrou em nenhuma mesa ativa
}


// PLACEHOLDERS para funções futuras
async function handleServicos(interaction, state) {
    await interaction.editReply({ content: 'A funcionalidade de Serviços ainda não foi implementada.', components: [] });
}
async function handlePlayerShop(interaction, state) {
     await interaction.editReply({ content: 'A funcionalidade de Lojas de Jogador ainda não foi implementada.', components: [] });
}

/**
 * Constrói o menu de Compra (Seleção de Itens da Loja)
 * @param {object} state - O estado da transação.
 * @param {number} page - A página a ser exibida (base 0).
 */
async function buildPaginatedShopMenu(state, page = 0) {
    const { tipoDeLojaLimpo, interactionId, shopFilter, subLojaNome, persuasionSuccess } = state;
    await docComprasVendas.loadInfo(); //
    const sheet = docComprasVendas.sheetsByTitle[tipoDeLojaLimpo];
    if (!sheet) throw new Error(`Aba da loja "${tipoDeLojaLimpo}" não encontrada.`);

    // +++ INÍCIO DA CORREÇÃO (CACHE DE LEITURA) +++
    let allRows;
    if (!state.shopRowsCache) {
        console.log(`[ShopCache] Cache de COMPRA (state.shopRowsCache) vazio. Buscando...`);
        await sheet.loadHeaderRow(1);
        state.shopRowsCache = await sheet.getRows();
    }
    allRows = state.shopRowsCache;
    // +++ FIM DA CORREÇÃO +++

    // +++ 2. FILTRO DE SUB-LOJA +++
    let baseRows = allRows;
    if (subLojaNome) {
        baseRows = allRows.filter(row => 
            row.get('Loja') && row.get('Loja').trim().toLowerCase() === subLojaNome.toLowerCase()
        );
    }

    // +++ 2. Lógica de Filtragem (Compra) - AGORA USA O MANAGER +++
    const keywords = shopFilter || [];
    const filteredRows = applyTextFilter(baseRows, keywords, (item) => item.get('Item')); //

    const ITEMS_PER_PAGE = 25; // Limite de opções de um Select Menu
    const options = [];

    // Move o botão de finalizar para cima, para podermos desabilitá-lo
    // +++ LÓGICA DE PREÇO (Persuasão) +++
    const priceCol = persuasionSuccess ? 'Preço (cd)' : 'Preço'; //
    const priceLabel = persuasionSuccess ? 'Preço (CD)' : 'Preço';
    
    for (const row of filteredRows) {
        const itemNome = row.get('Item');
        const itemPreco = parseFloat(row.get(priceCol)?.replace(',', '.')) || 0;

        let quant = 0;
        let descricaoEstoque = "Estoque ilimitado"; // Padrão
        
        // Se a loja tem [Estoque], só mostra itens com estoque > 0
        if (state.hasEstoque) {
            quant = parseInt(row.get('Estoque')) || 0;
            if (quant <= 0) continue; // Pula o item se o estoque for 0
            descricaoEstoque = `Em estoque: ${quant}`; // Texto pedido
        }

        if (itemNome && itemPreco > 0) {
            options.push(
                new StringSelectMenuOptionBuilder()
                    .setLabel(itemNome.substring(0, 100))
                    .setDescription(`${priceLabel}: ${itemPreco.toFixed(2)} PO | ${descricaoEstoque}`)
                    // O 'value' será o nome exato para o modal dinâmico
                    .setValue(itemNome.substring(0, 100)) 
            );
        }
    }

    // +++ LÓGICA DE PAGINAÇÃO +++
    const totalPages = Math.max(1, Math.ceil(options.length / ITEMS_PER_PAGE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1)); // Garante que a página é válida
    const startIndex = safePage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const itemsToShow = options.slice(startIndex, endIndex); // "Fatia" os itens para esta página

    const finalizeButton = new ButtonBuilder()
        .setCustomId(`transacao_compra_finalizar|${interactionId}`)
        .setLabel('Definir Quantidades')
        .setStyle(ButtonStyle.Success);
    
    const selectMenu = new StringSelectMenuBuilder()
        // O CustomID agora inclui a página
        .setCustomId(`transacao_compra_select|${interactionId}|${safePage}`)
        //.setPlaceholder(`Pág. ${safePage + 1}/${totalPages} (Selecione até ${MAX_MODAL_ITEMS} itens)`)
        //.setMinValues(1)
        //.setMaxValues(MAX_MODAL_ITEMS)
        //.addOptions(itemsToShow);
    
    // +++ CORREÇÃO: Declara os botões ANTES do bloco 'if' +++
    // Botões de Paginação
    const prevButton = new ButtonBuilder()
        .setCustomId(`transacao_page_prev|${interactionId}|${safePage}`)
        .setLabel('◀️ Anterior')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 0);

    const nextButton = new ButtonBuilder()
        .setCustomId(`transacao_page_next|${interactionId}|${safePage}`)
        .setLabel('Próxima ▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage + 1 >= totalPages);

    // +++ 4. Adiciona o Botão de Filtro (AGORA USA O MANAGER) +++
    const filterButton = buildFilterButton(`transacao_filtro_compra|${interactionId}`, safePage); //

    // +++ ADICIONADO: Botão de Cancelar +++
    const cancelButton = new ButtonBuilder()
        .setCustomId(`transacao_cancelar_modal|${interactionId}`)
        .setLabel('Cancelar')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌');

    // Trata Menu Vazio
    if (itemsToShow.length === 0) {
        // Usa 'options.length' para saber se o filtro falhou ou se a página está vazia
        const placeholder = (options.length === 0 && keywords.length > 0) 
            ? 'Nenhum item encontrado com este filtro' 
            : 'Não há itens nesta página';
        selectMenu.setPlaceholder(placeholder)
            .setMinValues(1)
            .setMaxValues(1) // Requerido pelo setDisabled
            .addOptions(new StringSelectMenuOptionBuilder().setLabel('placeholder').setValue('placeholder').setDescription('placeholder'))
            .setDisabled(true);
        finalizeButton.setDisabled(true); // Desabilita Finalizar se não há o que selecionar
    // +++ ADICIONADO: Também desabilita a paginação se não houver itens +++
        prevButton.setDisabled(true);
        nextButton.setDisabled(true);
    } else {
        selectMenu.setPlaceholder(`Pág. ${safePage + 1}/${totalPages} (Selecione até ${MAX_MODAL_ITEMS} itens)`)
            .setMinValues(1)
            .setMaxValues(Math.min(itemsToShow.length, MAX_MODAL_ITEMS))
            .addOptions(itemsToShow);
    }

    // Botões de Paginação
    /*const prevButton = new ButtonBuilder()
        .setCustomId(`transacao_page_prev|${interactionId}|${safePage}`)
        .setLabel('◀️ Anterior')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 0);

    const nextButton = new ButtonBuilder()
        .setCustomId(`transacao_page_next|${interactionId}|${safePage}`)
        .setLabel('Próxima ▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage + 1 >= totalPages);

    // +++ 4. Adiciona o Botão de Filtro +++
    const filterButton = buildFilterButton(`transacao_filtro_compra|${interactionId}`, safePage); */

    const filterText = keywords.length > 0 ? `\n**Filtro Ativo:** \`${formatFilterToString(keywords)}\`` : '';
    const content = `Selecione os itens que deseja comprar da loja **${tipoDeLojaLimpo}**.\n` +
                    `*Atenção: Você só pode definir a quantidade de ${MAX_MODAL_ITEMS} tipos de itens por vez.*\n` +
                    `**Exibindo Página ${safePage + 1} de ${totalPages}** (${filteredRows.length} itens encontrados) `+
                    filterText;
        
    return { 
        content: content,
        components: [
            new ActionRowBuilder().addComponents(selectMenu),
            new ActionRowBuilder().addComponents(prevButton, nextButton, filterButton, finalizeButton, cancelButton)
        ]
    };
}

/**
 * Processa a compra após o modal de quantidade.
 * @param {import('discord.js').ModalSubmitInteraction} interaction - A interação do Modal.
 * @param {object} state - O estado da transação.
 */
async function processCompra(interaction, state) {
    await interaction.deferUpdate(); //

    try {
        if (state.shopMessageId) { //
            await interaction.channel.messages.edit(state.shopMessageId, { content: 'Processando sua compra... ⏳', components: [] });
        } else {
            throw new Error("state.shopMessageId não foi definido. A mensagem do menu não pôde ser editada.");
        }
    } catch (e) {
        console.warn(`[WARN processCompra] Falha ao editar a msg do menu para "Processando": ${e.message}`);
    }

    const { character, tipoDeLojaLimpo, hasEstoque, isCaravana, selectedItems, shopMessageId, subLojaNome, persuasionSuccess } = state; // <<< Puxa o subLojaNome
    const playerRow = character.row; // A linha da planilha Inventário

    // +++ CORREÇÃO: Fecha a brecha de rolagem (se houver) +++
    await closeRollBrecha(interaction.client, interaction.channel.id, playerRow.get('JOGADOR'));

    
    await docComprasVendas.loadInfo(); //
    const shopSheet = docComprasVendas.sheetsByTitle[tipoDeLojaLimpo];
    const logSheet = docComprasVendas.sheetsByTitle['Registro'];
    if (!shopSheet) throw new Error(`Aba da loja "${tipoDeLojaLimpo}" não encontrada na planilha de Compras.`);
    if (!logSheet) throw new Error("Aba 'Registro' não encontrada na planilha de Compras.");
    
    await shopSheet.loadHeaderRow(1);
    const shopRows = await shopSheet.getRows();
    
    // +++ FILTRO DE SUB-LOJA (para Compra) +++
    let baseShopRows = shopRows;
    if (subLojaNome) {
        baseShopRows = shopRows.filter(row =>
            row.get('Loja') && row.get('Loja').trim().toLowerCase() === subLojaNome.toLowerCase()
        );
    }

    const priceCol = persuasionSuccess ? 'Preço (cd)' : 'Preço';

    const shopItemsMap = new Map();
    baseShopRows.forEach(r => shopItemsMap.set(r.get('Item'), r)); // Mapeia itens da loja pelo nome

    let totalCost = 0;
    const itemsToBuy = [];
    const itemsToLog_Registro = []; // <<< NOVO: Para o log detalhado
    const itemsToLog_Caravana = []; // <<< NOVO: Para a caravana (sem preço)
    const errors = [];
    const warnings = []; // <<< NOVO: Para avisos de estoque
    const shopRowsToSave = []; // <<< NOVO: Para salvar o novo estoque

    // +++ CORREÇÃO: Itera pelo 'selectedItems' (que guardámos no state) +++
    // em vez de iterar pelos 'components' do modal.
    for (const item of selectedItems) {
        const itemName = item.value; // O 'customId' do campo do modal
        
        // Busca o valor do campo de texto usando o seu customId
        const quantityString = interaction.fields.getTextInputValue(itemName);
        let quantity = parseInt(quantityString);
        if (isNaN(quantity) || quantity <= 0) {
            errors.push(`Quantidade inválida para ${itemName}.`);
            continue;
        }

        const shopItem = shopItemsMap.get(itemName);
        if (!shopItem) {
            errors.push(`Item ${itemName} não encontrado na loja (pode ter sido removido).`);
            continue;
        }

        const price = parseFloat(shopItem.get(priceCol)?.replace(',', '.')) || 0;
        
        // Validação de Estoque
        if (hasEstoque) {
            const stock = parseInt(shopItem.get('Estoque')) || 0;
            if (quantity > stock) {
                warnings.push(`Estoque de ${itemName} insuficiente (Disponível: ${stock}, Pedido: ${quantity}). **Você pegou apenas ${stock}.**`);
                quantity = stock; // Pega o máximo disponível
            }

            const newStock = stock - quantity;
            shopItem.set('Estoque', newStock); // Define o novo valor na linha
            shopRowsToSave.push(shopItem); // Adiciona a linha para ser salva

            // (Aqui chamaremos a 'batchUpdateStock' no futuro)
        }

        // Se a quantidade (após verificação de estoque) for 0, pula o item
        if (quantity === 0) continue;

        totalCost += (price * quantity);
        itemsToBuy.push({
            name: itemName,
            validationName: itemName.split('[')[0].trim(), //
            amount: quantity
        });
        itemsToLog_Caravana.push(`${quantity}x ${itemName}`);
        itemsToLog_Registro.push(`${quantity}x ${itemName} (${price.toFixed(2).replace('.', ',')} PO/un)`); // <<< MUDANÇA: Adiciona vírgula
    }

    // Validação de Ouro
    const playerGold = parseFloat(playerRow.get('Total')) || 0; //
    if (totalCost > playerGold) {
        errors.push(`Você não tem ouro suficiente (Necessário: ${totalCost.toFixed(2)} PO, Possui: ${playerGold.toFixed(2)} PO).`);
    }

    if (errors.length > 0) {
        await interaction.followUp({ content: `A transação falhou:\n• ${errors.join('\n• ')}`, ephemeral: true });
        return;
    }
    
    // --- SUCESSO - Processar Transação ---
    const playerPayload = {
        username: playerRow.get('JOGADOR'),
        characterName: playerRow.get('PERSONAGEM'),
        changes: {}
    };

    // 1. Remover Ouro do Jogador
    //
    const goldRemovePayload = [{ ...playerPayload, changes: { gold: totalCost } }];
    const removeSuccess = await batchRemoveInventories(goldRemovePayload, interaction.client);
    
    // 2. Adicionar Itens
    let addSuccess = true;
    if (isCaravana) {
        // Lógica da Caravana
        const caravanSheet = docComprasVendas.sheetsByTitle['Caravana Bastião'];
        if (!caravanSheet) throw new Error("Aba 'Caravana Bastião' não encontrada na planilha de Compras.");
        const dataCompra = getFormattedTimestamp(); // <<< USA A NOVA FUNÇÃO
        
        let previsao = "Data (H1) não encontrada"; //

        try {
            // 1. Carrega a célula H1 (onde está a data base)
            await caravanSheet.loadCells('H1');
            const cellH1 = caravanSheet.getCellByA1('H1');
            const dataBaseString = cellH1.formattedValue; // Pega a data formatada (ex: "05/11/2025")

            if (dataBaseString) {
                // 2. Parseia a data "dd/mm/aaaa"
                let [dia, mes, ano] = dataBaseString.split('/');

                // +++ CORREÇÃO: Força o ano para 4 dígitos (assume 20xx) +++
                if (ano.length === 2) {
                    ano = `20${ano}`;
                }
                const dataBase = new Date(ano, mes - 1, dia); // Agora: new Date(2025, 10, 3)

                // 3. Adiciona 7 dias
                //dataBase.setDate(dataBase.getDate() + 7);

                // 4. Formata de volta para "dd/mm/aaaa"
                previsao = dataBase.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
            }
        } catch (dateError) {
            console.error("[ERRO processCompra] Falha ao calcular data da caravana (H1):", dateError);
            previsao = "Erro ao calcular data";
        }
        
        await caravanSheet.addRow({
            'Jogador': playerRow.get('JOGADOR'),
            'Personagem': playerRow.get('PERSONAGEM'),
            'Data da compra': dataCompra,
            'Compras': itemsToLog_Caravana.join(', '),
            'Previsão de chegada': previsao
        });
    } else {
        // Adiciona direto ao inventário
        //
        const itemAddPayload = [{ ...playerPayload, changes: { itemsToAdd: itemsToBuy } }];
        addSuccess = await batchUpdateInventories(itemAddPayload, interaction.client);
    }
    
    // 3. Registrar Log
    const dataLog = getFormattedTimestamp(); // <<< USA A NOVA FUNÇÃO
    await logSheet.addRow({
        'Jogador': playerRow.get('JOGADOR'),
        'Personagem': playerRow.get('PERSONAGEM'),
        'Data': dataLog,
        'Local': tipoDeLojaLimpo,
        'Tipo': 'Compra',
        'Total': totalCost.toFixed(2).replace('.', ','), // <<< MUDANÇA: Adiciona vírgula
        'Transação': itemsToLog_Registro.join(', ') // <<< MUDANÇA: Usa a string detalhada
    });

    // 4. Salvar o Estoque (SÓ SE a transação foi bem-sucedida)
    if (hasEstoque && shopRowsToSave.length > 0) {
        console.log(`[INFO processCompra] Atualizando estoque para ${shopRowsToSave.length} itens...`);
        try {
            for (const rowToSave of shopRowsToSave) {
                await saveRow(rowToSave); // +++ CORREÇÃO (BUG 3): Usa a fila
                // await delay(1000); // Delay para não sobrecarregar a API
            }
        } catch (stockError) {
            console.error("[ERRO processCompra] Falha ao salvar novo estoque:", stockError);
            // Não falha a transação inteira, mas avisa o staff
            await interaction.followUp({ content: 'AVISO DE STAFF: A compra foi concluída, mas falhei ao atualizar o estoque da loja. Verifique a planilha.', ephemeral: true });
        }
    }
    
    if (removeSuccess && addSuccess) {
        let successMessageContent = `Compra de ${userMention(interaction.user.id)} (`+
            `${playerRow.get('PERSONAGEM')}) finalizada com sucesso!\n\n` +
            `**Total Gasto:** ${totalCost.toFixed(2).replace('.', ',')} PO\n` + // <<< MUDANÇA: Adiciona vírgula
            `**Itens Comprados:**\n• ${itemsToLog_Registro.join('\n• ')}\n\n` + // <<< MUDANÇA: Usa a string detalhada
            (isCaravana ? `*Seus itens foram enviados para a Caravana e chegarão em breve!*` : `*Seu inventário foi atualizado.*`);

        if (warnings.length > 0) {
            successMessageContent += `\n\n**Avisos:**\n• ${warnings.join('\n• ')}`;
        }

        await interaction.channel.send({ content: successMessageContent });
        // +++ CORREÇÃO: Apaga a mensagem usando o ID guardado no state +++
        if (shopMessageId) await interaction.channel.messages.delete(shopMessageId).catch(e => console.warn(`[WARN processCompra] Falha ao apagar msg do menu da loja: ${e.message}`));
    } else {
         await interaction.channel.send({ content: `Compra processada para ${userMention(interaction.user.id)}, mas ocorreu um erro ao atualizar seu inventário na planilha. Avise um Staff.` });
         if (shopMessageId) await interaction.channel.messages.delete(shopMessageId).catch(e => console.warn(`[WARN processCompra] Falha ao apagar msg do menu da loja: ${e.message}`));
    }
}

// +++ INÍCIO DA REFORMULAÇÃO (Venda) +++

// Mapeia as categorias de 'Valid_sell' para as colunas da planilha de Inventário
const categoryToInventoryColumnMap = {
    'itens mundanos': 'Itens Mundanos',
    'armas': 'Armas',
    'escudos/armaduras': 'Escudos/Armaduras',
    'consumíveis mágicos': 'Consumíveis Mágicos',
    'itens mágicos': 'Itens Mágicos',
    'materiais': 'Materiais',
    'ervas': 'Ervas',
    'misc': 'Misc',
    // Mapeamentos de conveniência
    'itens': 'Itens Mágicos',
    'poção': 'Consumíveis Mágicos'
};

// Mapeia as categorias para as planilhas e colunas de preço na Tabela de Craft
const categoryToCraftPriceMap = {
    'itens mundanos': { sheet: 'Itens Mundanos', nameCol: 'Name', priceCol: 'Valor' },
    'materiais': { sheet: 'Materiais', nameCol: 'Material', priceCol: 'Preço Base' },
    'ervas': { sheet: 'Ervas', nameCol: 'Nome da Erva', priceCol: 'Preço (PO)' },
    'itens': { sheet: 'Itens', nameCol: 'Name', priceCol: 'Preço de Venda' },
    // Mapeamentos de conveniência (apontam para o mesmo lugar)
    'itens mágicos': { sheet: 'Itens', nameCol: 'Name', priceCol: 'Preço de Venda' },
    'consumíveis mágicos': { sheet: 'Poção', nameCol: 'Name', priceCol: 'Preço de Venda' }
    // (Armas, Escudos, Misc... não têm preço de venda base por padrão, a menos que adicionados)
};

/**
 * (Helper) Carrega os preços de venda base das categorias necessárias do docCraft.
 * @param {Array<string>} categories - Array de nomes de categoria (ex: ["materiais", "poções"])
 * @returns {Promise<Map<string, number>>} - Um Map de <itemNameLower, basePrice>
 */
async function cacheSellPrices(categories) {
    const priceCache = new Map();
    const sheetsToFetch = new Map(); // Map<sheetName, priceColName>

    // 1. Determina quais planilhas e colunas precisamos ler
    for (const cat of categories) {
        const priceInfo = categoryToCraftPriceMap[cat.toLowerCase()];
        if (priceInfo) {
            if (!sheetsToFetch.has(priceInfo.sheet)) {
                sheetsToFetch.set(priceInfo.sheet, { nameCol: priceInfo.nameCol, priceCol: priceInfo.priceCol });
            }
        }
    }

    // 2. Carrega os dados
    await docCraft.loadInfo(); //
    for (const [sheetName, cols] of sheetsToFetch.entries()) {
        const { nameCol, priceCol } = cols;
        const sheet = docCraft.sheetsByTitle[sheetName];
        if (!sheet) {
            console.warn(`[cacheSellPrices] Aba de Craft "${sheetName}" não encontrada.`);
            continue;
        }
        // +++ INÍCIO DA CORREÇÃO (Evita 'Duplicate header') +++
        // Se for uma das abas problemáticas, usa o modo manual
        if (sheetName === 'Itens' || sheetName === 'Poção') {
            try {
                // 1. Carrega a Linha 1 (cabeçalho) para *encontrar* os índices
                await sheet.loadCells('A1:Z1'); 
                let nameColIndex = -1;
                let priceColIndex = -1;

                for (let i = 0; i < sheet.columnCount; i++) {
                    const cell = sheet.getCell(0, i); // Linha 0 = Linha 1 da planilha
                    if (cell.value === nameCol) nameColIndex = i;
                    if (cell.value === priceCol) priceColIndex = i;
                }

                if (nameColIndex === -1 || priceColIndex === -1) {
                    console.warn(`[cacheSellPrices] Aba "${sheetName}" não possui colunas '${nameCol}' ou '${priceCol}'.`);
                    continue;
                }
                
                // 2. Tira as LETRAS das colunas (ex: "A", "G") dos cabeçalhos (que JÁ carregámos)
                const nameColLetter = sheet.getCell(0, nameColIndex).a1Address.replace(/[0-9]/g, '');
                const priceColLetter = sheet.getCell(0, priceColIndex).a1Address.replace(/[0-9]/g, '');

                // 3. Constrói os intervalos manualmente (ex: "A2:A1000", "G2:G1000")
                const rangesToLoad = [
                    `${nameColLetter}2:${nameColLetter}${sheet.rowCount}`,
                    `${priceColLetter}2:${priceColLetter}${sheet.rowCount}`
                ];
                
                await sheet.loadCells(rangesToLoad);
                // 4. Itera pelas linhas manualmente
                for (let i = 1; i < sheet.rowCount; i++) { // Começa em 1 (dados)
                    const itemName = sheet.getCell(i, nameColIndex).value;
                    const itemPriceRaw = sheet.getCell(i, priceColIndex).value;
                    const itemPrice = parseFloat(String(itemPriceRaw)?.replace(',', '.')) || 0;
                    
                    if (itemName && itemPrice > 0) {
                        priceCache.set(String(itemName).toLowerCase(), itemPrice);
                    }
                }
            } catch (e) {
                console.error(`[cacheSellPrices] Erro no modo manual para ${sheetName}:`, e);
            }
        } else {
            // --- Comportamento Antigo (para 'Materiais', 'Ervas', etc.) ---
            await sheet.loadHeaderRow(1);
            if (!sheet.headerValues.includes(nameCol) || !sheet.headerValues.includes(priceCol)) {
                console.warn(`[cacheSellPrices] Aba "${sheetName}" não possui colunas '${nameCol}' ou '${priceCol}'.`);
                continue;
            }

            // +++ ESTE É O BLOCO QUE FALTAVA +++
            const rows = await sheet.getRows();
            for (const row of rows) {
                const itemName = row.get(nameCol);
                const itemPrice = parseFloat(row.get(priceCol)?.replace(',', '.')) || 0;
                if (itemName && itemPrice > 0) {
                    priceCache.set(itemName.toLowerCase(), itemPrice);
                }
            }
            // +++ FIM DO BLOCO QUE FALTAVA +++
        }
    }
    return priceCache;
}


/**
 * Constrói o menu de Venda (Seleção de Itens do Inventário do Jogador)
 * @param {object} state - O estado da transação.
 * @param {number} page - A página a ser exibida (base 0).
 * @param {boolean} price_adjust - Se deve mostrar "Sugestão" (P2P) em vez de "Venda".
 */
async function buildSellSelectMenu(state, page = 0, price_adjust = false) {
    const { interactionId, character, rules, tipoDeLojaLimpo, sellFilter, subLojaNome, persuasionSuccess, buyerInfo } = state;
    const playerRow = character.row;

    // --- 1. Buscar Regras de Venda e Itens da Loja ---
    const validSellRules = rules.validSell.split(',').map(s => s.trim().toLowerCase()); //
    const allowedCategories = new Set(validSellRules.map(s => s.replace('*', '')));
    const starredCategories = new Set(validSellRules.filter(s => s.endsWith('*')).map(s => s.replace('*', '')));

    await docComprasVendas.loadInfo(); //
    const shopSheet = docComprasVendas.sheetsByTitle[tipoDeLojaLimpo];
    if (!shopSheet) throw new Error(`Aba da loja "${tipoDeLojaLimpo}" não encontrada.`);
    
    await shopSheet.loadHeaderRow(1);

    // 1a. Pegar Fator de Venda (G2 ou I2)
    /*const fatorCol = persuasionSuccess ? 'Fator de Venda (cd)' : 'Fator de Venda'; //
    const priceLabel = persuasionSuccess ? 'Venda (CD)' : 'Venda';
    await shopSheet.loadCells('G2:H2'); // Carrega a célula correta
    const fatorDeVenda = parseFloat(shopSheet.getCell(1, shopSheet.headerValues.indexOf(fatorCol)).value) || 0.5;*/

    // +++ MUDANÇA: Define o fator e o rótulo com base no P2P +++
    let fatorDeVenda = 0.5; // Padrão
    let priceLabel = 'Venda';
    // Mapa de fatores para preço sugerido P2P
    const priceFactors = {
        'itens mundanos': 0.5, 'armas': 0.5, 'escudos/armaduras': 0.5,
        'itens mágicos': 0.5, 'itens': 0.5,
        'materiais': 1.0, 'ervas': 1.0, 'consumíveis mágicos': 1.0, 'poção': 1.0,
        'misc': 0.0
    };

    if (price_adjust) {
        priceLabel = 'Sugestão';
        // fatorDeVenda não é usado no modo P2P, usaremos priceFactors
    } else {
        // Modo Venda Loja
        const fatorCol = persuasionSuccess ? 'Fator de Venda (cd)' : 'Fator de Venda'; //
        priceLabel = persuasionSuccess ? 'Venda (CD)' : 'Venda';
        await shopSheet.loadCells('G2:H2'); // Carrega a linha 2, colunas G e H
        fatorDeVenda = parseFloat(shopSheet.getCell(1, shopSheet.headerValues.indexOf(fatorCol)).value) || 0.5;
    }


    // 1b. Pegar itens que a loja compra (para a regra *)
    const shopBuyItems = new Set();
    const shopRows = await shopSheet.getRows();
    // +++ FILTRO DE SUB-LOJA (para Venda) +++
    let baseShopRows = shopRows;
    if (subLojaNome) {
        baseShopRows = shopRows.filter(row =>
            row.get('Loja') && row.get('Loja').trim().toLowerCase() === subLojaNome.toLowerCase()
        );
    }

    baseShopRows.forEach(r => { // <<< Usa as linhas filtradas
        const itemName = r.get('Item');
        if (itemName) shopBuyItems.add(itemName.toLowerCase());
    });

    // --- 2. Buscar Preços Base do Craft ---
    // +++ INÍCIO DA CORREÇÃO (CACHE DE LEITURA) +++
    let priceCache;
    if (!state.priceCache) {
        console.log(`[ShopCache] Cache de VENDA (state.priceCache) vazio. Buscando...`);
        state.priceCache = await cacheSellPrices(allowedCategories);
    }
    priceCache = state.priceCache;
    // +++ FIM DA CORREÇÃO +++

    // --- 3. Filtrar Inventário e Expandir para Unidades ---
    const playerInventory = [];
    // Mapeia as categorias permitidas (ex: "poções") para as colunas do inventário (ex: "Consumíveis Mágicos")
    const inventoryColumnsToRead = new Set(
        [...allowedCategories].map(cat => categoryToInventoryColumnMap[cat.toLowerCase()])
    );

    for (const invCol of inventoryColumnsToRead) {
        if (!invCol) continue; // Categoria de venda não mapeada para coluna de inventário
        const itemString = playerRow.get(invCol) || '';
        const itemMap = parseInventoryString(itemString); //
        for (const [key, itemData] of itemMap.entries()) {
            // Guarda a categoria de origem (ex: "itens mundanos")
            const sourceCategory = [...allowedCategories].find(cat => categoryToInventoryColumnMap[cat] === invCol);
            playerInventory.push({ ...itemData, category: sourceCategory }); // itemData = { name, amount, category }
        }
    }

    // +++ 2. Lógica de Filtragem (Venda) +++
    const keywords = sellFilter || [];
    const filteredInventory = applyTextFilter(playerInventory, keywords, (item) => item.name); //

    const allItemUnits = [];
    for (const item of filteredInventory) {
        const itemKey = item.name.toLowerCase();
        // Precisamos determinar a categoria original do item (ex: 'poções') para checar a regra *
        const validationName = item.name.split('[')[0].trim();
        const basePrice = priceCache.get(validationName.toLowerCase()) || 0;
        let sellPrice = 0;

        if (price_adjust) {
            // --- Lógica P2P ---
            const factor = priceFactors[item.category] || 0.5; // Usa o fator P2P
            sellPrice = basePrice * factor;
            // (Permite itens com preço 0, ex: Misc)
        } else {
            // --- Lógica Venda Loja ---
            // Filtro 1: O item tem um preço base? (Se não, não é vendável)
            if (basePrice === 0) {
                console.warn(`[BuildSellMenu] Item "${item.name}" pulado (preço base 0).`);
                continue;
            }
            // Filtro 2: Regra da Estrela (*)
            if (item.category && starredCategories.has(item.category.toLowerCase())) {
                if (!shopBuyItems.has(itemKey)) {
                    console.warn(`[BuildSellMenu] Item "${item.name}" pulado (Regra * e loja não compra).`);
                    continue;
                }
            }
            sellPrice = basePrice * fatorDeVenda;
        }
        
        // 3d. Expande o item em unidades (como no /loot)
        if (sellPrice <= 0 && !price_adjust) continue; // Não exibe itens que a loja não compra (a menos que seja P2P)

        for (let i = 0; i < item.amount; i++) {
            allItemUnits.push({ 
                name: item.name, 
                unitIndex: i, 
                sellPrice: sellPrice,
                validationName: validationName // Guarda para o processamento final
            });
        }
    }

    // --- 4. Construir o Menu Paginado ---
    const ITEMS_PER_PAGE = 25;
    // +++ CORREÇÃO: Garante que totalPages é no mínimo 1 +++
    const totalPages = Math.max(1, Math.ceil(allItemUnits.length / ITEMS_PER_PAGE));
    const safePage = Math.max(0, Math.min(page, totalPages - 1));
    const startIndex = safePage * ITEMS_PER_PAGE;
    const endIndex = startIndex + ITEMS_PER_PAGE;
    const itemsToShow = allItemUnits.slice(startIndex, endIndex);

    // Move o botão de finalizar para cima
    const finalizeButton = new ButtonBuilder()
        .setCustomId(`transacao_venda_finalizar|${interactionId}`)
        .setLabel(price_adjust ? 'Definir Preço' : 'Finalizar Venda') // Label dinâmico
        .setStyle(ButtonStyle.Success);

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`transacao_venda_select|${interactionId}|${safePage}`)
        //.setPlaceholder(`Pág. ${safePage + 1}/${totalPages} (Selecione os itens para vender)`)
        //.setMinValues(0) // Permite não selecionar nada
        //.setMaxValues(itemsToShow.length) // Permite selecionar todos da página
        //.addOptions(itemsToShow.map(item => 
        //.setMaxValues(itemsToShow.length > 0 ? itemsToShow.length : 1); // Permite selecionar todos da página

    // Trata menu vazio
    if (itemsToShow.length === 0) {
        const placeholder = (allItemUnits.length === 0 && keywords.length > 0)
            ? 'Nenhum item encontrado com este filtro'
            : 'Não há itens nesta página';
        selectMenu.setPlaceholder(placeholder)
            .setMinValues(1)
            .addOptions(new StringSelectMenuOptionBuilder().setLabel('placeholder').setValue('placeholder').setDescription('placeholder'))
            .setDisabled(true)
            .setMaxValues(1);
        
        finalizeButton.setDisabled(true); // Desabilita Finalizar se não há o que selecionar
    } else {
        selectMenu.setPlaceholder(`Pág. ${safePage + 1}/${totalPages} (Selecione os itens para vender)`)
            .setMinValues(0) // Permite não selecionar nada
            .setMaxValues(itemsToShow.length) // Na Venda, pode selecionar todos (até 25)
            .addOptions(itemsToShow.map(item =>
            new StringSelectMenuOptionBuilder()
                .setLabel(item.name)
                .setDescription(`${priceLabel}: ${item.sellPrice.toFixed(2)} PO`)
                // O 'value' precisa ser único por item
                .setValue(`${item.name}|${item.unitIndex}`) 
            ));
    }

    // Botões
    const prevButton = new ButtonBuilder()
        .setCustomId(`transacao_venda_prev|${interactionId}|${safePage}`)
        .setLabel('◀️ Anterior')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage === 0);

    const nextButton = new ButtonBuilder()
        .setCustomId(`transacao_venda_next|${interactionId}|${safePage}`)
        .setLabel('Próxima ▶️')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(safePage + 1 >= totalPages);
    
    // +++ ADICIONADO: Botão de Cancelar +++
    const cancelButton = new ButtonBuilder()
        .setCustomId(`transacao_cancelar_modal|${interactionId}`)
        .setLabel('Cancelar')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌');

    // +++ ADICIONADO: Desabilita paginação se não houver itens +++
    if (itemsToShow.length === 0) {
        prevButton.setDisabled(true);
        nextButton.setDisabled(true);
    }

    // +++ 4. Adiciona o Botão de Filtro +++
    const filterButton = buildFilterButton(`transacao_filtro_venda|${interactionId}`, safePage); //

    const filterText = keywords.length > 0 ? `\n**Filtro Ativo:** \`${formatFilterToString(keywords)}\`` : '';
    // +++ MUDANÇA: Título dinâmico +++
    const content = price_adjust 
        ? `**Transação P2P com ${buyerInfo.characterRow.get('PERSONAGEM')}**\nSelecione os itens do *seu* inventário (${character.row.get('PERSONAGEM')}) que deseja vender.\n`
        : `Selecione os itens do seu inventário que deseja vender.\n` +
                    `**Exibindo Página ${safePage + 1} de ${totalPages}** (${allItemUnits.length} itens encontrados)` +
                    filterText;

    return {
        content: content,
        components: [
            new ActionRowBuilder().addComponents(selectMenu),
            new ActionRowBuilder().addComponents(prevButton, nextButton, filterButton, finalizeButton, cancelButton)
        ]
    };
}

/**
 * Processa a venda após a seleção dos itens.
 * @param {import('discord.js').Interaction} interaction - A interação do Botão.
 * @param {object} state - O estado da transação.
 */
async function processVenda(interaction, state) {
    await interaction.update({ content: 'Processando sua venda... ⏳', components: [] });

    const { character, tipoDeLojaLimpo, itemsToSell } = state;
    const playerRow = character.row;
    const username = playerRow.get('JOGADOR');
    const characterName = playerRow.get('PERSONAGEM');

    // +++ CORREÇÃO: Fecha a brecha de rolagem (se houver) +++
    await closeRollBrecha(interaction.client, interaction.channel.id, username);

    let totalGoldGained = 0;
    const aggregatedItems = new Map();
    const itemsToLog = [];

    // 1. Agregar itens e calcular ganhos
    for (const item of itemsToSell) {
        // Parseia o preço da description (ex: "Vender por: 1.00 PO")
        const priceMatch = item.description.match(/Venda(?: \(CD\))?: ([\d\.]+)/);
        const price = parseFloat(priceMatch ? priceMatch[1] : 0);
        
        totalGoldGained += price;

        // Agrega os itens para o batchRemove
        const key = item.name;
        const validationName = item.name.split('[')[0].trim(); //
        
        const current = aggregatedItems.get(key) || { 
            name: item.name, 
            validationName: validationName, 
            amount: 0 
        };
        current.amount += 1;
        aggregatedItems.set(key, current);
    }

    const itemsToRemove = Array.from(aggregatedItems.values());
    itemsToRemove.forEach(item => {
        itemsToLog.push(`${item.amount}x ${item.name}`);
    });

    // 2. Preparar Payloads
    const playerPayload = {
        username: username,
        characterName: characterName,
        changes: {}
    };

    // Payload para REMOVER itens
    const removePayload = [{ ...playerPayload, changes: { itemsToRemove: itemsToRemove } }];
    // Payload para ADICIONAR gold
    const addPayload = [{ ...playerPayload, changes: { gold: totalGoldGained } }];

    // 3. Executar Transações (Remover Itens, Adicionar Gold)
    const removeSuccess = await batchRemoveInventories(removePayload, interaction.client); //
    const addSuccess = await batchUpdateInventories(addPayload, interaction.client); //

    // 4. Registrar Log
    try {
        await docComprasVendas.loadInfo(); //
        const logSheet = docComprasVendas.sheetsByTitle['Registro']; //
        const dataLog = new Date().toLocaleString('pt-BR', { timeZone: 'America/Cuiaba', day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });

        await logSheet.addRow({
            'Jogador': username,
            'Personagem': characterName,
            'Data': dataLog,
            'Local': tipoDeLojaLimpo,
            'Tipo': 'Venda', // <<< TIPO VENDA
            'Total': totalGoldGained.toFixed(2).replace('.', ','), // <<< MUDANÇA: Adiciona vírgula
            'Transação': itemsToLog.join(', ')
        });
    } catch (logError) {
        console.error("[ERRO processVenda] Falha ao salvar log:", logError);
        await interaction.followUp({ content: 'AVISO DE STAFF: A venda foi concluída, mas falhei ao salvar o registro da transação.', ephemeral: true });
    }

    // 5. Responder e Limpar
    if (removeSuccess && addSuccess) {
        const successMessageContent = `Venda de ${userMention(interaction.user.id)} (`+
            `${characterName}) finalizada com sucesso!\n\n` +
            `**Total Recebido:** ${totalGoldGained.toFixed(2).replace('.', ',')} PO\n` + // <<< MUDANÇA: Adiciona vírgula
            `**Itens Vendidos:**\n• ${itemsToLog.join('\n• ')}\n\n` +
            `*Seu inventário foi atualizado.*`;
        
        // +++ MUDANÇA: Envia como nova mensagem e apaga o menu +++
        await interaction.channel.send({ content: successMessageContent });
        await interaction.message.delete().catch(e => console.warn(`[WARN processVenda] Falha ao apagar msg do menu de venda: ${e.message}`));
    } else {
         await interaction.channel.send({ content: `Venda processada para ${userMention(interaction.user.id)}, mas ocorreu um erro ao atualizar seu inventário na planilha. Avise um Staff.` });
         await interaction.message.delete().catch(e => console.warn(`[WARN processVenda] Falha ao apagar msg do menu de venda: ${e.message}`));
    }
}

// +++ INÍCIO: NOVAS FUNÇÕES DE PERSUASÃO +++

/**
 * (NOVA FUNÇÃO) Fecha/Limpa uma brecha de rolagem pendente para um jogador.
 * @param {import('discord.js').Client} client
 * @param {string} channelId
 * @param {string} username
 */
async function closeRollBrecha(client, channelId, username) {
    if (!client.pendingRolls || !username || !channelId) return;
    
    const key = `${channelId}-${username.trim().toLowerCase()}`;
    if (client.pendingRolls.delete(key)) {
        console.log(`[closeRollBrecha] Brecha de rolagem fechada para ${key}`);
    }
}


/**
 * Abre a "brecha" de rolagem para persuasão.
 * Salva os dados na RAM (client.pendingRolls).
 * @param {import('discord.js').Interaction} interaction
 * @param {object} state
 * @param {string} shopMessageId - O ID da mensagem da loja que será atualizada.
 */
async function openRollBrecha(interaction, state, shopMessageId) {
    const client = interaction.client;
    //if (!client.pendingRolls) client.pendingRolls = new Map();

    const key = `${interaction.channel.id}-${state.character.row.get('JOGADOR').trim().toLowerCase()}`;

    // +++ INÍCIO DA CORREÇÃO (BUG 5) +++
    if (!client.pendingRolls) client.pendingRolls = new Map();
    if (client.pendingRolls.has(key)) {
        console.warn(`[AVISO openRollBrecha] O jogador ${key} já tem uma brecha de rolagem aberta. A nova brecha foi ignorada.`);
        return; // Não abre uma segunda brecha
    }
    // +++ FIM DA CORREÇÃO (BUG 5) +++

    // 1. Busca os "Termos" na planilha da loja
    let termos = [];
    try {
        await docComprasVendas.loadInfo();
        const shopSheet = docComprasVendas.sheetsByTitle[state.tipoDeLojaLimpo];
        if (shopSheet) {
            await shopSheet.loadHeaderRow(1);
            if (shopSheet.headerValues.includes('Termos')) {
                const rows = await shopSheet.getRows();
                const shopRow = state.subLojaNome 
                    ? rows.find(r => r.get('Loja')?.toLowerCase() === state.subLojaNome.toLowerCase())
                    : rows[0]; // Pega a primeira linha se não for sub-loja
                
                const termosString = shopRow.get('Termos');
                if (termosString && termosString !== '-') {
                    termos = termosString.split(',').map(t => t.trim().toLowerCase());
                }
            }
        }
    } catch (e) {
        console.error(`[openRollBrecha] Falha ao buscar termos: ${e.message}`);
    }

    // 2. Salva a brecha na RAM
    // +++ CORREÇÃO (BUG 2): Adiciona o wrapper de timestamp +++
    const data = {
            cd: state.persuasionCD,
            rollType: 'd20',
            requiredText: termos.length > 0 ? termos : [], //
            interactionId: state.interactionId,
            channelId: interaction.channel.id, // O canal onde a loja está
            shopMessageId: shopMessageId, // O ID da mensagem da loja
            sourceCommand: 'transacao' // Para o listener saber o que chamar
    };
    client.pendingRolls.set(key, { data: data, timestamp: Date.now() });

    console.log(`[openRollBrecha] Brecha aberta para ${key} (CD: ${state.persuasionCD}, Termos: ${termos.join(', ')})`);
}

/**
 * Chamado pelo rollemListener.js quando uma rolagem de persuasão é resolvida.
 * @param {import('discord.js').Client} client
 * @param {object} brecha - O objeto salvo no client.pendingRolls
 * @param {boolean} rollSuccess - Se o jogador passou no teste de CD
 */
async function handlePersuasionResult(client, brecha, rollSuccess) {
    const state = client.pendingLoots.get(brecha.interactionId);
    if (!state) return; // Estado da transação expirou

    state.persuasionSuccess = rollSuccess;
    state.persuasionAttempted = true; // Marca que a tentativa foi feita
    /*
    // Reconstrói o menu (Compra ou Venda) com os novos preços
    const { content, components } = state.rules.possibilidades.includes('venda')
        ? await buildSellSelectMenu(state, 0)
        : await buildPaginatedShopMenu(state, 0);*/
    
    // Edita a mensagem da loja
    try {
        // +++ CORREÇÃO: Reconstrói o menu correto (Compra ou Venda) +++
        let content, components;
        if (state.activeMenu === 'venda') {
            ({ content, components } = await buildSellSelectMenu(state, 0)); //
        } else {
            ({ content, components } = await buildPaginatedShopMenu(state, 0)); //
        }
    
        const channel = client.channels.cache.get(brecha.channelId); // O canal onde a brecha foi aberta
        if (!channel) throw new Error(`Canal da brecha (${brecha.channelId}) não encontrado no cache.`);
        
        const shopMessage = await channel.messages.fetch(brecha.shopMessageId); // O ID da msg da loja
        
        await shopMessage.edit({ content: content, components: components });
        await shopMessage.react(rollSuccess ? '🎉' : '😥'); // Reage à mensagem da LOJA
    } catch (e) {
        console.error(`[handlePersuasionResult] Falha ao editar a mensagem da loja ${brecha.shopMessageId}: ${e.message}`);
    }
}
// +++ FIM: NOVAS FUNÇÕES DE PERSUASÃO +++

// +++ INÍCIO: NOVAS FUNÇÕES P2P (Sim/Não) +++

/**
 * (NOVO - P2P) Publica a mensagem de confirmação Sim/Não.
 * @param {import('discord.js').ModalSubmitInteraction} modalInteraction - A interação do modal de preço.
 * @param {object} state - O estado da transação.
 */
async function postP2PConfirmation(modalInteraction, state) {
    const { character, buyerInfo, itemsToSell, proposedPrice, tipoDeLojaLimpo } = state;
    const client = modalInteraction.client;

    // 1. Agrega os itens selecionados (para o state)
    const aggregatedItems = new Map();
    for (const item of itemsToSell) {
        const key = item.name;
        const validationName = item.name.split('[')[0].trim();
        const current = aggregatedItems.get(key) || { name: item.name, validationName: validationName, amount: 0 };
        current.amount += 1;
        aggregatedItems.set(key, current);
    }
    const itemsToTransfer = Array.from(aggregatedItems.values());

    // 2. Busca IDs do Vendedor e Comprador
    const seller = {
        id: state.ownerId,
        username: character.row.get('JOGADOR'),
        charRow: character.row
    };
    const buyerIds = await lookupIds([buyerInfo.owner]);
    const buyer = {
        id: buyerIds.length > 0 ? buyerIds[0] : null,
        username: buyerInfo.owner, // <<< CORREÇÃO 1
        charRow: buyerInfo.characterRow // <<< CORREÇÃO 2
    };

    // 3. Formata a lista de itens para a mensagem
    const itemList = itemsToTransfer.map(item => `- ${item.amount}x ${item.name}`).join('\n');

    // 4. Cria o estado PENDENTE
    const p2p_state = {
        seller: seller,
        buyer: buyer,
        items: itemsToTransfer,
        price: proposedPrice,
        logSheetName: tipoDeLojaLimpo,
        data: getFormattedTimestamp()
    };

    // 5. Envia a mensagem de confirmação
    const msgContent = `${userMention(seller.id)} (personagem: **${seller.charRow.get('PERSONAGEM')}**) quer vender para ${userMention(buyer.id)} (personagem: **${buyer.charRow.get('PERSONAGEM')}**):\n\n` +
                     `**Itens Ofertados:**\n${itemList}\n\n` +
                     `**Preço Total:** ${proposedPrice.toFixed(2)} PO\n\n` +
                     `*${userMention(buyer.id)}, você aceita esta transação?*`;

    // Envia a mensagem pública
    const proposalMessage = await modalInteraction.channel.send({ 
        content: msgContent,
        allowedMentions: { users: [seller.id, buyer.id] } 
    });
    const messageId = proposalMessage.id;

    // 6. Adiciona botões Sim/Não
    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`p2p_trade_accept|${messageId}`).setLabel('Sim, Aceitar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`p2p_trade_decline|${messageId}`).setLabel('Não, Recusar').setStyle(ButtonStyle.Danger)
    );
    await proposalMessage.edit({ components: [buttons] });

    // 7. Salva o estado P2P na RAM
    if (!client.pendingP2PTrades) client.pendingP2PTrades = new Map();
    // +++ CORREÇÃO (BUG 2): Adiciona o wrapper de timestamp +++
    client.pendingP2PTrades.set(messageId, { data: p2p_state, timestamp: Date.now() });
}

/**
 * (NOVO - P2P) Processa o clique em "Sim, Aceitar".
 * @param {import('discord.js').ButtonInteraction} buttonInteraction - A interação do botão.
 * @param {object} p2p_state - O estado P2P salvo na RAM.
 */
async function handleP2PConfirmation(buttonInteraction, p2p_state) {
    //await buttonInteraction.deferUpdate();
    const { seller, buyer, items, price, logSheetName, data } = p2p_state;
    const client = buttonInteraction.client;

    // +++ INÍCIO DA CORREÇÃO (BUG 1) +++
    // 1. Verifica se o comprador tem o ouro
    const buyerCurrentGold = parseFloat(buyer.charRow.get('Total')) || 0;
    if (buyerCurrentGold < price) {
        // O comprador não tem dinheiro. Aborta a transação.
        return buttonInteraction.message.content + `\n\n**FALHA NA TRANSAÇÃO**\nO comprador (${buyer.charRow.get('PERSONAGEM')}) não possui ouro suficiente (Possui: ${buyerCurrentGold.toFixed(2)} PO / Custo: ${price.toFixed(2)} PO).`;
    }
    // +++ FIM DA CORREÇÃO (BUG 1) +++

    // (Validação de inventário (se o vendedor ainda tem os itens / comprador tem o ouro) pode ser adicionada aqui)
    // (Por enquanto, confiamos no /gasto)

    // 1. Prepara os Payloads (Invertido do /gasto)
    const sellerPayload_RemoveItems = { username: seller.username, characterName: seller.charRow.get('PERSONAGEM'), changes: { itemsToRemove: items } };
    const sellerPayload_AddGold = { username: seller.username, characterName: seller.charRow.get('PERSONAGEM'), changes: { gold: price } };
    
    const buyerPayload_RemoveGold = { username: buyer.username, characterName: buyer.charRow.get('PERSONAGEM'), changes: { gold: price } };
    const buyerPayload_AddItems = { username: buyer.username, characterName: buyer.charRow.get('PERSONAGEM'), changes: { itemsToAdd: items } };

    // 2. Executa as transações em lote
    // (Fazemos em duas etapas para segurança)
    const removeSuccess = await batchRemoveInventories([sellerPayload_RemoveItems, buyerPayload_RemoveGold], client);
    const addSuccess = await batchUpdateInventories([buyerPayload_AddItems, sellerPayload_AddGold], client);

    // 3. Edita a mensagem final
    if (removeSuccess && addSuccess) {
        // +++ REQUERIMENTO 2 e 3: Formato da mensagem final e Log +++
        const itemsString = items.map(item => `${item.amount}x ${item.name}`).join(', ');
        const finalMessage = `Transação entre **${seller.charRow.get('PERSONAGEM')}** e **${buyer.charRow.get('PERSONAGEM')}** concluída.\n` +
                             `**${seller.charRow.get('PERSONAGEM')}** recebeu: ${price.toFixed(2)} PO\n` +
                             `**${buyer.charRow.get('PERSONAGEM')}** recebeu: ${itemsString}`;

        // +++ REQUERIMENTO 3: Logar na planilha +++
        try {
            await docComprasVendas.loadInfo();
            const logSheet = docComprasVendas.sheetsByTitle[logSheetName];
            if (logSheet) {
                await logSheet.addRow({
                    'Data': data,
                    'tag Vendedor': seller.username,
                    'personagem vendedor': seller.charRow.get('PERSONAGEM'),
                    'tag Comprador': buyer.username,
                    'persongem Comprador': buyer.charRow.get('PERSONAGEM'), // Corresponde ao seu cabeçalho "persongem"
                    'valor': price.toFixed(2).replace('.', ','),
                    'itens': itemsString
                });
            } else {
                console.error(`[ERRO P2P Log] A aba de log P2P "${logSheetName}" não foi encontrada na planilha COMPRAS_VENDAS.`);
            }
        } catch (logError) {
            console.error(`[ERRO P2P Log] Falha ao salvar o log P2P na aba "${logSheetName}":`, logError);
        }

        // Retorna a mensagem de sucesso
        return finalMessage;

    } else {
        // Retorna a mensagem de falha
        return buttonInteraction.message.content + `\n\n**FALHA NA TRANSAÇÃO**\nOcorreu um erro ao atualizar os inventários na planilha. A transação foi abortada. (Verifique se o comprador tinha ouro suficiente ou se o vendedor ainda tinha os itens).`;
    }
}

// +++ FIM: NOVAS FUNÇÕES P2P +++
 

module.exports = {
    validateMarketChannel,
    validateMesaCheck,
    handleServicos,
    handlePlayerShop,
    buildPaginatedShopMenu,
    processCompra,
    buildSellSelectMenu,
    processVenda,
    postP2PConfirmation,
    handleP2PConfirmation,
    openRollBrecha,
    handlePersuasionResult,
    closeRollBrecha
    // (handleVenda será adicionado aqui)
};