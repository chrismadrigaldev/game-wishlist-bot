import { REST, Routes, SlashCommandBuilder, SlashCommandStringOption } from 'discord.js';

const commands = [
  new SlashCommandBuilder()
    .setName('wishlist')
    .setDescription('Add a game to the wishlist')
    .addStringOption((option: SlashCommandStringOption) =>
      option.setName('game')
        .setDescription('Game name')
        .setRequired(true)
        .setAutocomplete(true)
    )
    .toJSON()
];

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN!);

(async () => {
  try {
    console.log('⏳ Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(process.env.CLIENT_ID!),
      { body: commands }
    );
    console.log('✅ Slash commands registered.');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
})();
