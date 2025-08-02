import {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  TextChannel,
  EmbedBuilder,
  Partials,
  ChannelType
} from 'discord.js';
import { config } from 'dotenv';
import { existsSync, readFileSync, writeFileSync } from 'fs';

config();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User]
});

type WishlistEntry = {
  name: string;
  appid: number;
  suggester: string;
};

let singleList: WishlistEntry[] = [];
let multiList: WishlistEntry[] = [];
let steamCache: Record<string, any> = {};

if (existsSync('wishlist_single.json')) singleList = JSON.parse(readFileSync('wishlist_single.json', 'utf-8'));
if (existsSync('wishlist_multi.json')) multiList = JSON.parse(readFileSync('wishlist_multi.json', 'utf-8'));
if (existsSync('steam_cache.json')) steamCache = JSON.parse(readFileSync('steam_cache.json', 'utf-8'));

function saveLists() {
  writeFileSync('wishlist_single.json', JSON.stringify(singleList, null, 2));
  writeFileSync('wishlist_multi.json', JSON.stringify(multiList, null, 2));
}
function saveCache() {
  writeFileSync('steam_cache.json', JSON.stringify(steamCache, null, 2));
}

async function searchSteamGame(query: string): Promise<{ name: string; appid: number; url: string } | null> {
  const cacheKey = `search:${query.toLowerCase()}`;
  if (steamCache[cacheKey]) return steamCache[cacheKey];

  const res = await fetch(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&cc=us&l=en`);
  const json = await res.json();
  if (json.items && json.items.length > 0) {
    const top = json.items.find((item: any) => item.name.toLowerCase() === query.toLowerCase()) || json.items[0];

    const result = {
      name: top.name,
      appid: top.id,
      url: `https://store.steampowered.com/app/${top.id}`
    };
    steamCache[cacheKey] = result;
    saveCache();
    return result;
  }
  return null;
}

async function fetchSteamDetails(appid: number): Promise<{
  name: string;
  description: string;
  price: string;
  headerImage: string;
  url: string;
  categories: string[];
  genres: string[];
} | null> {
  const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=us&l=en`);
  const data = await res.json();
  const game = data[appid]?.data;
  if (!game) return null;

  const price = game.is_free ? 'Free' : (game.price_overview?.final_formatted || 'Unknown');
  const description = game.short_description || 'No description provided.';
  const categories = game?.categories?.map((c: any) => c.description) || [];
  const genres = game?.genres?.map((g: any) => g.description) || [];
  return {
    name: game.name,
    description,
    price,
    headerImage: game.header_image,
    url: `https://store.steampowered.com/app/${appid}`,
    categories,
    genres
  };
}

function getGameType(categories: string[]): 'single' | 'multi' | 'both' | 'unknown' {
  const lower = categories.map(c => c.toLowerCase());
  const isSingle = lower.includes('single-player');
  const isMulti = lower.some(c => c.includes('multiplayer') || c.includes('co-op') || c.includes('cross-platform'));
  if (isMulti) return 'multi'; // override: any multiplayer makes it multi-only
  if (isSingle) return 'single';
  return 'unknown';
}

async function postGameEmbed(channelId: string, entry: WishlistEntry) {
  const channel = await client.channels.fetch(channelId) as TextChannel;
  if (!channel?.isTextBased()) return;
  const details = await fetchSteamDetails(entry.appid);
  if (!details) return;

  const embed = new EmbedBuilder()
    .setTitle(details.name)
    .setURL(details.url)
    .setDescription(details.description.slice(0, 300) + '...')
    .addFields(
      { name: 'Price', value: details.price, inline: true },
      { name: 'Genres', value: details.genres.join(', ') || 'N/A', inline: false },
      { name: 'Tags', value: details.categories.join(', ') || 'N/A', inline: false }
    )
    .setImage(details.headerImage);

  await channel.send({ embeds: [embed] });
}

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const submissionChannel = process.env.SUBMISSION_CHANNEL_ID!;
  const singleDisplayChannel = process.env.WISHLIST_SINGLE_CHANNEL_ID!;
  const multiDisplayChannel = process.env.WISHLIST_MULTI_CHANNEL_ID!;

  if (interaction.commandName === 'wishlist') {
    const gameName = interaction.options.getString('game', true);
    if (interaction.channel?.id !== submissionChannel) {
      return interaction.reply({ content: '❌ Please use this in the designated submission channel.', ephemeral: true });
    }

    const steamGame = await searchSteamGame(gameName);
    if (!steamGame) return interaction.reply({ content: '❌ Game not found on Steam.', ephemeral: true });

    const details = await fetchSteamDetails(steamGame.appid);
    if (!details) return interaction.reply({ content: '❌ Could not fetch game details.', ephemeral: true });

    const type = getGameType(details.categories);
    if (type === 'unknown') return interaction.reply({ content: '❌ Could not determine game type.', ephemeral: true });

    const entry: WishlistEntry = {
      name: steamGame.name,
      appid: steamGame.appid,
      suggester: interaction.user.username
    };

    const isDuplicate = (type === 'single') && singleList.some(g => g.appid === entry.appid) ||
                        (type === 'multi') && multiList.some(g => g.appid === entry.appid);
    if (isDuplicate) return interaction.reply({ content: '⚠️ This game is already in the wishlist.', ephemeral: true });

    if (type === 'single') {
      singleList.push(entry);
      await postGameEmbed(singleDisplayChannel, entry);
    }
    if (type === 'multi') {
      multiList.push(entry);
      await postGameEmbed(multiDisplayChannel, entry);
    }

    saveLists();
    await interaction.reply({ content: '👍', ephemeral: true });
  }
});

client.on('messageReactionAdd', async (reaction, user) => {
  if (reaction.partial) await reaction.fetch();
  if (user.bot || !reaction.message.guild) return;

  const guild = reaction.message.guild;

  let members;
  try {
    members = await guild.members.fetch();
  } catch (err) {
    console.warn("⚠️ Failed to fetch all members, falling back to cache.");
    members = guild.members.cache;
  }

  const totalHumans = members.filter(m => {
    return !m.user.bot && !m.roles.cache.some(role => role.name.toLowerCase().includes('bot'));
  }).size;

  const uniqueReactors = new Set();
  for (const [, react] of reaction.message.reactions.cache) {
    const users = await react.users.fetch();
    users.forEach(u => {
      if (!u.bot) uniqueReactors.add(u.id);
    });
  }

  if (uniqueReactors.size >= totalHumans) {
    const embed = reaction.message.embeds[0];
    const appidMatch = embed?.url?.match(/\/app\/(\d+)/);
    if (appidMatch) {
      const appid = parseInt(appidMatch[1]);
      const isMultiGame = multiList.some(g => g.appid === appid);

      singleList = singleList.filter(g => g.appid !== appid);
      multiList = multiList.filter(g => g.appid !== appid);
      saveLists();

      if (isMultiGame) {
        const capitalizedName = embed.title?.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).substring(0, 90);
        const existing = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.name === capitalizedName?.toLowerCase());

        if (!existing) {
          try {
            await guild.channels.create({
              name: capitalizedName || 'Game Voice',
              type: ChannelType.GuildVoice,
              parent: process.env.GAME_VOICE_CATEGORY_ID,
              reason: 'Everyone in the server has this game'
            });
          } catch (e) {
            console.warn('⚠️ Failed to create voice channel:', e);
          }
        }
      }
    }
    await reaction.message.delete().catch(() => {});
  }
});

client.once('ready', () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
});

client.login(process.env.DISCORD_TOKEN);
