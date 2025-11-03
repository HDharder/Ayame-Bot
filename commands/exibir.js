// commands/exibir.js
const { SlashCommandBuilder, EmbedBuilder, MessageFlagsBitField, userMention } = require('discord.js');

// Importa as funções de utilitários que vamos usar
const { getChannelOwner } = require('../utils/inventarioUtils.js'); //
const { docInventario, getValuesFromSheet } = require('../utils/google.js'); //
const { checkChannelPermission } = require('../utils/channelGuard.js'); //
const { fetchMesasJogadas } = require('../utils/exibirUtils.js'); //

// Pega o ID do canal de log (o mesmo usado pelo /loot e /relatorio)
//const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID; //

module.exports = {
    data: new SlashCommandBuilder()
        .setName('exibir')
        .setDescription('Exibe informações detalhadas do seu personagem (ex: histórico de gastos).')
        .addStringOption(option =>
            option.setName('opcao')
                .setDescription('A informação que você deseja exibir.')
                .setRequired(true)
                .addChoices(
                    { name: 'Gastos', value: 'gastos' },
                    { name: 'Histórico de Mesas Jogadas', value: 'mesas_jogadas' }
                    // { name: 'Opção Futura', value: 'outra_coisa' }
                )
        ),

    async execute(interaction) {
        
        // 1. VERIFICAÇÃO INICIAL DE CANAL (Channel Guard)
        const isAllowedInChannel = checkChannelPermission('Inventário', interaction); //
        if (!isAllowedInChannel) {
            await interaction.reply({
                content: "Este comando só pode ser usado num canal de inventário (post de fórum) designado.",
                flags: [MessageFlagsBitField.Flags.Ephemeral]
            });
            return;
        }

        await interaction.deferReply({ ephemeral: true });

        try {
            // 2. VERIFICAÇÃO DE DONO DO CANAL
            const channelInfo = await getChannelOwner(interaction.channel.id); //
            
            if (!channelInfo || !channelInfo.owner || !channelInfo.characterRow) {
                await interaction.editReply({
                    content: 'Este canal não está registrado para nenhum inventário. Use `/inventario` primeiro.'
                });
                return;
            }

            if (channelInfo.owner.trim().toLowerCase() !== interaction.user.username.trim().toLowerCase()) {
                await interaction.editReply({
                    content: `Este inventário pertence a **${channelInfo.owner}**. Apenas o dono pode usar este comando aqui.`
                });
                return;
            }

            // 3. ROTEAMENTO DA OPÇÃO
            const opcao = interaction.options.getString('opcao');

            if (opcao === 'gastos') {
                await this.handleExibirGastos(interaction, channelInfo.characterRow);
            } else if (opcao === 'mesas_jogadas') {
                await this.handleExibirMesas(interaction, channelInfo.characterRow);
            }

        } catch (error) {
            console.error("[ERRO /exibir execute]:", error);
            await interaction.editReply({ content: 'Ocorreu um erro inesperado ao processar sua solicitação.' });
        }
    },

    /**
     * Lógica específica para a opção 'gastos'
     * @param {import('discord.js').Interaction} interaction
     * @param {import('google-spreadsheet').GoogleSpreadsheetRow} characterRow
     */
    async handleExibirGastos(interaction, characterRow) {
        
        // 1. Buscar IDs da planilha
        const criteria = { 
            'JOGADOR': characterRow.get('JOGADOR'), 
            'PERSONAGEM': characterRow.get('PERSONAGEM') 
        };
        await docInventario.loadInfo(); //
        const sheet = docInventario.sheetsByTitle['Inventário']; //
        if (!sheet) throw new Error("Aba 'Inventário' não encontrada.");

        const result = await getValuesFromSheet(sheet, criteria, ['Gastos']); //
        
        if (result.length === 0 || !result[0]['Gastos'] || String(result[0]['Gastos']).trim() === '') {
            await interaction.editReply({ content: "Nenhum histórico de gastos encontrado para este personagem." });
            return;
        }

        const logIds = String(result[0]['Gastos']).split(',');

        /*
        // 2. Buscar Canal de Log
        if (!LOG_CHANNEL_ID) {
            await interaction.editReply({ content: "Erro: O ID do canal de log não está configurado no bot." });
            return;
        }
        
        const logChannel = await interaction.client.channels.fetch(LOG_CHANNEL_ID);
        if (!logChannel || !logChannel.isTextBased()) {
            await interaction.editReply({ content: "Erro: Não foi possível encontrar o canal de logs." });
            return;
        }*/

        // O canal de log é o próprio canal do inventário
        const logChannel = interaction.channel;
        // (Já sabemos que é 'TextBased' e que o bot tem permissão
        // por causa das verificações no início do comando)

        // 3. Buscar e compilar mensagens de log
        let allGastosLines = [];
        let notFoundCount = 0;

        for (const id of logIds) {
            try {
                const msg = await logChannel.messages.fetch(id.trim());
                if (msg && msg.embeds.length > 0) {
                    const embed = msg.embeds[0];
                    // Usa o timestamp da MENSAGEM, não do embed
                    const timestamp = Math.floor(msg.createdTimestamp / 1000);
                    
                    // Pega os campos do embed
                    const ouro = embed.fields.find(f => f.name === 'Ouro Removido')?.value || '0 PO';
                    const itens = (embed.fields.find(f => f.name === 'Itens Removidos')?.value || 'Nenhum').replace(/```/g, '');
                    const obs = (embed.fields.find(f => f.name === 'Observação (Motivo)')?.value || 'N/A').replace(/```/g, '');

                    // Formata a linha
                    allGastosLines.push(`**<t:${timestamp}:d> <t:${timestamp}:t>:** ${ouro} | **Itens:** ${itens} | **Motivo:** ${obs}`);
                }
            } catch (error) {
                if (error.code === 10008) { // Unknown Message
                    notFoundCount++;
                } else {
                    console.error(`[ERRO /exibir] Falha ao buscar log ID ${id}:`, error);
                }
            }
        }

        if (allGastosLines.length === 0) {
            await interaction.editReply({ content: "Nenhum registro de gasto encontrado (mensagens de log podem ter sido apagadas)." });
            return;
        }

        // 4. Paginar e enviar as mensagens (limite de 2000 caracteres)
        const embedsToSend = [];
        const embedTitle = `Histórico de Gastos para ${characterRow.get('PERSONAGEM')}`;
        let currentDescription = ''; // Começa a descrição vazia

        for (const line of allGastosLines) {
            const lineWithNewline = line + '\n';
            // Se a linha nova estourar o limite, salva a mensagem atual e começa uma nova
            if (currentDescription.length + lineWithNewline.length > 2000) {
                embedsToSend.push(
                    new EmbedBuilder().setTitle(embedTitle).setColor(0xFFA500).setDescription(currentDescription)
                );
                currentDescription = lineWithNewline; // Começa a nova descrição
            } else {
                currentDescription += lineWithNewline;
            }
        }
        // Adiciona o último embed (ou o primeiro, se for curto)
        embedsToSend.push(
            new EmbedBuilder().setTitle(embedTitle).setColor(0xFFA500).setDescription(currentDescription)
        );

        // Envia as mensagens
        await interaction.editReply({ embeds: [embedsToSend[0]] }); // Envia o primeiro embed

        for (let i = 1; i < embedsToSend.length; i++) {
            await interaction.followUp({ embeds: [embedsToSend[i]], ephemeral: true }); // Envia o resto como follow-up
        }

        if (notFoundCount > 0) {
            await interaction.followUp({ 
                content: `*Aviso: ${notFoundCount} registro(s) de gastos foram ignorados pois as mensagens de log originais foram apagadas.*`, 
                ephemeral: true 
            });
        }
    },

    /**
     * Lógica específica para a opção 'mesas_jogadas'
     * @param {import('discord.js').Interaction} interaction
     * @param {import('google-spreadsheet').GoogleSpreadsheetRow} characterRow
     */
    async handleExibirMesas(interaction, characterRow) {
        const charName = characterRow.get('PERSONAGEM');

        // 1. Busca os dados usando o novo utilitário
        const history = await fetchMesasJogadas(charName);

        if (!history || history.length === 0) {
            await interaction.editReply({ content: `Nenhum histórico de mesas jogadas encontrado para **${charName}**.` });
            return;
        }

        // 2. Formata as linhas
        const allMesaLines = history.map(mesa => {
            const dataStr = mesa.timestamp ? `<t:${mesa.timestamp}:d> <t:${mesa.timestamp}:t>` : '??/??/????';
            const itensStr = (mesa.itens && mesa.itens.trim() !== '') ? mesa.itens : 'Nenhum';
            
            return `**${dataStr} - Mestre:** ${mesa.mestre} (Tier ${mesa.tier})\n` +
                   `**Gold:** ${mesa.gold} PO | **Itens:** ${itensStr}`;
        });

        // 3. Paginar e enviar os Embeds
        const embedsToSend = [];
        const embedTitle = `Histórico de Mesas para ${charName}`;
        let currentDescription = '';

        for (const line of allMesaLines) {
            const lineWithNewline = line + '\n\n'; // Adiciona espaço extra entre as entradas
            
            // Limite de 2000 é seguro (Embed é 4096)
            if (currentDescription.length + lineWithNewline.length > 2000) {
                embedsToSend.push(
                    new EmbedBuilder().setTitle(embedTitle).setColor(0x5865F2).setDescription(currentDescription) // Azul
                );
                currentDescription = lineWithNewline;
            } else {
                currentDescription += lineWithNewline;
            }
        }
        // Adiciona o último embed
        embedsToSend.push(
            new EmbedBuilder().setTitle(embedTitle).setColor(0x5865F2).setDescription(currentDescription)
        );

        // 4. Envia as respostas
        await interaction.editReply({ embeds: [embedsToSend[0]] });

        for (let i = 1; i < embedsToSend.length; i++) {
            await interaction.followUp({ embeds: [embedsToSend[i]], ephemeral: true });
        }
    }
};