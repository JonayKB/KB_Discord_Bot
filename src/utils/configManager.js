const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '../data/config.json');

module.exports = {
    loadConfig() {
        if (!fs.existsSync(file)) return { reactions: [] };
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    },

    saveConfig(data) {
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
    }
};
