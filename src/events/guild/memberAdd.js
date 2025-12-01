const updateConfirmationsMessage = require('../../utils/updateMessage');


module.exports = {
    name: "guildMemberAdd",

    async execute(client, member) {
        console.info(`➡️ New member: ${member.user.tag}`);
        await updateConfirmationsMessage(client);
    }
};
