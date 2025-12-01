const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');
require('dotenv').config();

// Cargar variables de entorno
const { CLIENT_ID, GUILD_ID, TOKEN } = process.env;

// Definir comandos de barra
const commands = [
  // 📌 /setreaction
  new SlashCommandBuilder()
    .setName('setreaction')
    .setDescription('Configura un mensaje con reacción para asignar roles')
    .addChannelOption(option =>
      option.setName('canal')
        .setDescription('Canal donde se enviará el mensaje')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('titulo')
        .setDescription('Título del mensaje')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('descripcion')
        .setDescription('Descripción del mensaje. Usa \\n para saltos de línea')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('color')
        .setDescription('Color del mensaje en formato hexadecimal (ejemplo: #FF0000)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('emoji')
        .setDescription('Emoji que dará el rol')
        .setRequired(true))
    .addRoleOption(option =>
      option.setName('rol')
        .setDescription('Rol que se asignará al reaccionar')
        .setRequired(true)),

  // 📌 /calcular
  new SlashCommandBuilder()
    .setName('calcular')
    .setDescription('Calcula el precio por persona según los que tienen un rol específico')
    .addNumberOption(option =>
      option.setName('numero')
        .setDescription('Cantidad total a dividir')
        .setRequired(true))
    .addRoleOption(option =>
      option.setName('excluir_rol')
        .setDescription('Rol que SÍ participa en el cálculo')
        .setRequired(true)),
  // Enviar a rol
  new SlashCommandBuilder()
    .setName('enviar_a_rol')
    .setDescription('Envía un mensaje privado a todos los usuarios con un rol específico (con embed)')
    .addRoleOption(option =>
      option.setName('rol')
        .setDescription('El rol a cuyos miembros enviar el mensaje')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('titulo')
        .setDescription('El título del embed (puede incluir emojis)')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('mensaje')
        .setDescription('El contenido del mensaje. Usa \\n para saltos de línea')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('footer')
        .setDescription('El texto del pie de página del embed')
        .setRequired(false)),
]

// Crear instancia REST
const rest = new REST({ version: '10' }).setToken(TOKEN);

(async () => {
  try {
    console.info('🔁 Registrando comandos de barra...');
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands },
    );
    console.info('✅ Comandos registrados con éxito.');
  } catch (error) {
    console.error('❌ Error al registrar comandos:', error);
  }
})();
