const updateConfirmationsMessage = require('../../utils/updateMessage');

module.exports = {
    name: "guildMemberRemove",

    async execute(client, member) {
        console.info(`➡️ Member left: ${member.user.tag}`);
        await updateConfirmationsMessage(client);
    }
};
