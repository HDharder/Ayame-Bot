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

// --- 4. Registro dos Comandos (REST) ---
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

client.once(Events.ClientReady, async (bot) => {
  console.log(`Bot ${bot.user.tag} está online!`);

  // CARREGA AS REGRAS DE CANAL PARA O CACHE
  await loadChannelRules();

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

// --- 6. Login ---
client.login(DISCORD_TOKEN);