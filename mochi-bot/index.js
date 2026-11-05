require('dotenv').config();
const { Client, GatewayIntentBits, Partials } = require('discord.js');
const { SYSTEM_PROMPT, EXAMPLES } = require('./personality');

const discord = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ],
    partials: [Partials.Channel],
});

// Simple conversation memory - stores last few messages per channel
const conversationHistory = new Map();
const MAX_HISTORY = 10; // Remember last 10 exchanges per channel

// Get or create conversation history for a channel
function getHistory(channelId) {
    if (!conversationHistory.has(channelId)) {
        conversationHistory.set(channelId, []);
    }
    return conversationHistory.get(channelId);
}

// Add a message to history
function addToHistory(channelId, role, content) {
    const history = getHistory(channelId);
    history.push({ role, content });
    
    // Keep only the last MAX_HISTORY messages
    while (history.length > MAX_HISTORY * 2) {
        history.shift();
    }
}

// Clean up the message content - remove the @mention and clean up
function cleanMessage(message) {
    // Remove the bot mention from the message
    let content = message.content
        .replace(/<@!?\d+>/g, '') // Remove mentions
        .trim();
    
    // Add context about who's talking
    const username = message.author.displayName || message.author.username;
    return `${username} says: ${content}`;
}

// If she writes out a transcript, keep only her own part
function cleanReply(text) {
    const parts = text.split(/^\s*mochii?\s*(?:says)?\s*:\s*/im);
    let reply = parts[parts.length - 1];
    reply = reply.split(/\n[^\n]{1,40}? says:/i)[0]; // stop if she starts writing someone else's line
    return reply.trim();
}
// Generate a response from Mochi
async function generateResponse(channelId, userMessage) {
    const history = getHistory(channelId);

    const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...EXAMPLES,
        ...history,
        { role: 'user', content: userMessage }
    ];
    console.log(JSON.stringify(messages, null, 2));

    try {
        const response = await fetch('http://127.0.0.1:11434/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'qwen3:14b',
                stream: false,
                think: false,
                messages: messages,
                options: { num_predict: 150, temperature: 0.9, repeat_penalty: 1.1 },
            }),
            signal: AbortSignal.timeout(60_000),
        });

        if (!response.ok) {
            throw new Error(`ollama ${response.status}: ${await response.text()}`);
        }

        const data = await response.json();
        const assistantMessage = cleanReply(data.message.content);

        addToHistory(channelId, 'user', userMessage);
        addToHistory(channelId, 'assistant', assistantMessage);

        return assistantMessage;
    } catch (error) {
        console.error('Ollama error:', error);
        return "ah... my brain did a little oopsie :c try again maybe?";
    }
}

// Bot ready event
discord.once('ready', () => {
    console.log(`✨ Mochi is online as ${discord.user.tag}!`);
    console.log(`Watching for @mentions in ${discord.guilds.cache.size} server(s)`);
    
    // Set a cute status
    discord.user.setActivity('for @mentions :3', { type: 3 }); // Type 3 = Watching
});

// Message handler
discord.on('messageCreate', async (message) => {
    // Ignore bot messages (including own)
    if (message.author.bot) return;
    
    // Check if the bot was mentioned
    const isMentioned = message.mentions.has(discord.user.id);
    
    // Also respond to DMs
    const isDM = !message.guild;
    
    if (!isMentioned && !isDM) return;
    
    // Don't respond to empty mentions
    const cleanedContent = message.content.replace(/<@!?\d+>/g, '').trim();
    if (!cleanedContent && !message.attachments.size) {
        await message.reply("hmm? did you want something? :3");
        return;
    }

    message.channel.sendTyping(); // fires immediately
    const typingInterval = setInterval(() => {
        message.channel.sendTyping();
    }, 9000); // then every 9 seconds after

    try {
        const userMessage = cleanMessage(message);
        const response = await generateResponse(message.channel.id, userMessage);
        
        clearInterval(typingInterval);
        
        await message.reply({
            content: response,
            allowedMentions: { repliedUser: true }
        });
        
    } catch (error) {
        clearInterval(typingInterval);
        console.error('Error handling message:', error);
        await message.reply("something went weird... :c");
    }
});

// Error handling
discord.on('error', console.error);
process.on('unhandledRejection', console.error);

// Login
discord.login(process.env.DISCORD_TOKEN);
