// utils/exibirUtils.js
const { docControle } = require('./google.js'); //
const { TIER_DATA } = require('./lootLogic.js'); //

/**
 * Parseia a string de loot (ex: "1x Item*, 1x Item B (Dobro Ativado)")
 * @param {string} itemString - A string da planilha (colunas N-S)
 * @returns {{items: string, hasDobro: boolean}}
 */
function parseLootString(itemString) {
    if (!itemString || itemString.trim() === '') {
        return { items: 'Nenhum', hasDobro: false };
    }
    const hasDobro = itemString.includes('(Dobro Ativado)');
    const items = itemString.replace('(Dobro Ativado)', '').trim() || 'Nenhum';
    return { items, hasDobro };
}

/**
 * Aplica a lógica de "Dobro" ao gold e à string de itens.
 * @param {number} baseGold - O gold da Coluna M
 * @param {string} itemString - A string de itens (ex: "1x Poção Cura*, 1x Adaga")
 * @param {boolean} hasDobro - Se o dobro estava ativo
 * @returns {{finalGold: number, finalItems: string}}
 */
function applyDobroLogic(baseGold, itemString, hasDobro) {
    // 1. Processa o Gold Base
    let finalGold = hasDobro ? (parseFloat(baseGold) * 2) : parseFloat(baseGold);

    // Se não ativou o dobro, retorna os itens como estão
    if (!hasDobro || itemString === 'Nenhum') {
        // <<< CORREÇÃO: Mesmo sem dobro, precisamos processar o Gold Extra >>>
        // (Continua a função se tiver itens, mesmo sem 'hasDobro')
        if (itemString === 'Nenhum') {
             return { finalGold, finalItems: itemString };
        }
    }

    // 2. Processa a string de Itens
    // Se ativou o dobro, precisamos processar os itens para dobrar os que têm '*'
    const itemsRaw = itemString.split(',');
    // Regex: (1x) (Nome do Item) (*)
    const itemRegex = /^\s*(?:(\d+)\s*x\s*)?(.+?)(\*?)\s*$/;
    // Regex: (Nome) -> [Extra] (200.00) PO
    const goldExtraRegex = /\[Extra\]\s*([\d\.]+)\s*PO/i;
    const finalItemParts = [];

    for (const item of itemsRaw) {
        const match = item.match(itemRegex);
        if (!match) {
            if (item.trim()) finalItemParts.push(item.trim());
            continue;
        }

        let amount = parseInt(match[1] || '1', 10);
        const name = match[2].trim();
        const isPredefined = match[3] === '*';

        // +++ INÍCIO DA NOVA LÓGICA (Verifica se é Gold Extra) +++
        const goldMatch = name.match(goldExtraRegex);

        if (goldMatch) {
            // É um item de Gold Extra!
            let goldValue = parseFloat(goldMatch[1]);
            let totalExtraGold = amount * goldValue;

            // Dobra este gold extra APENAS se tiver dobro ativo E o item tiver '*'
            if (hasDobro && isPredefined) {
                totalExtraGold *= 2;
            }
            finalGold += totalExtraGold; // Adiciona ao total de gold

        } else {
            // É um item normal
            // Dobra a quantidade se for pré-definido e tiver dobro ativo
            if (hasDobro && isPredefined) {
                amount *= 2;
            }
            // Reconstrói a string do item
            finalItemParts.push(`${amount}x ${name}${isPredefined ? '*' : ''}`);
        }
        
        // Reconstrói a string do item
        //finalItemParts.push(`${amount}x ${name}${isPredefined ? '*' : ''}`);
    }

    // Se a lista de itens estiver vazia (só tinha gold extra), retorna 'Nenhum'
    const finalItemsString = finalItemParts.length > 0 ? finalItemParts.join(', ') : 'Nenhum';

    return { finalGold, finalItems: finalItemsString };
}

/**
 * Busca no "Historico" todas as mesas que um personagem jogou.
 * @param {string} characterName - O nome exato do personagem.
 * @returns {Promise<Array<object>>} - Um array de objetos de histórico.
 */
async function fetchMesasJogadas(characterName) {
    await docControle.loadInfo(); //
    const sheet = docControle.sheetsByTitle['Historico']; //
    if (!sheet) throw new Error("Aba 'Historico' não encontrada.");
    
    await sheet.loadHeaderRow(1);
    const rows = await sheet.getRows();
    const history = [];

    for (const row of rows) {
        let foundPlayerCol = -1; // Índice da coluna F-K (5-10)
        let playerItemString = '';

        // 1. Procura o personagem nas colunas F-K (índices 5-10)
        for (let i = 5; i <= 10; i++) {
            const cellData = row._rawData[i]; //
            if (!cellData || String(cellData).trim() === '') continue;

            const cellString = String(cellData);
            // Formato: "Tag - Personagem - Nível"
            const parts = cellString.split(' - ');

            if (parts.length >= 3) {
                // Pega tudo entre o primeiro e o último '-' como nome do personagem
                const char = parts.slice(1, -1).join(' - ').trim();
                
                // Compara o nome do personagem (ignorando maiúsculas/minúsculas)
                if (char.toLowerCase() === characterName.toLowerCase()) {
                    foundPlayerCol = i;
                    
                    // 2. Mapeia a coluna de item (N-S)
                    // F (5) -> N (13)
                    // G (6) -> O (14)
                    // ...
                    // K (10) -> S (18)
                    const itemColIndex = foundPlayerCol + 8; //
                    playerItemString = row._rawData[itemColIndex] || '';
                    break; // Para de procurar nas colunas F-K
                }
            }
        }

        // 3. Se encontrou o personagem, processa os dados
        if (foundPlayerCol !== -1) {

            // +++ NOVA VERIFICAÇÃO: Checa se a Coluna T é "Sim" +++
            const mesaFinalizada = row.get('Mesa Finalizada') || 'Não'; //
            if (mesaFinalizada.trim().toLowerCase() !== 'sim') {
                continue; // Pula esta linha se a mesa não estiver finalizada
            }

            const baseGold = parseFloat(row.get('Loot (PO)')) || 0; //
            
            // Processa a string de itens para checar o (Dobro Ativado)
            const { items, hasDobro } = parseLootString(playerItemString);
            
            // Aplica a lógica de dobrar o gold e os itens *
            const { finalGold, finalItems } = applyDobroLogic(baseGold, items, hasDobro);

            // Formata a data (B) e hora (C)
            const data = row.get('Data') || '??/??/??';
            const hora = row.get('Horário') || '??:??';
            const [dia, mes, ano] = data.split('/');
            const [h, min] = hora.split(':');
            let timestamp = Math.floor(new Date(`20${ano}`, mes - 1, dia, h, min).getTime() / 1000);
            if (isNaN(timestamp)) timestamp = null;

            history.push({
                timestamp: timestamp, //
                mestre: row.get('Narrador') || '?', //
                tier: (row.get('Tier') || "'?").replace(/'/g, ''), //
                gold: finalGold.toFixed(2),
                itens: finalItems
            });
        }
    }

    return history; // Retorna a lista de mesas
}

module.exports = {
    fetchMesasJogadas
};