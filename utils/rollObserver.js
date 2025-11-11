// utils/rollObserver.js
const { ActionRowBuilder, ButtonBuilder, ButtonStyle, userMention } = require('discord.js');
const { handlePersuasionResult, closeRollBrecha } = require('../utils/transacaoUtils.js');

/**
 * Esta função é CHAMADA pelo rollemListener.js quando uma rolagem
 * é válida, mas falta o texto.
 * @param {import('discord.js').Message} rollemMessage - A mensagem de resposta do Rollem.
 * @param {object} parsedData - O objeto 'parsed' do rollemListener.
 * @param {object} brecha - O objeto 'brecha' do rollemListener.
 */
async function createRollConfirmation(rollemMessage, parsedData, brecha) {
    // ID único para esta confirmação (usamos o ID da msg do Rollem)
    const confirmationId = rollemMessage.id;
    const client = rollemMessage.client;

    // 1. Constrói a mensagem
    const requiredText = brecha.requiredText.join(', ');
    const content = `${userMention(parsedData.user.id)}, a sua rolagem (**${parsedData.result}**) foi detectada sem o texto correto. ` +
                    `Esta foi uma rolagem para **"${requiredText}"**?\n\n` +
                    `> ${rollemMessage.url}`; // Link para a mensagem do Rollem

    const buttons = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`roll_confirm_yes|${confirmationId}`)
            .setLabel('Sim')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`roll_confirm_no|${confirmationId}`)
            .setLabel('Não')
            .setStyle(ButtonStyle.Danger)
    );

    // 2. Envia a mensagem pública de confirmação
    const confirmationMessage = await rollemMessage.channel.send({
        content: content,
        components: [buttons],
        allowedMentions: { users: [parsedData.user.id] } // Marca o jogador
    });

    // 3. Salva o estado para o handleButton
    if (!client.pendingRollConfirmations) client.pendingRollConfirmations = new Map();
    client.pendingRollConfirmations.set(confirmationId, {
        parsed: parsedData,
        brecha: brecha,
        confirmationMessageId: confirmationMessage.id,
        rollemMessageId: rollemMessage.id // Guarda o ID da msg do rollem para reagir
    });

    // 4. Adiciona um timeout (recolhedor de lixo) para 5 minutos
    setTimeout(() => {
        const pending = client.pendingRollConfirmations.get(confirmationId);
        if (pending) {
            console.log(`[RollObserver] Confirmação ${confirmationId} expirou.`);
            confirmationMessage.edit({ content: `Esta confirmação expirou.`, components: [] }).catch(() => {});
            client.pendingRollConfirmations.delete(confirmationId);
        }
    }, 5 * 60 * 1000); // 5 minutos para responder
}


/**
 * Handler para os botões 'roll_confirm_yes' e 'roll_confirm_no'
 */
async function handleButton(interaction) {
    const [action, confirmationId] = interaction.customId.split('|');
    const state = interaction.client.pendingRollConfirmations.get(confirmationId);

    // 1. Verifica se o estado existe
    if (!state) {
        await interaction.reply({ content: 'Esta confirmação de rolagem expirou ou já foi usada.', ephemeral: true });
        // Tenta apagar a mensagem de botões, se ainda existir
        await interaction.message.delete().catch(() => {});
        return;
    }

    // 2. Verifica se quem clicou é o jogador original
    if (interaction.user.id !== state.parsed.user.id) {
        await interaction.reply({ content: 'Apenas o jogador que rolou os dados pode confirmar esta ação.', ephemeral: true });
        return;
    }

    // 3. Confirma o clique e apaga o estado
    await interaction.deferUpdate();
    interaction.client.pendingRollConfirmations.delete(confirmationId);

    // 4. Apaga a mensagem de confirmação
    await interaction.message.delete().catch(e => console.warn(`[RollObserver] Falha ao apagar msg de confirmação: ${e.message}`));

    // 5. Executa a Ação
    if (action === 'roll_confirm_yes') {
        // Ação "Sim": O texto está confirmado. Agora, validamos o CD.
        const { parsed, brecha } = state;
        
        // (Re-executa a lógica de sucesso do rollemListener)
        const success = parsed.result >= brecha.cd;
        console.log(`[RollObserver] Confirmação 'Sim' recebida. CD: ${brecha.cd}, Resultado: ${parsed.result}. SUCESSO: ${success}`);

        // Reage à mensagem ORIGINAL do Rollem
        try {
            const rollemMessage = await interaction.channel.messages.fetch(state.rollemMessageId);
            if (success) {
                await rollemMessage.react('✅');
            } else {
                await rollemMessage.react('❌');
            }
        } catch (e) {
            console.error("[RollObserver] Falha ao reagir à mensagem do Rollem:", e.message);
        }

        if (brecha.sourceCommand === 'transacao') {
            await handlePersuasionResult(interaction.client, brecha, success);
        }
        
        await closeRollBrecha(interaction.client, parsed.channel, parsed.user.username);
    } else {
        // Ação "Não": A rolagem é ignorada.
        console.log(`[RollObserver] Confirmação 'Não' recebida. A rolagem será ignorada.`);
        // +++ CORREÇÃO: Fecha a brecha +++
        const { parsed, brecha } = state;
        await closeRollBrecha(interaction.client, parsed.channel, parsed.user.username);
    }
}

module.exports = {
    // Exportamos os handlers que o index.js e o rollemListener.js precisam
    buttons: ['roll_confirm_yes', 'roll_confirm_no'],
    handleButton: handleButton,
    createRollConfirmation: createRollConfirmation
};