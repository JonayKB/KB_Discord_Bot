import { ChannelType, Client, type Message, ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";

export default {
    name: "messageCreate",

    execute(client: Client, message: Message) {
        if (message.author.bot) return;
        if (message.channel.type !== ChannelType.DM) return;

        console.info(`📩 New DM from ${message.author.tag}: ${message.content}`);

        (async () => {
            const adminId = process.env.ADMIN_ID ?? "335537584686235649";
            try {
                const admin = await client.users.fetch(adminId);
                if (!admin) return console.warn("Admin user not found");

                const embed = {
                    title: `📩 New DM from ${message.author.tag}`,
                    description: message.content || "[no content]",
                    color: 0x00AE86,
                    fields: [
                        { name: "User", value: `${message.author.tag} (${message.author.id})`, inline: true },
                        { name: "Channel", value: "DM", inline: true }
                    ],
                    timestamp: new Date().toISOString()
                };

                // Crear botón para responder
                const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`reply_${message.author.id}`) // ID único por usuario
                        .setLabel("Responder")
                        .setStyle(ButtonStyle.Primary)
                );

                await admin.send({ embeds: [embed], components: [row] });
                console.info("Forwarded DM to admin with reply button");
            } catch (err) {
                console.error("Failed to forward DM to admin:", err);
            }
        })();
    }
};
