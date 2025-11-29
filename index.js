// --- 1. Importação das Bibliotecas ---
require('dotenv').config();
const { loadChannelRules } = require('./utils/channelGuard.js'); // +++ IMPORTA O GUARD +++
const { handleRollemMessage } = require('./utils/rollemListener.js'); // <<< NOVO: Importa o escutador
const rollObserver = require('./utils/rollObserver.js');
const { preloadInventoryEmbedData, docCraft, flushDocCache } = require('./utils/google.js');
const { preloadItemCategories } = require('./utils/itemUtils.js');
const fs = require('node:fs');
const path = require('node:path');
const ADMIN_SERVER_ID = process.env.ADMIN_SERVER_ID;
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  Collection,
  MessageFlagsBitField,
  // +++ NOVAS IMPORTAÇÕES PARA OTIMIZAÇÃO +++
  Options, 
  Partials 
} = require('discord.js');

// --- 2. Configuração das Credenciais ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    
    // +++ CÓDIGO DE OTIMIZAÇÃO DE RAM ADICIONADO +++

    // 1. ADICIONA 'PARTIALS'
    // Isto garante que o bot possa "ver" reações em mensagens
    // que NÃO estão no cache (mensagens antigas).
    // O seu 'handleReaction' já está pronto para isso.
    partials: [
        Partials.Message,
        Partials.Reaction,
        Partials.User
    ],

    // 2. CONFIGURA O CACHE (makeCache)
    // Aqui dizemos o que o bot deve ou não guardar na RAM.
    makeCache: Options.cacheWithLimits({
        // --- LIMITES BAIXOS ---
        // Guarda apenas 10 mensagens por canal. Suficiente para
        // apanhar reações recentes, mas liberta muita RAM.
        MessageManager: 10, 
        
        // --- DESLIGADOS (0 = Sem cache) ---
        
        // A MAIOR ECONOMIA DE RAM: Não guardar utilizadores/membros.
        // O bot irá buscá-los (fetch) quando precisar.
        UserManager: 0,
        GuildMemberManager: 0,

        // Não guardar status (ex: "Jogando...")
        PresenceManager: 0, 
        // Não guardar quem está em canais de voz
        VoiceStateManager: 0, 
        
        // Outros caches que o seu bot não parece usar
        GuildEmojiManager: 0,
        GuildStickerManager: 0,
        GuildScheduledEventManager: 0,
        ApplicationCommandManager: 0, // Comandos /
        
        // Mantém threads, pois 'transacao' pode usá-las
        ThreadManager: 50, 
    })
});

// --- 3. Carregador de Comandos ---
client.commands = new Collection();
// Armazena o estado dos registros pendentes no próprio client
client.pendingRegistrations = new Map(); 
// Armazena estados pendentes do /loot
client.pendingLoots = new Map();
// Armazena estados pendentes do /relatorio
client.pendingRelatorios = new Map();
// Armazena estados pendentes do /inventario
client.pendingInventarios = new Map();
client.pendingRolls = new Map();
// Armazena confirmações de rolagem pendentes
client.pendingRollConfirmations = new Map();
// Armazena propostas P2P pendentes (Sim/Não)
client.pendingP2PTrades = new Map();
client.reactionListeners = new Map();
const commandsToRegister = [];
const commandsPath = path.join(__dirname, 'commands');
const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
  const filePath = path.join(commandsPath, file);
  // Adiciona try...catch para lidar com erros ao carregar um comando
  try {
    const command = require(filePath);

    if ('data' in command && 'execute' in command) {
      client.commands.set(command.data.name, command);
      commandsToRegister.push(command.data.toJSON());
      console.log(`[SUCESSO] Comando ${command.data.name} carregado.`);
    } else {
      console.warn(`[AVISO] O comando em ${filePath} está faltando "data" ou "execute".`);
    }
  } catch (error) {
      console.error(`[ERRO] Falha ao carregar comando ${filePath}:`, error);
  }
}

// +++ INÍCIO: SISTEMA DE GESTÃO DE MEMÓRIA +++

const mapsToClean = new Map(); // Mapa para guardar os mapas a limpar
const STALE_LIMIT_HOURS = 1; // Limite de 6 horas para estados antigos

/**
 * Limpa mapas de estado pendentes (pendingLoots, etc.) para libertar RAM
 * de interações que foram abandonadas pelos utilizadores.
 * @param {boolean} [forceAll=false] - Se true, limpa todos os estados, independentemente da idade.
 */
async function forceCleanup(forceAll = false) {
    console.log(`[INFO GarbageCollector] A executar limpeza. Forçar tudo: ${forceAll}`);
    const now = Date.now();
    const limitMs = STALE_LIMIT_HOURS * 3600 * 1000;
    let itemsCleaned = 0;

    for (const [mapName, map] of mapsToClean.entries()) {
        if (!map) continue;
        
        // +++ INÍCIO DA CORREÇÃO (BUG 2) +++
        for (const [key, value] of map.entries()) {
            let timestamp = 0;
 
            if (value && value.timestamp) {
                // --- Formato Novo (com timestamp) ---
                // (Usado por pendingRolls, pendingP2PTrades, etc.)
                timestamp = value.timestamp;
            } else {
                // --- Formato Antigo (baseado no Interaction ID) ---
                // (Usado por pendingLoots, pendingRegistrations, etc.)
                try {
                    timestamp = Number((BigInt(key) >> 22n) + 1420070400000n);
                } catch (e) {
                    // Ignora chaves que não são Snowflakes (como 'pendingRolls' antes da correção)
                }
             }
 
            if (timestamp > 0) {
                const ageMs = now - timestamp;
                if (forceAll || ageMs > limitMs) {
                    map.delete(key);
                    itemsCleaned++;
                }
            }
            // +++ FIM DA CORREÇÃO (BUG 2) +++
            
        }
    }
    console.log(`[INFO GarbageCollector] Limpeza concluída. ${itemsCleaned} estados removidos.`);
}

/**
 * Inicia o temporizador de limpeza de rotina (a cada hora).
 */
function startRoutineGarbageCollector() {
    const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 Hora

    setInterval(() => {
        console.log(`[INFO Rotina] A executar ciclo de manutenção (Save + Flush + GC)...`);
        saveAllStates(); // +++ 1. SALVAMENTO PERIÓDICO (Checkpoint) +++
        forceCleanup(false); // Chama a limpeza (sem forçar)

        // +++ LIMPEZA PROFUNDA DE RAM +++
        try {
            flushDocCache(); // Reseta as planilhas do Google (liberta cache de células)
        } catch (e) {
            console.error("Erro ao limpar cache do Google:", e);
        }
        if (global.gc) {
            // Força o Node a limpar o lixo da memória AGORA
            const ramAntes = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
            global.gc();
            const ramDepois = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
            console.log(`[INFO GC] Memória limpa: ${ramAntes}MB -> ${ramDepois}MB`);
        } else {
            console.warn("[AVISO] O bot não foi iniciado com --expose-gc. A limpeza manual falhou.");
        }
    }, CHECK_INTERVAL_MS);
}
// +++ FIM: SISTEMA DE GESTÃO DE MEMÓRIA +++

// +++ INÍCIO: SISTEMA DE PERSISTÊNCIA DE ESTADO (JSON) +++

// +++ Define o nome da pasta de estados +++
const STATES_DIR = path.join(__dirname, 'states');

// Define os caminhos para os nossos ficheiros de estado
const STATE_PATHS = {
    pendingRegistrations: path.join(STATES_DIR, 'state_registrations.json'),
    pendingLoots: path.join(STATES_DIR, 'state_loots.json'),
    pendingRelatorios: path.join(STATES_DIR, 'state_relatorios.json'),
    pendingInventarios: path.join(STATES_DIR, 'state_inventarios.json'),
    pendingRolls: path.join(STATES_DIR, 'state_rolls.json'),
    pendingRollConfirmations: path.join(STATES_DIR, 'state_roll_confirms.json'),
    pendingP2PTrades: path.join(STATES_DIR, 'state_p2p_trades.json'),
    reactionListeners: path.join(STATES_DIR, 'state_reactions.json')
};

/**
 * Converte um Map para um Array (para que possa ser salvo como JSON).
 * @param {Map} map 
 */
function mapToJSON(map) {
    return JSON.stringify(Array.from(map.entries()), null, 4);
}

/**
 * Converte um Array (lido do JSON) de volta para um Map.
 * @param {string} jsonString 
 */
function jsonToMap(jsonString) {
    try {
        const arr = JSON.parse(jsonString);
        return new Map(arr);
    } catch (e) {
        return new Map(); // Retorna um mapa vazio se o JSON estiver corrompido
    }
}

/**
 * Salva todos os estados voláteis da RAM para ficheiros JSON.
 */
function saveAllStates() {
    console.log("[INFO Persistência] A guardar todos os estados para o disco...");
    try {
        // +++ GARANTE QUE A PASTA EXISTE +++
        // (Não precisa de criar a pasta manualmente)
        if (!fs.existsSync(STATES_DIR)) {
            fs.mkdirSync(STATES_DIR, { recursive: true });
            console.log(`[INFO Persistência] Pasta 'states' criada em ${STATES_DIR}`);
        }

        for (const [mapName, mapObject] of mapsToClean.entries()) {
            const filePath = STATE_PATHS[mapName];
            if (filePath && mapObject) {
                fs.writeFileSync(filePath, mapToJSON(mapObject));
            }
        }
        console.log("[INFO Persistência] Todos os estados foram salvos com sucesso.");
    } catch (error) {
        console.error("[ERRO Persistência] Falha crítica ao salvar estados:", error);
    }
}

/**
 * Carrega todos os estados dos ficheiros JSON para a RAM (client).
 */
function loadAllStates() {
    console.log("[INFO Persistência] A carregar estados do disco para a RAM...");
    try {
        for (const mapName in STATE_PATHS) {
            const filePath = STATE_PATHS[mapName];
            if (fs.existsSync(filePath)) {
                const fileData = fs.readFileSync(filePath, 'utf8');
                const loadedMap = jsonToMap(fileData);
                
                // Atribui o mapa carregado ao 'client'
                client[mapName] = loadedMap; 
                
                console.log(`[INFO Persistência] Carregados ${loadedMap.size} registos de '${mapName}'.`);
            }
        }
        console.log("[INFO Persistência] Carregamento de estados concluído.");
    } catch (error) {
        console.error("[ERRO Persistência] Falha crítica ao carregar estados:", error);
    }
}
// +++ FIM: SISTEMA DE PERSISTÊNCIA DE ESTADO (JSON) +++

// --- 4. Registro dos Comandos (REST) ---
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

client.once(Events.ClientReady, async (bot) => {
  console.log(`Bot ${bot.user.tag} está online!`);

  // +++ CARREGA OS ESTADOS PERSISTIDOS PRIMEIRO +++
  loadAllStates();

  // --- INÍCIO DO TESTE DE PERSISTÊNCIA (fs) ---
  console.log("[Teste FS] A tentar escrever no disco...");
  try {
      const testFilePath = path.join(__dirname, 'persistence_test.json');
      const testData = {
          message: "Se este ficheiro existe, o bot tem permissão de escrita.",
          timestamp: new Date().toISOString()
      };
      
      fs.writeFileSync(testFilePath, JSON.stringify(testData, null, 4));
      
      console.log(`[Teste FS SUCESSO] Ficheiro 'persistence_test.json' escrito com sucesso na pasta principal.`);
  } catch (error) {
      console.error(`[Teste FS FALHA] Não foi possível escrever o ficheiro de teste:`, error);
      console.error("[Teste FS FALHA] A persistência de estado (Bug 2) NÃO irá funcionar neste servidor.");
  }
  // --- FIM DO TESTE DE PERSISTÊNCIA (fs) ---

  // +++ ADICIONA OS MAPAS AO GESTOR DE LIMPEZA +++
  mapsToClean.set('pendingRegistrations', client.pendingRegistrations); //
  mapsToClean.set('pendingLoots', client.pendingLoots); //
  mapsToClean.set('pendingRelatorios', client.pendingRelatorios); //
  mapsToClean.set('pendingInventarios', client.pendingInventarios); //
  mapsToClean.set('pendingRolls', client.pendingRolls); //
  mapsToClean.set('pendingRollConfirmations', client.pendingRollConfirmations); //
  mapsToClean.set('pendingP2PTrades', client.pendingP2PTrades); //
  mapsToClean.set('reactionListeners', client.reactionListeners); //

  // CARREGA AS REGRAS DE CANAL PARA O CACHE
  await loadChannelRules();

  // +++ INÍCIO DA NOVA LÓGICA DE CACHE DE EMBED +++
  
  // 1. Cria um local para guardar o cache
  client.inventoryEmbedData = null;

  // 2. Função para carregar e atualizar o cache
  const refreshEmbedData = async () => {
    console.log("[Cache] Carregando/Atualizando dados de embed do inventário...");
    try {
        const data = await preloadInventoryEmbedData();
        if (data) {
            client.inventoryEmbedData = data;
            console.log("[Cache] Dados de embed carregados com sucesso.");
        } else {
            console.error("[Cache ERRO] preloadInventoryEmbedData retornou nulo. Mantendo cache antigo (se houver).");
        }
    } catch (error) {
        console.error("[Cache ERRO] Falha ao atualizar dados de embed:", error.message);
    }
  };

  // 3. Carrega os dados pela primeira vez
  await refreshEmbedData();

  // 4. Configura um temporizador para atualizar o cache a cada 15 minutos
  setInterval(refreshEmbedData, 15 * 60 * 1000); 

  // +++ CARREGA O CACHE DE ITENS (para /gasto, /transacao, etc.) +++
  await preloadItemCategories(docCraft); //

  // +++ FIM DA NOVA LÓGICA DE CACHE DE EMBED +++

  // +++ INICIA O RECOLHEDOR DE LIXO +++
  startRoutineGarbageCollector(); // Inicia o timer

  try {
    console.log(`Registrando ${commandsToRegister.length} comandos (/) ...`);
    await rest.put(
      Routes.applicationCommands(bot.user.id),
      { body: commandsToRegister },
    );
    console.log('Comandos registrados com sucesso!');
  } catch (error) {
    console.error("Erro ao registrar comandos:", error);
  }
});

// --- 5. O ROTEADOR DE INTERAÇÕES ---
client.on(Events.InteractionCreate, async interaction => {

  // +++ INÍCIO: "DISJUNTOR" DE RAM (O que você pediu) +++
  const ramLimitMB = parseInt(process.env.RAM_LIMIT_MB) || 100; // Padrão de 500MB
  const ramLimitBytes = ramLimitMB * 1024 * 1024;
  const currentRSS = process.memoryUsage().rss; // RAM atual usada pelo Node

  if (currentRSS > ramLimitBytes) {
      console.warn(`[ALERTA DE RAM] Limite (${ramLimitMB}MB) excedido! RAM atual: ${(currentRSS / 1024 / 1024).toFixed(2)}MB.`);
      console.warn(`[ALERTA DE RAM] A forçar limpeza de estados antigos ANTES de executar o comando...`);
      
      await forceCleanup(false); // Tenta limpar estados com >6 horas primeiro
      console.log(`[ALERTA DE RAM] Limpeza concluída. A continuar com o comando...`);
  }
  // +++ FIM: "DISJUNTOR" DE RAM +++

  try {
    let command; // Variável para guardar o comando encontrado
    // --- Roteador de Slash Commands ---
    if (interaction.isChatInputCommand()) {
      command = interaction.client.commands.get(interaction.commandName); // Atribui à variável externa
      if (!command) {
        console.error(`Comando "${interaction.commandName}" não encontrado.`);
        return;
      }
      // Verifica se execute existe antes de chamar
      if (command.execute) { await command.execute(interaction); }
      else { console.error(`Comando "${interaction.commandName}" não tem função execute.`); }
    } 

    // --- Roteador de Botões ---
    else if (interaction.isButton()) {
      const [action] = interaction.customId.split('|');
      
      command = null; // Reseta command
      // Itera sobre os comandos carregados, usando 'cmd' como variável do loop
      for (const cmd of client.commands.values()) {
        // Verifica se o comando atual (cmd) define 'buttons' e se a ação está na lista
        if (cmd.buttons && cmd.buttons.includes(action)) {
          command = cmd; // Atribui o comando encontrado (cmd) à variável externa 'command'
          break;
        }
      }
      // +++ CORREÇÃO: Se nenhum comando normal tratar disto, verifica o RollObserver +++
      if (!command && rollObserver.buttons && rollObserver.buttons.includes(action)) {
          command = rollObserver;
      }
      // Chama o handler se encontrado, senão avisa e defere
      if (command && command.handleButton) {
          await command.handleButton(interaction);
      } else {
          console.warn(`Nenhum handler de botão encontrado para: ${interaction.customId}`);
          // Confirma silenciosamente para evitar "Interação falhou"
          if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate().catch(()=>{});
      }
    }

    // --- Roteador de Modais ---
    else if (interaction.isModalSubmit()) {
      const [action] = interaction.customId.split('|');
      
      command = null; // Reseta command
      // Itera usando 'cmd'
      for (const cmd of client.commands.values()) {
        // Verifica se 'cmd' lida com este modal
        if (cmd.modals && cmd.modals.includes(action)) {
          command = cmd; // Atribui à variável externa 'command'
          break;
        }
      }
      // Chama o handler se encontrado, senão avisa e defere
      if (command && command.handleModal) {
          await command.handleModal(interaction);
      } else {
          console.warn(`Nenhum handler de modal encontrado para: ${interaction.customId}`);
          // Confirma silenciosamente
          if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate().catch(()=>{});
      }
    }

    // --- Roteador de Select Menus ---
    else if (interaction.isStringSelectMenu()) {
      const [action] = interaction.customId.split('|');
      
      command = null; // Reseta command
      // Itera usando 'cmd'
      for (const cmd of client.commands.values()) {
        // Verifica se 'cmd' lida com este select menu
        if (cmd.selects && cmd.selects.includes(action)) {
          command = cmd; // Atribui à variável externa 'command'
          break;
        }
      }
      // Chama o handler se encontrado, senão avisa e defere
      if (command && command.handleSelect) {
          await command.handleSelect(interaction);
      } else {
          console.warn(`Nenhum handler de select menu encontrado para: ${interaction.customId}`);
          // Confirma silenciosamente
          if (!interaction.replied && !interaction.deferred) await interaction.deferUpdate().catch(()=>{});
      }
    }

    // --- Roteador de Autocomplete ---
    else if (interaction.isAutocomplete()) {
        command = null; // Reseta command
        // Itera usando 'cmd'
        for (const cmd of client.commands.values()) {
            // Verifica se 'cmd' lida com este autocomplete
            // Usamos o NOME DO COMANDO como a chave
            if (cmd.autocomplete && cmd.autocomplete.includes(interaction.commandName)) {
                command = cmd; // Atribui à variável externa 'command'
                break;
            }
        }
        // Chama o handler se encontrado
        if (command && command.handleAutocomplete) {
            await command.handleAutocomplete(interaction);
        } else {
             console.warn(`Nenhum handler de autocomplete encontrado para: ${interaction.commandName}`);
        }
    }

  } catch (error) {
    // Um 'catch' genérico para qualquer erro
    console.error("Erro GERAL na interação:", error); // Ajusta nome do log
    // Garante que a mensagem de erro não exceda o limite do Discord
    const errorContent = `Ocorreu um erro inesperado: ${error.message}`.substring(0,1900);
    const errorMessage = { content: errorContent, flags: [MessageFlagsBitField.Flags.Ephemeral] };

    // Tenta responder ou seguir, dependendo do estado da interação
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp(errorMessage).catch(console.error);
    } else {
      // Tenta responder diretamente, adiciona catch para o caso de falhar também
      await interaction.reply(errorMessage).catch(async (replyError) => {
          console.error("Falha ao responder ao erro GERAL, tentando followUp:", replyError);
          // Última tentativa com followUp
          await interaction.followUp(errorMessage).catch(finalError => {
               console.error("Falha final ao enviar mensagem de erro GERAL:", finalError);
          });
      });
    }
  }
});

// --- 6. NOVO: OUVINTE DE REAÇÕES ---
client.on(Events.MessageReactionAdd, async (reaction, user) => {
    // 1. Ignorar reações de bots
    if (user.bot) return;

    // 2. Tentar carregar dados "parciais" (mensagens ou reações antigas)
    if (reaction.partial) {
        try {
            await reaction.fetch();
        } catch (error) {
            console.error('Falha ao carregar reação parcial:', error);
            return;
        }
    }
    if (reaction.message.partial) {
        try {
            await reaction.message.fetch();
        } catch (error) {
            console.error('Falha ao carregar mensagem parcial:', error);
            return;
        }
    }

    // 3. Verificar se estamos "ouvindo" esta mensagem
    const listener = client.reactionListeners.get(reaction.message.id)?.data;
    if (!listener) return; // Ninguém está ouvindo esta mensagem

    // 4. Verificar se é o emoji correto
    // Compara o ID (para emojis customizados) ou o nome (para emojis unicode, ex: '✅')
    const emojiIdentifier = reaction.emoji.id ? reaction.emoji.id : reaction.emoji.name;
    if (emojiIdentifier !== listener.emojiIdentifier) return; 

    // 5. Verificar Permissões (Usuário ou Cargo)
    let hasPermission = false;
    
    // 5a. Verificar lista de usuários permitidos
    if (listener.allowedUsers && listener.allowedUsers.includes(user.id)) {
        hasPermission = true;
    }

    // 5b. Verificar lista de cargos permitidos (se o usuário ainda não tiver permissão)
    if (!hasPermission && listener.allowedRoles && listener.allowedRoles.length > 0) {
        try {
            // Precisamos do 'member' (membro do servidor) para verificar os cargos
            const member = await reaction.message.guild.members.fetch(user.id);
            if (member && member.roles.cache.some(role => listener.allowedRoles.includes(role.id))) {
                hasPermission = true;
            }
        } catch (fetchError) {
            console.error("[Reação] Erro ao buscar 'member' para checar cargos:", fetchError);
        }
    }

    // 6. Se não tiver permissão, para
    if (!hasPermission) return;

    // 7. SUCESSO! Acionar o comando correspondente
    try {
        const command = client.commands.get(listener.commandName);
        if (command && command.handleReaction) {
            // Passa a reação, o usuário que reagiu, e os dados extras do ouvinte
            await command.handleReaction(reaction, user, listener);
        } else {
            console.warn(`[Reação] Comando '${listener.commandName}' não encontrado ou não tem 'handleReaction'.`);
        }
    } catch (error) {
        console.error(`[Reação] Erro ao executar handleReaction para '${listener.commandName}':`, error);
    }
});

// --- 7. NOVO: OUVINTE DE MENSAGENS (Para o Rollem) ---
client.on(Events.MessageCreate, async message => {
    // Ignora as nossas próprias mensagens
    if (message.author.id === client.user.id) return;

    // Se for uma mensagem do Rollem, processa-a
    if (message.author.username === 'rollem') { //
        await handleRollemMessage(message);
    }
});

// +++ HOOK DE ENCERRAMENTO (Shutdown Hook) +++
process.on('SIGINT', () => {
    console.log("[INFO Shutdown] Sinal de encerramento (SIGINT) recebido.");
    console.log("[INFO Shutdown] A guardar todos os estados pendentes ANTES de desligar...");
    saveAllStates(); // Salva tudo
    console.log("[INFO Shutdown] Estados guardados. A desligar.");
    process.exit(0);
});

// +++ 2. HOOK DE "CRASH" (Salvamento de Emergência) +++
// Isto é acionado se o bot sofrer um erro de código que não foi tratado.
process.on('uncaughtException', (error, origin) => {
    console.error('[ERRO FATAL] Uncaught Exception (CRASH):', error);
    console.error('[ERRO FATAL] Origem:', origin);
    
    console.log("[INFO Shutdown] A tentar um salvamento de emergência ANTES de cair...");
    try {
        // Tenta um último salvamento. Como é síncrono, deve bloquear
        // o processo o tempo suficiente para terminar antes de o bot cair.
        saveAllStates();
        console.log("[INFO Shutdown] Salvamento de emergência concluído.");
    } catch (saveError) {
        console.error("[ERRO FATAL] Salvamento de emergência falhou:", saveError);
    }
    
    process.exit(1); // Sai com um código de erro, indicando que houve um crash
});

// --- 8. Login ---
client.login(DISCORD_TOKEN);