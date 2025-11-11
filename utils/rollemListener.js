// utils/rollemListener.js
const { createRollConfirmation } = require('../utils/rollObserver.js');
const { handlePersuasionResult } = require('../utils/transacaoUtils.js');
// O username do bot que estamos a escutar
const ROLLEM_USERNAME = 'rollem';

/**
 * Processa uma linha de texto e separa os números em três grupos
 * com base na formatação (~~num~~, **num**, ou num).
 * (Esta é a sua função)
 *
 * @param {string} linha - A string de entrada para processar.
 * @returns {object} Um objeto com três arrays: 'tils', 'asteriscos', e 'normais'.
 */
function processarLinha(linha) {
  // 1. Definir os arrays de resultados
  const grupoTils = [];       // Grupo 1: Números com ~~
  const grupoAsteriscos = []; // Grupo 2: Números com **
  const grupoNormais = [];    // Grupo 3: Números sem formatação

  // 2. A Expressão Regular
  const regex = /~~.*?(\d+).*?~~|\*\*(\d+)\*\*|(\d+)/g;

  // 3. Encontrar todas as correspondências
  const matches = linha.matchAll(regex);

  // 4. Iterar e categorizar cada correspondência
  for (const match of matches) {
    if (match[1] !== undefined) {
      grupoTils.push(match[1]);
    } else if (match[2] !== undefined) {
      grupoAsteriscos.push(match[2]);
    } else if (match[3] !== undefined) {
      grupoNormais.push(match[3]);
    }
  }

  // 5. Retornar os resultados
  return {
    tils: grupoTils,
    asteriscos: grupoAsteriscos,
    normais: grupoNormais,
  };
}


/**
 * Analisa (parse) uma mensagem do bot Rollem para extrair os dados da rolagem.
 * (Esta é a sua versão, com a correção do d20ValidCount)
 * @param {import('discord.js').Message} message - A mensagem enviada pelo Rollem.
 * @returns {object|null} - Um objeto com os dados ou null se não for possível analisar.
 */
function parseRollemMessage(message) {
    const content = message.content;
    
    // --- 1. Regex Principal (Simplificada) ---
    // G1 (Opcional): Texto (ex: 'persuasão')
    // G2: Resultado (ex: 19)
    // G3: O RESTO da linha (ex: "[7] 1d10 + 5 + [3] 1d4..." ou "[**20**] 1d20 + 7")
    const regex = /^(?:'([^']*)'\s*,\s*)?\s*`\s*(\d+)\s*`\s*⟵\s*(.*)$/u;
    
    const match = content.match(regex);

    if (!match) return null; // Não correspondeu ao formato

    const originalUser = message.mentions.repliedUser;
    if (!originalUser) return null; // Ignora se não for uma resposta

    try {
        const text = match[1] || '';           // G1: O texto
        const result = parseInt(match[2], 10); // G2: O resultado
        const detailsString = match[3];      // G3: Todo o resto da linha

        // --- 2. Novo Parser Interno ---
        // Esta Regex encontra CADA par de "[resultado] notação" na detailsString.
        const diceRollRegex = /\[(.*?)\]\s*(\S+)/g;
        
        // Usamos matchAll para pegar *todos* os pares (no caso complexo)
        const allRollMatches = [...detailsString.matchAll(diceRollRegex)];

        // Se não encontrar NENHUM par, o formato é inválido.
        if (allRollMatches.length === 0) return null;

        // Arrays para acumular todos os dados
        let allValidRolls = [];
        let allDiscardedRolls = [];
        let allCritRolls = [];
        let dieTypes = [];
        let isCrit = false;
        // +++ CORREÇÃO: Conta quantos dados d20 VÁLIDOS foram rolados +++
        let d20ValidCount = 0; 

        // --- 3. Loop sobre todas as rolagens encontradas ---
        for (const rollMatch of allRollMatches) {
            const rollsString = rollMatch[1]; // Ex: "**20**" ou "7" ou "15, ~~8~~"
            const notation = rollMatch[2];    // Ex: "1d20" ou "1d10" ou "4d6"

            // 3a. Usar sua função para analisar a string de rolagem
            const rollData = processarLinha(rollsString); 
            
            const validRollsFromThis = [...rollData.normais.map(Number), ...rollData.asteriscos.map(Number)];
            const critRollsFromThis = rollData.asteriscos.map(Number);
            
            allValidRolls.push(...validRollsFromThis);
            allDiscardedRolls.push(...rollData.tils.map(Number));
            allCritRolls.push(...critRollsFromThis); // Acumula todos os **

            // 3b. Analisar a notação do dado (ex: "1d20")
            const dieMatch = notation.match(/(\d+)d(\d+)/);
            let currentDieType = 0;
            if (dieMatch) {
                currentDieType = parseInt(dieMatch[2], 10); // O 'Y' (ex: 20 ou 6)
                dieTypes.push(currentDieType);
            }
            
            // +++ CORREÇÃO: Conta quantos d20 válidos foram rolados +++
            if (currentDieType === 20) {
                d20ValidCount += validRollsFromThis.length;
            }

            // 3c. Verificar crítico PARA ESTE DADO
            // Mantém a sua lógica original: é crítico se for um d20 E tiver **
            if (currentDieType === 20 && critRollsFromThis.includes(20)) {
                isCrit = true; // Marca a flag global de crítico
            }
        }

        // Definir qual dado "principal" reportar (usamos o primeiro)
        const primaryDieType = dieTypes[0] || 0;
        const primaryDieNotation = primaryDieType > 0 ? `d${primaryDieType}` : (allRollMatches[0][2] || 'd?');

        return {
            user: originalUser,
            die: primaryDieNotation,
            dieType: primaryDieType,
            dieTypes: dieTypes, // <<< NOVO: Array de todos os dados [20, 4, 10]
            result: result,
            text: text,
            channel: message.channel.id,
            isCrit: isCrit,
            validRolls: allValidRolls,
            d20ValidCount: d20ValidCount, // <<< NOVO: Contagem de d20 válidos
            discardedRolls: allDiscardedRolls,
            critRolls: allCritRolls
        };
    } catch (e) {
        console.error("[Rollem Parser] Erro ao analisar a rolagem:", e);
        return null;
    }
}


/**
 * (Placeholder de Teste) Verifica se há uma "brecha" de rolagem aberta.
 * @param {string} userId 
 * @param {string} channelId 
 * @returns {Promise<object|null>}
 */
async function checkRollBrecha(client, userId, channelId) {
    if (!client.pendingRolls) return null;
    
    // Chave é "id_chat-tag_player_lower"
    const key = `${channelId}-${userId}`;
    // Retorna a brecha se ela existir na RAM
    return client.pendingRolls.get(key)?.data;
}

/**
 * Função principal chamada pelo index.js para processar uma mensagem do Rollem.
 * @param {import('discord.js').Message} message - A mensagem recebida.
 */
async function handleRollemMessage(message) {
    // 1. Verifica se é o bot Rollem
    if (message.author.username !== ROLLEM_USERNAME) {
        return;
    }

    // 2. Tenta analisar a mensagem
    const parsed = parseRollemMessage(message);
    if (!parsed) {
        // +++ ATIVADO: Loga as mensagens que falham no parse +++
        console.log(`[AVISO Rollem] Mensagem do Rollem não parseada: ${message.content}`);
        return;
    }

    // --- Logs de Teste (para o utilizador) ---
    console.log("--- INFORMAÇÃO DE ROLAGEM (TESTE) ---");
    console.log(`- Usuário: ${parsed.user.tag}`);
    console.log(`- Tipo de Dado Principal: ${parsed.die} (Tipo Num: ${parsed.dieType})`);
    console.log(`- Todos os Tipos de Dado: [${parsed.dieTypes.join(', ')}]`);
    console.log(`- Resultado Final: ${parsed.result}`);
    console.log(`- Texto: '${parsed.text}'`);
    console.log(`- Canal: ${parsed.channel}`);
    console.log(`- Crítico (d20=20): ${parsed.isCrit}`);
    console.log(`- Dados Válidos (Contados): [${parsed.validRolls.join(', ')}] (Total: ${parsed.validRolls.length})`);
    console.log(`- Dados Válidos (Contagem d20): ${parsed.d20ValidCount}`);
    console.log(`- Dados Descartados (~~): [${parsed.discardedRolls.join(', ')}]`);

    // --- 4. Lógica de Teste (Verifica a "brecha") ---
    const brecha = await checkRollBrecha(message.client, parsed.user.username.toLowerCase(), parsed.channel);

    if (brecha) {
        let isValidRoll = true;
        let textIsValid = true;
        let failureReason = "";

        // --- Validação da "Brecha" ---
        
        // A. Validação de Texto (E)
        if (brecha.requiredText && brecha.requiredText.length > 0) {
            const textLower = parsed.text.toLowerCase();
            if (!brecha.requiredText.every(kw => textLower.includes(kw))) {
                textIsValid = false; //
                failureReason += `Texto '${parsed.text}' não corresponde ao esperado '${brecha.requiredText.join(', ')}'. `;
            }
        }
        
        // B. Validação de Tipo de Rolagem (d20)
        if (brecha.rollType === 'd20') {
            if (!parsed.dieTypes.includes(20)) {
                isValidRoll = false;
                failureReason += `Brecha pedia 'd20', mas nenhum d20 foi rolado. `;
            } else if (parsed.d20ValidCount !== 1) { // <<< CORREÇÃO: Usa a nova contagem
                isValidRoll = false;
                failureReason += `Brecha pedia 1 dado d20, mas ${parsed.d20ValidCount} dados d20 válidos foram contados. `;
            }
        }
        
        // C. Validação de Tipo de Rolagem (any)
        else if (brecha.rollType === 'any') {
            const allowedDice = [2, 3, 4, 6, 8, 10, 12];
            // Verifica se *pelo menos um* dos dados rolados está na lista permitida
            if (!parsed.dieTypes.some(die => allowedDice.includes(die))) {
                isValidRoll = false;
                failureReason += `Brecha pedia 'any' (d2-d12), mas a rolagem foi '${parsed.die}'. `;
            }
            // (Não verifica a quantidade de dados para 'any')
        }

        // --- 5. Resultado ---
        if (!isValidRoll) {
            // A rolagem é fundamentalmente errada (dado errado, contagem errada)
            console.log(`[Rollem] TESTE: Rolagem IGNORADA (Dado/Contagem errada). ${failureReason}`);
        } else if (!textIsValid) {
            // A rolagem está CORRETA, mas falta o TEXTO.
            console.log(`[Rollem] Rolagem válida, mas texto ausente. A perguntar ao jogador...`);
            // <<< NOVA LÓGICA DE PERGUNTA >>>
            await createRollConfirmation(message, parsed, brecha);
        } else {
            // Rolagem e texto são válidos.
            const success = parsed.result >= brecha.cd;
            console.log(`[Rollem] Rolagem VÁLIDA. CD: ${brecha.cd}, Resultado: ${parsed.result}. SUCESSO: ${success}`);

            // 6. Reage à mensagem
            try {
                if (success) {
                    await message.react('✅');
                } else {
                    await message.react('❌');
                }
            } catch (e) {
                console.error("[Rollem] Falha ao reagir à mensagem:", e.message);
            }
            
            // 7. Notifica o comando original (Transacao) e fecha a brecha
            if (brecha.sourceCommand === 'transacao') {
                await handlePersuasionResult(message.client, brecha, success);
            }

            // 8. Fecha a brecha (remove da RAM)
            const key = `${parsed.channel}-${parsed.user.username.toLowerCase()}`;
            message.client.pendingRolls.delete(key);
        }

    } else {
        console.log("[Rollem] Rolagem parseada, mas nenhuma 'brecha' aberta para este usuário/canal.");
    }
    console.log("---------------------------------");
}

module.exports = {
    handleRollemMessage
};