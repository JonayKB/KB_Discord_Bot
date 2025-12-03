import { ChannelType, Client, type Message } from "discord.js";

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

                await admin.send({ embeds: [embed] });
                console.info("Forwarded DM to admin");
            } catch (err) {
                console.error("Failed to forward DM to admin:", err);
            }
        })();
    }
};