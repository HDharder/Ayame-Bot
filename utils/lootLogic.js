// Funções de cálculo de gold e lógica de tiers/dados

const { docSorteio } = require('./google.js'); // docSorteio ainda é usado para getPlayerLevels

// --- Funções de Utilidade ---

/**
 * Rola dados no formato XdY (ex: 2d4)
 * Retorna string formatada para Vantagem
 */
function rollDice(expression, hasAdvantage = false) {
  // Separa a expressão (ex: "2d4") em número de dados e lados
  const [num, sides] = expression.split('d').map(Number);
  let total = 0; // Soma dos dados mantidos
  let rollsKept = []; // Array dos dados mantidos
  let rollsDiscarded = []; // Array dos dados descartados (em caso de vantagem)
  let rollStrings = []; // Array para strings formatadas individuais -> "[kept, ~~discarded~~]" ou "kept"

  // Rola cada dado individualmente
  for (let i = 0; i < num; i++) {
    const roll1 = Math.floor(Math.random() * sides) + 1; // Primeira rolagem

    if (hasAdvantage) {
      const roll2 = Math.floor(Math.random() * sides) + 1; // Segunda rolagem (vantagem)
      const kept = Math.max(roll1, roll2); // Pega o maior
      const discarded = Math.min(roll1, roll2); // Pega o menor

      total += kept; // Adiciona o maior ao total
      rollsKept.push(kept); // Guarda o maior
      rollsDiscarded.push(discarded); // Guarda o menor (descartado)
      // Formata a string para este dado com vantagem: [Maior, ~~Menor~~]
      rollStrings.push(`[${kept}, ~~${discarded}~~]`);
    } else {
      // Rolagem normal (sem vantagem)
      total += roll1; // Adiciona ao total
      rollsKept.push(roll1); // Guarda o dado
      rollStrings.push(roll1.toString()); // Guarda a string do dado (apenas o número)
    }
  }
  // Junta todas as strings de dados individuais com ", "
  const finalRollString = rollStrings.join(', ');

  // Retorna o total, os arrays de dados (caso precise) e a string final formatada
  return { total, rollsKept, rollsDiscarded, rollString: finalRollString };
}

/**
 * Converte um nível de jogador para o tier de loot correspondente
 */
function getTier(level) {
  if (level <= 2) return 1;
  if (level <= 4) return 2;
  if (level <= 6) return 3;
  if (level <= 8) return 4;
  if (level <= 10) return 5;
  if (level <= 12) return 6;
  if (level <= 16) return 7;
  // Níveis 17 a 20 e acima caem no tier 8
  if (level >= 17) return 8;
  // Fallback para níveis inválidos (embora getPlayerLevels já trate)
  return 1;
}

/** Mapeamento de Tiers para dados e modificadores */
const TIER_DATA = {
  1: { dice: '2d4', mod: 100 },
  2: { dice: '2d4', mod: 125 },
  3: { dice: '4d4', mod: 150 },
  4: { dice: '4d4', mod: 175 },
  5: { dice: '6d4', mod: 200 },
  6: { dice: '6d6', mod: 225 },
  7: { dice: '8d6', mod: 250 },
  8: { dice: '8d6', mod: 300 },
};

/** Tabela de Média de Gold (conforme especificado) */
const MEDIA_TABLE = {
  // tier: { 4P, 5P, 6P }
  1: { 4: 125.00, 5: 100.00, 6: 83.33 },
  2: { 4: 156.25, 5: 125.00, 6: 104.17 },
  3: { 4: 375.00, 5: 300.00, 6: 250.00 },
  4: { 4: 437.50, 5: 350.00, 6: 291.67 },
  5: { 4: 750.00, 5: 600.00, 6: 500.00 },
  6: { 4: 1181.25, 5: 945.00, 6: 787.50 },
  7: { 4: 1750.00, 5: 1400.00, 6: 1166.67 },
  8: { 4: 2100.00, 5: 1680.00, 6: 1400.00 },
};

// --- Funções Principais de Lógica ---

/**
 * Busca os dados dos jogadores (Tag, Personagem, Nível) da linha da mesa na planilha Historico
 * Usa _rawData[index] para ler por índice de coluna
 */
async function getPlayerLevels(mesaRow, headerValues) { // headerValues é recebido mas não usado diretamente para get
  const playersData = []; // Armazena {playerString, originalColIndex}

  // Colunas F a K (índices 5 a 10)
  for (let i = 5; i <= 10; i++) {
    // Usa a propriedade interna _rawData[index] para ler o valor da célula pelo índice
    const playerStringRaw = mesaRow._rawData[i];

    // Verifica se a string não é nula ou vazia antes de adicionar
    if (playerStringRaw && String(playerStringRaw).trim() !== '') {
      playersData.push({ playerString: String(playerStringRaw).trim(), originalColIndex: i });
    }
  }

  // Se nenhuma string de jogador foi encontrada
  if (playersData.length === 0) {
    throw new Error('Nenhum jogador encontrado ou colunas F-K vazias nesta mesa no Histórico.');
  }

  // Mapeia os dados, extraindo Tag, Personagem e Nível
  const players = playersData.map(data => {
    const parts = data.playerString.split(' - '); // Separa por " - "
    let tag = data.playerString; // Valor padrão caso o split falhe
    let char = 'Personagem Desconhecido';
    let level = 1; // Nível padrão caso não encontre ou falhe o parse

    if (parts.length >= 3) {
      // Assume: Tag - ...Personagem... - Nível
      tag = parts[0].trim(); // Primeira parte é a Tag
      // Pega a última parte como nível
      const levelStr = parts[parts.length - 1].trim();
      level = parseInt(levelStr); // Tenta converter para número
      // Se a conversão para número falhar ou for 0, usa nível 1 e avisa
      if (isNaN(level) || level <= 0) {
          console.warn(`[AVISO Loot Parse Nível] Não foi possível parsear o nível "${levelStr}" ou nível inválido para ${tag}. Usando nível 1.`);
          level = 1;
      }
      // Pega todas as partes do meio como nome do personagem
      char = parts.slice(1, -1).join(' - ').trim();
      // Garante que o nome do char não seja vazio
      if (!char) {
          console.warn(`[AVISO Loot Parse Char] Nome do personagem vazio para ${tag}. Usando 'Personagem Desconhecido'. String original: "${data.playerString}"`);
          char = 'Personagem Desconhecido';
      }

    } else if (parts.length === 2) {
        // Formato antigo? "Tag - Personagem" -> Usa nível 1 como padrão e avisa
        console.warn(`[AVISO Loot Parse Nível] String do jogador "${data.playerString}" parece estar no formato antigo (sem nível). Usando nível 1.`);
        tag = parts[0].trim();
        char = parts[1].trim();
        level = 1;
    } else {
        // Formato inesperado (nem 2 nem 3+ partes)
         console.warn(`[AVISO Loot Parse Nível] String do jogador "${data.playerString}" em formato inesperado. Usando tag completa e nível 1.`);
         // Mantém a string original como tag e nível 1
         // Não sobrescreve 'tag' aqui para manter a string original
         level = 1;
    }

    // Retorna o objeto formatado para este jogador
    return {
      tag: tag,
      char: char,
      level: level, // Nível extraído (ou padrão 1)
      originalColIndex: data.originalColIndex // Índice original da coluna (5-10)
    };
  });

  // NÃO busca mais níveis nas planilhas Primários/Secundários

  // Retorna o array de objetos 'players'
  return players;
}

/**
 * Calcula o Gold por jogador com base nas regras
 * Usa novo formato de critério do rollDice
 */
function calculateGold(playerLevels, tierString, lootPrevisto) {
    const numPlayers = playerLevels.length;
    if (numPlayers === 0) return { goldPerPlayer: 0, criterio: 'Nenhum jogador' };

    const playerTiers = playerLevels.map(p => getTier(p.level));
    const tierCounts = {};
    playerTiers.forEach(tier => { tierCounts[tier] = (tierCounts[tier] || 0) + 1; });
    const uniqueTiers = Object.keys(tierCounts);

    const hasAdvantage = !lootPrevisto;
    const advantageString = hasAdvantage ? " [Vantagem]" : " [Previsto]";

    // Caso 1: 3+ Tiers ou Tier "aberto" (Média)
    if (uniqueTiers.length >= 3 || tierString.toLowerCase() === 'aberto') {
      // Determina qual coluna da média usar (4P, 5P, ou 6P)
      const colName = numPlayers <= 4 ? 4 : (numPlayers === 5 ? 5 : 6);
      let totalGoldMedia = 0; let criterio = "(";
      // Soma a média de gold correspondente para cada jogador na mesa
      for (const tier of playerTiers) {
          // Verifica se o tier e a coluna existem na tabela de médias
          if (!MEDIA_TABLE[tier] || !MEDIA_TABLE[tier][colName]) {
              console.warn(`[AVISO Loot Média] Tier ${tier} ou coluna ${colName}P não encontrado na MEDIA_TABLE.`);
              criterio += `Média_Tier_${tier}? + `; // Indica erro na string
              continue; // Pula este tier se a média não for encontrada
          }
          const media = MEDIA_TABLE[tier][colName];
          totalGoldMedia += media; criterio += `${media} + `;
      }
      // Verifica se alguma média válida foi somada
      if (totalGoldMedia === 0 && playerTiers.length > 0 && !criterio.includes('?')) {
          console.error("[ERRO Loot Média] totalGoldMedia zerado, mas tiers encontrados. Verifique MEDIA_TABLE.");
          return { goldPerPlayer: 0, criterio: "Erro ao buscar médias para os tiers." };
      }
      // Evita divisão por zero se nenhum tier válido foi encontrado
      const divisor = playerTiers.length > 0 ? playerTiers.length : 1;
      const goldTotal = totalGoldMedia / divisor; // Calcula a média das médias
      const goldPerPlayer = Math.ceil(goldTotal); // Arredonda para cima
      // Remove o último " + " apenas se houver médias válidas
      if (criterio.length > 1 && !criterio.endsWith('? + ')) {
         criterio = criterio.slice(0, -3);
      } else if (criterio.endsWith('? + ')) {
          criterio = criterio.slice(0, -3) + " (Erro)"; // Indica erro na string final
      }
      criterio = `${criterio}) / ${divisor} [Média]`;
      return { goldPerPlayer, criterio };
    }

    // Caso 2: 1 Tier (Rolagem Simples)
    if (uniqueTiers.length === 1) {
      const tier = uniqueTiers[0];
      // Adiciona verificação se o tier existe
      if (!TIER_DATA[tier]) {
          console.warn(`[AVISO Loot Rolagem] Tier ${tier} não encontrado na TIER_DATA.`);
          return { goldPerPlayer: 0, criterio: `Tier ${tier} inválido.` };
      }
      const { dice, mod } = TIER_DATA[tier];

      // Pega a 'rollString' formatada de rollDice
      const { total, rollString } = rollDice(dice, hasAdvantage);
      const goldTotal = (total * mod);
      const goldPerPlayer = goldTotal / numPlayers;

      // Usa a variável 'rollString' aqui
      const criterio = `${rollString} → \` ${total} \` ⨯ ${mod} / ${numPlayers} [Tier ${tier}${advantageString}]`;
      return { goldPerPlayer, criterio };
    }

    // Caso 3: 2 Tiers
    if (uniqueTiers.length === 2) {
      const [tierA, tierB] = uniqueTiers.map(Number);
      // Adiciona verificação se os tiers existem
       if (!TIER_DATA[tierA] || !TIER_DATA[tierB]) {
          console.warn(`[AVISO Loot Rolagem Mista] Tier ${tierA} ou ${tierB} não encontrado na TIER_DATA.`);
          return { goldPerPlayer: 0, criterio: `Tier ${tierA} ou ${tierB} inválido.` };
      }
      const countA = tierCounts[tierA];
      const countB = tierCounts[tierB];

      // Subcaso 3a: Regra da Maioria (um dos tiers tem apenas 1 jogador)
      if (countA === 1 || countB === 1) {
        const majorityTier = countA > 1 ? tierA : tierB;
        const { dice, mod } = TIER_DATA[majorityTier];

        // Pega a 'rollString' formatada de rollDice
        const { total, rollString } = rollDice(dice, hasAdvantage);
        const goldTotal = (total * mod);
        const goldPerPlayer = goldTotal / numPlayers;

        // Usa a variável 'rollString' aqui
        const criterio = `${rollString} → \` ${total} \` ⨯ ${mod} / ${numPlayers} [Tier ${majorityTier} - Maioria${advantageString}]`;
        return { goldPerPlayer, criterio };
      }

      // Subcaso 3b: Misto (pelo menos 2 jogadores em cada tier)
      const dataA = TIER_DATA[tierA];
      const dataB = TIER_DATA[tierB];
      // Extrai número de dados e lados para cada tier
      const [diceNumA, diceSidesA] = dataA.dice.split('d').map(Number);
      const [diceNumB, diceSidesB] = dataB.dice.split('d').map(Number);
      // Calcula metade dos dados (mínimo 1) para cada tier
      const diceExprA = `${Math.max(1, Math.floor(diceNumA / 2))}d${diceSidesA}`;
      const diceExprB = `${Math.max(1, Math.floor(diceNumB / 2))}d${diceSidesB}`;

      // Pega as 'rollString' formatadas de rollDice para cada parte
      const { total: totalA, rollString: rollStringA } = rollDice(diceExprA, hasAdvantage);
      const { total: totalB, rollString: rollStringB } = rollDice(diceExprB, hasAdvantage);

      // Soma os resultados ponderados pelos modificadores
      const goldTotal = (totalA * dataA.mod) + (totalB * dataB.mod);
      // Divide pelo número total de jogadores
      const goldPerPlayer = goldTotal / numPlayers;

      // Monta a string de critério detalhada para o caso misto
      const criterio = `Tier ${tierA}: [${rollStringA} → \` ${totalA} \` ⨯ ${dataA.mod}] + Tier ${tierB}: [${rollStringB} → \` ${totalB} \` ⨯ ${dataB.mod}] / ${numPlayers} [Misto${advantageString}]`;
      return { goldPerPlayer, criterio };
    }

    // Fallback (se nenhuma condição for atendida, o que não deve acontecer)
    console.error("[ERRO Loot] Nenhuma condição de cálculo de gold foi atendida.", { numPlayers, uniqueTiers });
    return { goldPerPlayer: 0, criterio: "Erro no cálculo" };
}


// Exporta apenas as funções que restaram
module.exports = {
  rollDice,
  getTier,
  TIER_DATA,
  MEDIA_TABLE,
  getPlayerLevels,
  calculateGold,
};