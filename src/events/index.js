const fs = require('fs');
const path = require('path');

module.exports = (client) => {
    const eventsPath = path.join(__dirname);
    const eventFolders = fs.readdirSync(eventsPath);

    for (const folder of eventFolders) {
        if (folder === 'index.js') continue;

        const folderPath = path.join(eventsPath, folder);
        const eventFiles = fs.readdirSync(folderPath).filter(file => file.endsWith('.js'));

        for (const file of eventFiles) {
            const event = require(path.join(folderPath, file));

            client.on(event.name, (...args) => event.execute(client, ...args));

            console.info(`🗹 Loaded Event: ${event.name}`);
        }
    }
};
