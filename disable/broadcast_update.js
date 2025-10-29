const { SlashCommandBuilder, EmbedBuilder, ChannelType, PermissionFlagsBits } = require('discord.js');
// Importa o seu ficheiro de registo de alterações
const changelog = require('../changelog.json'); 
// Importa o utilitário de autenticação
const { checkAuth, AuthLevels } = require('../utils/auth.js'); 

module.exports = {
    // 1. Flag especial para o index.js saber que este comando é restrito
    adminOnly: true, 
    
    data: new SlashCommandBuilder()
        .setName('broadcast_update')
        .setDescription('Envia a última atualização para o canal #ayame-changelogs em todos os servidores.')
        .setDMPermission(false), // Garante que não pode ser usado em DMs

    async execute(interaction) {
        // 2. VERIFICAR PERMISSÃO (Só Staff pode usar)
        // (Pode mudar para AuthLevels.STAFF se preferir)
        const hasAuth = await checkAuth(interaction, { allowedLevels: [AuthLevels.STAFF] });
        if (!hasAuth) {
            // checkAuth já envia a resposta de erro
            return;
        }

        await interaction.reply({ content: 'Iniciando transmissão do changelog... ⏳', ephemeral: true });

        // 3. PEGAR A ÚLTIMA ATUALIZAÇÃO do changelog.json
        const latestUpdate = changelog.updates[0];
        if (!latestUpdate) {
            await interaction.followUp({ content: 'Erro: `changelog.json` está vazio ou não foi encontrado.', ephemeral: true });
            return;
        }

        // 4. MONTAR O EMBED (Mensagem bonita)
        const embed = new EmbedBuilder()
            .setTitle(`🎉 Atualização v${latestUpdate.version}: ${latestUpdate.title}`)
            .setColor(0x5865F2) // Cor do Discord
            .setDescription(`*Publicado em: ${latestUpdate.date}*`)
            .setTimestamp();

        // Adiciona os campos dinamicamente
        if (latestUpdate.features && latestUpdate.features.length > 0) {
            embed.addFields({ 
                name: '✨ Novas Features', 
                value: '• ' + latestUpdate.features.join('\n• ') 
            });
        }
        if (latestUpdate.fixes && latestUpdate.fixes.length > 0) {
            embed.addFields({ 
                name: '🐛 Correções de Bugs', 
                value: '• ' + latestUpdate.fixes.join('\n• ') 
            });
        }
        if (latestUpdate.backend && latestUpdate.backend.length > 0) {
            embed.addFields({ 
                name: '⚙️ Backend/Outros', 
                value: '• ' + latestUpdate.backend.join('\n• ') 
            });
        }

        // 5. ITERAR E ENVIAR
        const channelName = 'ayame-changelogs';
        let serversSent = 0;
        let serversFailed = 0;
        
        // Usamos Promise.all para aguardar que todas as tentativas terminem
        const broadcastPromises = [];

        // Itera por todos os servidores (guilds) que o bot está
        interaction.client.guilds.cache.forEach(guild => {
            const promise = (async () => {
                // Encontra o canal pelo nome exato e tipo de texto
                const channel = guild.channels.cache.find(
                    c => c.name === channelName && c.type === ChannelType.GuildText
                );
                
                // Se não encontrou o canal, ignora este servidor
                if (!channel) {
                    return; 
                }

                // Tenta buscar o "membro" do bot no servidor para verificar permissões
                let botMember;
                try {
                    botMember = await guild.members.fetchMe();
                } catch (e) {
                    console.log(`[Broadcast] Não consegui verificar permissões em ${guild.name}. Pulando.`);
                    serversFailed++;
                    return;
                }

                // Verifica se o bot pode enviar mensagens naquele canal
                if (channel.permissionsFor(botMember).has(PermissionFlagsBits.SendMessages)) {
                    try {
                        await channel.send({ embeds: [embed] });
                        serversSent++;
                    } catch (e) {
                        console.error(`[Broadcast] Falha ao ENVIAR para ${guild.name} (#${channel.name}):`, e.message);
                        serversFailed++;
                    }
                } else {
                    // Bot vê o canal mas não pode falar
                    console.log(`[Broadcast] Sem permissão em ${guild.name} (#${channel.name})`);
                    serversFailed++;
                }
            })();
            broadcastPromises.push(promise);
        });

        // 6. ESPERAR E RESPONDER AO ADMIN
        await Promise.all(broadcastPromises);

        await interaction.followUp({ 
            content: `✅ Transmissão concluída!\n\nEnviado para: ${serversSent} servidores.\nFalha em: ${serversFailed} servidores (canal não encontrado ou sem permissão).`, 
            ephemeral: true 
        });
    }
};