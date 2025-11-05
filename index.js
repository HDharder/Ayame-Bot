// --- 1. Importação das Bibliotecas ---
require('dotenv').config();
const { loadChannelRules } = require('./utils/channelGuard.js'); // +++ IMPORTA O GUARD +++
const fs = require('node:fs');
const path = require('node:path');
const ADMIN_SERVER_ID = process.env.ADMIN_SERVER_ID;
const {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  Events,
  Collection, // Usamos Collection em vez de Map, é otimizado para discord.js
  MessageFlagsBitField
} = require('discord.js');

// --- 2. Configuração das Credenciais ---
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;

const client = new Client({ intents: [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMessageReactions
]});

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
        
        // Itera pelas chaves (IDs) do mapa
        for (const interactionId of map.keys()) {
            // Tenta extrair o timestamp do ID do Discord
            const timestamp = (BigInt(interactionId) >> 22n) + 1420070400000n;
            const ageMs = now - Number(timestamp);

            // Se 'forceAll' estiver ativo, OU se o estado for mais antigo que o limite
            if (forceAll || ageMs > limitMs) {
                map.delete(interactionId);
                itemsCleaned++;
            }
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
        console.log(`[INFO GarbageCollector] A executar limpeza de rotina...`);
        forceCleanup(false); // Chama a limpeza (sem forçar)
    }, CHECK_INTERVAL_MS);
}
// +++ FIM: SISTEMA DE GESTÃO DE MEMÓRIA +++

// --- 4. Registro dos Comandos (REST) ---
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

client.once(Events.ClientReady, async (bot) => {
  console.log(`Bot ${bot.user.tag} está online!`);

  // +++ ADICIONA OS MAPAS AO GESTOR DE LIMPEZA +++
  mapsToClean.set('pendingRegistrations', client.pendingRegistrations); //
  mapsToClean.set('pendingLoots', client.pendingLoots); //
  mapsToClean.set('pendingRelatorios', client.pendingRelatorios); //
  mapsToClean.set('pendingInventarios', client.pendingInventarios); //

  // CARREGA AS REGRAS DE CANAL PARA O CACHE
  await loadChannelRules();

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
    const listener = client.reactionListeners.get(reaction.message.id);
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

// --- 7. Login ---
client.login(DISCORD_TOKEN);